import { projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"
import { type AgentRunId, type ReviewAgentArtifactId } from "@diffdash/domain/review-agent"
import type { RepositoryLocalPath } from "@diffdash/domain/repository"
import {
  HostedReviewSnapshot,
  RepositoryComparisonSnapshot,
  type ReviewSnapshot,
} from "@diffdash/domain/review-context"
import type { ReviewFileId, ReviewProjectId } from "@diffdash/domain/review-identity"
import type { ReviewThreadId } from "@diffdash/domain/review-thread"
import { orderedReviewFiles, orderedReviewHunks } from "@diffdash/domain/review-ordering"
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

/** Immutable resources captured by the Core handlers for one review-agent run. */
export interface ReviewMcpHandlerContext {
  readonly runId: AgentRunId
  readonly threadId: ReviewThreadId
  readonly repoId: ReviewProjectId
  readonly snapshot: ReviewSnapshot
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

const available = (data: object): DiffDashMcpToolResponse => ({
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
    const effect = (() => {
      switch (request.tool) {
        case DiffDashReviewMcpTool.getReviewContext:
          return Effect.succeed(available(reviewContext(context.snapshot)))
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

const getChangedFiles = (snapshot: ReviewSnapshot, input: typeof GetChangedFilesRequest.Type) => {
  const allFiles = orderedReviewFiles(snapshot)
  const page = paginateByOffset(allFiles, input.offset, input.limit)
  return Effect.succeed(
    available({
      files: page.items.map((file) => ({
        fileId: file.fileId,
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        hunkIds: file.hunks.map((hunk) => hunk.id),
      })),
      offset: page.offset,
      limit: page.limit,
      totalFiles: page.total,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
    }),
  )
}

const getDiffHunk = (snapshot: ReviewSnapshot, input: typeof GetDiffHunkRequest.Type) => {
  const file = snapshot.parsedDiff.files.find((entry) => entry.fileId === input.fileId)
  const hunk = file?.hunks.find((entry) => entry.id === input.hunkId)
  if (file === undefined || hunk === undefined) {
    return Effect.succeed(unavailable("Diff hunk is unavailable for this review run"))
  }

  const page = paginateByOffset(hunk.lines, input.startLine, input.lineCount)
  return Effect.succeed(
    available({
      fileId: file.fileId,
      path: file.path,
      hunkId: hunk.id,
      fingerprint: hunk.fingerprint,
      header: hunk.header,
      startLine: page.offset,
      lines: page.items,
      totalLines: page.total,
      nextStartLine: page.nextOffset,
    }),
  )
}

const getDiffFile = (snapshot: ReviewSnapshot, fileId: ReviewFileId) => {
  const file = snapshot.parsedDiff.files.find((entry) => entry.fileId === fileId)
  return Effect.succeed(
    file === undefined
      ? unavailable("Diff file is unavailable for this review run")
      : available({
          fileId: file.fileId,
          path: file.path,
          oldPath: file.oldPath,
          status: file.status,
          patch: file.patch,
        }),
  )
}

type SearchDiffFile = ReviewSnapshot["parsedDiff"]["files"][number]
type SearchDiffHunk = SearchDiffFile["hunks"][number]

const searchReviewDiff = (snapshot: ReviewSnapshot, input: typeof SearchReviewDiffRequest.Type) => {
  const needle = input.caseSensitive ? input.query : input.query.toLowerCase()
  const matches: Array<{
    readonly fileId: SearchDiffFile["fileId"]
    readonly path: string
    readonly hunkId: SearchDiffHunk["id"]
    readonly header: string
    readonly patchLine: string
    readonly oldLineNumber: number | null
    readonly newLineNumber: number | null
  }> = []
  let total = 0

  for (const file of orderedReviewFiles(snapshot)) {
    if (input.path !== undefined && file.path !== input.path && file.oldPath !== input.path)
      continue
    for (const hunk of orderedReviewHunks(file.hunks)) {
      for (const line of projectDiffHunkLines(hunk)) {
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
  }

  return Effect.succeed(available({ matches, total, truncated: total > matches.length }))
}

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
  if (!hasExactRepositoryWorkspace(context.snapshot)) {
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
  const revision = context.snapshot.headRevision

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
  if (!hasExactRepositoryWorkspace(context.snapshot)) {
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
  const revision = context.snapshot.headRevision

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

const reviewContext = (snapshot: ReviewSnapshot): DiffDashMcpToolResponse => {
  return Match.value(snapshot).pipe(
    Match.tag("hosted", (hosted) =>
      available({
        kind: "hosted",
        reviewKey: hosted.reviewKey,
        baseRevision: hosted.baseRevision,
        headRevision: hosted.headRevision,
        title: hosted.detail.summary.title,
      }),
    ),
    Match.tag("repositoryComparison", (comparison) =>
      available({
        kind: "repositoryComparison",
        reviewKey: comparison.reviewKey,
        baseRevision: comparison.baseRevision,
        headRevision: comparison.headRevision,
        title: comparison.detail.title,
      }),
    ),
    Match.tag("local", (local) =>
      available({
        kind: "local",
        reviewKey: local.reviewKey,
        baseRevision: local.baseRevision,
        headRevision: local.headRevision,
        title: local.detail.title,
      }),
    ),
    Match.exhaustive,
  )
}

const hasExactRepositoryWorkspace = (
  snapshot: ReviewSnapshot,
): snapshot is HostedReviewSnapshot | RepositoryComparisonSnapshot =>
  Schema.is(HostedReviewSnapshot)(snapshot) || Schema.is(RepositoryComparisonSnapshot)(snapshot)
