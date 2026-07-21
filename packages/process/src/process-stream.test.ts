import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Either, Fiber, Stream } from "effect"
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
  ProcessService,
  ProcessSpawnError,
  ProcessStdinError,
  ProcessTimeoutError,
  processRequest,
  type ProcessEvent,
  type ProcessRequestOptions,
} from "./process"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-cli-stream-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const collectEvents = (events: Iterable<ProcessEvent>) => Array.from(events)

const streamCli = (command: string, args: readonly string[], options?: ProcessRequestOptions) =>
  Stream.unwrap(
    ProcessService.pipe(
      Effect.map((processes) => processes.streamLines(processRequest(command, args, options))),
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
      const events = collectEvents(
        yield* streamCli(process.execPath, ["-e", script]).pipe(Stream.runCollect),
      )

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

  it.scopedLive("preserves GUI PATH, cwd, environment, and stdin behavior", () =>
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

      const events = collectEvents(
        yield* streamCli("diffdash-stream-command", [], {
          cwd,
          env: { DIFFDASH_VALUE: "from-env", HOME: home, PATH: "" },
          stdin: "from-stdin\n",
        }).pipe(Stream.runCollect),
      )

      expect(events[0]).toEqual({
        _tag: "ProcessLine",
        source: "stdout",
        line: `${realpathSync(cwd)}|from-env|from-stdin`,
      })
    }),
  )

  it.live("accepts exact newline-free line bytes and fails one byte over", () =>
    Effect.gen(function* () {
      const exact = collectEvents(
        yield* streamCli(process.execPath, ["-e", "process.stdout.write('abcde')"], {
          maxLineBytes: 5,
        }).pipe(Stream.runCollect),
      )
      expect(exact[0]).toEqual({ _tag: "ProcessLine", source: "stdout", line: "abcde" })
      expect(exact.at(-1)).toMatchObject({ _tag: "ProcessExit" })

      const over = yield* Effect.either(
        streamCli(process.execPath, ["-e", "process.stdout.write('abcdef')"], {
          maxLineBytes: 5,
          killAfterMs: 25,
          forceKillAfterMs: 25,
        }).pipe(Stream.runCollect),
      )
      expect(Either.isLeft(over)).toBe(true)
      if (Either.isLeft(over)) {
        expect(over.left).toBeInstanceOf(ProcessOutputError)
        expect(over.left.message).toBe("stdout line exceeded 5 bytes")
      }
    }),
  )

  it.live("enforces exact total stream bytes and event counts", () =>
    Effect.gen(function* () {
      const exactBytes = collectEvents(
        yield* streamCli(process.execPath, ["-e", "process.stdout.write('abc\\n')"], {
          maxStreamBytes: 4,
        }).pipe(Stream.runCollect),
      )
      expect(exactBytes[0]).toEqual({ _tag: "ProcessLine", source: "stdout", line: "abc" })

      const overBytes = yield* Effect.either(
        streamCli(process.execPath, ["-e", "process.stdout.write('abc\\n')"], {
          maxStreamBytes: 3,
          killAfterMs: 25,
          forceKillAfterMs: 25,
        }).pipe(Stream.runCollect),
      )
      expect(Either.isLeft(overBytes)).toBe(true)
      if (Either.isLeft(overBytes)) {
        expect(overBytes.left.message).toBe("Subprocess stream exceeded 3 total bytes")
      }

      const exactEvents = collectEvents(
        yield* streamCli(process.execPath, ["-e", "process.stdout.write('a\\nb\\n')"], {
          maxStreamEvents: 2,
        }).pipe(Stream.runCollect),
      )
      expect(
        exactEvents.filter((event) => {
          const { _tag: tag } = event
          return tag === "ProcessLine"
        }),
      ).toHaveLength(2)

      const overEvents = yield* Effect.either(
        streamCli(process.execPath, ["-e", "process.stdout.write('a\\nb\\n')"], {
          maxStreamEvents: 1,
          killAfterMs: 25,
          forceKillAfterMs: 25,
        }).pipe(Stream.runCollect),
      )
      expect(Either.isLeft(overEvents)).toBe(true)
      if (Either.isLeft(overEvents)) {
        expect(overEvents.left.message).toBe("Subprocess stream exceeded 1 line events")
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
      const result = yield* Effect.either(
        streamCli(process.execPath, ["-e", script], {
          stdout: { maxBytes: 5, overflow: "truncate" },
          stderr: { maxBytes: 10, overflow: "truncate" },
        }).pipe(Stream.runForEach((event) => Effect.sync(() => emitted.push(event)))),
      )

      expect(emitted).toEqual([
        { _tag: "ProcessLine", source: "stdout", line: "abcdef" },
        { _tag: "ProcessLine", source: "stderr", line: "diagnostic" },
      ])
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toMatchObject({
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

  it.scopedLive("pauses Node pipes behind a slow consumer without dropping events", () =>
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
      const spawnResult = yield* Effect.either(
        streamCli("diffdash-stream-command-that-does-not-exist", []).pipe(Stream.runCollect),
      )
      expect(Either.isLeft(spawnResult)).toBe(true)
      if (Either.isLeft(spawnResult)) {
        expect(spawnResult.left).toBeInstanceOf(ProcessSpawnError)
        expect(spawnResult.left.cause).not.toBeNull()
      }

      const closeStdinScript = `
        require('node:fs').closeSync(0)
        setInterval(() => {}, 1_000)
      `
      const stdinResult = yield* Effect.either(
        streamCli(process.execPath, ["-e", closeStdinScript], {
          stdin: "x".repeat(2 * 1024 * 1024),
          timeoutMs: 5_000,
          killAfterMs: 25,
          forceKillAfterMs: 25,
        }).pipe(Stream.runCollect),
      )
      expect(Either.isLeft(stdinResult)).toBe(true)
      if (Either.isLeft(stdinResult)) {
        expect(stdinResult.left).toBeInstanceOf(ProcessStdinError)
        expect(stdinResult.left.message).toBe("Failed to write command stdin")
        expect(stdinResult.left.cause).not.toBeNull()
      }
    }),
  )

  it.scopedLive("times out and escalates the process group from SIGTERM to SIGKILL", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const marker = join(directory, "timeout-sigterm")
      const script = `
        const fs = require('node:fs')
        process.on('SIGTERM', () => fs.writeFileSync(process.env.MARKER, 'SIGTERM'))
        process.stdout.write(String(process.pid) + '\\n')
        setInterval(() => {}, 1_000)
      `
      const result = yield* Effect.either(
        streamCli(process.execPath, ["-e", script], {
          env: { MARKER: marker },
          killAfterMs: 500,
          forceKillAfterMs: 500,
          timeoutMs: 1_000,
        }).pipe(Stream.runCollect),
      )

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(ProcessTimeoutError)
        expect(result.left.signal).toBe("SIGKILL")
        const pid = Number.parseInt(result.left.stdout, 10)
        expect(processIsRunning(pid)).toBe(false)
      }
      expect(readFileSync(marker, "utf8")).toBe("SIGTERM")
    }),
  )

  it.scopedLive("terminates and escalates when stream consumption is interrupted", () =>
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
        Effect.fork,
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
