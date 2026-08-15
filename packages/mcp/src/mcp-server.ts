import { Buffer } from "node:buffer"
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
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
  Predicate,
  Redacted,
  Schema,
} from "effect"
import { z } from "zod"
import {
  DiffDashReviewMcpTool,
  GetDiffFileRequest,
  GetDiffHunkRequest,
  GetOlderThreadMessagesRequest,
  GetPriorArtifactRequest,
  SearchRepositoryRequest,
  SearchReviewDiffRequest,
  type DiffDashMcpToolResponse,
} from "@diffdash/protocol/mcp"
import { truncateUtf8, utf8ByteLength } from "@diffdash/protocol/payload-utf8"
import {
  DiffDashMcpServerError,
  type DiffDashMcpRunAccess,
  type DiffDashMcpRunContext,
  type DiffDashMcpServerLifecycleHooks,
  type DiffDashMcpServerLayerOptions,
  type DiffDashMcpToolError,
} from "./port"

export { DiffDashMcpServerError } from "./port"
export { DiffDashMcpToolError } from "./port"
export type {
  DiffDashMcpRunAccess,
  DiffDashMcpRunContext,
  DiffDashMcpServerLayerOptions,
  DiffDashMcpToolHandlers,
} from "./port"

const MAX_REQUEST_BYTES = 1024 * 1024
const noop = () => {}
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

interface ResolvedServerOptions {
  readonly capabilityGraceMs: number
  readonly requestFinalizerMs: number
  readonly mcpCloseMs: number
  readonly httpCloseMs: number
  readonly httpForceCloseMs: number
  readonly hooks: DiffDashMcpServerLifecycleHooks
}

interface CallbackRunFork {
  <A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E>
}

interface StartedCallback<A, E> {
  readonly fiber: Fiber.Fiber<A, E>
  readonly promise: Promise<A>
}

class CallbackFiberOwner {
  readonly #fibers = new Set<Fiber.Fiber<unknown, unknown>>()
  #accepting = true

  constructor(private readonly runFork: CallbackRunFork) {}

  start<A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E> {
    if (!this.#accepting) return Effect.runFork(Effect.interrupt)
    const fiber = this.runFork(effect)
    this.#fibers.add(fiber)
    fiber.addObserver(() => this.#fibers.delete(fiber))
    return fiber
  }

  interruptAll(): readonly Fiber.Fiber<unknown, unknown>[] {
    this.#accepting = false
    const fibers = [...this.#fibers]
    this.#fibers.clear()
    for (const fiber of fibers) fiber.interruptUnsafe()
    return fibers
  }
}

const startCallback = <A, E>(runFork: CallbackRunFork, effect: Effect.Effect<A, E>) => {
  const fiber = runFork(effect)
  return { fiber, promise: Effect.runPromise(Fiber.join(fiber)) } satisfies StartedCallback<A, E>
}

type CapabilityState = "active" | "revoking" | "revoked"

class RequestLease {
  readonly #abortController = new AbortController()
  readonly #fibers = new Map<Fiber.Fiber<unknown, unknown>, Promise<unknown>>()
  #closed = false

  constructor(
    readonly runFork: CallbackRunFork,
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
    const started = startCallback(this.runFork, interruptOnAbort(effect, this.signal))
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
  readonly #revoked = deferredSignal()
  #state: CapabilityState = "active"

  constructor(readonly context: DiffDashMcpRunContext) {}

  tryBeginRequest(runFork: CallbackRunFork): RequestLease | null {
    if (this.#state !== "active") return null
    const lease = new RequestLease(runFork, (ended) => this.#endRequest(ended))
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
    const fibers = new Set<Fiber.Fiber<unknown, unknown>>()
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
    this.#revoked.resolve()
  }

  #endRequest(lease: RequestLease): void {
    if (!this.#requests.delete(lease) || this.#requests.size !== 0) return
    for (const resolve of this.#drainWaiters) resolve()
    this.#drainWaiters.clear()
  }
}

/** Loopback-only MCP server with scoped, per-run bearer capabilities. */
export class DiffDashMcpServer extends Context.Service<
  DiffDashMcpServer,
  {
    readonly acquireRun: (
      context: DiffDashMcpRunContext,
    ) => Effect.Effect<DiffDashMcpRunAccess, DiffDashMcpServerError, Scope.Scope>
  }
>()("@diffdash/DiffDashMcpServer") {
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
  Layer.effect(
    DiffDashMcpServer,
    Effect.gen(function* () {
      const options = resolveServerOptions(input)
      const runtimeContext = yield* Effect.context()
      const callbackOwner = new CallbackFiberOwner(Effect.runForkWith(runtimeContext))
      const runCallback: CallbackRunFork = (effect) => callbackOwner.start(effect)
      const capabilities = new Map<string, RunCapability>()
      const lifecycle = { accepting: true }

      const server = yield* listen(
        createHttpHandler({
          runCallback,
          capabilities,
          lifecycle,
          options,
        }),
      )
      const onServerError = (cause: Error) => {
        const started = startCallback(
          runCallback,
          reportCleanupError(options, "http.server", cause),
        )
        void started.promise.catch(() => undefined)
      }
      server.on("error", onServerError)
      yield* Effect.addFinalizer(() =>
        shutdownHttpServer(server, onServerError, lifecycle, capabilities, callbackOwner, options),
      )

      const address = server.address()
      if (address === null || Predicate.isString(address)) {
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
  Effect.callback<HttpServer, DiffDashMcpServerError>((resume) => {
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
  readonly runCallback: CallbackRunFork
  readonly capabilities: ReadonlyMap<string, RunCapability>
  readonly lifecycle: { accepting: boolean }
  readonly options: ResolvedServerOptions
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
    const lease = capability?.tryBeginRequest(services.runCallback) ?? null
    if (capability === undefined || lease === null) {
      disconnect.remove()
      writeJson(response, 401, rpcError(-32001, "Unauthorized"))
      return
    }

    const handle = handleHttpRequest(request, response, capability, lease, services.options).pipe(
      Effect.catch((failure) =>
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
    const started = startCallback(services.runCallback, interruptOnAbort(handle, disconnect.signal))
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
  options: ResolvedServerOptions,
): Effect.Effect<void, HttpRequestFailure> =>
  Effect.gen(function* () {
    yield* options.hooks.onHttpRequest ?? Effect.void
    const body = yield* readJsonBody(request)
    const mcp = createRunServer(capability.context, (effect) => lease.run(effect))
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
  runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
) => {
  const server = new McpServer({ name: "diffdash-review-context", version: "1" })
  const register = <InputSchema extends z.AnyZodObject>(
    name: string,
    description: string,
    inputSchema: InputSchema,
    handler: (
      input: z.infer<InputSchema>,
    ) => Effect.Effect<DiffDashMcpToolResponse, DiffDashMcpToolError>,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema: inputSchema.shape, annotations: READ_ONLY_TOOL_ANNOTATIONS },
      (input: z.infer<InputSchema>) =>
        runEffect(
          handler(input).pipe(
            Effect.map((result) => boundedToolResult(result, context.maxToolOutputBytes)),
          ),
        ),
    )

  register(
    DiffDashReviewMcpTool.getReviewContext,
    "Get immutable metadata for this review run.",
    z.object({}),
    () => context.handlers.execute({ tool: DiffDashReviewMcpTool.getReviewContext }),
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
    (input) => context.handlers.execute({ tool: DiffDashReviewMcpTool.getChangedFiles, ...input }),
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
    (input) =>
      context.handlers.execute(
        Schema.decodeUnknownSync(SearchReviewDiffRequest)({
          tool: DiffDashReviewMcpTool.searchReviewDiff,
          ...input,
        }),
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
    (input) =>
      context.handlers.execute(
        Schema.decodeUnknownSync(GetDiffHunkRequest)({
          tool: DiffDashReviewMcpTool.getDiffHunk,
          ...input,
        }),
      ),
  )
  register(
    DiffDashReviewMcpTool.getDiffFile,
    "Get exact patch text for one stable changed-file ID.",
    z.object({ fileId: z.string().min(1) }),
    (input) =>
      context.handlers.execute(
        Schema.decodeUnknownSync(GetDiffFileRequest)({
          tool: DiffDashReviewMcpTool.getDiffFile,
          ...input,
        }),
      ),
  )
  register(
    DiffDashReviewMcpTool.searchRepository,
    "Fixed-string search of the isolated worktree at the immutable review head revision.",
    z.object({
      query: z.string().min(1).max(1024),
      path: z.string().min(1).optional(),
      caseSensitive: z.boolean().default(false),
      maxResults: z.number().int().min(1).max(100).default(25),
    }),
    (input) =>
      context.handlers.execute(
        Schema.decodeUnknownSync(SearchRepositoryRequest)({
          tool: DiffDashReviewMcpTool.searchRepository,
          ...input,
        }),
      ),
  )
  register(
    DiffDashReviewMcpTool.readRepositoryFile,
    "Read one file from the isolated worktree at the immutable review head revision.",
    z.object({ path: z.string().min(1).max(4096) }),
    (input) =>
      context.handlers.execute({ tool: DiffDashReviewMcpTool.readRepositoryFile, ...input }),
  )
  register(
    DiffDashReviewMcpTool.getThreadContext,
    "Get this run's local thread and messages.",
    z.object({}),
    () => context.handlers.execute({ tool: DiffDashReviewMcpTool.getThreadContext }),
  )
  register(
    DiffDashReviewMcpTool.getOlderThreadMessages,
    "Get older messages for this run's thread using sequence pagination.",
    z.object({
      beforeSequence: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    (input) =>
      context.handlers.execute(
        Schema.decodeUnknownSync(GetOlderThreadMessagesRequest)({
          tool: DiffDashReviewMcpTool.getOlderThreadMessages,
          ...input,
        }),
      ),
  )
  register(
    DiffDashReviewMcpTool.getPriorArtifact,
    "Get one normalized prior artifact owned by this run's thread.",
    z.object({ artifactId: z.string().min(1) }),
    (input) =>
      context.handlers.execute(
        Schema.decodeUnknownSync(GetPriorArtifactRequest)({
          tool: DiffDashReviewMcpTool.getPriorArtifact,
          ...input,
        }),
      ),
  )
  register(
    DiffDashReviewMcpTool.getWalkthroughContext,
    "Get the cached walkthrough for this review run.",
    z.object({}),
    () => context.handlers.execute({ tool: DiffDashReviewMcpTool.getWalkthroughContext }),
  )

  return server
}

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
  return Effect.callback<unknown, HttpRequestFailure>((resume) => {
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
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
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
    Effect.callback<never>((resume) => {
      const interrupt = () => resume(Effect.interrupt)
      if (signal.aborted) {
        interrupt()
        return Effect.void
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
        yield* Effect.sync(() => {
          for (const fiber of running.fibers) fiber.interruptUnsafe()
        })
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

      const fibers = callbackOwner.interruptAll()
      const callbacks = yield* Effect.promise(() =>
        settleWithin(
          Promise.allSettled(fibers.map((fiber) => Effect.runPromise(Fiber.join(fiber)))),
          options.requestFinalizerMs,
        ),
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
      yield* Effect.sync(() => {
        for (const fiber of running.fibers) fiber.interruptUnsafe()
      })
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
  let forceClose = Option.some(setTimeout(() => server.closeAllConnections(), forceAfterMs))
  const cancelForceClose = () => {
    if (Option.isSome(forceClose)) clearTimeout(forceClose.value)
    forceClose = Option.none()
  }
  const promise = new Promise<void>((resolve, reject) => {
    server.close((cause) => {
      cancelForceClose()
      if (cause === undefined) resolve()
      else reject(cause)
    })
  })
  void promise.catch(() => undefined)
  return {
    promise,
    cancelForceClose,
  }
}

const reportCleanupError = (options: ResolvedServerOptions, operation: string, _cause: unknown) =>
  Effect.sync(() => {
    options.hooks.onCleanupError?.(operation)
  }).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.andThen(Effect.logError(`DiffDash MCP cleanup failed: ${operation}`)),
  )

const runLifecycleProbe = (probe: (() => void) | undefined) =>
  Effect.sync(() => probe?.()).pipe(Effect.catchCause(() => Effect.void))

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

type SettledWithin =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly cause: unknown }
  | { readonly status: "timed-out" }

const settleWithin = (
  promise: PromiseLike<unknown>,
  milliseconds: number,
): Promise<SettledWithin> => {
  const operation = Promise.resolve(promise).then<SettledWithin, SettledWithin>(
    () => ({ status: "completed" }),
    (cause: unknown) => ({ status: "failed", cause }),
  )
  let cancelDeadline = noop
  const deadline = new Promise<SettledWithin>((resolve) => {
    const timeout = setTimeout(() => resolve({ status: "timed-out" }), milliseconds)
    cancelDeadline = () => clearTimeout(timeout)
  })
  return Promise.race([operation, deadline]).finally(() => cancelDeadline())
}

const deferredSignal = () => {
  let complete = noop
  const promise = new Promise<void>((resolve) => {
    complete = () => resolve()
  })
  return {
    promise,
    resolve: () => complete(),
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
