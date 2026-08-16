import { type AgentRunId, type ReviewAgentArtifactId } from "@diffdash/domain/review-agent"
import type { RepositoryLocalPath } from "@diffdash/domain/repository"
import type { ReviewPromptIdentity } from "@diffdash/agents/review-thread"
import { ReviewFileId, ReviewHunkId, type ReviewProjectId } from "@diffdash/domain/review-identity"
import type { ReviewThreadId } from "@diffdash/domain/review-thread"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import {
  DiffDashReviewMcpTool,
  GetChangedFilesRequest,
  GetDiffHunkRequest,
  GetOlderThreadMessagesRequest,
  ReadRepositoryFileRequest,
  SearchRepositoryRequest,
  SearchReviewDiffRequest,
  type DiffDashMcpToolRequest,
  type DiffDashMcpToolResponse,
} from "@diffdash/protocol/mcp"
import { DiffDashMcpToolError, type DiffDashMcpToolHandlers } from "@diffdash/mcp/port"
import { AgentRunArtifactStore } from "@diffdash/persistence/agent-run-artifact-store"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import { type ProcessRunner, ProcessService, processRequest } from "@diffdash/process"
import { Context, Effect, Layer, Match, Option, Schema } from "effect"
import { paginateByOffset } from "./offset-pagination"
import {
  OPERATION_SNAPSHOT_HUNK_LIMIT,
  OPERATION_SNAPSHOT_INVENTORY_LIMIT,
  type OperationSnapshotHandle,
} from "./operation-snapshot-reader"
import {
  decodeSnapshotHunkLines,
  projectSnapshotHunk,
  reviewPromptFile,
} from "./operation-snapshot-projection"
import { projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"

/** Immutable resources captured by the Core handlers for one review-agent run. */
export interface ReviewMcpHandlerContext {
  readonly runId: AgentRunId
  readonly threadId: ReviewThreadId
  readonly repoId: ReviewProjectId
  readonly review: ReviewPromptIdentity
  readonly snapshot: OperationSnapshotHandle
  readonly localPath: RepositoryLocalPath
  readonly walkthrough: Option.Option<StoredWalkthrough>
}

/** Supplies Core-owned implementations for the MCP adapter's typed tool port. */
export class ReviewMcpHandlers extends Context.Service<
  ReviewMcpHandlers,
  {
    readonly make: (context: ReviewMcpHandlerContext) => DiffDashMcpToolHandlers
  }
>()("@diffdash/ReviewMcpHandlers") {
  static readonly layer = Layer.effect(
    ReviewMcpHandlers,
    Effect.gen(function* () {
      const threads = yield* ReviewThreadStore
      const artifacts = yield* AgentRunArtifactStore
      const processes = yield* ProcessService

      return ReviewMcpHandlers.of({
        make: (context) => makeHandlers(context, threads, artifacts, processes),
      })
    }),
  )
}

const available = <Data>(data: Data): DiffDashMcpToolResponse => ({
  status: "available",
  data: Schema.decodeUnknownSync(Schema.Json)(data),
})
const unavailable = (reason: string): DiffDashMcpToolResponse => ({ status: "unavailable", reason })

const makeHandlers = (
  context: ReviewMcpHandlerContext,
  threads: Context.Service.Shape<typeof ReviewThreadStore>,
  artifacts: Context.Service.Shape<typeof AgentRunArtifactStore>,
  processes: ProcessRunner,
): DiffDashMcpToolHandlers => ({
  execute: (request: DiffDashMcpToolRequest) => {
    const effect: Effect.Effect<DiffDashMcpToolResponse, Error> = (() => {
      switch (request.tool) {
        case DiffDashReviewMcpTool.getReviewContext:
          return Effect.succeed(reviewContext(context.review))
        case DiffDashReviewMcpTool.getChangedFiles:
          return getChangedFiles(context.snapshot, request)
        case DiffDashReviewMcpTool.searchReviewDiff:
          return searchReviewDiff(context.snapshot, request)
        case DiffDashReviewMcpTool.getDiffHunk:
          return getDiffHunk(context.snapshot, request)
        case DiffDashReviewMcpTool.getDiffFile:
          return getDiffFile(context.snapshot, request.fileId)
        case DiffDashReviewMcpTool.searchRepository:
          return searchLinkedRepository(context, processes, request)
        case DiffDashReviewMcpTool.readRepositoryFile:
          return readLinkedRepositoryFile(context, processes, request)
        case DiffDashReviewMcpTool.getThreadContext:
          return threads.get(context.threadId).pipe(Effect.map(available))
        case DiffDashReviewMcpTool.getOlderThreadMessages:
          return getOlderThreadMessages(context.threadId, threads, request)
        case DiffDashReviewMcpTool.getPriorArtifact:
          return getPriorArtifact(context, artifacts, request.artifactId)
        case DiffDashReviewMcpTool.getWalkthroughContext:
          return Effect.succeed(
            Option.match(context.walkthrough, {
              onNone: () => unavailable("No walkthrough is available for this review revision"),
              onSome: available,
            }),
          )
        default:
          return Effect.die(request satisfies never)
      }
    })()
    return effect.pipe(
      Effect.mapError((cause) =>
        DiffDashMcpToolError.make({ operation: request.tool, reason: String(cause) }),
      ),
    )
  },
})

const getChangedFiles = (
  snapshot: OperationSnapshotHandle,
  input: typeof GetChangedFilesRequest.Type,
) =>
  Effect.gen(function* () {
    const limit = Math.min(input.limit, OPERATION_SNAPSHOT_INVENTORY_LIMIT)
    const files = yield* snapshot.inventory(input.offset, limit)
    const totalFiles = yield* inventoryCount(snapshot)
    return available({
      files: yield* Effect.forEach(files, (file) =>
        Effect.gen(function* () {
          const hunks = yield* snapshot.hunks(
            ReviewFileId.make(file.fileId),
            0,
            OPERATION_SNAPSHOT_HUNK_LIMIT,
          )
          return { ...reviewPromptFile(file), hunkIds: hunks.map((hunk) => hunk.id) }
        }),
      ),
      offset: input.offset,
      limit,
      totalFiles,
      hasMore: input.offset + files.length < totalFiles,
      nextOffset: input.offset + files.length < totalFiles ? input.offset + files.length : null,
    })
  })

const getDiffHunk = (snapshot: OperationSnapshotHandle, input: typeof GetDiffHunkRequest.Type) =>
  snapshot.readHunk(input.fileId, input.hunkId).pipe(
    Effect.flatMap(({ file, hunk, bytes }) =>
      Effect.gen(function* () {
        const lines = yield* decodeSnapshotHunkLines(bytes)
        const page = paginateByOffset(lines, input.startLine, input.lineCount)
        return available({
          fileId: file.fileId,
          path: file.path,
          hunkId: hunk.id,
          fingerprint: hunk.fingerprint,
          header: hunk.header,
          startLine: page.offset,
          lines: page.items,
          totalLines: page.total,
          nextStartLine: page.nextOffset,
        })
      }),
    ),
    Effect.catchTag("OperationSnapshotReaderError", () =>
      Effect.succeed(unavailable("Diff hunk is unavailable for this review run")),
    ),
  )

const getDiffFile = (snapshot: OperationSnapshotHandle, fileId: ReviewFileId) =>
  snapshot.readFile(fileId).pipe(
    Effect.flatMap(({ file, bytes }) =>
      Effect.gen(function* () {
        const patch = yield* decodeSnapshotHunkLines(bytes)
        return available({
          fileId: file.fileId,
          path: file.path,
          oldPath: file.oldPath,
          status: file.status,
          patch: patch.join("\n"),
        })
      }),
    ),
    Effect.catchTag("OperationSnapshotReaderError", () =>
      Effect.succeed(unavailable("Diff file is unavailable for this review run")),
    ),
  )

const searchReviewDiff = (
  snapshot: OperationSnapshotHandle,
  input: typeof SearchReviewDiffRequest.Type,
) =>
  Effect.gen(function* () {
    const needle = input.caseSensitive ? input.query : input.query.toLowerCase()
    const matches: Array<{
      readonly fileId: string
      readonly path: string
      readonly hunkId: string
      readonly header: string
      readonly patchLine: string
      readonly oldLineNumber: number | null
      readonly newLineNumber: number | null
    }> = []
    let total = 0

    let offset = 0
    for (;;) {
      const files = yield* snapshot.inventory(offset, OPERATION_SNAPSHOT_INVENTORY_LIMIT)
      for (const file of files) {
        if (input.path !== undefined && file.path !== input.path && file.oldPath !== input.path)
          continue
        let hunkOffset = 0
        for (;;) {
          const hunks = yield* snapshot.hunks(
            ReviewFileId.make(file.fileId),
            hunkOffset,
            OPERATION_SNAPSHOT_HUNK_LIMIT,
          )
          for (const hunk of hunks) {
            const read = yield* snapshot.readHunk(
              ReviewFileId.make(file.fileId),
              ReviewHunkId.make(hunk.id),
            )
            const lines = yield* decodeSnapshotHunkLines(read.bytes)
            for (const line of projectDiffHunkLines(projectSnapshotHunk(hunk, lines))) {
              const haystack = input.caseSensitive ? line.patchLine : line.patchLine.toLowerCase()
              if (!haystack.includes(needle)) continue
              total += 1
              if (matches.length < input.maxResults) {
                matches.push({
                  fileId: file.fileId,
                  path: file.path,
                  hunkId: hunk.id,
                  header: hunk.header,
                  patchLine: line.patchLine,
                  oldLineNumber: line.oldLineNumber,
                  newLineNumber: line.newLineNumber,
                })
              }
            }
          }
          if (hunks.length < OPERATION_SNAPSHOT_HUNK_LIMIT) break
          hunkOffset += hunks.length
        }
      }
      if (files.length < OPERATION_SNAPSHOT_INVENTORY_LIMIT) break
      offset += files.length
    }

    return available({ matches, total, truncated: total > matches.length })
  })

const getOlderThreadMessages = (
  threadId: ReviewThreadId,
  threads: Context.Service.Shape<typeof ReviewThreadStore>,
  input: typeof GetOlderThreadMessagesRequest.Type,
) =>
  threads.get(threadId).pipe(
    Effect.map((details) => {
      const eligible = details.messages.filter(
        (message) => input.beforeSequence === undefined || message.sequence < input.beforeSequence,
      )
      const page = eligible.slice(Math.max(0, eligible.length - input.limit))
      return available({
        messages: page,
        hasMore: eligible.length > page.length,
        nextBeforeSequence: page[0]?.sequence ?? null,
      })
    }),
  )

const getPriorArtifact = (
  context: ReviewMcpHandlerContext,
  artifacts: Context.Service.Shape<typeof AgentRunArtifactStore>,
  artifactId: ReviewAgentArtifactId,
) =>
  artifacts.get(artifactId).pipe(
    Effect.option,
    Effect.map((artifact) => {
      if (
        Option.isNone(artifact) ||
        artifact.value.threadId !== context.threadId ||
        artifact.value.runId === context.runId
      ) {
        return unavailable("Artifact is unavailable for this thread")
      }
      return available(artifact.value)
    }),
  )

const searchLinkedRepository = (
  context: ReviewMcpHandlerContext,
  processes: ProcessRunner,
  input: typeof SearchRepositoryRequest.Type,
): Effect.Effect<DiffDashMcpToolResponse> => {
  if (!hasExactRepositoryWorkspace(context.review)) {
    return Effect.succeed(
      unavailable("Exact repository search is available for immutable repository reviews"),
    )
  }
  if (context.localPath === null) {
    return Effect.succeed(
      unavailable("An isolated repository workspace is unavailable for this review run"),
    )
  }
  const localPath = context.localPath
  const safePath = input.path === undefined ? undefined : normalizeRepositoryPath(input.path)
  if (safePath === null) {
    return Effect.succeed(unavailable("Repository search path must stay inside the checkout"))
  }
  const revision = context.review.headRevision

  return Effect.gen(function* () {
    yield* processes.run(
      processRequest("git", ["-C", localPath, "cat-file", "-e", `${revision}^{commit}`], {
        timeoutMs: 10_000,
      }),
    )
    const result = yield* processes
      .run(
        processRequest(
          "git",
          [
            "-C",
            localPath,
            "grep",
            "-n",
            "-I",
            "-F",
            `--max-count=${input.maxResults}`,
            ...(input.caseSensitive ? [] : ["-i"]),
            "-e",
            input.query,
            revision,
            "--",
            ...(safePath === undefined ? [] : [safePath]),
          ],
          { timeoutMs: 20_000 },
        ),
      )
      .pipe(
        Effect.map(Option.some),
        Effect.catchTag("ProcessExitError", (cause) =>
          cause.exitCode === 1 ? Effect.succeed(Option.none()) : Effect.fail(cause),
        ),
      )
    const matches = Option.isSome(result)
      ? parseGitGrepMatches(result.value.stdout, revision, input.maxResults)
      : []
    return available({
      revision,
      source: "isolated-worktree",
      matches,
      truncated: Option.isSome(result) && matches.length === input.maxResults,
    })
  }).pipe(
    Effect.orElseSucceed(() =>
      unavailable(
        "The isolated worktree does not contain the immutable review head or could not be searched",
      ),
    ),
  )
}

const readLinkedRepositoryFile = (
  context: ReviewMcpHandlerContext,
  processes: ProcessRunner,
  input: typeof ReadRepositoryFileRequest.Type,
): Effect.Effect<DiffDashMcpToolResponse> => {
  if (!hasExactRepositoryWorkspace(context.review)) {
    return Effect.succeed(
      unavailable("Exact repository reads are available for immutable repository reviews"),
    )
  }
  if (context.localPath === null) {
    return Effect.succeed(
      unavailable("An isolated repository workspace is unavailable for this review run"),
    )
  }
  const localPath = context.localPath
  const safePath = normalizeRepositoryPath(input.path)
  if (safePath === null) {
    return Effect.succeed(unavailable("Repository file path must stay inside the checkout"))
  }
  const revision = context.review.headRevision

  return processes
    .run(
      processRequest("git", ["-C", localPath, "show", `${revision}:${safePath}`], {
        timeoutMs: 20_000,
      }),
    )
    .pipe(
      Effect.map((result) =>
        available({
          revision,
          source: "isolated-worktree",
          path: safePath,
          content: result.stdout,
        }),
      ),
      Effect.orElseSucceed(() =>
        unavailable("Repository file is unavailable at the immutable review head"),
      ),
    )
}

const normalizeRepositoryPath = (path: string) => {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "")
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    return null
  }
  return normalized
}

const parseGitGrepMatches = (output: string, revision: string, maxResults: number) => {
  const prefix = `${revision}:`
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const withoutRevision = line.startsWith(prefix) ? line.slice(prefix.length) : line
      const match = /^(.*):(\d+):(.*)$/u.exec(withoutRevision)
      return match === null
        ? []
        : [{ path: match[1] ?? "", lineNumber: Number(match[2]), line: match[3] ?? "" }]
    })
    .slice(0, maxResults)
}

const reviewContext = (review: ReviewPromptIdentity): DiffDashMcpToolResponse => {
  const identity = {
    reviewKey: review.reviewKey,
    baseRevision: review.baseRevision,
    headRevision: review.headRevision,
  }
  return Match.value(review.descriptor).pipe(
    Match.tag("hosted", (hosted) =>
      available({
        ...identity,
        kind: "hosted",
        title: hosted.title,
      }),
    ),
    Match.tag("repositoryComparison", (comparison) =>
      available({
        ...identity,
        kind: "repositoryComparison",
        title: comparison.title,
      }),
    ),
    Match.tag("local", (local) =>
      available({
        ...identity,
        kind: "local",
        title: local.title,
      }),
    ),
    Match.exhaustive,
  )
}

const hasExactRepositoryWorkspace = (review: ReviewPromptIdentity): boolean =>
  Match.valueTags(review.descriptor, {
    hosted: () => true,
    local: () => false,
    repositoryComparison: () => true,
  })

const inventoryCount = Effect.fn("ReviewMcpHandlers.inventoryCount")(function* (
  snapshot: OperationSnapshotHandle,
) {
  let total = 0
  for (;;) {
    const page = yield* snapshot.inventory(total, OPERATION_SNAPSHOT_INVENTORY_LIMIT)
    total += page.length
    if (page.length < OPERATION_SNAPSHOT_INVENTORY_LIMIT) return total
  }
})
