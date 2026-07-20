import { Buffer } from "node:buffer"
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { DiffDashReviewMcpTool } from "@diffdash/agent-provider"
import { projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"
import { type AgentRunId, ReviewAgentArtifactId } from "@diffdash/domain/review-agent"
import { HostedReviewSnapshot, type ReviewSnapshot } from "@diffdash/domain/review-context"
import type { ReviewThreadId } from "@diffdash/domain/review-thread"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import { AgentRunArtifactStore } from "@diffdash/persistence/agent-run-artifact-store"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import { type ProcessRunner, ProcessService, processRequest } from "@diffdash/process"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { Scope } from "effect"
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Runtime,
  Schema,
} from "effect"
import { z } from "zod"
import { paginateByOffset } from "./offset-pagination"
import { orderedReviewFiles, orderedReviewHunks } from "./ordering"
import { truncateUtf8, utf8ByteLength } from "./utf8-budget"

const MAX_REQUEST_BYTES = 1024 * 1024
const DEFAULT_TOOL_OUTPUT_BYTES = 128 * 1024
const DEFAULT_HUNK_PAGE_LINES = 200
const MAX_HUNK_PAGE_LINES = 500
const DEFAULT_DIFF_SEARCH_RESULTS = 50
const MAX_DIFF_SEARCH_RESULTS = 100
const DEFAULT_CHANGED_FILES_PAGE_SIZE = 100
const MAX_CHANGED_FILES_PAGE_SIZE = 500
const DEFAULT_CAPABILITY_GRACE_MS = 250
const DEFAULT_REQUEST_FINALIZER_MS = 3_000
const DEFAULT_MCP_CLOSE_MS = 1_000
const DEFAULT_HTTP_CLOSE_MS = 1_000
const DEFAULT_HTTP_FORCE_CLOSE_MS = 250
const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const
const noopTransportClose: NonNullable<Transport["onclose"]> = () => undefined
const noopTransportError: NonNullable<Transport["onerror"]> = () => undefined
const noopTransportMessage: NonNullable<Transport["onmessage"]> = () => undefined

/** Immutable context authorized for one review-agent MCP capability. */
interface DiffDashMcpRunContext {
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

/** Optional lifecycle probes and gates used by deterministic server-boundary tests. */
interface DiffDashMcpServerLifecycleHooks {
  readonly onHttpRequest?: Effect.Effect<void>
  readonly onCapabilityRevoking?: () => void
  readonly beforeMcpConnect?: Effect.Effect<void>
  readonly beforeMcpClose?: (resource: "transport" | "server") => Effect.Effect<void>
  readonly onCleanupError?: (operation: string) => void
}

/** Finite lifecycle limits for the loopback MCP server. */
export interface DiffDashMcpServerLayerOptions {
  readonly capabilityGraceMs?: number
  readonly requestFinalizerMs?: number
  readonly mcpCloseMs?: number
  readonly httpCloseMs?: number
  readonly httpForceCloseMs?: number
  readonly hooks?: DiffDashMcpServerLifecycleHooks
}

interface ResolvedServerOptions {
  readonly capabilityGraceMs: number
  readonly requestFinalizerMs: number
  readonly mcpCloseMs: number
  readonly httpCloseMs: number
  readonly httpForceCloseMs: number
  readonly hooks: DiffDashMcpServerLifecycleHooks
}

interface CallbackRunFork {
  <A, E>(effect: Effect.Effect<A, E>): Fiber.RuntimeFiber<A, E>
}

interface StartedCallback<A, E> {
  readonly fiber: Fiber.RuntimeFiber<A, E>
  readonly promise: Promise<A>
}

class CallbackFiberOwner {
  readonly #fibers = new Set<Fiber.RuntimeFiber<unknown, unknown>>()
  #closed = false

  constructor(readonly runFork: CallbackRunFork) {}

  run<A, E>(effect: Effect.Effect<A, E>): StartedCallback<A, E> | null {
    if (this.#closed) return null
    const fiber = this.runFork(effect)
    this.#fibers.add(fiber)
    fiber.addObserver(() => this.#fibers.delete(fiber))
    return { fiber, promise: fiberPromise(fiber) }
  }

  beginClose() {
    this.#closed = true
    return [...this.#fibers]
  }
}

type CapabilityState = "active" | "revoking" | "revoked"

class RequestLease {
  readonly #abortController = new AbortController()
  readonly #fibers = new Map<Fiber.RuntimeFiber<unknown, unknown>, Promise<unknown>>()
  #closed = false

  constructor(
    readonly owner: CallbackFiberOwner,
    readonly onEnd: (lease: RequestLease) => void,
  ) {}

  get signal() {
    return this.#abortController.signal
  }

  track<A, E>(started: StartedCallback<A, E>): void {
    if (this.#closed) {
      this.#abortController.abort()
      return
    }
    this.#fibers.set(started.fiber, started.promise)
    started.fiber.addObserver(() => this.#fibers.delete(started.fiber))
  }

  run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
    if (this.#closed) return Promise.reject(new Error("MCP request capability is revoked"))
    const started = this.owner.run(interruptOnAbort(effect, this.signal))
    if (started === null) return Promise.reject(new Error("MCP server runtime is disposed"))
    this.track(started)
    return started.promise
  }

  close() {
    if (!this.#closed) {
      this.#closed = true
      this.#abortController.abort()
    }
    return {
      fibers: [...this.#fibers.keys()],
      promises: [...this.#fibers.values()],
    }
  }

  end() {
    if (!this.#closed) this.#closed = true
    this.onEnd(this)
  }
}

class RunCapability {
  readonly #requests = new Set<RequestLease>()
  readonly #drainWaiters = new Set<() => void>()
  readonly #revoked = deferredPromise<void>()
  #state: CapabilityState = "active"

  constructor(readonly context: DiffDashMcpRunContext) {}

  tryBeginRequest(owner: CallbackFiberOwner): RequestLease | null {
    if (this.#state !== "active") return null
    const lease = new RequestLease(owner, (ended) => this.#endRequest(ended))
    this.#requests.add(lease)
    return lease
  }

  beginRevoking(): boolean {
    if (this.#state !== "active") return false
    this.#state = "revoking"
    return true
  }

  waitForDrain(): Promise<void> {
    if (this.#requests.size === 0) return Promise.resolve()
    return new Promise<void>((resolve) => this.#drainWaiters.add(resolve))
  }

  waitForRevoked(): Promise<void> {
    return this.#revoked.promise
  }

  abortRequests() {
    const fibers = new Set<Fiber.RuntimeFiber<unknown, unknown>>()
    const promises = new Set<Promise<unknown>>()
    for (const request of this.#requests) {
      const running = request.close()
      for (const fiber of running.fibers) fibers.add(fiber)
      for (const promise of running.promises) promises.add(promise)
    }
    return { fibers: [...fibers], promises: [...promises] }
  }

  finishRevoked(): void {
    if (this.#state === "revoked") return
    this.#state = "revoked"
    this.#revoked.resolve(undefined)
  }

  #endRequest(lease: RequestLease): void {
    if (!this.#requests.delete(lease) || this.#requests.size !== 0) return
    for (const resolve of this.#drainWaiters) resolve()
    this.#drainWaiters.clear()
  }
}

/** A typed failure from the local DiffDash review context server. */
class DiffDashMcpServerError extends Schema.TaggedError<DiffDashMcpServerError>()(
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
  static get layer() {
    return makeDiffDashMcpServerLayer({})
  }

  /** Constructs a server layer with finite lifecycle overrides and optional test probes. */
  static layerWith(options: DiffDashMcpServerLayerOptions) {
    return makeDiffDashMcpServerLayer(options)
  }
}

type HttpServer = ReturnType<typeof createServer>

const makeDiffDashMcpServerLayer = (input: DiffDashMcpServerLayerOptions) =>
  Layer.scoped(
    DiffDashMcpServer,
    Effect.gen(function* () {
      const threads = yield* ReviewThreadStore
      const artifacts = yield* AgentRunArtifactStore
      const processes = yield* ProcessService
      const runtime = yield* Effect.runtime<never>()
      const options = resolveServerOptions(input)
      const callbackOwner = new CallbackFiberOwner(Runtime.runFork(runtime))
      const capabilities = new Map<string, RunCapability>()
      const lifecycle = { accepting: true }

      const server = yield* listen(
        createHttpHandler({
          artifacts,
          callbackOwner,
          capabilities,
          processes,
          lifecycle,
          options,
          threads,
        }),
      )
      const onServerError = (cause: Error) => {
        const started = callbackOwner.run(reportCleanupError(options, "http.server", cause))
        if (started !== null) void started.promise.catch(() => undefined)
      }
      server.on("error", onServerError)
      yield* Effect.addFinalizer(() =>
        shutdownHttpServer(server, onServerError, lifecycle, capabilities, callbackOwner, options),
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
            Effect.gen(function* () {
              if (!lifecycle.accepting) {
                return yield* DiffDashMcpServerError.make({
                  operation: "acquireRun",
                  cause: new Error("MCP server is disposing"),
                })
              }
              const token = freshBearerToken(capabilities)
              const capability = new RunCapability(context)
              capabilities.set(token, capability)
              return {
                access: { url, bearerToken: Redacted.make(token) },
                capability,
                token,
              }
            }),
            ({ capability, token }) => revokeCapability(token, capability, capabilities, options),
          ).pipe(Effect.map(({ access }) => access)),
      })
    }),
  )

const listen = (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Effect.Effect<HttpServer, DiffDashMcpServerError> =>
  Effect.async<HttpServer, DiffDashMcpServerError>((resume) => {
    const server = createServer(handler)
    const onError = (cause: Error) =>
      resume(Effect.fail(DiffDashMcpServerError.make({ operation: "listen", cause })))
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError)
      resume(Effect.succeed(server))
    })
    return Effect.sync(() => {
      server.off("error", onError)
      server.closeAllConnections()
      if (server.listening) server.close()
    })
  })

interface HttpHandlerServices {
  readonly artifacts: Context.Tag.Service<AgentRunArtifactStore>
  readonly callbackOwner: CallbackFiberOwner
  readonly capabilities: ReadonlyMap<string, RunCapability>
  readonly processes: ProcessRunner
  readonly lifecycle: { accepting: boolean }
  readonly options: ResolvedServerOptions
  readonly threads: Context.Tag.Service<ReviewThreadStore>
}

const createHttpHandler =
  (services: HttpHandlerServices) =>
  (request: IncomingMessage, response: ServerResponse): void => {
    const disconnect = observeDisconnect(request, response)
    if (request.method !== "POST" || request.url !== "/mcp") {
      disconnect.remove()
      writeJson(response, 405, rpcError(-32000, "Method not allowed"))
      return
    }
    const token = bearerToken(request.headers.authorization)
    const capability =
      services.lifecycle.accepting && token !== null ? services.capabilities.get(token) : undefined
    const lease = capability?.tryBeginRequest(services.callbackOwner) ?? null
    if (capability === undefined || lease === null) {
      disconnect.remove()
      writeJson(response, 401, rpcError(-32001, "Unauthorized"))
      return
    }

    const handle = handleHttpRequest(
      request,
      response,
      capability,
      lease,
      services.threads,
      services.artifacts,
      services.processes,
      services.options,
    ).pipe(
      Effect.catchAll((failure) =>
        Effect.sync(() =>
          writeJson(response, failure.status, rpcError(failure.code, failure.message)),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          disconnect.remove()
          lease.end()
        }),
      ),
    )
    const started = services.callbackOwner.run(interruptOnAbort(handle, disconnect.signal))
    if (started === null) {
      disconnect.remove()
      lease.end()
      writeJson(response, 503, rpcError(-32002, "Server is disposing"))
      return
    }
    lease.track(started)
    void started.promise.catch(() => {
      if (!disconnect.signal.aborted) writeJson(response, 500, rpcError(-32603, "Internal error"))
      return undefined
    })
  }

const handleHttpRequest = (
  request: IncomingMessage,
  response: ServerResponse,
  capability: RunCapability,
  lease: RequestLease,
  threads: Context.Tag.Service<ReviewThreadStore>,
  artifacts: Context.Tag.Service<AgentRunArtifactStore>,
  processes: ProcessRunner,
  options: ResolvedServerOptions,
): Effect.Effect<void, HttpRequestFailure> =>
  Effect.gen(function* () {
    yield* options.hooks.onHttpRequest ?? Effect.void
    const body = yield* readJsonBody(request)
    const mcp = createRunServer(capability.context, threads, artifacts, processes, (effect) =>
      lease.run(effect),
    )
    const transport = new StreamableHTTPServerTransport()
    const mcpTransport = adaptServerTransport(transport)
    yield* Effect.acquireUseRelease(
      Effect.succeed({ mcp, transport }),
      ({ mcp: runMcp, transport: runTransport }) =>
        Effect.gen(function* () {
          yield* options.hooks.beforeMcpConnect ?? Effect.void
          yield* Effect.tryPromise({
            try: () => runMcp.connect(mcpTransport),
            catch: (cause) => new HttpRequestFailure(500, -32603, "MCP setup failed", cause),
          })
          yield* Effect.tryPromise({
            try: () => runTransport.handleRequest(request, response, body),
            catch: (cause) => new HttpRequestFailure(500, -32603, "MCP request failed", cause),
          })
        }),
      ({ mcp: runMcp, transport: runTransport }) =>
        closeMcpResources(runMcp, runTransport, options),
    )
  })

const createRunServer = (
  context: DiffDashMcpRunContext,
  threads: Context.Tag.Service<ReviewThreadStore>,
  artifacts: Context.Tag.Service<AgentRunArtifactStore>,
  processes: ProcessRunner,
  runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
) => {
  const server = new McpServer({ name: "diffdash-review-context", version: "1" })
  const register = <InputSchema extends z.AnyZodObject>(
    name: string,
    description: string,
    inputSchema: InputSchema,
    handler: (input: z.infer<InputSchema>) => Effect.Effect<unknown, unknown>,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema, annotations: READ_ONLY_TOOL_ANNOTATIONS },
      // SAFETY: `inputSchema` validates callback input; the SDK's Zod compatibility
      // overload loses that generic relationship under exactOptionalPropertyTypes.
      ((input: z.infer<InputSchema>) =>
        runEffect(
          handler(input).pipe(
            Effect.map((result) => boundedToolResult(result, context.maxToolOutputBytes)),
          ),
        )) as never,
    )

  register(
    DiffDashReviewMcpTool.getReviewContext,
    "Get immutable metadata for this review run.",
    z.object({}),
    () => Effect.sync(() => reviewContext(context.snapshot)),
  )
  register(
    DiffDashReviewMcpTool.getChangedFiles,
    "Page through every changed file and stable hunk ID in deterministic path order.",
    z.object({
      offset: z.number().int().nonnegative().default(0),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_CHANGED_FILES_PAGE_SIZE)
        .default(DEFAULT_CHANGED_FILES_PAGE_SIZE),
    }),
    ({ offset, limit }) =>
      Effect.sync(() => {
        const allFiles = orderedReviewFiles(context.snapshot)
        const page = paginateByOffset(allFiles, offset, limit)
        const files = page.items.map((file) => ({
          fileId: file.fileId,
          path: file.path,
          oldPath: file.oldPath,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          hunkIds: file.hunks.map((hunk) => hunk.id),
        }))
        return available({
          files,
          offset: page.offset,
          limit: page.limit,
          totalFiles: page.total,
          hasMore: page.hasMore,
          nextOffset: page.nextOffset,
        })
      }),
  )
  register(
    DiffDashReviewMcpTool.searchReviewDiff,
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
      Effect.sync(() =>
        available(searchReviewDiff(context.snapshot, query, path, caseSensitive, maxResults)),
      ),
  )
  register(
    DiffDashReviewMcpTool.getDiffHunk,
    "Get one bounded page of exact patch lines for a stable changed-file hunk.",
    z.object({
      fileId: z.string().min(1),
      hunkId: z.string().min(1),
      startLine: z.number().int().min(0).default(0),
      lineCount: z.number().int().min(1).max(MAX_HUNK_PAGE_LINES).default(DEFAULT_HUNK_PAGE_LINES),
    }),
    ({ fileId, hunkId, startLine, lineCount }) =>
      Effect.sync(() => {
        const file = context.snapshot.parsedDiff.files.find((entry) => entry.fileId === fileId)
        const hunk = file?.hunks.find((entry) => entry.id === hunkId)
        if (file === undefined || hunk === undefined) {
          return unavailable("Diff hunk is unavailable for this review run")
        }

        const page = paginateByOffset(hunk.lines, startLine, lineCount)
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
  )
  register(
    DiffDashReviewMcpTool.getDiffFile,
    "Get exact patch text for one stable changed-file ID.",
    z.object({ fileId: z.string().min(1) }),
    ({ fileId }) =>
      Effect.sync(() => {
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
      }),
  )
  register(
    DiffDashReviewMcpTool.searchRepository,
    "Fixed-string search of the isolated worktree at the immutable pull-request head revision.",
    z.object({
      query: z.string().min(1).max(1024),
      path: z.string().min(1).optional(),
      caseSensitive: z.boolean().default(false),
      maxResults: z.number().int().min(1).max(100).default(25),
    }),
    ({ query, path, caseSensitive, maxResults }) =>
      searchLinkedRepository(context, processes, query, path, caseSensitive, maxResults),
  )
  register(
    DiffDashReviewMcpTool.readRepositoryFile,
    "Read one file from the isolated worktree at the immutable pull-request head revision.",
    z.object({ path: z.string().min(1).max(4096) }),
    ({ path }) => readLinkedRepositoryFile(context, processes, path),
  )
  register(
    DiffDashReviewMcpTool.getThreadContext,
    "Get this run's local thread and messages.",
    z.object({}),
    () => threads.get(context.threadId).pipe(Effect.map(available)),
  )
  register(
    DiffDashReviewMcpTool.getOlderThreadMessages,
    "Get older messages for this run's thread using sequence pagination.",
    z.object({
      beforeSequence: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    ({ beforeSequence, limit }) =>
      threads.get(context.threadId).pipe(
        Effect.map((details) => {
          const eligible = details.messages.filter(
            (message) => beforeSequence === undefined || message.sequence < beforeSequence,
          )
          const page = eligible.slice(Math.max(0, eligible.length - limit))
          return available({
            messages: page,
            hasMore: eligible.length > page.length,
            nextBeforeSequence: page[0]?.sequence ?? null,
          })
        }),
      ),
  )
  register(
    DiffDashReviewMcpTool.getPriorArtifact,
    "Get one normalized prior artifact owned by this run's thread.",
    z.object({ artifactId: z.string().min(1) }),
    ({ artifactId }) =>
      artifacts.get(ReviewAgentArtifactId.make(artifactId)).pipe(
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
      ),
  )
  register(
    DiffDashReviewMcpTool.getWalkthroughContext,
    "Get the cached walkthrough for this review run.",
    z.object({}),
    () =>
      Effect.sync(() =>
        context.walkthrough === null
          ? unavailable("No walkthrough is available for this review revision")
          : available(context.walkthrough),
      ),
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

  for (const file of orderedReviewFiles(snapshot)) {
    if (path !== undefined && file.path !== path && file.oldPath !== path) continue
    for (const hunk of orderedReviewHunks(file.hunks)) {
      for (const line of projectDiffHunkLines(hunk)) {
        const haystack = caseSensitive ? line.patchLine : line.patchLine.toLowerCase()
        if (!haystack.includes(needle)) continue
        total += 1
        if (matches.length < maxResults) {
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

  return { matches, total, truncated: total > matches.length }
}

const searchLinkedRepository = (
  context: DiffDashMcpRunContext,
  processes: ProcessRunner,
  query: string,
  path: string | undefined,
  caseSensitive: boolean,
  maxResults: number,
): Effect.Effect<Envelope> => {
  if (!(context.snapshot instanceof HostedReviewSnapshot)) {
    return Effect.succeed(unavailable("Exact repository search is available for hosted reviews"))
  }
  if (context.localPath === null) {
    return Effect.succeed(
      unavailable("An isolated repository workspace is unavailable for this review run"),
    )
  }
  const localPath = context.localPath
  const safePath = path === undefined ? undefined : normalizeRepositoryPath(path)
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
      .pipe(
        Effect.map(Option.some),
        Effect.catchTag("ProcessExitError", (cause) =>
          cause.exitCode === 1 ? Effect.succeed(Option.none()) : Effect.fail(cause),
        ),
      )
    const matches = Option.isSome(result)
      ? parseGitGrepMatches(result.value.stdout, revision, maxResults)
      : []
    return available({
      revision,
      source: "isolated-worktree",
      matches,
      truncated: Option.isSome(result) && matches.length === maxResults,
    })
  }).pipe(
    Effect.catchAll(() =>
      Effect.succeed(
        unavailable(
          "The isolated worktree does not contain the immutable review head or could not be searched",
        ),
      ),
    ),
  )
}

const readLinkedRepositoryFile = (
  context: DiffDashMcpRunContext,
  processes: ProcessRunner,
  path: string,
): Effect.Effect<Envelope> => {
  if (!(context.snapshot instanceof HostedReviewSnapshot)) {
    return Effect.succeed(unavailable("Exact repository reads are available for hosted reviews"))
  }
  if (context.localPath === null) {
    return Effect.succeed(
      unavailable("An isolated repository workspace is unavailable for this review run"),
    )
  }
  const safePath = normalizeRepositoryPath(path)
  if (safePath === null) {
    return Effect.succeed(unavailable("Repository file path must stay inside the checkout"))
  }
  const revision = context.snapshot.headRevision

  return processes
    .run(
      processRequest("git", ["-C", context.localPath, "show", `${revision}:${safePath}`], {
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
      Effect.catchAll(() =>
        Effect.succeed(unavailable("Repository file is unavailable at the immutable review head")),
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

type Envelope =
  | { readonly status: "available"; readonly data: unknown }
  | { readonly status: "unavailable"; readonly reason: string }

const available = (data: unknown): Envelope => ({ status: "available", data })
const unavailable = (reason: string): Envelope => ({ status: "unavailable", reason })

const boundedToolResult = (value: unknown, maxBytes = DEFAULT_TOOL_OUTPUT_BYTES) => {
  const budget = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0
  const json = JSON.stringify(value)
  if (utf8ByteLength(json) <= budget) {
    return { content: [{ type: "text" as const, text: json }] }
  }
  const originalBytes = utf8ByteLength(json)
  let low = 0
  let high = budget
  let text = JSON.stringify({
    status: "truncated",
    originalBytes,
    limitBytes: budget,
    content: "",
  })
  if (utf8ByteLength(text) > budget) {
    return {
      content: [{ type: "text" as const, text: truncateUtf8(text, budget) }],
    }
  }
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = JSON.stringify({
      status: "truncated",
      originalBytes,
      limitBytes: budget,
      content: truncateUtf8(json, middle),
    })
    if (utf8ByteLength(candidate) <= budget) {
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

const reviewContext = (snapshot: ReviewSnapshot) => {
  const hosted = snapshot instanceof HostedReviewSnapshot
  return {
    status: "available" as const,
    data: {
      kind: hosted ? "hosted" : "local",
      reviewKey: snapshot.reviewKey,
      baseRevision: snapshot.baseRevision,
      headRevision: snapshot.headRevision,
      title: hosted ? snapshot.detail.summary.title : snapshot.detail.title,
    },
  }
}

const bearerToken = (authorization: string | undefined) => {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) return null
  const token = authorization.slice("Bearer ".length)
  return token.length === 64 ? token : null
}

class HttpRequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
  }
}

const readJsonBody = (request: IncomingMessage): Effect.Effect<unknown, HttpRequestFailure> => {
  const contentLength = Number(request.headers["content-length"] ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    request.resume()
    return Effect.fail(new HttpRequestFailure(413, -32003, "MCP request body exceeds size limit"))
  }
  return Effect.async<unknown, HttpRequestFailure>((resume) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const cleanup = () => {
      request.off("data", onData)
      request.off("end", onEnd)
      request.off("aborted", onAborted)
      request.off("close", onClose)
      request.off("error", onError)
    }
    const complete = (effect: Effect.Effect<unknown, HttpRequestFailure>) => {
      if (settled) return
      settled = true
      cleanup()
      resume(effect)
    }
    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      size += bytes.length
      if (size > MAX_REQUEST_BYTES) {
        complete(
          Effect.fail(new HttpRequestFailure(413, -32003, "MCP request body exceeds size limit")),
        )
        request.resume()
        return
      }
      chunks.push(bytes)
    }
    const onEnd = () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        complete(Effect.succeed(body))
      } catch (cause) {
        complete(Effect.fail(new HttpRequestFailure(400, -32700, "Invalid JSON body", cause)))
      }
    }
    const onAborted = () =>
      complete(Effect.fail(new HttpRequestFailure(400, -32004, "MCP request was aborted")))
    const onClose = () => {
      if (!request.complete) onAborted()
    }
    const onError = (cause: Error) =>
      complete(Effect.fail(new HttpRequestFailure(400, -32004, "MCP request body failed", cause)))

    request.on("data", onData)
    request.once("end", onEnd)
    request.once("aborted", onAborted)
    request.once("close", onClose)
    request.once("error", onError)
    if (request.aborted || (request.destroyed && !request.complete)) onAborted()
    return Effect.sync(cleanup)
  })
}

const observeDisconnect = (request: IncomingMessage, response: ServerResponse) => {
  const controller = new AbortController()
  let removed = false
  const abort = () => controller.abort()
  const onRequestClose = () => {
    if (!request.complete) abort()
  }
  const onResponseClose = () => {
    if (!response.writableFinished) abort()
  }
  request.once("aborted", abort)
  request.once("close", onRequestClose)
  request.once("error", abort)
  response.once("close", onResponseClose)
  response.once("error", abort)
  if (request.aborted || (request.destroyed && !request.complete)) abort()

  return {
    signal: controller.signal,
    remove: () => {
      if (removed) return
      removed = true
      request.off("aborted", abort)
      request.off("close", onRequestClose)
      request.off("error", abort)
      response.off("close", onResponseClose)
      response.off("error", abort)
    },
  }
}

const interruptOnAbort = <A, E>(effect: Effect.Effect<A, E>, signal: AbortSignal) =>
  Effect.raceFirst(
    effect,
    Effect.async<never>((resume) => {
      const interrupt = () => resume(Effect.interrupt)
      if (signal.aborted) {
        interrupt()
        return
      }
      signal.addEventListener("abort", interrupt, { once: true })
      return Effect.sync(() => signal.removeEventListener("abort", interrupt))
    }),
  )

const adaptServerTransport = (transport: StreamableHTTPServerTransport): Transport => {
  let onclose = noopTransportClose
  let onerror = noopTransportError
  let onmessage = noopTransportMessage
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports expose callback properties, not EventTarget events.
  transport.onclose = () => onclose()
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports expose callback properties, not EventTarget events.
  transport.onerror = (error) => onerror(error)
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports expose callback properties, not EventTarget events.
  transport.onmessage = (message, extra) => onmessage(message, extra)

  return {
    start: () => transport.start(),
    close: () => transport.close(),
    send: (message, options) => {
      const relatedRequestId = options?.relatedRequestId
      return transport.send(
        message,
        relatedRequestId === undefined ? undefined : { relatedRequestId },
      )
    },
    get onclose() {
      return onclose
    },
    set onclose(handler) {
      onclose = handler
    },
    get onerror() {
      return onerror
    },
    set onerror(handler) {
      onerror = handler
    },
    get onmessage() {
      return onmessage
    },
    set onmessage(handler) {
      onmessage = handler
    },
  }
}

const closeMcpResources = (
  mcp: McpServer,
  transport: StreamableHTTPServerTransport,
  options: ResolvedServerOptions,
) =>
  Effect.gen(function* () {
    yield* closeMcpResource("transport", () => transport.close(), options)
    yield* closeMcpResource("server", () => mcp.close(), options)
  })

const closeMcpResource = (
  resource: "transport" | "server",
  close: () => Promise<void>,
  options: ResolvedServerOptions,
) =>
  Effect.gen(function* () {
    const hookExit = yield* Effect.exit(options.hooks.beforeMcpClose?.(resource) ?? Effect.void)
    if (Exit.isFailure(hookExit)) {
      yield* reportCleanupError(
        options,
        `mcp.${resource}.beforeClose`,
        Cause.squash(hookExit.cause),
      )
    }
    const result = yield* Effect.promise(() =>
      settleWithin(Promise.resolve().then(close), options.mcpCloseMs),
    )
    if (result.status === "failed") {
      yield* reportCleanupError(options, `mcp.${resource}.close`, result.cause)
    } else if (result.status === "timed-out") {
      yield* reportCleanupError(
        options,
        `mcp.${resource}.close`,
        new Error(`MCP ${resource} close exceeded its deadline`),
      )
    }
  })

const revokeCapability = (
  token: string,
  capability: RunCapability,
  capabilities: Map<string, RunCapability>,
  options: ResolvedServerOptions,
) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const started = yield* Effect.sync(() => {
        capabilities.delete(token)
        return capability.beginRevoking()
      })
      if (!started) {
        const result = yield* Effect.promise(() =>
          settleWithin(
            capability.waitForRevoked(),
            options.capabilityGraceMs + options.requestFinalizerMs,
          ),
        )
        if (result.status === "timed-out") {
          yield* reportCleanupError(
            options,
            "capability.awaitRevoked",
            new Error("Capability revocation exceeded its deadline"),
          )
        }
        return
      }
      yield* runLifecycleProbe(options.hooks.onCapabilityRevoking)

      yield* Effect.gen(function* () {
        const grace = yield* Effect.promise(() =>
          settleWithin(capability.waitForDrain(), options.capabilityGraceMs),
        )
        if (grace.status === "completed") return

        const running = capability.abortRequests()
        yield* Effect.forEach(running.fibers, Fiber.interruptFork, { discard: true })
        const finalized = yield* Effect.promise(() =>
          settleWithin(Promise.allSettled(running.promises), options.requestFinalizerMs),
        )
        if (finalized.status === "timed-out") {
          yield* reportCleanupError(
            options,
            "capability.requestFinalizers",
            new Error("MCP request finalizers exceeded their deadline"),
          )
        }
      }).pipe(Effect.ensuring(Effect.sync(() => capability.finishRevoked())))
    }),
  )

const shutdownHttpServer = (
  server: HttpServer,
  onServerError: (cause: Error) => void,
  lifecycle: { accepting: boolean },
  capabilities: Map<string, RunCapability>,
  callbackOwner: CallbackFiberOwner,
  options: ResolvedServerOptions,
) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const { entries: active, revokingCount } = yield* Effect.sync(() => {
        lifecycle.accepting = false
        server.off("error", onServerError)
        const entries = [...capabilities.entries()]
        capabilities.clear()
        let begunRevocations = 0
        for (const [, capability] of entries) {
          if (capability.beginRevoking()) begunRevocations += 1
        }
        return { entries, revokingCount: begunRevocations }
      })
      yield* Effect.forEach(
        Array.from({ length: revokingCount }),
        () => runLifecycleProbe(options.hooks.onCapabilityRevoking),
        { discard: true },
      )
      const closing = beginHttpClose(server, options.httpCloseMs)
      server.closeIdleConnections()

      yield* Effect.forEach(
        active,
        ([token, capability]) => revokeStartedCapability(token, capability, options),
        { concurrency: "unbounded", discard: true },
      )

      const fibers = callbackOwner.beginClose()
      yield* Effect.forEach(fibers, Fiber.interruptFork, { discard: true })
      const callbacks = yield* Effect.promise(() =>
        settleWithin(Promise.allSettled(fibers.map(fiberPromise)), options.requestFinalizerMs),
      )
      if (callbacks.status === "timed-out") {
        yield* reportCleanupError(
          options,
          "runtime.callbackFinalizers",
          new Error("MCP callback finalizers exceeded their deadline"),
        )
      }

      const closed = yield* Effect.promise(() =>
        settleWithin(closing.promise, options.httpForceCloseMs),
      )
      closing.cancelForceClose()
      if (closed.status === "failed") {
        yield* reportCleanupError(options, "http.close", closed.cause)
      } else if (closed.status === "timed-out") {
        server.closeAllConnections()
        yield* reportCleanupError(
          options,
          "http.close",
          new Error("HTTP server close exceeded its force-close deadline"),
        )
      }
    }),
  )

const revokeStartedCapability = (
  _token: string,
  capability: RunCapability,
  options: ResolvedServerOptions,
) =>
  Effect.gen(function* () {
    const grace = yield* Effect.promise(() =>
      settleWithin(capability.waitForDrain(), options.capabilityGraceMs),
    )
    if (grace.status !== "completed") {
      const running = capability.abortRequests()
      yield* Effect.forEach(running.fibers, Fiber.interruptFork, { discard: true })
      const finalized = yield* Effect.promise(() =>
        settleWithin(Promise.allSettled(running.promises), options.requestFinalizerMs),
      )
      if (finalized.status === "timed-out") {
        yield* reportCleanupError(
          options,
          "capability.requestFinalizers",
          new Error("MCP request finalizers exceeded their deadline"),
        )
      }
    }
    capability.finishRevoked()
  })

const beginHttpClose = (server: HttpServer, forceAfterMs: number) => {
  let forceClose: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => server.closeAllConnections(),
    forceAfterMs,
  )
  const promise = new Promise<void>((resolve, reject) => {
    server.close((cause) => {
      if (forceClose !== undefined) clearTimeout(forceClose)
      forceClose = undefined
      if (cause === undefined) resolve()
      else reject(cause)
    })
  })
  void promise.catch(() => undefined)
  return {
    promise,
    cancelForceClose: () => {
      if (forceClose !== undefined) clearTimeout(forceClose)
      forceClose = undefined
    },
  }
}

const reportCleanupError = (options: ResolvedServerOptions, operation: string, _cause: unknown) =>
  Effect.sync(() => {
    options.hooks.onCleanupError?.(operation)
  }).pipe(
    Effect.catchAllCause(() => Effect.void),
    Effect.zipRight(Effect.logError(`DiffDash MCP cleanup failed: ${operation}`)),
  )

const runLifecycleProbe = (probe: (() => void) | undefined) =>
  Effect.sync(() => probe?.()).pipe(Effect.catchAllCause(() => Effect.void))

const freshBearerToken = (capabilities: ReadonlyMap<string, RunCapability>) => {
  let token = randomBytes(32).toString("hex")
  while (capabilities.has(token)) token = randomBytes(32).toString("hex")
  return token
}

const resolveServerOptions = (options: DiffDashMcpServerLayerOptions): ResolvedServerOptions => ({
  capabilityGraceMs: finiteMilliseconds(options.capabilityGraceMs, DEFAULT_CAPABILITY_GRACE_MS),
  requestFinalizerMs: finiteMilliseconds(options.requestFinalizerMs, DEFAULT_REQUEST_FINALIZER_MS),
  mcpCloseMs: finiteMilliseconds(options.mcpCloseMs, DEFAULT_MCP_CLOSE_MS),
  httpCloseMs: finiteMilliseconds(options.httpCloseMs, DEFAULT_HTTP_CLOSE_MS),
  httpForceCloseMs: finiteMilliseconds(options.httpForceCloseMs, DEFAULT_HTTP_FORCE_CLOSE_MS),
  hooks: options.hooks ?? {},
})

const finiteMilliseconds = (value: number | undefined, fallback: number) =>
  value === undefined || !Number.isSafeInteger(value) || value < 0 ? fallback : value

const fiberPromise = <A, E>(fiber: Fiber.RuntimeFiber<A, E>) =>
  new Promise<A>((resolve, reject) =>
    fiber.addObserver((exit) => {
      if (Exit.isSuccess(exit)) resolve(exit.value)
      else reject(Cause.squash(exit.cause))
    }),
  )

type SettledWithin =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly cause: unknown }
  | { readonly status: "timed-out" }

const settleWithin = (
  promise: PromiseLike<unknown>,
  milliseconds: number,
): Promise<SettledWithin> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<SettledWithin>((resolve) => {
    timeout = setTimeout(() => resolve({ status: "timed-out" }), milliseconds)
  })
  const operation = Promise.resolve(promise).then<SettledWithin, SettledWithin>(
    () => ({ status: "completed" }),
    (cause: unknown) => ({ status: "failed", cause }),
  )
  return Promise.race([operation, deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout)
  })
}

const deferredPromise = <A>() => {
  let complete: ((value: A | PromiseLike<A>) => void) | undefined
  const promise = new Promise<A>((resolve) => {
    complete = resolve
  })
  return {
    promise,
    resolve: (value: A | PromiseLike<A>) => complete?.(value),
  }
}

const rpcError = (code: number, message: string) => ({
  jsonrpc: "2.0",
  error: { code, message },
  id: null,
})

const writeJson = (response: ServerResponse, status: number, body: unknown) => {
  if (response.destroyed || response.writableEnded) return
  if (response.headersSent) {
    response.end()
    return
  }
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}
