import { Buffer } from "node:buffer"
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { Scope } from "effect"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { z } from "zod"

import type { StoredAgentRunArtifact } from "@diffdash/domain/agent-run"
import { type AgentRunId, ReviewAgentArtifactId } from "@diffdash/domain/review-agent"
import { PullRequestReviewSnapshot, type ReviewSnapshot } from "@diffdash/domain/review-context"
import type { ReviewThreadId } from "@diffdash/domain/review-thread"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import { AgentRunArtifactStore } from "./agent-run-artifact-store"
import { CliError, type CliRunner, CliService } from "@diffdash/process/cli"
import { ReviewThreadStore } from "./review-thread-store"

const MAX_REQUEST_BYTES = 1024 * 1024
const DEFAULT_TOOL_OUTPUT_BYTES = 128 * 1024
const DEFAULT_HUNK_PAGE_LINES = 200
const MAX_HUNK_PAGE_LINES = 500
const DEFAULT_DIFF_SEARCH_RESULTS = 50
const MAX_DIFF_SEARCH_RESULTS = 100
const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

/** Immutable context authorized for one review-agent MCP capability. */
export interface DiffDashMcpRunContext {
  readonly runId: AgentRunId
  readonly threadId: ReviewThreadId
  readonly repoId: string
  readonly snapshot: ReviewSnapshot
  readonly localPath: string | null
  readonly walkthrough: StoredWalkthrough | null
  readonly maxToolOutputBytes?: number
}

/** Scoped connection details passed only to the selected provider adapter. */
export interface DiffDashMcpRunAccess {
  readonly url: string
  readonly bearerToken: Redacted.Redacted<string>
}

class RunCapability {
  activeRequests = 0
  readonly waiters = new Set<() => void>()

  constructor(readonly context: DiffDashMcpRunContext) {}

  begin() {
    this.activeRequests += 1
  }

  end() {
    this.activeRequests -= 1
    if (this.activeRequests !== 0) return
    for (const resolve of this.waiters) resolve()
    this.waiters.clear()
  }

  drain() {
    if (this.activeRequests === 0) return Promise.resolve()
    return new Promise<void>((resolve) => this.waiters.add(resolve))
  }
}

/** A typed failure from the local DiffDash review context server. */
export class DiffDashMcpServerError extends Schema.TaggedError<DiffDashMcpServerError>()(
  "DiffDashMcpServerError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Loopback-only MCP server with scoped, per-run bearer capabilities. */
export class DiffDashMcpServer extends Context.Tag("@diffdash/DiffDashMcpServer")<
  DiffDashMcpServer,
  {
    readonly acquireRun: (
      context: DiffDashMcpRunContext,
    ) => Effect.Effect<DiffDashMcpRunAccess, DiffDashMcpServerError, Scope.Scope>
  }
>() {
  static readonly layer = Layer.scoped(
    DiffDashMcpServer,
    Effect.gen(function* () {
      const threads = yield* ReviewThreadStore
      const artifacts = yield* AgentRunArtifactStore
      const cli = yield* CliService
      const capabilities = new Map<string, RunCapability>()

      const server = yield* Effect.acquireRelease(
        listen((request, response) =>
          handleHttpRequest(request, response, capabilities, threads, artifacts, cli),
        ),
        (httpServer) =>
          Effect.async<void>((resume) => {
            capabilities.clear()
            httpServer.close(() => resume(Effect.void))
          }),
      )
      const address = server.address()
      if (address === null || typeof address === "string") {
        return yield* DiffDashMcpServerError.make({
          operation: "listen.address",
          cause: new Error("MCP server did not expose a TCP address"),
        })
      }
      const url = `http://127.0.0.1:${address.port}/mcp`

      return DiffDashMcpServer.of({
        acquireRun: (context) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const token = randomBytes(32).toString("hex")
              capabilities.set(token, new RunCapability(context))
              return { url, bearerToken: Redacted.make(token) }
            }),
            (access) => {
              const token = Redacted.value(access.bearerToken)
              const capability = capabilities.get(token)
              capabilities.delete(token)
              return capability === undefined
                ? Effect.void
                : Effect.promise(() => capability.drain())
            },
          ),
      })
    }),
  )
}

type HttpServer = ReturnType<typeof createServer>

const listen = (
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Effect.Effect<HttpServer, DiffDashMcpServerError> =>
  Effect.async<HttpServer, DiffDashMcpServerError>((resume) => {
    const server = createServer((request, response) => {
      void handler(request, response).catch(() => {
        if (!response.headersSent) writeJson(response, 500, rpcError(-32603, "Internal error"))
        else response.end()
      })
    })
    server.once("error", (cause) =>
      resume(Effect.fail(DiffDashMcpServerError.make({ operation: "listen", cause }))),
    )
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
  })

const handleHttpRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  capabilities: ReadonlyMap<string, RunCapability>,
  threads: Context.Tag.Service<ReviewThreadStore>,
  artifacts: Context.Tag.Service<AgentRunArtifactStore>,
  cli: CliRunner,
) => {
  if (request.method !== "POST" || request.url !== "/mcp") {
    writeJson(response, 405, rpcError(-32000, "Method not allowed"))
    return
  }
  const token = bearerToken(request.headers.authorization)
  const capability = token === null ? undefined : capabilities.get(token)
  if (capability === undefined) {
    writeJson(response, 401, rpcError(-32001, "Unauthorized"))
    return
  }

  capability.begin()
  try {
    const body = await readJsonBody(request)
    const mcp = createRunServer(capability.context, threads, artifacts, cli)
    // SAFETY: The SDK documents explicit `undefined` as stateless mode, but its declaration conflicts
    // with exactOptionalPropertyTypes. The Node wrapper also has an equivalent callback variance issue.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as never })
    await mcp.connect(transport as Transport)
    response.once("close", () => {
      void transport.close()
      void mcp.close()
    })
    await transport.handleRequest(request, response, body)
  } finally {
    capability.end()
  }
}

const createRunServer = (
  context: DiffDashMcpRunContext,
  threads: Context.Tag.Service<ReviewThreadStore>,
  artifacts: Context.Tag.Service<AgentRunArtifactStore>,
  cli: CliRunner,
) => {
  const server = new McpServer({ name: "diffdash-review-context", version: "1" })
  const register = <InputSchema extends z.AnyZodObject>(
    name: string,
    description: string,
    inputSchema: InputSchema,
    handler: (input: z.infer<InputSchema>) => Promise<unknown> | unknown,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema, annotations: READ_ONLY_TOOL_ANNOTATIONS },
      // SAFETY: `inputSchema` validates the callback input. The SDK's v3/v4 Zod compatibility
      // overload does not preserve this generic relationship under exactOptionalPropertyTypes.
      (async (input: z.infer<InputSchema>) =>
        boundedToolResult(await handler(input), context.maxToolOutputBytes)) as never,
    )

  register("getReviewContext", "Get immutable metadata for this review run.", z.object({}), () =>
    reviewContext(context.snapshot),
  )
  register("getChangedFiles", "List every changed file and stable hunk ID.", z.object({}), () =>
    available(
      context.snapshot.parsedDiff.files.map((file) => ({
        fileId: file.fileId,
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        hunkIds: file.hunks.map((hunk) => hunk.id),
      })),
    ),
  )
  register(
    "searchReviewDiff",
    "Fixed-string search over immutable parsed diff hunk lines with exact line metadata.",
    z.object({
      query: z.string().min(1).max(1024),
      path: z.string().min(1).optional(),
      caseSensitive: z.boolean().default(false),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(MAX_DIFF_SEARCH_RESULTS)
        .default(DEFAULT_DIFF_SEARCH_RESULTS),
    }),
    ({ query, path, caseSensitive, maxResults }) =>
      available(searchReviewDiff(context.snapshot, query, path, caseSensitive, maxResults)),
  )
  register(
    "getDiffHunk",
    "Get one bounded page of exact patch lines for a stable changed-file hunk.",
    z.object({
      fileId: z.string().min(1),
      hunkId: z.string().min(1),
      startLine: z.number().int().min(0).default(0),
      lineCount: z.number().int().min(1).max(MAX_HUNK_PAGE_LINES).default(DEFAULT_HUNK_PAGE_LINES),
    }),
    ({ fileId, hunkId, startLine, lineCount }) => {
      const file = context.snapshot.parsedDiff.files.find((entry) => entry.fileId === fileId)
      const hunk = file?.hunks.find((entry) => entry.id === hunkId)
      const lines = hunk?.lines.slice(startLine, startLine + lineCount)
      return hunk === undefined
        ? unavailable("Diff hunk is unavailable for this review run")
        : available({
            fileId: file?.fileId,
            path: file?.path,
            hunkId: hunk.id,
            fingerprint: hunk.fingerprint,
            header: hunk.header,
            startLine,
            lines,
            totalLines: hunk.lines.length,
            nextStartLine: startLine + lineCount < hunk.lines.length ? startLine + lineCount : null,
          })
    },
  )
  register(
    "getDiffFile",
    "Get exact patch text for one stable changed-file ID.",
    z.object({ fileId: z.string().min(1) }),
    ({ fileId }) => {
      const file = context.snapshot.parsedDiff.files.find((entry) => entry.fileId === fileId)
      return file === undefined
        ? unavailable("Diff file is unavailable for this review run")
        : available({
            fileId: file.fileId,
            path: file.path,
            oldPath: file.oldPath,
            status: file.status,
            patch: file.patch,
          })
    },
  )
  register(
    "searchRepository",
    "Fixed-string search of the isolated worktree at the immutable pull-request head revision.",
    z.object({
      query: z.string().min(1).max(1024),
      path: z.string().min(1).optional(),
      caseSensitive: z.boolean().default(false),
      maxResults: z.number().int().min(1).max(100).default(25),
    }),
    async ({ query, path, caseSensitive, maxResults }) =>
      searchLinkedRepository(context, cli, query, path, caseSensitive, maxResults),
  )
  register(
    "readRepositoryFile",
    "Read one file from the isolated worktree at the immutable pull-request head revision.",
    z.object({ path: z.string().min(1).max(4096) }),
    async ({ path }) => readLinkedRepositoryFile(context, cli, path),
  )
  register(
    "getThreadContext",
    "Get this run's local thread and messages.",
    z.object({}),
    async () => {
      const details = await Effect.runPromise(threads.get(context.threadId))
      return available(details)
    },
  )
  register(
    "getOlderThreadMessages",
    "Get older messages for this run's thread using sequence pagination.",
    z.object({
      beforeSequence: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    async ({ beforeSequence, limit }) => {
      const details = await Effect.runPromise(threads.get(context.threadId))
      const eligible = details.messages.filter(
        (message) => beforeSequence === undefined || message.sequence < beforeSequence,
      )
      const page = eligible.slice(Math.max(0, eligible.length - limit))
      return available({
        messages: page,
        hasMore: eligible.length > page.length,
        nextBeforeSequence: page[0]?.sequence ?? null,
      })
    },
  )
  register(
    "getPriorArtifact",
    "Get one normalized prior artifact owned by this run's thread.",
    z.object({ artifactId: z.string().min(1) }),
    async ({ artifactId }) => {
      const artifact = await Effect.runPromise(
        artifacts.get(ReviewAgentArtifactId.make(artifactId)).pipe(Effect.option),
      )
      if (
        Option.isNone(artifact) ||
        artifact.value.threadId !== context.threadId ||
        artifact.value.runId === context.runId
      ) {
        return unavailable("Artifact is unavailable for this thread")
      }
      return available(artifact.value)
    },
  )
  register(
    "getWalkthroughContext",
    "Get the cached walkthrough for this review run.",
    z.object({}),
    () =>
      context.walkthrough === null
        ? unavailable("No walkthrough is available for this review revision")
        : available(context.walkthrough),
  )

  return server
}

type SearchDiffFile = ReviewSnapshot["parsedDiff"]["files"][number]
type SearchDiffHunk = SearchDiffFile["hunks"][number]

const searchReviewDiff = (
  snapshot: ReviewSnapshot,
  query: string,
  path: string | undefined,
  caseSensitive: boolean,
  maxResults: number,
) => {
  const needle = caseSensitive ? query : query.toLowerCase()
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

  for (const file of orderedDiffFiles(snapshot)) {
    if (path !== undefined && file.path !== path && file.oldPath !== path) continue
    for (const hunk of orderedDiffHunks(file.hunks)) {
      let oldLine = hunk.oldStart
      let newLine = hunk.newStart
      for (const patchLine of hunk.lines) {
        let oldLineNumber: number | null = null
        let newLineNumber: number | null = null
        if (patchLine.startsWith(" ")) {
          oldLineNumber = oldLine
          newLineNumber = newLine
          oldLine += 1
          newLine += 1
        } else if (patchLine.startsWith("-")) {
          oldLineNumber = oldLine
          oldLine += 1
        } else if (patchLine.startsWith("+")) {
          newLineNumber = newLine
          newLine += 1
        }

        const haystack = caseSensitive ? patchLine : patchLine.toLowerCase()
        if (!haystack.includes(needle)) continue
        total += 1
        if (matches.length < maxResults) {
          matches.push({
            fileId: file.fileId,
            path: file.path,
            hunkId: hunk.id,
            header: hunk.header,
            patchLine,
            oldLineNumber,
            newLineNumber,
          })
        }
      }
    }
  }

  return { matches, total, truncated: total > matches.length }
}

const searchLinkedRepository = async (
  context: DiffDashMcpRunContext,
  cli: CliRunner,
  query: string,
  path: string | undefined,
  caseSensitive: boolean,
  maxResults: number,
): Promise<Envelope> => {
  if (!(context.snapshot instanceof PullRequestReviewSnapshot)) {
    return unavailable("Exact repository search is available for pull-request reviews")
  }
  if (context.localPath === null) {
    return unavailable("An isolated repository workspace is unavailable for this review run")
  }
  const safePath = path === undefined ? undefined : normalizeRepositoryPath(path)
  if (safePath === null) return unavailable("Repository search path must stay inside the checkout")
  const revision = context.snapshot.headRevision

  try {
    await Effect.runPromise(
      cli.run("git", ["-C", context.localPath, "cat-file", "-e", `${revision}^{commit}`], {
        timeoutMs: 10_000,
      }),
    )
    const result = await Effect.runPromise(
      cli.run(
        "git",
        [
          "-C",
          context.localPath,
          "grep",
          "-n",
          "-I",
          "-F",
          `--max-count=${maxResults}`,
          ...(caseSensitive ? [] : ["-i"]),
          "-e",
          query,
          revision,
          "--",
          ...(safePath === undefined ? [] : [safePath]),
        ],
        { timeoutMs: 20_000 },
      ),
    )
    const matches = parseGitGrepMatches(result.stdout, revision, maxResults)
    return available({
      revision,
      source: "isolated-worktree",
      matches,
      truncated: matches.length === maxResults,
    })
  } catch (cause) {
    if (cause instanceof CliError && cause.exitCode === 1) {
      return available({
        revision,
        source: "isolated-worktree",
        matches: [],
        truncated: false,
      })
    }
    return unavailable(
      "The isolated worktree does not contain the immutable review head or could not be searched",
    )
  }
}

const readLinkedRepositoryFile = async (
  context: DiffDashMcpRunContext,
  cli: CliRunner,
  path: string,
): Promise<Envelope> => {
  if (!(context.snapshot instanceof PullRequestReviewSnapshot)) {
    return unavailable("Exact repository reads are available for pull-request reviews")
  }
  if (context.localPath === null) {
    return unavailable("An isolated repository workspace is unavailable for this review run")
  }
  const safePath = normalizeRepositoryPath(path)
  if (safePath === null) return unavailable("Repository file path must stay inside the checkout")
  const revision = context.snapshot.headRevision

  try {
    const result = await Effect.runPromise(
      cli.run("git", ["-C", context.localPath, "show", `${revision}:${safePath}`], {
        timeoutMs: 20_000,
      }),
    )
    return available({
      revision,
      source: "isolated-worktree",
      path: safePath,
      content: result.stdout,
    })
  } catch {
    return unavailable("Repository file is unavailable at the immutable review head")
  }
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

const orderedDiffFiles = (snapshot: ReviewSnapshot) =>
  sortedCopy(
    snapshot.parsedDiff.files,
    (left, right) =>
      compareStrings(left.path, right.path) ||
      compareStrings(left.oldPath ?? "", right.oldPath ?? "") ||
      compareStrings(left.fileId, right.fileId),
  )

const orderedDiffHunks = (hunks: readonly SearchDiffHunk[]) =>
  sortedCopy(
    hunks,
    (left, right) =>
      left.oldStart - right.oldStart ||
      left.newStart - right.newStart ||
      compareStrings(left.id, right.id),
  )

const compareStrings = (left: string, right: string) => (left === right ? 0 : left < right ? -1 : 1)

const sortedCopy = <Item>(items: readonly Item[], compare: (left: Item, right: Item) => number) => {
  const copy = [...items]
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks toSorted; only the copy mutates.
  return copy.sort(compare)
}

type Envelope =
  | { readonly status: "available"; readonly data: unknown }
  | { readonly status: "unavailable"; readonly reason: string }

const available = (data: unknown): Envelope => ({ status: "available", data })
const unavailable = (reason: string): Envelope => ({ status: "unavailable", reason })

const boundedToolResult = (value: unknown, maxBytes = DEFAULT_TOOL_OUTPUT_BYTES) => {
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, "utf8") <= maxBytes) {
    return { content: [{ type: "text" as const, text: json }] }
  }
  const originalBytes = Buffer.byteLength(json, "utf8")
  let low = 0
  let high = maxBytes
  let text = JSON.stringify({
    status: "truncated",
    originalBytes,
    limitBytes: maxBytes,
    content: "",
  })
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = JSON.stringify({
      status: "truncated",
      originalBytes,
      limitBytes: maxBytes,
      content: truncateUtf8(json, middle),
    })
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      text = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return {
    content: [{ type: "text" as const, text }],
  }
}

const truncateUtf8 = (value: string, maxBytes: number) => {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.length <= maxBytes) return value
  return bytes.subarray(0, Math.max(0, maxBytes)).toString("utf8").replace(/�$/u, "")
}

const reviewContext = (snapshot: ReviewSnapshot) => ({
  status: "available" as const,
  data: {
    kind: snapshot instanceof PullRequestReviewSnapshot ? "pullRequest" : "local",
    reviewKey: snapshot.reviewKey,
    baseRevision: snapshot.baseRevision,
    headRevision: snapshot.headRevision,
    title: snapshot.detail.title,
  },
})

const bearerToken = (authorization: string | undefined) => {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) return null
  const token = authorization.slice("Bearer ".length)
  return token.length === 64 ? token : null
}

const readJsonBody = (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error("MCP request body exceeds size limit"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown)
      } catch (cause) {
        reject(cause)
      }
    })
    request.on("error", reject)
  })

const rpcError = (code: number, message: string) => ({
  jsonrpc: "2.0",
  error: { code, message },
  id: null,
})

const writeJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

/** Returns an artifact only when it belongs to the current thread capability. */
export const mcpArtifactForThread = (artifact: StoredAgentRunArtifact, threadId: ReviewThreadId) =>
  artifact.threadId === threadId ? artifact : null
