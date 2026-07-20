import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import { delimiter, join, resolve } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { Context, Data, Deferred, Effect, Layer, Runtime, Stream, type Scope } from "effect"

import type { ProcessOutputPolicy, ProcessOutputSource } from "./process"

/** Fully validated process options consumed by the private Node adapter and output codecs. */
export interface ResolvedProcessOptions {
  readonly stdout: ProcessOutputPolicy
  readonly stderr: ProcessOutputPolicy
  readonly killAfterMs: number
  readonly forceKillAfterMs: number
  readonly exitCloseAfterMs: number
  readonly maxLineBytes: number
  readonly maxStreamBytes: number
  readonly maxStreamEvents: number
  readonly maxBufferedEvents: number
}

/** Complete request passed to the private Node process adapter. */
export interface SpawnProcessInput {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string | null
  readonly stdin: string | null
  readonly env: Readonly<Record<string, string>>
  readonly unsetEnv: readonly string[]
  readonly options: ResolvedProcessOptions
  readonly capture: BoundedOutput
}

/** One source-tagged byte chunk read from a child process. */
export interface NodeProcessChunk {
  readonly source: ProcessOutputSource
  readonly bytes: Buffer
}

/** Asynchronous Node process creation failed. */
export class NodeProcessSpawnFailed extends Data.TaggedClass("NodeProcessSpawnFailed")<{
  readonly cause: unknown
}> {}

/** The child closed its inherited stdio and produced terminal process metadata. */
export class NodeProcessClosed extends Data.TaggedClass("NodeProcessClosed")<{
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}> {}

/** Terminal state observed by the private Node process adapter. */
export type NodeProcessTerminal = NodeProcessSpawnFailed | NodeProcessClosed

/** Reading one of the child process output pipes failed. */
export class NodeProcessIoFailure extends Data.TaggedClass("NodeProcessIoFailure")<{
  readonly source: ProcessOutputSource
  readonly cause: unknown
}> {}

/** Writing or closing child process stdin failed. */
export class NodeProcessStdinFailure extends Data.TaggedClass("NodeProcessStdinFailure")<{
  readonly cause: unknown
}> {}

/** Scoped handle returned by the private Node process adapter. */
export interface NodeProcessHandle {
  readonly output: Stream.Stream<NodeProcessChunk, NodeProcessIoFailure>
  readonly writeStdin: Effect.Effect<void, NodeProcessStdinFailure>
  readonly monitorStdin: Effect.Effect<void, NodeProcessStdinFailure>
  readonly monitorOutput: Effect.Effect<ProcessLimitFailure | null>
  readonly awaitExit: Effect.Effect<void>
  readonly awaitTerminal: Effect.Effect<NodeProcessTerminal>
  readonly terminate: Effect.Effect<void>
}

/** Private leaf service containing the unavoidable Node callback and process-signal boundary. */
export class NodeProcessSpawner extends Context.Tag("@diffdash/process/NodeProcessSpawner")<
  NodeProcessSpawner,
  {
    readonly spawn: (
      input: SpawnProcessInput,
    ) => Effect.Effect<NodeProcessHandle, NodeProcessSpawnFailed, Scope.Scope>
  }
>() {
  static readonly layer = Layer.succeed(
    NodeProcessSpawner,
    NodeProcessSpawner.of({ spawn: spawnNode }),
  )
}

/** A bounded snapshot of one output channel. */
export interface ProcessOutputSnapshot {
  readonly text: string
  readonly truncated: boolean
}

/** Independently bounded stdout and stderr retained for results and diagnostics. */
export interface ProcessOutput {
  readonly stdout: ProcessOutputSnapshot
  readonly stderr: ProcessOutputSnapshot
}

/** Internal output-limit violation raised by synchronous byte and line codecs. */
export class ProcessLimitFailure extends Error {
  constructor(
    readonly limit: "capture-bytes" | "events" | "line-bytes" | "stream-bytes",
    readonly source: ProcessOutputSource | null,
    message: string,
  ) {
    super(message)
  }
}

class BoundedByteOutput {
  readonly #chunks: Buffer[] = []
  #capturedBytes = 0
  #truncated = false

  constructor(
    readonly source: ProcessOutputSource,
    readonly policy: ProcessOutputPolicy,
  ) {}

  append(chunk: Buffer): void {
    if (chunk.length === 0) return
    const remaining = this.policy.maxBytes - this.#capturedBytes
    const capturedLength = Math.min(chunk.length, remaining)
    if (capturedLength > 0) {
      // Copy the prefix so a tiny retained slice cannot keep a large Node read buffer alive.
      this.#chunks.push(Buffer.from(chunk.subarray(0, capturedLength)))
      this.#capturedBytes += capturedLength
    }
    if (capturedLength === chunk.length) return
    this.#truncated = true
    if (this.policy.overflow === "error") {
      throw new ProcessLimitFailure(
        "capture-bytes",
        this.source,
        `Command ${this.source} exceeded its configured capture budget`,
      )
    }
  }

  snapshot(): ProcessOutputSnapshot {
    const decoder = new StringDecoder("utf8")
    const text = decoder.write(Buffer.concat(this.#chunks, this.#capturedBytes))
    return {
      // A truncated capture intentionally omits an incomplete trailing UTF-8 sequence.
      text: this.#truncated ? text : text + decoder.end(),
      truncated: this.#truncated,
    }
  }
}

/** Synchronous, single-owner byte accumulator shared by captured and streamed execution. */
export class BoundedOutput {
  readonly #stdout: BoundedByteOutput
  readonly #stderr: BoundedByteOutput

  constructor(stdout: ProcessOutputPolicy, stderr: ProcessOutputPolicy) {
    this.#stdout = new BoundedByteOutput("stdout", stdout)
    this.#stderr = new BoundedByteOutput("stderr", stderr)
  }

  append(source: ProcessOutputSource, chunk: Buffer): void {
    return source === "stdout" ? this.#stdout.append(chunk) : this.#stderr.append(chunk)
  }

  snapshot(): ProcessOutput {
    return { stdout: this.#stdout.snapshot(), stderr: this.#stderr.snapshot() }
  }
}

class BoundedLineDecoder {
  readonly #chunks: Buffer[] = []
  #bytes = 0

  constructor(
    readonly source: ProcessOutputSource,
    readonly maxLineBytes: number,
  ) {}

  write(chunk: Buffer): readonly string[] {
    const lines: string[] = []
    let offset = 0
    while (offset < chunk.length) {
      const newlineIndex = chunk.indexOf(0x0a, offset)
      const end = newlineIndex < 0 ? chunk.length : newlineIndex
      this.#append(chunk.subarray(offset, end))
      if (newlineIndex < 0) return lines
      lines.push(this.#takeLine())
      offset = newlineIndex + 1
    }
    return lines
  }

  end(): readonly string[] {
    return this.#bytes === 0 ? [] : [this.#takeLine()]
  }

  #append(segment: Buffer): void {
    if (segment.length === 0) return
    if (segment.length > this.maxLineBytes - this.#bytes) {
      throw new ProcessLimitFailure(
        "line-bytes",
        this.source,
        `${this.source} line exceeded ${this.maxLineBytes} bytes`,
      )
    }
    this.#chunks.push(Buffer.from(segment))
    this.#bytes += segment.length
  }

  #takeLine(): string {
    let lineBytes = Buffer.concat(this.#chunks, this.#bytes)
    this.#chunks.length = 0
    this.#bytes = 0
    if (lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, lineBytes.length - 1)
    return lineBytes.toString("utf8")
  }
}

/** Synchronous source-aware line framing and aggregate stream limit enforcement. */
export class StreamOutputDecoder {
  readonly #stdout: BoundedLineDecoder
  readonly #stderr: BoundedLineDecoder
  #streamBytes = 0
  #events = 0

  constructor(
    readonly options: Pick<
      ResolvedProcessOptions,
      "maxLineBytes" | "maxStreamBytes" | "maxStreamEvents"
    >,
  ) {
    this.#stdout = new BoundedLineDecoder("stdout", options.maxLineBytes)
    this.#stderr = new BoundedLineDecoder("stderr", options.maxLineBytes)
  }

  write(source: ProcessOutputSource, chunk: Buffer) {
    if (chunk.length > this.options.maxStreamBytes - this.#streamBytes) {
      throw new ProcessLimitFailure(
        "stream-bytes",
        source,
        `Subprocess stream exceeded ${this.options.maxStreamBytes} total bytes`,
      )
    }
    this.#streamBytes += chunk.length
    return this.#bounded(
      source,
      source === "stdout" ? this.#stdout.write(chunk) : this.#stderr.write(chunk),
    )
  }

  end() {
    return [
      ...this.#bounded("stdout", this.#stdout.end()),
      ...this.#bounded("stderr", this.#stderr.end()),
    ]
  }

  #bounded(source: ProcessOutputSource, lines: readonly string[]) {
    if (lines.length > this.options.maxStreamEvents - this.#events) {
      throw new ProcessLimitFailure(
        "events",
        source,
        `Subprocess stream exceeded ${this.options.maxStreamEvents} line events`,
      )
    }
    this.#events += lines.length
    return lines.map((line) => ({ _tag: "ProcessLine" as const, source, line }))
  }
}

function spawnNode(
  input: SpawnProcessInput,
): Effect.Effect<NodeProcessHandle, NodeProcessSpawnFailed, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const terminal = yield* Deferred.make<NodeProcessTerminal>()
      const exited = yield* Deferred.make<void>()
      const stdinFailed = yield* Deferred.make<never, NodeProcessStdinFailure>()
      const outputFailed = yield* Deferred.make<ProcessLimitFailure>()
      const runtime = yield* Effect.runtime<never>()
      const runFork = Runtime.runFork(runtime)
      const child = yield* Effect.try({
        try: () => spawnChild(input),
        catch: (cause) => new NodeProcessSpawnFailed({ cause }),
      })

      const onError = (cause: Error) => {
        runFork(Deferred.succeed(terminal, new NodeProcessSpawnFailed({ cause })))
      }
      const onExit = () => {
        runFork(Deferred.succeed(exited, undefined))
      }
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        runFork(Deferred.succeed(terminal, new NodeProcessClosed({ code, signal })))
      }
      const onStdinError = (cause: Error) => {
        runFork(Deferred.fail(stdinFailed, new NodeProcessStdinFailure({ cause })))
      }
      child.once("error", onError)
      child.once("exit", onExit)
      child.once("close", onClose)
      child.stdin.on("error", onStdinError)

      const output = outputChunks(
        child,
        input.options.maxBufferedEvents,
        input.capture,
        (failure) => {
          runFork(Deferred.succeed(outputFailed, failure))
        },
      )
      const terminate = terminateChild(child, terminal, input.options)
      const writeStdin = writeChildStdin(child, input.stdin)
      const monitorStdin = Effect.raceFirst(
        Deferred.await(stdinFailed),
        Deferred.await(terminal).pipe(Effect.asVoid),
      )
      const monitorOutput = Effect.raceFirst(
        Deferred.await(outputFailed).pipe(
          Effect.map((failure) => ({ _tag: "Failed" as const, failure })),
        ),
        Deferred.await(terminal).pipe(Effect.as({ _tag: "Terminal" as const })),
      ).pipe(
        Effect.flatMap((state) => {
          const { _tag: stateTag } = state
          return stateTag === "Terminal"
            ? Effect.succeed(null)
            : terminate.pipe(Effect.zipRight(Deferred.await(terminal)), Effect.as(state.failure))
        }),
      )

      return {
        handle: NodeProcessHandleValue({
          output,
          writeStdin,
          monitorStdin,
          monitorOutput,
          awaitExit: Deferred.await(exited),
          awaitTerminal: Deferred.await(terminal),
          terminate,
        }),
        release: terminate.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              child.off("error", onError)
              child.off("exit", onExit)
              child.off("close", onClose)
              child.stdin.off("error", onStdinError)
            }),
          ),
        ),
      }
    }),
    ({ release }) => release,
  ).pipe(Effect.map(({ handle }) => handle))
}

const NodeProcessHandleValue = (handle: NodeProcessHandle): NodeProcessHandle => handle

const outputChunks = (
  child: ChildProcessWithoutNullStreams,
  bufferSize: number,
  capture: BoundedOutput,
  onLimit: (failure: ProcessLimitFailure) => void,
): Stream.Stream<NodeProcessChunk, NodeProcessIoFailure> =>
  Stream.asyncScoped<NodeProcessChunk, NodeProcessIoFailure>(
    (emit) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          let active = true
          let pending = Promise.resolve()
          const ended = new Set<ProcessOutputSource>()
          const pause = () => {
            child.stdout.pause()
            child.stderr.pause()
          }
          const resume = () => {
            if (!active) return
            child.stdout.resume()
            child.stderr.resume()
          }
          const enqueue = (effect: () => Promise<void>) => {
            pause()
            pending = pending
              .then(effect, effect)
              .catch(() => undefined)
              .finally(resume)
          }
          const onData = (source: ProcessOutputSource) => (bytes: Buffer) => {
            const copied = Buffer.from(bytes)
            try {
              capture.append(source, copied)
            } catch (cause) {
              if (cause instanceof ProcessLimitFailure) onLimit(cause)
            }
            enqueue(() => emit.single({ source, bytes: copied }))
          }
          const onError = (source: ProcessOutputSource) => (cause: Error) =>
            enqueue(() => emit.fail(new NodeProcessIoFailure({ source, cause })))
          const onEnd = (source: ProcessOutputSource) => () => {
            ended.add(source)
            if (ended.size === 2) enqueue(() => emit.end())
          }
          const onStdoutData = onData("stdout")
          const onStderrData = onData("stderr")
          const onStdoutError = onError("stdout")
          const onStderrError = onError("stderr")
          const onStdoutEnd = onEnd("stdout")
          const onStderrEnd = onEnd("stderr")
          child.stdout.on("data", onStdoutData)
          child.stderr.on("data", onStderrData)
          child.stdout.once("error", onStdoutError)
          child.stderr.once("error", onStderrError)
          child.stdout.once("end", onStdoutEnd)
          child.stderr.once("end", onStderrEnd)
          if (child.stdout.readableEnded) onStdoutEnd()
          if (child.stderr.readableEnded) onStderrEnd()

          return () => {
            active = false
            child.stdout.off("data", onStdoutData)
            child.stderr.off("data", onStderrData)
            child.stdout.off("error", onStdoutError)
            child.stderr.off("error", onStderrError)
            child.stdout.off("end", onStdoutEnd)
            child.stderr.off("end", onStderrEnd)
          }
        }),
        (removeListeners) => Effect.sync(removeListeners),
      ),
    { bufferSize, strategy: "suspend" },
  )

const writeChildStdin = (
  child: ChildProcessWithoutNullStreams,
  stdin: string | null,
): Effect.Effect<void, NodeProcessStdinFailure> =>
  Effect.async<void, NodeProcessStdinFailure>((resume) => {
    let settled = false
    const finish = (effect: Effect.Effect<void, NodeProcessStdinFailure>) => {
      if (settled) return
      settled = true
      resume(effect)
    }
    try {
      child.stdin.end(stdin ?? undefined, () => finish(Effect.void))
    } catch (cause) {
      finish(Effect.fail(new NodeProcessStdinFailure({ cause })))
    }
  })

const terminateChild = (
  child: ChildProcessWithoutNullStreams,
  terminal: Deferred.Deferred<NodeProcessTerminal>,
  options: ResolvedProcessOptions,
): Effect.Effect<void> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (yield* Deferred.isDone(terminal)) return
      yield* signalProcessTree(child, false)
      const gracefullyClosed = yield* restore(waitForTerminal(terminal, options.killAfterMs))
      if (gracefullyClosed) return
      yield* signalProcessTree(child, true)
      const forciblyClosed = yield* restore(waitForTerminal(terminal, options.forceKillAfterMs))
      if (forciblyClosed) return
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      yield* Deferred.succeed(terminal, new NodeProcessClosed({ code: null, signal: "SIGKILL" }))
    }),
  )

const waitForTerminal = (terminal: Deferred.Deferred<NodeProcessTerminal>, durationMs: number) =>
  Effect.raceFirst(
    Deferred.await(terminal).pipe(Effect.as(true), Effect.interruptible),
    Effect.sleep(durationMs).pipe(Effect.as(false), Effect.interruptible),
  )

const spawnChild = (input: SpawnProcessInput): ChildProcessWithoutNullStreams => {
  const env = { ...process.env, ...input.env }
  for (const key of input.unsetEnv) delete env[key]
  env.PATH = executablePath(env.PATH, env.HOME)
  return spawn(input.command, [...input.args], {
    cwd: input.cwd ?? undefined,
    detached: process.platform !== "win32",
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
}

/** Builds the normalized executable path shared by process execution and lookup. */
export const executablePath = (envPath = "", home = process.env.HOME ?? "") => {
  const pathDirectories = envPath.split(delimiter).filter((entry) => entry.length > 0)
  const supplementalDirectories = [
    home.length > 0 ? join(home, ".local", "bin") : "",
    home.length > 0 ? join(home, "bin") : "",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((entry) => entry.length > 0)

  const seen = new Set<string>()
  return [...pathDirectories, ...supplementalDirectories]
    .filter((entry) => {
      const resolved = resolve(entry)
      if (seen.has(resolved)) return false
      seen.add(resolved)
      return true
    })
    .join(delimiter)
}

const signalProcessTree = (
  child: ChildProcessWithoutNullStreams,
  force: boolean,
): Effect.Effect<void> =>
  Effect.sync(() => {
    const signal = force ? "SIGKILL" : "SIGTERM"
    const pid = child.pid
    if (process.platform === "win32" && pid !== undefined) {
      const taskkill = spawnSync(
        "taskkill",
        ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
        { stdio: "ignore", timeout: 1_000, windowsHide: true },
      )
      if (taskkill.error === undefined && taskkill.status === 0) return
    } else if (pid !== undefined) {
      try {
        process.kill(-pid, signal)
        return
      } catch {
        // The group can disappear between observation and signaling; fall back to the child.
      }
    }

    try {
      child.kill(signal)
    } catch {
      // Cleanup remains finite even when the direct child can no longer be signaled.
    }
  })
