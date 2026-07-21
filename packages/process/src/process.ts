import { Context, Effect, Layer, Schema, Stream } from "effect"

import {
  BoundedOutput,
  NodeProcessIoFailure,
  NodeProcessSpawner,
  NodeProcessStdinFailure,
  StreamOutputDecoder,
  type NodeProcessHandle,
  type ResolvedProcessOptions,
  type NodeProcessTerminal,
  type SpawnProcessInput,
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

/** Identifies the subprocess output channel that produced bytes or a complete line. */
export const ProcessOutputSource = Schema.Literal("stdout", "stderr")

/** Identifies the subprocess output channel that produced bytes or a complete line. */
export type ProcessOutputSource = typeof ProcessOutputSource.Type

/** Controls retained bytes and behavior when one output channel exceeds its budget. */
export class ProcessOutputPolicy extends Schema.Class<ProcessOutputPolicy>("ProcessOutputPolicy")({
  maxBytes: Schema.Number,
  overflow: Schema.Literal("error", "truncate"),
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
}

/** Complete immutable request for one finite local process execution. */
export class ProcessRequest extends Schema.Class<ProcessRequest>("ProcessRequest")({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  stdin: Schema.NullOr(Schema.String),
  timeoutMs: Schema.NullOr(Schema.Number),
  env: Schema.Record({ key: Schema.String, value: Schema.String }),
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
export const ProcessEvent = Schema.Union(ProcessLine, ProcessExit)

/** Ordered line or successful terminal event from a streamed process. */
export type ProcessEvent = typeof ProcessEvent.Type

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
  { ...diagnosticFields, option: Schema.String, cause: Schema.Defect },
) {}

/** The operating system could not spawn the requested process. */
export class ProcessSpawnError extends Schema.TaggedError<ProcessSpawnError>()(
  "ProcessSpawnError",
  { ...diagnosticFields, cause: Schema.Defect },
) {}

/** The process rejected or failed while receiving stdin. */
export class ProcessStdinError extends Schema.TaggedError<ProcessStdinError>()(
  "ProcessStdinError",
  { ...diagnosticFields, cause: Schema.Defect },
) {}

/** Process output failed or exceeded a configured byte/event limit. */
export class ProcessOutputError extends Schema.TaggedError<ProcessOutputError>()(
  "ProcessOutputError",
  {
    ...diagnosticFields,
    source: Schema.NullOr(ProcessOutputSource),
    limit: Schema.Literal("capture-bytes", "events", "line-bytes", "stream-bytes", "io"),
    cause: Schema.NullOr(Schema.Defect),
  },
) {}

/** The process exceeded its configured execution timeout. */
export class ProcessTimeoutError extends Schema.TaggedError<ProcessTimeoutError>()(
  "ProcessTimeoutError",
  { ...diagnosticFields, timeoutMs: Schema.Number },
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
  | ProcessCleanupError
  | ProcessExitError

/** Shared capability for captured and line-streaming local process execution. */
export interface ProcessRunner {
  readonly run: (request: ProcessRequest) => Effect.Effect<ProcessResult, ProcessExecutionError>
  readonly streamLines: (
    request: ProcessRequest,
  ) => Stream.Stream<ProcessEvent, ProcessExecutionError>
}

/** Main-process service for scoped, bounded local process execution. */
export class ProcessService extends Context.Tag("@diffdash/process/ProcessService")<
  ProcessService,
  ProcessRunner
>() {
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
              Stream.asyncScoped<ProcessEvent, ProcessExecutionError>(
                (emit) =>
                  execute(spawner, request, resolved, (event) =>
                    Effect.promise(() => emit.single(event)),
                  ).pipe(
                    Effect.flatMap((result) =>
                      Effect.promise(() => emit.single(ProcessExit.make({ result }))),
                    ),
                    Effect.flatMap(() => Effect.promise(() => emit.end())),
                    Effect.catchAll((error) => Effect.promise(() => emit.fail(error))),
                    Effect.forkScoped,
                  ),
                { bufferSize: resolved.options.maxBufferedEvents, strategy: "suspend" },
              ),
            ),
          ),
        )

      return ProcessService.of({ run, streamLines })
    }),
  )
}

const resolveRequest = (
  request: ProcessRequest,
  mode: "captured" | "streaming",
): Effect.Effect<ResolvedExecution, InvalidProcessOptionsError> =>
  Effect.try({
    try: () => {
      const defaults = mode === "captured" ? capturedDefaults : streamingDefaults
      if (request.command.length === 0) throw new OptionError("command", "command cannot be empty")
      if (request.timeoutMs !== null) nonNegativeInteger(request.timeoutMs, "timeoutMs")
      const stdout = request.stdout ?? defaults.stdout
      const stderr = request.stderr ?? defaults.stderr
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
        maxBufferedEvents: positiveInteger(
          request.maxBufferedEvents ?? defaultMaxBufferedEvents,
          "maxBufferedEvents",
        ),
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
  spawner: Context.Tag.Service<NodeProcessSpawner>,
  request: ProcessRequest,
  resolved: ResolvedExecution,
  emitLine?: (event: ProcessLine) => Effect.Effect<void>,
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
      const handle = yield* spawner
        .spawn({ ...resolved.spawn, capture })
        .pipe(
          Effect.mapError((failure) =>
            processSpawnError(request, capture, "Failed to spawn command", failure.cause),
          ),
        )

      const consumeOutput = handle.output.pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
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
          const { _tag: tag } = failure
          return tag === "ProcessOutputError"
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

      const timeoutMs = request.timeoutMs
      const [, , , outputFailure, terminal] = yield* timeoutMs === null
        ? execution
        : Effect.raceFirst(
            execution,
            Effect.sleep(timeoutMs).pipe(
              Effect.zipRight(handle.terminate),
              Effect.zipRight(handle.awaitTerminal),
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
  const { _tag: terminalTag } = terminal
  if (terminalTag === "NodeProcessSpawnFailed") {
    return processSpawnError(request, capture, "Failed to spawn command", terminal.cause)
  }
  if (terminal.code !== 0 || terminal.signal !== null) {
    const message =
      terminal.code === null
        ? `Command terminated by ${terminal.signal ?? "an unknown signal"}`
        : `Command exited with code ${terminal.code}`
    return ProcessExitError.make({
      ...diagnostics(request, capture, terminal.code, terminal.signal),
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
    Effect.flatMap((first) => {
      const { _tag: firstTag } = first
      if (firstTag === "Terminal") return Effect.succeed(first.terminal)
      return Effect.raceFirst(
        handle.awaitTerminal.pipe(
          Effect.map((terminal) => ({ _tag: "Terminal" as const, terminal })),
        ),
        Effect.sleep(options.exitCloseAfterMs).pipe(Effect.as({ _tag: "CloseTimeout" as const })),
      ).pipe(
        Effect.flatMap((afterExit) => {
          const { _tag: afterExitTag } = afterExit
          if (afterExitTag === "Terminal") return Effect.succeed(afterExit.terminal)
          return handle.terminate.pipe(
            Effect.zipRight(handle.awaitTerminal),
            Effect.flatMap((terminal) =>
              ProcessCleanupError.make({
                ...terminalDiagnostics(request, capture, terminal),
                message: "Command cleanup reached its termination deadline before stdio closed",
              }),
            ),
          )
        }),
      )
    }),
  )

const resolveOutputPolicy = (policy: ProcessOutputPolicy, source: ProcessOutputSource) => ({
  maxBytes: nonNegativeInteger(policy.maxBytes, `${source}.maxBytes`),
  overflow: policy.overflow,
})

const nonNegativeInteger = (value: number, option: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OptionError(option, `${option} must be a non-negative safe integer`)
  }
  return value
}

const positiveInteger = (value: number, option: string): number => {
  nonNegativeInteger(value, option)
  if (value === 0) throw new OptionError(option, `${option} must be greater than zero`)
  return value
}

class OptionError extends Error {
  constructor(
    readonly option: string,
    message: string,
  ) {
    super(message)
  }
}

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
  const { _tag: terminalTag } = terminal
  return terminalTag === "NodeProcessClosed"
    ? diagnostics(request, capture, terminal.code, terminal.signal)
    : diagnostics(request, capture, null, null)
}

const invalidOptionsError = (request: ProcessRequest, cause: unknown) =>
  InvalidProcessOptionsError.make({
    ...diagnostics(request, null, null, null),
    option: cause instanceof OptionError ? cause.option : "request",
    message: cause instanceof Error ? cause.message : "Invalid process request",
    cause,
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
    cause,
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

const processOutputError = (request: ProcessRequest, capture: BoundedOutput, cause: unknown) => {
  const limit =
    cause instanceof NodeProcessIoFailure
      ? "io"
      : typeof cause === "object" && cause !== null && "limit" in cause
        ? String(cause.limit)
        : "io"
  const source =
    typeof cause === "object" && cause !== null && "source" in cause
      ? cause.source === "stdout" || cause.source === "stderr"
        ? cause.source
        : null
      : null
  return ProcessOutputError.make({
    ...diagnostics(request, capture, null, null),
    source,
    limit:
      limit === "capture-bytes" ||
      limit === "events" ||
      limit === "line-bytes" ||
      limit === "stream-bytes"
        ? limit
        : "io",
    message: cause instanceof Error ? cause.message : "Failed while consuming subprocess output",
    cause: cause instanceof NodeProcessIoFailure ? cause.cause : cause,
  })
}
