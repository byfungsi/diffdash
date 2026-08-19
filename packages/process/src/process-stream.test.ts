import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Result, Fiber, Stream } from "effect"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ProcessOutputError,
  ProcessCancellationError,
  ProcessService,
  ProcessSpawnError,
  ProcessStdinError,
  ProcessTimeoutError,
  processRequest,
  type ProcessEvent,
  type ProcessRequestOptions,
  type ProcessByteStreamOptions,
  type ProcessStreamMetrics,
} from "./process"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-cli-stream-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const streamCli = (command: string, args: readonly string[], options?: ProcessRequestOptions) =>
  Stream.unwrap(
    ProcessService.pipe(
      Effect.map((processes) => processes.streamLines(processRequest(command, args, options))),
      Effect.provide(ProcessService.layer),
    ),
  )

const streamBytes = (
  command: string,
  args: readonly string[],
  options?: ProcessRequestOptions,
  streamOptions?: ProcessByteStreamOptions,
) =>
  Stream.unwrap(
    ProcessService.pipe(
      Effect.map((processes) =>
        processes.streamBytes(processRequest(command, args, options), streamOptions),
      ),
      Effect.provide(ProcessService.layer),
    ),
  )

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForProcessExit = (pid: number, attemptsRemaining = 200): Promise<void> => {
  if (!processIsRunning(pid)) return Promise.resolve()
  if (attemptsRemaining === 0) return Promise.reject(new Error(`Timed out waiting for PID ${pid}`))
  return new Promise((resolve) => setTimeout(resolve, 10)).then(() =>
    waitForProcessExit(pid, attemptsRemaining - 1),
  )
}

const waitForFile = (path: string, attemptsRemaining = 200): Promise<void> => {
  if (existsSync(path)) return Promise.resolve()
  if (attemptsRemaining === 0) return Promise.reject(new Error(`Timed out waiting for ${path}`))
  return new Promise((resolve) => setTimeout(resolve, 10)).then(() =>
    waitForFile(path, attemptsRemaining - 1),
  )
}

describe("ProcessService line streaming", () => {
  it.live("emits ordered complete UTF-8 lines across chunk boundaries", () =>
    Effect.gen(function* () {
      const script = `
        const value = Buffer.from('😀')
        process.stdout.write(value.subarray(0, 2))
        setTimeout(() => {
          process.stdout.write(Buffer.concat([value.subarray(2), Buffer.from('\\r\\nnext\\n')]))
          setTimeout(() => process.stderr.end('warning\\r\\n'), 20)
        }, 20)
      `
      const events = yield* streamCli(process.execPath, ["-e", script]).pipe(Stream.runCollect)

      expect(events.slice(0, 3)).toEqual([
        { _tag: "ProcessLine", source: "stdout", line: "😀" },
        { _tag: "ProcessLine", source: "stdout", line: "next" },
        { _tag: "ProcessLine", source: "stderr", line: "warning" },
      ])
      const exit = events.at(-1)
      expect(exit).toBeDefined()
      if (exit === undefined) return
      const { _tag: exitTag } = exit
      expect(exitTag).toBe("ProcessExit")
      if (exitTag === "ProcessExit") {
        expect(exit.result.stdout).toBe("😀\r\nnext\n")
        expect(exit.result.stderr).toBe("warning\r\n")
        expect(exit.result.outputTruncated).toBe(false)
      }
    }),
  )

  it.live("preserves GUI PATH, cwd, environment, and stdin behavior", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectory
      const cwd = join(home, "worktree")
      const localBin = join(home, ".local", "bin")
      const commandPath = join(localBin, "diffdash-stream-command")
      yield* Effect.sync(() => {
        mkdirSync(cwd, { recursive: true })
        mkdirSync(localBin, { recursive: true })
        writeFileSync(
          commandPath,
          '#!/bin/sh\nIFS= read -r input\nprintf "%s|%s|%s\\n" "$PWD" "$DIFFDASH_VALUE" "$input"\n',
          "utf8",
        )
        chmodSync(commandPath, 0o755)
      })

      const events = yield* streamCli("diffdash-stream-command", [], {
        cwd,
        env: { DIFFDASH_VALUE: "from-env", HOME: home, PATH: "" },
        stdin: "from-stdin\n",
      }).pipe(Stream.runCollect)

      expect(events[0]).toEqual({
        _tag: "ProcessLine",
        source: "stdout",
        line: `${realpathSync(cwd)}|from-env|from-stdin`,
      })
    }),
  )

  it.live("accepts exact newline-free line bytes and fails one byte over", () =>
    Effect.gen(function* () {
      const exact = yield* streamCli(process.execPath, ["-e", "process.stdout.write('abcde')"], {
        maxLineBytes: 5,
      }).pipe(Stream.runCollect)
      expect(exact[0]).toEqual({ _tag: "ProcessLine", source: "stdout", line: "abcde" })
      expect(exact.at(-1)).toMatchObject({ _tag: "ProcessExit" })

      const over = yield* Effect.result(
        streamCli(process.execPath, ["-e", "process.stdout.write('abcdef')"], {
          maxLineBytes: 5,
          killAfterMs: 25,
          forceKillAfterMs: 25,
        }).pipe(Stream.runCollect),
      )
      expect(Result.isFailure(over)).toBe(true)
      if (Result.isFailure(over)) {
        expect(over.failure).toBeInstanceOf(ProcessOutputError)
        expect(over.failure.message).toBe("stdout line exceeded 5 bytes")
      }
    }),
  )

  it.live("enforces exact total stream bytes and event counts", () =>
    Effect.gen(function* () {
      const exactBytes = yield* streamCli(
        process.execPath,
        ["-e", "process.stdout.write('abc\\n')"],
        {
          maxStreamBytes: 4,
        },
      ).pipe(Stream.runCollect)
      expect(exactBytes[0]).toEqual({ _tag: "ProcessLine", source: "stdout", line: "abc" })

      const overBytes = yield* Effect.result(
        streamCli(process.execPath, ["-e", "process.stdout.write('abc\\n')"], {
          maxStreamBytes: 3,
          killAfterMs: 25,
          forceKillAfterMs: 25,
        }).pipe(Stream.runCollect),
      )
      expect(Result.isFailure(overBytes)).toBe(true)
      if (Result.isFailure(overBytes)) {
        expect(overBytes.failure.message).toBe("Subprocess stream exceeded 3 total bytes")
      }

      const exactEvents = yield* streamCli(
        process.execPath,
        ["-e", "process.stdout.write('a\\nb\\n')"],
        {
          maxStreamEvents: 2,
        },
      ).pipe(Stream.runCollect)
      expect(
        exactEvents.filter((event) => {
          const { _tag: tag } = event
          return tag === "ProcessLine"
        }),
      ).toHaveLength(2)

      const overEvents = yield* Effect.result(
        streamCli(process.execPath, ["-e", "process.stdout.write('a\\nb\\n')"], {
          maxStreamEvents: 1,
          killAfterMs: 25,
          forceKillAfterMs: 25,
        }).pipe(Stream.runCollect),
      )
      expect(Result.isFailure(overEvents)).toBe(true)
      if (Result.isFailure(overEvents)) {
        expect(overEvents.failure.message).toBe("Subprocess stream exceeded 1 line events")
      }
    }),
  )

  it.live("retains independent bounded diagnostics while emitting complete lines", () =>
    Effect.gen(function* () {
      const emitted: ProcessEvent[] = []
      const script = `
        process.stdout.write('abcdef\\n')
        process.stderr.write('diagnostic')
        process.exitCode = 7
      `
      const result = yield* Effect.result(
        streamCli(process.execPath, ["-e", script], {
          stdout: { maxBytes: 5, overflow: "truncate" },
          stderr: { maxBytes: 10, overflow: "truncate" },
        }).pipe(Stream.runForEach((event) => Effect.sync(() => emitted.push(event)))),
      )

      expect(emitted).toEqual([
        { _tag: "ProcessLine", source: "stdout", line: "abcdef" },
        { _tag: "ProcessLine", source: "stderr", line: "diagnostic" },
      ])
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "ProcessExitError",
          exitCode: 7,
          stdout: "abcde",
          stderr: "diagnostic",
          stdoutTruncated: true,
          stderrTruncated: false,
        })
      }
    }),
  )

  it.live("pauses Node pipes behind a slow consumer without dropping events", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const marker = join(directory, "backpressure")
      const lineCount = 2_000
      const script = `
        const fs = require('node:fs')
        const line = 'x'.repeat(512) + '\\n'
        for (let index = 0; index < ${lineCount}; index += 1) {
          if (!process.stdout.write(line)) fs.writeFileSync(process.env.MARKER, 'paused')
        }
      `
      let consumed = 0
      let delayed = false
      yield* streamCli(process.execPath, ["-e", script], {
        env: { MARKER: marker },
        maxBufferedEvents: 1,
        maxLineBytes: 512,
        maxStreamBytes: 2 * 1024 * 1024,
        maxStreamEvents: lineCount,
      }).pipe(
        Stream.runForEach((event) => {
          const { _tag: tag } = event
          if (tag !== "ProcessLine") return Effect.void
          consumed += 1
          if (delayed) return Effect.void
          delayed = true
          return Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 100)))
        }),
      )

      expect(consumed).toBe(lineCount)
      expect(readFileSync(marker, "utf8")).toBe("paused")
    }),
  )

  it.live("reports spawn and stdin write failures", () =>
    Effect.gen(function* () {
      const spawnResult = yield* Effect.result(
        streamCli("diffdash-stream-command-that-does-not-exist", []).pipe(Stream.runCollect),
      )
      expect(Result.isFailure(spawnResult)).toBe(true)
      if (Result.isFailure(spawnResult)) {
        expect(spawnResult.failure).toBeInstanceOf(ProcessSpawnError)
        expect(spawnResult.failure.cause).not.toBeNull()
      }

      const closeStdinScript = `
        require('node:fs').closeSync(0)
        setInterval(() => {}, 1_000)
      `
      const stdinResult = yield* Effect.result(
        streamCli(process.execPath, ["-e", closeStdinScript], {
          stdin: "x".repeat(2 * 1024 * 1024),
          timeoutMs: 5_000,
          killAfterMs: 25,
          forceKillAfterMs: 25,
        }).pipe(Stream.runCollect),
      )
      expect(Result.isFailure(stdinResult)).toBe(true)
      if (Result.isFailure(stdinResult)) {
        expect(stdinResult.failure).toBeInstanceOf(ProcessStdinError)
        expect(stdinResult.failure.message).toBe("Failed to write command stdin")
        expect(stdinResult.failure.cause).not.toBeNull()
      }
    }),
  )

  it.live("times out and escalates the process group from SIGTERM to SIGKILL", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const marker = join(directory, "timeout-sigterm")
      const script = `
        const fs = require('node:fs')
        process.on('SIGTERM', () => fs.writeFileSync(process.env.MARKER, 'SIGTERM'))
        process.stdout.write(String(process.pid) + '\\n')
        setInterval(() => {}, 1_000)
      `
      const result = yield* Effect.result(
        streamCli(process.execPath, ["-e", script], {
          env: { MARKER: marker },
          killAfterMs: 500,
          forceKillAfterMs: 500,
          timeoutMs: 1_000,
        }).pipe(Stream.runCollect),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(ProcessTimeoutError)
        expect(result.failure.signal).toBe("SIGKILL")
        const pid = Number.parseInt(result.failure.stdout, 10)
        expect(processIsRunning(pid)).toBe(false)
      }
      expect(readFileSync(marker, "utf8")).toBe("SIGTERM")
    }),
  )

  it.live("terminates and escalates when stream consumption is interrupted", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const marker = join(directory, "interrupt-sigterm")
      const pidReady = yield* Deferred.make<number>()
      const script = `
        const fs = require('node:fs')
        process.on('SIGTERM', () => fs.writeFileSync(process.env.MARKER, 'SIGTERM'))
        process.stdout.write(String(process.pid) + '\\n')
        setInterval(() => {}, 1_000)
      `
      const fiber = yield* streamCli(process.execPath, ["-e", script], {
        env: { MARKER: marker },
        killAfterMs: 500,
        forceKillAfterMs: 500,
      }).pipe(
        Stream.tap((event) => {
          const { _tag: tag } = event
          return tag === "ProcessLine"
            ? Deferred.succeed(pidReady, Number.parseInt(event.line, 10))
            : Effect.void
        }),
        Stream.runDrain,
        Effect.forkChild,
      )
      const pid = yield* Deferred.await(pidReady)

      yield* Fiber.interrupt(fiber)

      yield* Effect.promise(() => waitForProcessExit(pid))
      expect(existsSync(marker)).toBe(true)
      expect(readFileSync(marker, "utf8")).toBe("SIGTERM")
      expect(processIsRunning(pid)).toBe(false)
    }),
  )
})

describe("ProcessService byte streaming", () => {
  it.live("streams output larger than the legacy total cap with bounded chunks", () =>
    Effect.gen(function* () {
      const outputBytes = 20 * 1024 * 1024
      const chunkBytes = 32 * 1024
      let observedBytes = 0
      let largestChunk = 0
      yield* streamBytes(
        process.execPath,
        ["-e", `process.stdout.write(Buffer.alloc(${outputBytes}, 120))`],
        {
          maxBufferedBytes: 128 * 1024,
          maxByteChunkBytes: chunkBytes,
          stdout: { maxBytes: 0, overflow: "truncate" },
        },
      ).pipe(
        Stream.runForEach((event) => {
          const { _tag: tag } = event
          if (tag === "ProcessExit") return Effect.void
          observedBytes += event.bytes.length
          largestChunk = Math.max(largestChunk, event.bytes.length)
          return Effect.void
        }),
      )

      expect(observedBytes).toBe(outputBytes)
      expect(largestChunk).toBeLessThanOrEqual(chunkBytes)
    }),
  )

  it.live("rejects a queue byte budget smaller than one chunk", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        streamBytes(process.execPath, ["-e", "process.stdout.write('x')"], {
          maxBufferedBytes: 1024,
          maxByteChunkBytes: 2048,
        }).pipe(Stream.runDrain),
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "InvalidProcessOptionsError",
          option: "maxBufferedBytes",
        })
      }
    }),
  )

  it.live("keeps exact queue and reservation budgets under a slow consumer", () =>
    Effect.gen(function* () {
      const chunkBytes = 16 * 1024
      const queueBytes = 2 * chunkBytes
      const snapshots: ProcessStreamMetrics[] = []
      let observedBytes = 0
      let delayed = false
      const script = `
        const chunk = Buffer.alloc(${chunkBytes}, 120)
        let remaining = 12 * 1024 * 1024
        const write = () => {
          while (remaining > 0) {
            const next = Math.min(remaining, chunk.length)
            remaining -= next
            if (!process.stdout.write(chunk.subarray(0, next))) return process.stdout.once('drain', write)
          }
        }
        write()
      `

      yield* streamBytes(
        process.execPath,
        ["-e", script],
        {
          maxBufferedBytes: queueBytes,
          maxReservedBytes: chunkBytes,
          maxByteChunkBytes: chunkBytes,
          stdout: { maxBytes: 0, overflow: "truncate" },
        },
        { observer: (metrics) => snapshots.push(metrics) },
      ).pipe(
        Stream.runForEach((event) => {
          if (event["_tag"] === "ProcessExit") return Effect.void
          observedBytes += event.bytes.length
          if (delayed) return Effect.void
          delayed = true
          return Effect.sleep(100)
        }),
      )

      expect(observedBytes).toBe(12 * 1024 * 1024)
      expect(Math.max(...snapshots.map((value) => value.queueBytes))).toBeLessThanOrEqual(
        queueBytes,
      )
      expect(Math.max(...snapshots.map((value) => value.queueDepth))).toBeLessThanOrEqual(2)
      expect(Math.max(...snapshots.map((value) => value.reservedBytes))).toBeLessThanOrEqual(
        chunkBytes,
      )
      expect(Math.max(...snapshots.map((value) => value.reservationUtilization))).toBe(1)
      expect(Math.max(...snapshots.map((value) => value.blockedDurationMs))).toBeGreaterThan(0)
    }),
  )

  it.live("drains saturated stderr independently and types stderr overflow", () =>
    Effect.gen(function* () {
      const script = `
        process.stderr.write(Buffer.alloc(4 * 1024 * 1024, 101))
        process.stdout.end('ok')
      `
      const events = yield* streamBytes(process.execPath, ["-e", script], {
        maxBufferedBytes: 64 * 1024,
        maxReservedBytes: 64 * 1024,
        maxByteChunkBytes: 16 * 1024,
        stderr: { maxBytes: 1024, overflow: "truncate" },
      }).pipe(Stream.runCollect)
      const stdout = events.find((event) => event["_tag"] === "ProcessByteChunk")
      expect(stdout?.["_tag"] === "ProcessByteChunk" ? Array.from(stdout.bytes) : []).toEqual([
        111, 107,
      ])
      expect(events.at(-1)).toMatchObject({
        _tag: "ProcessExit",
        result: { stderrTruncated: true },
      })

      const overflow = yield* Effect.result(
        streamBytes(process.execPath, ["-e", "process.stderr.write('overflow')"], {
          stderr: { maxBytes: 4, overflow: "error" },
          killAfterMs: 25,
          forceKillAfterMs: 25,
        }).pipe(Stream.runDrain),
      )
      expect(Result.isFailure(overflow)).toBe(true)
      if (Result.isFailure(overflow)) {
        expect(overflow.failure).toBeInstanceOf(ProcessOutputError)
        expect(overflow.failure).toMatchObject({ source: "stderr", limit: "capture-bytes" })
      }
    }),
  )

  it.live("returns typed cancellation and kills the complete process group", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const descendantPath = join(directory, "byte-stream-descendant")
      const cancellation = yield* Deferred.make<void>()
      const snapshots: ProcessStreamMetrics[] = []
      const script = `
        const { spawn } = require('node:child_process')
        const fs = require('node:fs')
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: ['ignore', 'inherit', 'inherit'],
        })
        fs.writeFileSync(process.env.DESCENDANT_PATH, String(child.pid))
        process.on('SIGTERM', () => {})
        process.stdout.write(String(process.pid))
        setInterval(() => {}, 1000)
      `
      let parentPid = 0
      const fiber = yield* streamBytes(
        process.execPath,
        ["-e", script],
        {
          env: { DESCENDANT_PATH: descendantPath },
          killAfterMs: 100,
          forceKillAfterMs: 100,
        },
        {
          cancellation: Deferred.await(cancellation),
          observer: (metrics) => snapshots.push(metrics),
        },
      ).pipe(
        Stream.tap((event) =>
          event["_tag"] === "ProcessByteChunk"
            ? Effect.sync(() => {
                parentPid = Number.parseInt(Buffer.from(event.bytes).toString("utf8"), 10)
              })
            : Effect.void,
        ),
        Stream.runDrain,
        Effect.result,
        Effect.forkChild,
      )
      yield* Effect.promise(() => waitForFile(descendantPath))
      yield* Deferred.succeed(cancellation, undefined)
      const result = yield* Fiber.join(fiber)
      const descendantPid = Number.parseInt(readFileSync(descendantPath, "utf8"), 10)

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(ProcessCancellationError)
      yield* Effect.promise(() => waitForProcessExit(parentPid))
      yield* Effect.promise(() => waitForProcessExit(descendantPid))
      expect(processIsRunning(parentPid)).toBe(false)
      expect(processIsRunning(descendantPid)).toBe(false)
      expect(snapshots.at(-1)).toMatchObject({
        queueBytes: 0,
        queueDepth: 0,
        reservedBytes: 0,
      })
      expect(snapshots.at(-1)?.cancellationAgeMs).toBeGreaterThanOrEqual(100)
    }),
  )
})
