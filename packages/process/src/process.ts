import {
  Clock,
  Context,
  Effect,
  Layer,
  Match,
  Predicate,
  Queue,
  Schema,
  Semaphore,
  Stream,
} from "effect"

import {
  BoundedOutput,
  NodeProcessIoFailure,
  NodeProcessSpawner,
  NodeProcessStdinFailure,
  ProcessLimitFailure,
  StreamOutputDecoder,
  type NodeProcessHandle,
  type ResolvedProcessOptions,
  type NodeProcessTerminal,
  type SpawnProcessInput,
  type ProcessStreamMetricsTracker,
} from "./subprocess"

/** Default retained stdout bytes for captured commands and stream diagnostics. */
export const defaultMaxStdoutBytes = 1024 * 1024

/** Default retained stderr bytes, independent from the stdout budget. */
export const defaultMaxStderrBytes = 256 * 1024

/** Default grace period between graceful and forced process-tree termination. */
export const defaultKillAfterMs = 1_000

/** Default deadline for cleanup after forced process-tree termination. */
export const defaultForceKillAfterMs = 1_000

/** Default time allowed for inherited stdio to close after the direct child exits. */
export const defaultExitCloseAfterMs = 1_000

/** Default maximum bytes allowed in one streaming line, excluding its LF delimiter. */
export const defaultMaxLineBytes = 1024 * 1024

/** Default maximum aggregate stdout and stderr bytes accepted by one stream. */
export const defaultMaxStreamBytes = 16 * 1024 * 1024

/** Default maximum line events accepted by one stream. */
export const defaultMaxStreamEvents = 20_000

/** Default number of line events buffered between the process and a stream consumer. */
export const defaultMaxBufferedEvents = 16

/** Default maximum bytes emitted in one raw subprocess stream chunk. */
export const defaultMaxByteChunkBytes = 64 * 1024

/** Default resident byte budget for a raw subprocess stream queue. */
export const defaultMaxBufferedBytes = 1024 * 1024

/** Default downstream byte reservation held between the process queue and stream consumer. */
export const defaultMaxReservedBytes = 1024 * 1024

/** Identifies the subprocess output channel that produced bytes or a complete line. */
export const ProcessOutputSource = Schema.Literals(["stdout", "stderr"])

/** Identifies the subprocess output channel that produced bytes or a complete line. */
export type ProcessOutputSource = typeof ProcessOutputSource.Type

/** Controls retained bytes and behavior when one output channel exceeds its budget. */
export class ProcessOutputPolicy extends Schema.Class<ProcessOutputPolicy>("ProcessOutputPolicy")({
  maxBytes: Schema.Number,
  overflow: Schema.Literals(["error", "truncate"]),
}) {}

/** Structural input accepted when configuring one output channel. */
export interface ProcessOutputPolicyInput {
  readonly maxBytes: number
  readonly overflow: "error" | "truncate"
}

/** Input accepted by the process request factory. */
export interface ProcessRequestOptions {
  readonly cwd?: string
  readonly stdin?: string
  readonly timeoutMs?: number
  readonly env?: Readonly<Record<string, string>>
  readonly unsetEnv?: readonly string[]
  readonly stdout?: ProcessOutputPolicyInput
  readonly stderr?: ProcessOutputPolicyInput
  readonly killAfterMs?: number
  readonly forceKillAfterMs?: number
  readonly exitCloseAfterMs?: number
  readonly maxLineBytes?: number
  readonly maxStreamBytes?: number
  readonly maxStreamEvents?: number
  readonly maxBufferedEvents?: number
  readonly maxByteChunkBytes?: number
  readonly maxBufferedBytes?: number
  readonly maxReservedBytes?: number
}

/** Complete immutable request for one finite local process execution. */
export class ProcessRequest extends Schema.Class<ProcessRequest>("ProcessRequest")({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  stdin: Schema.NullOr(Schema.String),
  timeoutMs: Schema.NullOr(Schema.Number),
  env: Schema.Record(Schema.String, Schema.String),
  unsetEnv: Schema.Array(Schema.String),
  stdout: Schema.NullOr(ProcessOutputPolicy),
  stderr: Schema.NullOr(ProcessOutputPolicy),
  killAfterMs: Schema.NullOr(Schema.Number),
  forceKillAfterMs: Schema.NullOr(Schema.Number),
  exitCloseAfterMs: Schema.NullOr(Schema.Number),
  maxLineBytes: Schema.NullOr(Schema.Number),
  maxStreamBytes: Schema.NullOr(Schema.Number),
  maxStreamEvents: Schema.NullOr(Schema.Number),
  maxBufferedEvents: Schema.NullOr(Schema.Number),
  maxByteChunkBytes: Schema.NullOr(Schema.Number),
  maxBufferedBytes: Schema.NullOr(Schema.Number),
  maxReservedBytes: Schema.NullOr(Schema.Number),
}) {}

/** Creates one process request while preserving optional caller overrides. */
export const processRequest = (
  command: string,
  args: readonly string[],
  options: ProcessRequestOptions = {},
): ProcessRequest =>
  ProcessRequest.make({
    command,
    args: [...args],
    cwd: options.cwd ?? null,
    stdin: options.stdin ?? null,
    timeoutMs: options.timeoutMs ?? null,
    env: { ...options.env },
    unsetEnv: [...(options.unsetEnv ?? [])],
    stdout: options.stdout === undefined ? null : ProcessOutputPolicy.make(options.stdout),
    stderr: options.stderr === undefined ? null : ProcessOutputPolicy.make(options.stderr),
    killAfterMs: options.killAfterMs ?? null,
    forceKillAfterMs: options.forceKillAfterMs ?? null,
    exitCloseAfterMs: options.exitCloseAfterMs ?? null,
    maxLineBytes: options.maxLineBytes ?? null,
    maxStreamBytes: options.maxStreamBytes ?? null,
    maxStreamEvents: options.maxStreamEvents ?? null,
    maxBufferedEvents: options.maxBufferedEvents ?? null,
    maxByteChunkBytes: options.maxByteChunkBytes ?? null,
    maxBufferedBytes: options.maxBufferedBytes ?? null,
    maxReservedBytes: options.maxReservedBytes ?? null,
  })

/** Captured output from a completed process. */
export class ProcessResult extends Schema.Class<ProcessResult>("ProcessResult")({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
  outputTruncated: Schema.Boolean,
  exitCode: Schema.Literal(0),
  signal: Schema.NullOr(Schema.String),
}) {}

/** One complete output line without its trailing LF or CRLF delimiter. */
export class ProcessLine extends Schema.TaggedClass<ProcessLine>()("ProcessLine", {
  source: ProcessOutputSource,
  line: Schema.String,
}) {}

/** Terminal event emitted after a streamed process exits successfully. */
export class ProcessExit extends Schema.TaggedClass<ProcessExit>()("ProcessExit", {
  result: ProcessResult,
}) {}

/** Ordered line or successful terminal event from a streamed process. */
export const ProcessEvent = Schema.Union([ProcessLine, ProcessExit])

/** Ordered line or successful terminal event from a streamed process. */
export type ProcessEvent = typeof ProcessEvent.Type

/** One bounded raw stdout chunk. The bytes are copied and never alias Node's read buffer. */
export interface ProcessByteChunk {
  readonly _tag: "ProcessByteChunk"
  readonly bytes: Uint8Array
}

/** Ordered raw stdout chunk or successful terminal event. */
export type ProcessByteEvent = ProcessByteChunk | ProcessExit

/** Point-in-time byte-stream pressure measurements for diagnostics and scale tests. */
export interface ProcessStreamMetrics {
  readonly queueBytes: number
  readonly queueDepth: number
  readonly blockedDurationMs: number
  readonly cancellationAgeMs: number
  readonly reservedBytes: number
  readonly reservationCapacityBytes: number
  readonly reservationUtilization: number
}

/** Receives pressure changes without becoming part of the subprocess critical path. */
export type ProcessStreamObserver = (metrics: ProcessStreamMetrics) => void

/** Optional observation and typed cancellation controls for a raw byte stream. */
export interface ProcessByteStreamOptions {
  readonly observer?: ProcessStreamObserver
  readonly cancellation?: Effect.Effect<void>
}

const diagnosticFields = {
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
  outputTruncated: Schema.Boolean,
  message: Schema.String,
} as const

/** Process request options failed validation before spawning. */
export class InvalidProcessOptionsError extends Schema.TaggedError<InvalidProcessOptionsError>()(
  "InvalidProcessOptionsError",
  { ...diagnosticFields, option: Schema.String, cause: Schema.ErrorInstance() },
) {}

/** The operating system could not spawn the requested process. */
export class ProcessSpawnError extends Schema.TaggedError<ProcessSpawnError>()(
  "ProcessSpawnError",
  { ...diagnosticFields, cause: Schema.ErrorInstance() },
) {}

/** The process rejected or failed while receiving stdin. */
export class ProcessStdinError extends Schema.TaggedError<ProcessStdinError>()(
  "ProcessStdinError",
  { ...diagnosticFields, cause: Schema.ErrorInstance() },
) {}

/** Process output failed or exceeded a configured byte/event limit. */
export class ProcessOutputError extends Schema.TaggedError<ProcessOutputError>()(
  "ProcessOutputError",
  {
    ...diagnosticFields,
    source: Schema.NullOr(ProcessOutputSource),
    limit: Schema.Literals(["capture-bytes", "events", "line-bytes", "stream-bytes", "io"]),
    cause: Schema.NullOr(Schema.ErrorInstance()),
  },
) {}

/** The process exceeded its configured execution timeout. */
export class ProcessTimeoutError extends Schema.TaggedError<ProcessTimeoutError>()(
  "ProcessTimeoutError",
  { ...diagnosticFields, timeoutMs: Schema.Number },
) {}

/** An explicit byte-stream cancellation request terminated the process tree. */
export class ProcessCancellationError extends Schema.TaggedError<ProcessCancellationError>()(
  "ProcessCancellationError",
  diagnosticFields,
) {}

/** The process or inherited stdio could not be cleaned up within finite deadlines. */
export class ProcessCleanupError extends Schema.TaggedError<ProcessCleanupError>()(
  "ProcessCleanupError",
  { ...diagnosticFields },
) {}

/** The process exited unsuccessfully or was terminated by a signal. */
export class ProcessExitError extends Schema.TaggedError<ProcessExitError>()(
  "ProcessExitError",
  diagnosticFields,
) {}

/** Recoverable failures from finite local process execution. */
export type ProcessExecutionError =
  | InvalidProcessOptionsError
  | ProcessSpawnError
  | ProcessStdinError
  | ProcessOutputError
  | ProcessTimeoutError
  | ProcessCancellationError
  | ProcessCleanupError
  | ProcessExitError

/** Shared capability for captured and line-streaming local process execution. */
export interface ProcessRunner {
  readonly run: (request: ProcessRequest) => Effect.Effect<ProcessResult, ProcessExecutionError>
  readonly streamLines: (
    request: ProcessRequest,
  ) => Stream.Stream<ProcessEvent, ProcessExecutionError>
  readonly streamBytes: (
    request: ProcessRequest,
    options?: ProcessByteStreamOptions,
  ) => Stream.Stream<ProcessByteEvent, ProcessExecutionError>
}

/** Main-process service for scoped, bounded local process execution. */
export class ProcessService extends Context.Service<ProcessService, ProcessRunner>()(
  "@diffdash/process/ProcessService",
) {
  static readonly layer = Layer.suspend(makeProcessServiceLayer).pipe(
    Layer.provide(NodeProcessSpawner.layer),
  )
}

interface ResolvedExecution {
  readonly spawn: Omit<SpawnProcessInput, "capture">
  readonly options: ResolvedProcessOptions
}

const capturedDefaults = {
  stdout: ProcessOutputPolicy.make({ maxBytes: defaultMaxStdoutBytes, overflow: "error" }),
  stderr: ProcessOutputPolicy.make({ maxBytes: defaultMaxStderrBytes, overflow: "truncate" }),
} as const

const streamingDefaults = {
  stdout: ProcessOutputPolicy.make({ maxBytes: defaultMaxStdoutBytes, overflow: "truncate" }),
  stderr: ProcessOutputPolicy.make({ maxBytes: defaultMaxStderrBytes, overflow: "truncate" }),
} as const

function makeProcessServiceLayer() {
  return Layer.effect(
    ProcessService,
    Effect.gen(function* () {
      const spawner = yield* NodeProcessSpawner

      const run = Effect.fn("ProcessService.run")(function* (request: ProcessRequest) {
        const resolved = yield* resolveRequest(request, "captured")
        return yield* execute(spawner, request, resolved)
      })

      const streamLines = (request: ProcessRequest) =>
        Stream.unwrap(
          resolveRequest(request, "streaming").pipe(
            Effect.map((resolved) =>
              Stream.callback<ProcessEvent, ProcessExecutionError>(
                (queue) =>
                  execute(spawner, request, resolved, (event) => Queue.offer(queue, event)).pipe(
                    Effect.flatMap((result) => Queue.offer(queue, ProcessExit.make({ result }))),
                    Effect.andThen(Queue.end(queue)),
                    Effect.catch((error) => Queue.fail(queue, error)),
                    Effect.forkScoped,
                  ),
                { bufferSize: resolved.options.maxBufferedEvents, strategy: "suspend" },
              ),
            ),
          ),
        )

      const streamBytes = (request: ProcessRequest, streamOptions?: ProcessByteStreamOptions) =>
        Stream.unwrap(
          resolveRequest(request, "bytes").pipe(
            Effect.map((resolved) => {
              const metrics = makeStreamMetricsTracker(
                resolved.options.maxReservedBytes,
                resolved.options.maxByteChunkBytes,
                streamOptions?.observer,
              )
              return Stream.callback<ProcessByteEvent, ProcessExecutionError>(
                (queue) =>
                  execute(
                    spawner,
                    request,
                    resolved,
                    undefined,
                    (bytes) =>
                      Effect.gen(function* () {
                        const startedAt = yield* Clock.currentTimeMillis
                        yield* Queue.offer(queue, { _tag: "ProcessByteChunk", bytes })
                        const finishedAt = yield* Clock.currentTimeMillis
                        metrics.blocked(finishedAt - startedAt)
                      }),
                    metrics,
                    streamOptions?.cancellation,
                  ).pipe(
                    Effect.flatMap((result) => Queue.offer(queue, ProcessExit.make({ result }))),
                    Effect.andThen(Queue.end(queue)),
                    Effect.catch((error) => Queue.fail(queue, error)),
                    Effect.onInterrupt(() =>
                      Clock.currentTimeMillis.pipe(
                        Effect.tap((now) => Effect.sync(() => metrics.cancel(now))),
                      ),
                    ),
                    Effect.forkScoped,
                  ),
                { bufferSize: resolved.options.maxReservedEvents, strategy: "suspend" },
              ).pipe(
                Stream.tap((event) =>
                  event["_tag"] === "ProcessExit" ? Effect.void : metrics.release,
                ),
                Stream.ensuring(
                  Clock.currentTimeMillis.pipe(
                    Effect.tap((now) => Effect.sync(() => metrics.finish(now))),
                  ),
                ),
              )
            }),
          ),
        )

      return ProcessService.of({ run, streamBytes, streamLines })
    }),
  )
}

const resolveRequest = (
  request: ProcessRequest,
  mode: "bytes" | "captured" | "streaming",
): Effect.Effect<ResolvedExecution, InvalidProcessOptionsError> =>
  Effect.try({
    try: () => {
      const defaults = mode === "captured" ? capturedDefaults : streamingDefaults
      if (request.command.length === 0)
        throw OptionError.make({ option: "command", message: "command cannot be empty" })
      if (request.timeoutMs !== null) nonNegativeInteger(request.timeoutMs, "timeoutMs")
      const stdout = request.stdout ?? defaults.stdout
      const stderr = request.stderr ?? defaults.stderr
      const maxByteChunkBytes = positiveInteger(
        request.maxByteChunkBytes ?? defaultMaxByteChunkBytes,
        "maxByteChunkBytes",
      )
      const maxBufferedBytes = positiveInteger(
        request.maxBufferedBytes ?? defaultMaxBufferedBytes,
        "maxBufferedBytes",
      )
      const maxReservedBytes = positiveInteger(
        request.maxReservedBytes ?? defaultMaxReservedBytes,
        "maxReservedBytes",
      )
      const configuredBufferedEvents = positiveInteger(
        request.maxBufferedEvents ?? defaultMaxBufferedEvents,
        "maxBufferedEvents",
      )
      if (mode === "bytes" && maxBufferedBytes < maxByteChunkBytes) {
        throw OptionError.make({
          option: "maxBufferedBytes",
          message: "maxBufferedBytes must be at least maxByteChunkBytes",
        })
      }
      if (mode === "bytes" && maxReservedBytes < maxByteChunkBytes) {
        throw OptionError.make({
          option: "maxReservedBytes",
          message: "maxReservedBytes must be at least maxByteChunkBytes",
        })
      }
      const options: ResolvedProcessOptions = {
        stdout: resolveOutputPolicy(stdout, "stdout"),
        stderr: resolveOutputPolicy(stderr, "stderr"),
        killAfterMs: nonNegativeInteger(request.killAfterMs ?? defaultKillAfterMs, "killAfterMs"),
        forceKillAfterMs: nonNegativeInteger(
          request.forceKillAfterMs ?? defaultForceKillAfterMs,
          "forceKillAfterMs",
        ),
        exitCloseAfterMs: nonNegativeInteger(
          request.exitCloseAfterMs ?? defaultExitCloseAfterMs,
          "exitCloseAfterMs",
        ),
        maxLineBytes: nonNegativeInteger(
          request.maxLineBytes ?? defaultMaxLineBytes,
          "maxLineBytes",
        ),
        maxStreamBytes: nonNegativeInteger(
          request.maxStreamBytes ?? defaultMaxStreamBytes,
          "maxStreamBytes",
        ),
        maxStreamEvents: nonNegativeInteger(
          request.maxStreamEvents ?? defaultMaxStreamEvents,
          "maxStreamEvents",
        ),
        maxByteChunkBytes,
        maxBufferedBytes,
        maxReservedBytes,
        maxReservedEvents: Math.floor(maxReservedBytes / maxByteChunkBytes),
        maxBufferedEvents:
          mode === "bytes"
            ? Math.floor(maxBufferedBytes / maxByteChunkBytes)
            : configuredBufferedEvents,
      }
      return {
        spawn: {
          command: request.command,
          args: request.args,
          cwd: request.cwd,
          stdin: request.stdin,
          env: request.env,
          unsetEnv: request.unsetEnv,
          options,
        },
        options,
      }
    },
    catch: (cause) => invalidOptionsError(request, cause),
  })

const execute = (
  spawner: Context.Service.Shape<typeof NodeProcessSpawner>,
  request: ProcessRequest,
  resolved: ResolvedExecution,
  emitLine?: (event: ProcessLine) => Effect.Effect<void>,
  emitBytes?: (bytes: Uint8Array) => Effect.Effect<void>,
  metrics?: ProcessStreamMetricsTracker,
  cancellation?: Effect.Effect<void>,
): Effect.Effect<ProcessResult, ProcessExecutionError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const capture = new BoundedOutput(resolved.options.stdout, resolved.options.stderr)
      const decoder =
        emitLine === undefined
          ? null
          : new StreamOutputDecoder({
              maxLineBytes: resolved.options.maxLineBytes,
              maxStreamBytes: resolved.options.maxStreamBytes,
              maxStreamEvents: resolved.options.maxStreamEvents,
            })
      const spawnInput: SpawnProcessInput =
        metrics === undefined
          ? { ...resolved.spawn, capture }
          : { ...resolved.spawn, capture, metrics }
      const handle = yield* spawner
        .spawn(spawnInput)
        .pipe(
          Effect.mapError((failure) =>
            processSpawnError(request, capture, "Failed to spawn command", failure.cause),
          ),
        )

      const consumeOutput = handle.output.pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            if (emitBytes !== undefined && chunk.source === "stdout") {
              yield* emitBytes(chunk.bytes)
            }
            const lines = yield* Effect.try({
              try: () => {
                return decoder?.write(chunk.source, chunk.bytes) ?? []
              },
              catch: (cause) => processOutputError(request, capture, cause),
            })
            if (emitLine !== undefined) {
              yield* Effect.forEach(lines, emitLine, { discard: true })
            }
          }),
        ),
        Effect.mapError((failure) => {
          return Schema.is(ProcessOutputError)(failure)
            ? failure
            : processOutputError(request, capture, failure)
        }),
      )

      const awaitTerminal = awaitProcessTerminal(request, capture, handle, resolved.options)

      const execution = Effect.all(
        [
          consumeOutput,
          handle.writeStdin.pipe(
            Effect.mapError((failure) => processStdinError(request, capture, failure)),
          ),
          handle.monitorStdin.pipe(
            Effect.mapError((failure) => processStdinError(request, capture, failure)),
          ),
          handle.monitorOutput,
          awaitTerminal,
        ] as const,
        { concurrency: "unbounded" },
      )

      const cancellableExecution =
        cancellation === undefined
          ? execution
          : Effect.raceFirst(
              execution,
              cancellation.pipe(
                Effect.tap(() =>
                  Clock.currentTimeMillis.pipe(
                    Effect.tap((now) => Effect.sync(() => metrics?.cancel(now))),
                  ),
                ),
                Effect.andThen(handle.terminate),
                Effect.andThen(handle.awaitTerminal),
                Effect.flatMap((cancelledTerminal) =>
                  ProcessCancellationError.make({
                    ...terminalDiagnostics(request, capture, cancelledTerminal),
                    message: "Command byte stream was cancelled",
                  }),
                ),
              ),
            )
      const timeoutMs = request.timeoutMs
      const [, , , outputFailure, terminal] = yield* timeoutMs === null
        ? cancellableExecution
        : Effect.raceFirst(
            cancellableExecution,
            Effect.sleep(timeoutMs).pipe(
              Effect.andThen(handle.terminate),
              Effect.andThen(handle.awaitTerminal),
              Effect.flatMap((timedOutTerminal) =>
                ProcessTimeoutError.make({
                  ...terminalDiagnostics(request, capture, timedOutTerminal),
                  message: `Command timed out after ${timeoutMs}ms`,
                  timeoutMs,
                }),
              ),
            ),
          )

      if (outputFailure !== null) {
        return yield* processOutputError(request, capture, outputFailure)
      }

      if (decoder !== null && emitLine !== undefined) {
        const remaining = yield* Effect.try({
          try: () => decoder.end(),
          catch: (cause) => processOutputError(request, capture, cause),
        })
        yield* Effect.forEach(remaining, emitLine, { discard: true })
      }

      return yield* terminalResult(request, capture, terminal)
    }),
  )

const terminalResult = (
  request: ProcessRequest,
  capture: BoundedOutput,
  terminal: NodeProcessTerminal,
): Effect.Effect<ProcessResult, ProcessSpawnError | ProcessExitError> => {
  return Match.value(terminal).pipe(
    Match.tag("NodeProcessSpawnFailed", (failed) =>
      processSpawnError(request, capture, "Failed to spawn command", failed.cause),
    ),
    Match.tag("NodeProcessClosed", (closed) => {
      if (closed.code !== 0 || closed.signal !== null) {
        const message =
          closed.code === null
            ? `Command terminated by ${closed.signal ?? "an unknown signal"}`
            : `Command exited with code ${closed.code}`
        return ProcessExitError.make({
          ...diagnostics(request, capture, closed.code, closed.signal),
          message,
        })
      }
      const output = capture.snapshot()
      return Effect.succeed(
        ProcessResult.make({
          command: request.command,
          args: request.args,
          cwd: request.cwd,
          stdout: output.stdout.text,
          stderr: output.stderr.text,
          stdoutTruncated: output.stdout.truncated,
          stderrTruncated: output.stderr.truncated,
          outputTruncated: output.stdout.truncated || output.stderr.truncated,
          exitCode: 0,
          signal: null,
        }),
      )
    }),
    Match.exhaustive,
  )
}

const awaitProcessTerminal = (
  request: ProcessRequest,
  capture: BoundedOutput,
  handle: NodeProcessHandle,
  options: ResolvedProcessOptions,
): Effect.Effect<NodeProcessTerminal, ProcessCleanupError> =>
  Effect.raceFirst(
    handle.awaitTerminal.pipe(Effect.map((terminal) => ({ _tag: "Terminal" as const, terminal }))),
    handle.awaitExit.pipe(Effect.as({ _tag: "ExitObserved" as const })),
  ).pipe(
    Effect.flatMap((first) =>
      Match.value(first).pipe(
        Match.tag("Terminal", ({ terminal }) => Effect.succeed(terminal)),
        Match.tag("ExitObserved", () =>
          Effect.raceFirst(
            handle.awaitTerminal.pipe(
              Effect.map((terminal) => ({ _tag: "Terminal" as const, terminal })),
            ),
            Effect.sleep(options.exitCloseAfterMs).pipe(
              Effect.as({ _tag: "CloseTimeout" as const }),
            ),
          ).pipe(
            Effect.flatMap((afterExit) =>
              Match.value(afterExit).pipe(
                Match.tag("Terminal", ({ terminal }) => Effect.succeed(terminal)),
                Match.tag("CloseTimeout", () =>
                  handle.terminate.pipe(
                    Effect.andThen(handle.awaitTerminal),
                    Effect.flatMap((terminal) =>
                      ProcessCleanupError.make({
                        ...terminalDiagnostics(request, capture, terminal),
                        message:
                          "Command cleanup reached its termination deadline before stdio closed",
                      }),
                    ),
                  ),
                ),
                Match.exhaustive,
              ),
            ),
          ),
        ),
        Match.exhaustive,
      ),
    ),
  )

const resolveOutputPolicy = (policy: ProcessOutputPolicy, source: ProcessOutputSource) => ({
  maxBytes: nonNegativeInteger(policy.maxBytes, `${source}.maxBytes`),
  overflow: policy.overflow,
})

const makeStreamMetricsTracker = (
  reservationCapacityBytes: number,
  reservationBytesPerEvent: number,
  observer: ProcessStreamObserver | undefined,
): ProcessStreamMetricsTracker => {
  let queueBytes = 0
  let queueDepth = 0
  let blockedDurationMs = 0
  let cancelledAt: number | null = null
  let cancellationAgeMs = 0
  let reservedBytes = 0
  const reservationSlots = Semaphore.makeUnsafe(
    Math.floor(reservationCapacityBytes / reservationBytesPerEvent),
  )

  const observe = () => {
    if (observer === undefined) return
    try {
      observer({
        queueBytes,
        queueDepth,
        blockedDurationMs,
        cancellationAgeMs,
        reservedBytes,
        reservationCapacityBytes,
        reservationUtilization: reservedBytes / reservationCapacityBytes,
      })
    } catch {
      // Diagnostics must not alter subprocess behavior.
    }
  }

  return {
    queued: (bytes, depth) => {
      queueBytes = bytes
      queueDepth = depth
      observe()
    },
    blocked: (durationMs) => {
      blockedDurationMs += Math.max(0, durationMs)
      observe()
    },
    reserve: Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      yield* reservationSlots.take(1)
      const finishedAt = yield* Clock.currentTimeMillis
      blockedDurationMs += Math.max(0, finishedAt - startedAt)
      reservedBytes += reservationBytesPerEvent
      observe()
    }),
    release: reservationSlots.release(1).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          reservedBytes = Math.max(0, reservedBytes - reservationBytesPerEvent)
          observe()
        }),
      ),
      Effect.asVoid,
    ),
    cancel: (now) => {
      cancelledAt ??= now
      observe()
    },
    finish: (now) => {
      if (cancelledAt !== null) cancellationAgeMs = Math.max(0, now - cancelledAt)
      queueBytes = 0
      queueDepth = 0
      reservedBytes = 0
      observe()
    },
  }
}

const nonNegativeInteger = (value: number, option: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw OptionError.make({
      option,
      message: `${option} must be a non-negative safe integer`,
    })
  }
  return value
}

const positiveInteger = (value: number, option: string): number => {
  nonNegativeInteger(value, option)
  if (value === 0)
    throw OptionError.make({ option, message: `${option} must be greater than zero` })
  return value
}

class OptionError extends Schema.TaggedError<OptionError>()("OptionError", {
  option: Schema.String,
  message: Schema.String,
}) {}

const emptyOutput = {
  stdout: { text: "", truncated: false },
  stderr: { text: "", truncated: false },
} as const

const diagnostics = (
  request: ProcessRequest,
  capture: BoundedOutput | null,
  exitCode: number | null,
  signal: string | null,
) => {
  const output = capture?.snapshot() ?? emptyOutput
  return {
    command: request.command,
    args: [...request.args],
    cwd: request.cwd,
    exitCode,
    signal,
    stdout: output.stdout.text,
    stderr: output.stderr.text,
    stdoutTruncated: output.stdout.truncated,
    stderrTruncated: output.stderr.truncated,
    outputTruncated: output.stdout.truncated || output.stderr.truncated,
  }
}

const terminalDiagnostics = (
  request: ProcessRequest,
  capture: BoundedOutput,
  terminal: NodeProcessTerminal,
) => {
  return Match.value(terminal).pipe(
    Match.tag("NodeProcessClosed", (closed) =>
      diagnostics(request, capture, closed.code, closed.signal),
    ),
    Match.tag("NodeProcessSpawnFailed", () => diagnostics(request, capture, null, null)),
    Match.exhaustive,
  )
}

const invalidOptionsError = (request: ProcessRequest, cause: unknown) =>
  InvalidProcessOptionsError.make({
    ...diagnostics(request, null, null, null),
    option: Schema.is(OptionError)(cause) ? cause.option : "request",
    message: Schema.is(Schema.ErrorInstance())(cause) ? cause.message : "Invalid process request",
    cause: toError(cause),
  })

const processSpawnError = (
  request: ProcessRequest,
  capture: BoundedOutput,
  message: string,
  cause: unknown,
) =>
  ProcessSpawnError.make({
    ...diagnostics(request, capture, null, null),
    message,
    cause: toError(cause),
  })

const processStdinError = (
  request: ProcessRequest,
  capture: BoundedOutput,
  failure: NodeProcessStdinFailure,
) =>
  ProcessStdinError.make({
    ...diagnostics(request, capture, null, null),
    message: "Failed to write command stdin",
    cause: failure.cause,
  })

const isNodeProcessIoFailure = (value: unknown): value is NodeProcessIoFailure =>
  Predicate.isTagged("NodeProcessIoFailure")(value)

const processOutputError = (request: ProcessRequest, capture: BoundedOutput, cause: unknown) => {
  const details = Match.type<unknown>().pipe(
    Match.when(isNodeProcessIoFailure, (failure) => ({
      limit: "io" as const,
      source: failure.source,
      message: failure.cause.message,
      cause: failure.cause,
    })),
    Match.when(Schema.is(ProcessLimitFailure), (failure) => ({
      limit: failure.limit,
      source: failure.source,
      message: failure.message,
      cause,
    })),
    Match.when(Schema.is(Schema.ErrorInstance()), (error) => ({
      limit: "io" as const,
      source: null,
      message: error.message,
      cause: error,
    })),
    Match.orElse(() => ({
      limit: "io" as const,
      source: null,
      message: "Failed while consuming subprocess output",
      cause,
    })),
  )(cause)
  return ProcessOutputError.make({
    ...diagnostics(request, capture, null, null),
    source: details.source,
    limit:
      details.limit === "capture-bytes" ||
      details.limit === "events" ||
      details.limit === "line-bytes" ||
      details.limit === "stream-bytes"
        ? details.limit
        : "io",
    message: details.message,
    cause: toError(details.cause),
  })
}

const toError = (cause: unknown): Error =>
  Schema.is(Schema.ErrorInstance())(cause) ? cause : new Error(String(cause))
