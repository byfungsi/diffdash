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

import { CliStreamError, type CliStreamEvent, streamCli } from "./cli-stream"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-cli-stream-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const collectEvents = (events: Iterable<CliStreamEvent>) => Array.from(events)

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("CliStreamService", () => {
  it.effect("emits ordered complete JSONL lines across chunk boundaries", () =>
    Effect.gen(function* () {
      const script = `
        process.stdout.write('{"id":')
        setTimeout(() => {
          process.stdout.write('1}\\r\\n{"id":2}\\n')
          setTimeout(() => {
            process.stderr.write('warning\\r\\n')
            setTimeout(() => process.stdout.end('tail'), 20)
          }, 20)
        }, 20)
      `
      const events = collectEvents(
        yield* streamCli(process.execPath, ["-e", script]).pipe(Stream.runCollect),
      )

      expect(events.map(({ _tag: tag }) => tag)).toEqual([
        "CliLine",
        "CliLine",
        "CliLine",
        "CliLine",
        "CliExit",
      ])
      expect(events.slice(0, 4)).toEqual([
        { _tag: "CliLine", source: "stdout", line: '{"id":1}' },
        { _tag: "CliLine", source: "stdout", line: '{"id":2}' },
        { _tag: "CliLine", source: "stderr", line: "warning" },
        { _tag: "CliLine", source: "stdout", line: "tail" },
      ])

      const exit = events.at(-1)
      expect(exit).toBeDefined()
      if (exit === undefined) return
      const { _tag: exitTag } = exit
      expect(exitTag).toBe("CliExit")
      if (exitTag === "CliExit") {
        expect(exit.result.stdout).toBe('{"id":1}\r\n{"id":2}\ntail')
        expect(exit.result.stderr).toBe("warning\r\n")
        expect(exit.result.outputTruncated).toBe(false)
        expect(exit.result.exitCode).toBe(0)
      }
    }),
  )

  it.scoped("preserves GUI PATH, cwd, environment, and stdin behavior", () =>
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
        _tag: "CliLine",
        source: "stdout",
        line: `${realpathSync(cwd)}|from-env|from-stdin`,
      })
    }),
  )

  it.effect(
    "bounds failure diagnostics and exposes truncation without truncating line events",
    () =>
      Effect.gen(function* () {
        const emitted: CliStreamEvent[] = []
        const script = `
        process.stdout.write('abcdef\\n')
        setTimeout(() => {
          process.stderr.write('xyz\\n')
          setTimeout(() => process.exit(7), 20)
        }, 20)
      `
        const result = yield* Effect.either(
          streamCli(process.execPath, ["-e", script], { maxOutputBytes: 5 }).pipe(
            Stream.runForEach((event) => Effect.sync(() => emitted.push(event))),
          ),
        )

        expect(emitted).toEqual([
          { _tag: "CliLine", source: "stdout", line: "abcdef" },
          { _tag: "CliLine", source: "stderr", line: "xyz" },
        ])
        expect(Either.isLeft(result)).toBe(true)
        if (Either.isLeft(result)) {
          expect(result.left).toBeInstanceOf(CliStreamError)
          expect(result.left.reason).toBe("exit")
          expect(result.left.exitCode).toBe(7)
          expect(result.left.stdout).toBe("abcde")
          expect(result.left.stderr).toBe("")
          expect(result.left.stdoutTruncated).toBe(true)
          expect(result.left.stderrTruncated).toBe(true)
          expect(result.left.outputTruncated).toBe(true)
        }
      }),
  )

  it.scoped("times out and escalates from SIGTERM to SIGKILL", () =>
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
          killAfterMs: 50,
          timeoutMs: 50,
        }).pipe(Stream.runCollect),
      )

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left.reason).toBe("timeout")
        expect(result.left.signal).toBe("SIGKILL")
        const pid = Number.parseInt(result.left.stdout, 10)
        expect(Number.isSafeInteger(pid)).toBe(true)
        expect(processIsRunning(pid)).toBe(false)
      }
      expect(readFileSync(marker, "utf8")).toBe("SIGTERM")
    }),
  )

  it.scoped("terminates and escalates when stream consumption is interrupted", () =>
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
        killAfterMs: 50,
      }).pipe(
        Stream.tap((event) => {
          const { _tag: tag } = event
          return tag === "CliLine"
            ? Deferred.succeed(pidReady, Number.parseInt(event.line, 10))
            : Effect.void
        }),
        Stream.runDrain,
        Effect.fork,
      )
      const pid = yield* Deferred.await(pidReady)

      yield* Fiber.interrupt(fiber)

      expect(existsSync(marker)).toBe(true)
      expect(readFileSync(marker, "utf8")).toBe("SIGTERM")
      expect(processIsRunning(pid)).toBe(false)
    }),
  )
})
