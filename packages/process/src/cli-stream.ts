import { Context, Effect, Layer, Schema, Stream } from "effect"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

import { defaultExecutablePath, type CliRunOptions } from "./cli"

const defaultMaxOutputBytes = 1024 * 1024
const defaultKillAfterMs = 1_000

/** Identifies the subprocess stream that produced a line. */
export type CliOutputSource = "stdout" | "stderr"

/** A complete output line, without its trailing LF or CRLF delimiter. */
export interface CliLineEvent {
  readonly _tag: "CliLine"
  readonly source: CliOutputSource
  readonly line: string
}

/** Bounded output and exit metadata from a completed streaming subprocess. */
export interface CliStreamResult {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string | null
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly outputTruncated: boolean
  readonly exitCode: number
  readonly signal: string | null
}

/** The terminal event emitted after a streaming subprocess exits successfully. */
export interface CliExitEvent {
  readonly _tag: "CliExit"
  readonly result: CliStreamResult
}

/** An ordered line or successful completion event from a streaming subprocess. */
export type CliStreamEvent = CliLineEvent | CliExitEvent

/** The stage at which a streaming subprocess failed. */
export type CliStreamErrorReason = "spawn" | "exit" | "timeout"

/** A typed streaming subprocess failure with bounded diagnostic output. */
export class CliStreamError extends Schema.TaggedError<CliStreamError>()("CliStreamError", {
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
  reason: Schema.Literal("spawn", "exit", "timeout"),
  message: Schema.String,
  cause: Schema.NullOr(Schema.Defect),
}) {}

/** Options controlling streaming subprocess execution and cleanup. */
export interface CliStreamOptions extends CliRunOptions {
  /** Maximum combined stdout and stderr bytes retained for completion diagnostics. */
  readonly maxOutputBytes?: number
  /** Grace period after SIGTERM before escalating to SIGKILL. */
  readonly killAfterMs?: number
}

/** Shared shape for services capable of streaming local CLI commands. */
export interface CliStreamRunner {
  readonly stream: (
    command: string,
    args: readonly string[],
    options?: CliStreamOptions,
  ) => Stream.Stream<CliStreamEvent, CliStreamError>
}

class CapturedOutput {
  readonly #chunks: Record<CliOutputSource, Buffer[]> = { stdout: [], stderr: [] }
  readonly #truncated: Record<CliOutputSource, boolean> = { stdout: false, stderr: false }
  #remaining: number

  constructor(maxOutputBytes: number) {
    this.#remaining = maxOutputBytes
  }

  append(source: CliOutputSource, chunk: Buffer): void {
    if (chunk.length === 0) return

    const capturedLength = Math.min(chunk.length, this.#remaining)
    if (capturedLength > 0) {
      this.#chunks[source].push(chunk.subarray(0, capturedLength))
      this.#remaining -= capturedLength
    }
    if (capturedLength < chunk.length) this.#truncated[source] = true
  }

  text(source: CliOutputSource): string {
    return Buffer.concat(this.#chunks[source]).toString("utf8")
  }

  truncated(source: CliOutputSource): boolean {
    return this.#truncated[source]
  }
}

class LineDecoder {
  readonly #decoder = new StringDecoder("utf8")
  #pending = ""

  constructor(
    readonly source: CliOutputSource,
    readonly emit: (event: CliLineEvent) => void,
  ) {}

  write(chunk: Buffer): void {
    this.#pending += this.#decoder.write(chunk)
    this.#emitCompleteLines()
  }

  end(): void {
    this.#pending += this.#decoder.end()
    this.#emitCompleteLines()
    if (this.#pending.length === 0) return

    this.emit({
      _tag: "CliLine",
      source: this.source,
      line: this.#stripCarriageReturn(this.#pending),
    })
    this.#pending = ""
  }

  #emitCompleteLines(): void {
    let newlineIndex = this.#pending.indexOf("\n")
    while (newlineIndex >= 0) {
      this.emit({
        _tag: "CliLine",
        source: this.source,
        line: this.#stripCarriageReturn(this.#pending.slice(0, newlineIndex)),
      })
      this.#pending = this.#pending.slice(newlineIndex + 1)
      newlineIndex = this.#pending.indexOf("\n")
    }
  }

  #stripCarriageReturn(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line
  }
}

interface StreamEmitter {
  readonly single: (event: CliStreamEvent) => boolean
  readonly fail: (error: CliStreamError) => void
  readonly end: () => void
}

class RunningProcess {
  readonly #captured: CapturedOutput
  readonly #stdoutDecoder: LineDecoder
  readonly #stderrDecoder: LineDecoder
  readonly #onStdout: (chunk: Buffer) => void
  readonly #onStderr: (chunk: Buffer) => void
  readonly #onError: (cause: Error) => void
  readonly #onClose: (code: number | null, signal: NodeJS.Signals | null) => void
  readonly #onStdinError = (): void => undefined
  #timeout: ReturnType<typeof setTimeout> | undefined
  #killTimeout: ReturnType<typeof setTimeout> | undefined
  #disposeResolve: (() => void) | undefined
  #settled = false
  #disposing = false
  #timedOut = false

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly command: string,
    readonly args: readonly string[],
    readonly options: CliStreamOptions,
    readonly maxOutputBytes: number,
    readonly killAfterMs: number,
    readonly emitter: StreamEmitter,
  ) {
    this.#captured = new CapturedOutput(maxOutputBytes)
    this.#stdoutDecoder = new LineDecoder("stdout", (event) => void emitter.single(event))
    this.#stderrDecoder = new LineDecoder("stderr", (event) => void emitter.single(event))
    this.#onStdout = (chunk) => {
      this.#captured.append("stdout", chunk)
      this.#stdoutDecoder.write(chunk)
    }
    this.#onStderr = (chunk) => {
      this.#captured.append("stderr", chunk)
      this.#stderrDecoder.write(chunk)
    }
    this.#onError = (cause) => this.#handleError(cause)
    this.#onClose = (code, signal) => this.#handleClose(code, signal)

    child.stdout.on("data", this.#onStdout)
    child.stderr.on("data", this.#onStderr)
    child.stdin.on("error", this.#onStdinError)
    child.once("error", this.#onError)
    child.once("close", this.#onClose)

    if (options.timeoutMs !== undefined) {
      this.#timeout = setTimeout(() => {
        if (this.#settled || this.#disposing) return
        this.#timedOut = true
        this.#beginTermination()
      }, options.timeoutMs)
    }

    if (options.stdin !== undefined) child.stdin.write(options.stdin)
    child.stdin.end()
  }

  dispose(): Promise<void> {
    this.#clearTimeout()
    if (this.#settled) {
      this.#removeListeners()
      return Promise.resolve()
    }

    this.#disposing = true
    return new Promise((resolve) => {
      this.#disposeResolve = resolve
      this.#beginTermination()
    })
  }

  #beginTermination(): void {
    if (this.#settled || this.#killTimeout !== undefined) return

    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM")
      this.#killTimeout = setTimeout(() => {
        if (this.#settled) return
        if (this.child.exitCode === null && this.child.signalCode === null) {
          this.child.kill("SIGKILL")
        }
      }, this.killAfterMs)
    }
  }

  #handleError(cause: Error): void {
    if (this.#settled) return
    this.#settled = true
    this.#clearTimers()

    if (!this.#disposing) {
      this.emitter.fail(this.#makeError("spawn", null, null, "Failed to spawn command", cause))
    }
    this.#finishDispose()
  }

  #handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#settled) return
    this.#settled = true
    this.#clearTimers()

    if (!this.#disposing) {
      this.#stdoutDecoder.end()
      this.#stderrDecoder.end()

      if (this.#timedOut) {
        this.emitter.fail(
          this.#makeError(
            "timeout",
            code,
            signal,
            `Command timed out after ${this.options.timeoutMs}ms`,
            null,
          ),
        )
      } else if (code !== 0) {
        const message =
          code === null
            ? `Command terminated by ${signal ?? "an unknown signal"}`
            : `Command exited with code ${code}`
        this.emitter.fail(this.#makeError("exit", code, signal, message, null))
      } else {
        this.emitter.single({
          _tag: "CliExit",
          result: this.#makeResult(code, signal),
        })
        this.emitter.end()
      }
    }
    this.#finishDispose()
  }

  #makeResult(exitCode: number, signal: string | null): CliStreamResult {
    const stdoutTruncated = this.#captured.truncated("stdout")
    const stderrTruncated = this.#captured.truncated("stderr")
    return {
      command: this.command,
      args: this.args,
      cwd: this.options.cwd ?? null,
      stdout: this.#captured.text("stdout"),
      stderr: this.#captured.text("stderr"),
      stdoutTruncated,
      stderrTruncated,
      outputTruncated: stdoutTruncated || stderrTruncated,
      exitCode,
      signal,
    }
  }

  #makeError(
    reason: CliStreamErrorReason,
    exitCode: number | null,
    signal: string | null,
    message: string,
    cause: unknown,
  ): CliStreamError {
    const stdoutTruncated = this.#captured.truncated("stdout")
    const stderrTruncated = this.#captured.truncated("stderr")
    return CliStreamError.make({
      command: this.command,
      args: [...this.args],
      cwd: this.options.cwd ?? null,
      exitCode,
      signal,
      stdout: this.#captured.text("stdout"),
      stderr: this.#captured.text("stderr"),
      stdoutTruncated,
      stderrTruncated,
      outputTruncated: stdoutTruncated || stderrTruncated,
      reason,
      message,
      cause,
    })
  }

  #clearTimeout(): void {
    if (this.#timeout !== undefined) clearTimeout(this.#timeout)
    this.#timeout = undefined
  }

  #clearTimers(): void {
    this.#clearTimeout()
    if (this.#killTimeout !== undefined) clearTimeout(this.#killTimeout)
    this.#killTimeout = undefined
  }

  #finishDispose(): void {
    if (this.#disposing) this.#removeListeners()
    this.#disposeResolve?.()
    this.#disposeResolve = undefined
  }

  #removeListeners(): void {
    this.child.stdout.off("data", this.#onStdout)
    this.child.stderr.off("data", this.#onStderr)
    this.child.stdin.off("error", this.#onStdinError)
    this.child.off("error", this.#onError)
    this.child.off("close", this.#onClose)
  }
}

const nonNegativeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

const spawnError = (
  command: string,
  args: readonly string[],
  options: CliStreamOptions,
  cause: unknown,
): CliStreamError =>
  CliStreamError.make({
    command,
    args: [...args],
    cwd: options.cwd ?? null,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    outputTruncated: false,
    reason: "spawn",
    message: "Failed to spawn command",
    cause,
  })

/** Streams ordered complete lines and a terminal result from a scoped local subprocess. */
export const streamCli = (
  command: string,
  args: readonly string[],
  options: CliStreamOptions = {},
): Stream.Stream<CliStreamEvent, CliStreamError> =>
  Stream.asyncPush<CliStreamEvent, CliStreamError>(
    (emitter) =>
      Effect.acquireRelease(
        Effect.try({
          try: () => {
            const maxOutputBytes = nonNegativeInteger(
              options.maxOutputBytes ?? defaultMaxOutputBytes,
              "maxOutputBytes",
            )
            const killAfterMs = nonNegativeInteger(
              options.killAfterMs ?? defaultKillAfterMs,
              "killAfterMs",
            )
            if (options.timeoutMs !== undefined) {
              nonNegativeInteger(options.timeoutMs, "timeoutMs")
            }

            const env = { ...process.env, ...options.env }
            for (const key of options.unsetEnv ?? []) delete env[key]
            env.PATH = defaultExecutablePath(env.PATH, env.HOME)
            const child = spawn(command, [...args], {
              cwd: options.cwd,
              env,
              shell: false,
            })
            return new RunningProcess(
              child,
              command,
              args,
              options,
              maxOutputBytes,
              killAfterMs,
              emitter,
            )
          },
          catch: (cause) => spawnError(command, args, options, cause),
        }),
        (running) => Effect.promise(() => running.dispose()),
      ),
    { bufferSize: "unbounded" },
  )

/** Main-process service for scoped streaming local CLI commands. */
export class CliStreamService extends Context.Tag("@diffdash/CliStreamService")<
  CliStreamService,
  CliStreamRunner
>() {
  static readonly layer = Layer.succeed(
    CliStreamService,
    CliStreamService.of({ stream: streamCli }),
  )
}
