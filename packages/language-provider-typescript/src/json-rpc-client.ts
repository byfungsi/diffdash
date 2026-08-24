import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"

import { Effect, HashMap, Option, Ref, Result, Schema } from "effect"

const MAX_HEADER_BYTES = 8 * 1024
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
const MAX_PENDING_REQUESTS = 32

const JsonRpcError = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
})

const JsonRpcResponse = Schema.Union([
  Schema.Struct({
    _tag: Schema.tagDefaultOmit("success"),
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Number,
    result: Schema.Json,
  }),
  Schema.Struct({
    _tag: Schema.tagDefaultOmit("failure"),
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Number,
    error: JsonRpcError,
  }),
]).pipe(Schema.toTaggedUnion("_tag"))

const JsonRpcServerRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.Number, Schema.String]),
  method: Schema.String,
  params: Schema.OptionFromOptionalKey(Schema.Json),
})

/** Expected transport failure produced by the adapter-local JSON-RPC client. */
export class JsonRpcClientError extends Schema.TaggedError<JsonRpcClientError>()(
  "JsonRpcClientError",
  {
    reason: Schema.Literals([
      "malformedResponse",
      "resultTooLarge",
      "serverFailed",
      "serverUnavailable",
    ]),
    message: Schema.String,
  },
) {}

class PendingRequest {
  constructor(
    readonly method: string,
    readonly resume: (effect: Effect.Effect<Schema.Json, JsonRpcClientError>) => void,
  ) {}
}

/** Launch configuration for a bounded JSON-RPC subprocess. */
export class JsonRpcProcessOptions extends Schema.Class<JsonRpcProcessOptions>(
  "JsonRpcProcessOptions",
)({
  executable: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
}) {}

/** A bounded JSON-RPC 2.0 client over a child process's stdio streams. */
export class JsonRpcClient {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #pending = Ref.makeUnsafe(HashMap.empty<number, PendingRequest>())
  readonly #buffer = Ref.makeUnsafe(Buffer.alloc(0))
  readonly #nextId = Ref.makeUnsafe(1)
  readonly #terminalError = Ref.makeUnsafe(Option.none<JsonRpcClientError>())
  readonly #closed = Ref.makeUnsafe(false)

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child
    child.stdout.on("data", this.#onData)
    child.stderr.on("data", this.#onStderr)
    child.stdin.on("error", this.#onError)
    child.once("error", this.#onError)
    child.once("close", this.#onClose)
  }

  /** Spawns a subprocess and attaches a JSON-RPC client to its stdio streams. */
  static spawn(options: JsonRpcProcessOptions): Effect.Effect<JsonRpcClient, JsonRpcClientError> {
    return Effect.try({
      try: () =>
        new JsonRpcClient(
          spawn(options.executable, [...options.args], {
            cwd: options.cwd,
            env: Option.match(Option.fromNullishOr(process.versions.electron), {
              onNone: () => process.env,
              onSome: () => ({ ...process.env, ELECTRON_RUN_AS_NODE: "1" }),
            }),
            stdio: ["pipe", "pipe", "pipe"],
          }),
        ),
      catch: (cause) =>
        JsonRpcClientError.make({
          reason: "serverUnavailable",
          message: `Unable to launch language server: ${String(cause)}`,
        }),
    })
  }

  /** Sends a request and cancels it at the protocol boundary when its Effect is interrupted. */
  request(method: string, params: Schema.Json): Effect.Effect<Schema.Json, JsonRpcClientError> {
    return Effect.callback<Schema.Json, JsonRpcClientError>((resume) => {
      const terminalError = Ref.getUnsafe(this.#terminalError)
      if (Option.isSome(terminalError)) {
        resume(Effect.fail(terminalError.value))
        return Effect.void
      }
      if (HashMap.size(Ref.getUnsafe(this.#pending)) >= MAX_PENDING_REQUESTS) {
        resume(
          Effect.fail(
            JsonRpcClientError.make({
              reason: "serverFailed",
              message: `Language server has more than ${MAX_PENDING_REQUESTS} pending requests`,
            }),
          ),
        )
        return Effect.void
      }

      const id = Effect.runSync(Ref.modify(this.#nextId, (nextId) => [nextId, nextId + 1] as const))
      Effect.runSync(Ref.update(this.#pending, HashMap.set(id, new PendingRequest(method, resume))))
      const writeError = this.#write({ jsonrpc: "2.0", id, method, params })
      if (Option.isSome(writeError)) {
        Effect.runSync(Ref.update(this.#pending, HashMap.remove(id)))
        resume(Effect.fail(writeError.value))
        return Effect.void
      }

      return Effect.sync(() => {
        if (HashMap.has(Ref.getUnsafe(this.#pending), id)) {
          Effect.runSync(Ref.update(this.#pending, HashMap.remove(id)))
          this.#write({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } })
        }
      })
    })
  }

  /** Sends a JSON-RPC notification without awaiting a response. */
  notify(method: string, params: Schema.Json): Effect.Effect<void, JsonRpcClientError> {
    return Effect.suspend(() => {
      const error = this.#write({ jsonrpc: "2.0", method, params })
      return Option.match(error, { onNone: () => Effect.void, onSome: Effect.fail })
    })
  }

  /** Gracefully shuts down the server, then escalates to process termination if necessary. */
  close(): Effect.Effect<void> {
    return Effect.promise(() => this.#finalize())
  }

  readonly #onData = (chunk: Buffer): void => {
    if (Option.isSome(Ref.getUnsafe(this.#terminalError))) return
    Effect.runSync(Ref.update(this.#buffer, (buffer) => Buffer.concat([buffer, chunk])))
    this.#drainMessages()
  }

  readonly #onStderr = (_chunk: Buffer): void => {
    // Draining stderr prevents a verbose server from blocking on a full pipe.
  }

  readonly #onError = (cause: Error): void => {
    this.#fail(
      JsonRpcClientError.make({
        reason: "serverUnavailable",
        message: `Language server process failed: ${cause.message}`,
      }),
    )
  }

  readonly #onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    Effect.runSync(Ref.set(this.#closed, true))
    this.#fail(
      JsonRpcClientError.make({
        reason: "serverUnavailable",
        message: `Language server exited before completing requests (code ${String(code)}, signal ${String(signal)})`,
      }),
    )
  }

  #drainMessages(): void {
    while (Ref.getUnsafe(this.#buffer).length > 0) {
      const buffer = Ref.getUnsafe(this.#buffer)
      const separator = buffer.indexOf("\r\n\r\n")
      if (separator < 0) {
        if (buffer.length > MAX_HEADER_BYTES) this.#malformed("JSON-RPC header is too large")
        return
      }
      if (separator > MAX_HEADER_BYTES) {
        this.#malformed("JSON-RPC header is too large")
        return
      }

      const header = buffer.subarray(0, separator).toString("ascii")
      const lengthMatch = Option.fromNullishOr(
        /(?:^|\r\n)Content-Length: ([0-9]+)(?:\r\n|$)/iu.exec(header),
      )
      const contentLengthText = Option.flatMap(lengthMatch, (match) =>
        Option.fromNullishOr(match[1]),
      )
      const contentLength = Option.match(contentLengthText, {
        onNone: () => Number.NaN,
        onSome: Number,
      })
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        this.#malformed("JSON-RPC message has an invalid Content-Length header")
        return
      }
      if (contentLength > MAX_MESSAGE_BYTES) {
        this.#fail(
          JsonRpcClientError.make({
            reason: "resultTooLarge",
            message: `JSON-RPC message exceeds ${MAX_MESSAGE_BYTES} bytes`,
          }),
        )
        this.#child.kill("SIGTERM")
        return
      }

      const bodyStart = separator + 4
      const messageEnd = bodyStart + contentLength
      if (buffer.length < messageEnd) return
      const body = buffer.subarray(bodyStart, messageEnd).toString("utf8")
      Effect.runSync(Ref.set(this.#buffer, buffer.subarray(messageEnd)))
      this.#handleMessage(body)
      if (Option.isSome(Ref.getUnsafe(this.#terminalError))) return
    }
  }

  #handleMessage(body: string): void {
    const parsed = Result.getSuccess(
      Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))(body),
    )
    if (Option.isNone(parsed)) {
      this.#malformed("Language server returned invalid JSON")
      return
    }

    const response = Result.getSuccess(Schema.decodeUnknownResult(JsonRpcResponse)(parsed.value))
    if (Option.isSome(response)) {
      const pending = HashMap.get(Ref.getUnsafe(this.#pending), response.value.id)
      if (Option.isNone(pending)) return
      Effect.runSync(Ref.update(this.#pending, HashMap.remove(response.value.id)))
      JsonRpcResponse.match(response.value, {
        failure: ({ error }) =>
          pending.value.resume(
            Effect.fail(
              JsonRpcClientError.make({
                reason: "serverFailed",
                message: `${pending.value.method} failed (${error.code}): ${error.message}`,
              }),
            ),
          ),
        success: ({ result }) => pending.value.resume(Effect.succeed(result)),
      })
      return
    }

    const serverRequest = Result.getSuccess(
      Schema.decodeUnknownResult(JsonRpcServerRequest)(parsed.value),
    )
    Option.match(serverRequest, {
      onNone: () => {},
      onSome: (message) => {
        const result = message.method === "workspace/configuration" ? [] : null
        this.#write({ jsonrpc: "2.0", id: message.id, result })
      },
    })
  }

  #write(message: Schema.JsonObject): Option.Option<JsonRpcClientError> {
    const terminalError = Ref.getUnsafe(this.#terminalError)
    if (
      Option.isSome(terminalError) ||
      Ref.getUnsafe(this.#closed) ||
      this.#child.stdin.destroyed
    ) {
      return Option.orElse(terminalError, () =>
        Option.some(
          JsonRpcClientError.make({
            reason: "serverUnavailable",
            message: "Language server stdin is closed",
          }),
        ),
      )
    }
    try {
      const body = Schema.encodeSync(Schema.fromJsonString(Schema.Json))(message)
      const byteLength = Buffer.byteLength(body)
      if (byteLength > MAX_MESSAGE_BYTES) {
        return Option.some(
          JsonRpcClientError.make({
            reason: "serverFailed",
            message: `JSON-RPC request exceeds ${MAX_MESSAGE_BYTES} bytes`,
          }),
        )
      }
      this.#child.stdin.write(`Content-Length: ${byteLength}\r\n\r\n${body}`)
      return Option.none()
    } catch (cause) {
      return Option.some(
        JsonRpcClientError.make({
          reason: "serverUnavailable",
          message: `Unable to write to language server: ${String(cause)}`,
        }),
      )
    }
  }

  #malformed(message: string): void {
    this.#fail(JsonRpcClientError.make({ reason: "malformedResponse", message }))
    this.#child.kill("SIGTERM")
  }

  #fail(error: JsonRpcClientError): void {
    if (Option.isNone(Ref.getUnsafe(this.#terminalError))) {
      Effect.runSync(Ref.set(this.#terminalError, Option.some(error)))
    }
    for (const pending of HashMap.values(Ref.getUnsafe(this.#pending))) {
      pending.resume(Effect.fail(error))
    }
    Effect.runSync(Ref.set(this.#pending, HashMap.empty()))
  }

  async #finalize(): Promise<void> {
    try {
      if (!Ref.getUnsafe(this.#closed)) {
        await this.#requestForFinalization("shutdown", null, 750)
        this.#write({ jsonrpc: "2.0", method: "exit", params: null })
        if (await this.#waitForClose(500)) return
        this.#child.kill("SIGTERM")
        if (await this.#waitForClose(500)) return
        this.#child.kill("SIGKILL")
        await this.#waitForClose(500)
      }
    } finally {
      this.#child.stdout.off("data", this.#onData)
      this.#child.stderr.off("data", this.#onStderr)
      this.#child.stdin.off("error", this.#onError)
      this.#child.off("error", this.#onError)
      this.#child.off("close", this.#onClose)
    }
  }

  #requestForFinalization(method: string, params: Schema.Json, timeoutMs: number): Promise<void> {
    if (Option.isSome(Ref.getUnsafe(this.#terminalError)) || Ref.getUnsafe(this.#closed)) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const id = Effect.runSync(Ref.modify(this.#nextId, (nextId) => [nextId, nextId + 1] as const))
      const timeout = setTimeout(() => {
        Effect.runSync(Ref.update(this.#pending, HashMap.remove(id)))
        finish()
      }, timeoutMs)
      Effect.runSync(
        Ref.update(
          this.#pending,
          HashMap.set(
            id,
            new PendingRequest(method, () => {
              clearTimeout(timeout)
              finish()
            }),
          ),
        ),
      )
      const error = this.#write({ jsonrpc: "2.0", id, method, params })
      if (Option.isSome(error)) {
        clearTimeout(timeout)
        Effect.runSync(Ref.update(this.#pending, HashMap.remove(id)))
        finish()
      }
    })
  }

  #waitForClose(timeoutMs: number): Promise<boolean> {
    if (Ref.getUnsafe(this.#closed)) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (closed: boolean) => {
        if (settled) return
        settled = true
        resolve(closed)
      }
      const timeout = setTimeout(() => {
        this.#child.off("close", onClose)
        finish(false)
      }, timeoutMs)
      const onClose = () => {
        clearTimeout(timeout)
        finish(true)
      }
      this.#child.once("close", onClose)
    })
  }
}
