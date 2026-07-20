import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Fiber } from "effect"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  InvalidProcessOptionsError,
  ProcessCleanupError,
  ProcessExitError,
  ProcessService,
  ProcessStdinError,
  ProcessTimeoutError,
  processRequest,
  type ProcessRequestOptions,
  type ProcessRunner,
} from "./process"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-cli-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const killIfRunning = (pid: number): void => {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // The supervised process may already have reaped the fixture child.
  }
}

const waitForFile = (path: string, attemptsRemaining = 200): Promise<void> => {
  if (existsSync(path)) return Promise.resolve()
  if (attemptsRemaining === 0) return Promise.reject(new Error(`Timed out waiting for ${path}`))
  return new Promise((resolve) => setTimeout(resolve, 10)).then(() =>
    waitForFile(path, attemptsRemaining - 1),
  )
}

const testRunner = (processes: ProcessRunner) => ({
  run: (command: string, args: readonly string[], options?: ProcessRequestOptions) =>
    processes.run(processRequest(command, args, options)),
})

describe("ProcessService captured execution", () => {
  it.live("rejects invalid options with a typed error before spawning", () =>
    Effect.gen(function* () {
      const processes = yield* ProcessService
      const result = yield* processes
        .run(processRequest("", [], { timeoutMs: -1 }))
        .pipe(Effect.either)

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(InvalidProcessOptionsError)
        const { _tag: tag } = result.left
        if (tag === "InvalidProcessOptionsError") expect(result.left.option).toBe("command")
      }
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.live("captures complete stdout from a successful command", () =>
    Effect.gen(function* () {
      const cli = testRunner(yield* ProcessService)
      const result = yield* cli.run(process.execPath, ["-e", "process.stdout.write('ok')"])

      expect(result).toMatchObject({
        stdout: "ok",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        exitCode: 0,
      })
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.live("returns a typed exit error without replacing captured stderr", () =>
    Effect.gen(function* () {
      const cli = testRunner(yield* ProcessService)
      const result = yield* Effect.either(
        cli.run(process.execPath, ["-e", "process.stderr.write('bad'); process.exit(7)"]),
      )

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(ProcessExitError)
        expect(result.left).toMatchObject({
          exitCode: 7,
          message: "Command exited with code 7",
          stderr: "bad",
        })
      }
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.live("accepts an exact stdout budget and fails on the next byte", () =>
    Effect.gen(function* () {
      const cli = testRunner(yield* ProcessService)
      const exact = yield* cli.run(process.execPath, ["-e", "process.stdout.write('abcde')"], {
        stdout: { maxBytes: 5, overflow: "error" },
      })
      expect(exact.stdout).toBe("abcde")
      expect(exact.stdoutTruncated).toBe(false)

      const over = yield* Effect.either(
        cli.run(
          process.execPath,
          ["-e", "process.stdout.write('abcdef'); process.stderr.write('diagnostic')"],
          {
            stdout: { maxBytes: 5, overflow: "error" },
            stderr: { maxBytes: 10, overflow: "truncate" },
          },
        ),
      )
      expect(Either.isLeft(over)).toBe(true)
      if (Either.isLeft(over)) {
        const { _tag: tag } = over.left
        expect(tag).toBe("ProcessOutputError")
        expect(over.left.stdout).toBe("abcde")
        expect(over.left.stdoutTruncated).toBe(true)
        expect(over.left.stderr).toBe("diagnostic")
        expect(over.left.stderrTruncated).toBe(false)
      }
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.live("budgets stdout and stderr independently", () =>
    Effect.gen(function* () {
      const cli = testRunner(yield* ProcessService)
      const result = yield* cli.run(
        process.execPath,
        ["-e", "process.stdout.write('abcde'); process.stderr.write('123456')"],
        {
          stdout: { maxBytes: 5, overflow: "error" },
          stderr: { maxBytes: 5, overflow: "truncate" },
        },
      )

      expect(result).toMatchObject({
        stdout: "abcde",
        stdoutTruncated: false,
        stderr: "12345",
        stderrTruncated: true,
      })
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.live("drops a partial trailing UTF-8 code point at a capture boundary", () =>
    Effect.gen(function* () {
      const cli = testRunner(yield* ProcessService)
      const result = yield* Effect.either(
        cli.run(process.execPath, ["-e", "process.stdout.write('a😀b')"], {
          stdout: { maxBytes: 3, overflow: "error" },
        }),
      )

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left.stdout).toBe("a")
        expect(result.left.stdout).not.toContain("�")
      }
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.scopedLive("keeps captured output separate from timeout diagnostics", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const signalPath = join(directory, "signal")
      const script = `
        const fs = require('node:fs')
        process.stdout.write('partial')
        process.stderr.write('warning')
        process.on('SIGTERM', () => fs.writeFileSync(process.env.SIGNAL_PATH, 'SIGTERM'))
        setInterval(() => {}, 1_000)
      `
      const cli = testRunner(yield* ProcessService)
      const result = yield* Effect.either(
        cli.run(process.execPath, ["-e", script], {
          env: { SIGNAL_PATH: signalPath },
          timeoutMs: 100,
          killAfterMs: 25,
          forceKillAfterMs: 25,
        }),
      )

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toMatchObject({
          _tag: "ProcessTimeoutError",
          message: "Command timed out after 100ms",
          stdout: "partial",
          stderr: "warning",
        })
        expect(result.left).toBeInstanceOf(ProcessTimeoutError)
      }
      expect(readFileSync(signalPath, "utf8")).toBe("SIGTERM")
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.live("reports signal termination and stdin failures with typed reasons", () =>
    Effect.gen(function* () {
      const cli = testRunner(yield* ProcessService)
      const signalResult = yield* Effect.either(
        cli.run(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"]),
      )
      expect(Either.isLeft(signalResult)).toBe(true)
      if (Either.isLeft(signalResult)) {
        expect(signalResult.left).toBeInstanceOf(ProcessExitError)
        expect(signalResult.left.message).toContain("SIGTERM")
        expect(signalResult.left.stderr).toBe("")
      }

      const closeStdinScript = `
        require('node:fs').closeSync(0)
        setInterval(() => {}, 1_000)
      `
      const stdinResult = yield* Effect.either(
        cli.run(process.execPath, ["-e", closeStdinScript], {
          stdin: "x".repeat(2 * 1024 * 1024),
          timeoutMs: 5_000,
          killAfterMs: 25,
          forceKillAfterMs: 25,
        }),
      )
      expect(Either.isLeft(stdinResult)).toBe(true)
      if (Either.isLeft(stdinResult)) {
        expect(stdinResult.left).toBeInstanceOf(ProcessStdinError)
        expect(stdinResult.left.message).toBe("Failed to write command stdin")
        expect(stdinResult.left.stderr).toBe("")
        expect(stdinResult.left.cause).not.toBeNull()
      }
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.scopedLive("terminates the process group when the Effect fiber is interrupted", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const pidPath = join(directory, "pid")
      const signalPath = join(directory, "signal")
      const script = `
        const fs = require('node:fs')
        fs.writeFileSync(process.env.PID_PATH, String(process.pid))
        process.on('SIGTERM', () => fs.writeFileSync(process.env.SIGNAL_PATH, 'SIGTERM'))
        setInterval(() => {}, 1_000)
      `
      const cli = testRunner(yield* ProcessService)
      const fiber = yield* cli
        .run(process.execPath, ["-e", script], {
          env: { PID_PATH: pidPath, SIGNAL_PATH: signalPath },
          killAfterMs: 25,
          forceKillAfterMs: 25,
        })
        .pipe(Effect.fork)
      yield* Effect.promise(() => waitForFile(pidPath))

      yield* Fiber.interrupt(fiber)

      const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10)
      expect(readFileSync(signalPath, "utf8")).toBe("SIGTERM")
      expect(processIsRunning(pid)).toBe(false)
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.scopedLive("kills a same-group descendant that retains stdio after the child exits", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const descendantPath = join(directory, "descendant")
      const script = `
        const { spawn } = require('node:child_process')
        const fs = require('node:fs')
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: ['ignore', 'inherit', 'inherit'],
        })
        child.unref()
        fs.writeFileSync(process.env.DESCENDANT_PATH, String(child.pid))
        process.stdout.write('parent-output')
      `
      const cli = testRunner(yield* ProcessService)
      const result = yield* Effect.either(
        cli.run(process.execPath, ["-e", script], {
          env: { DESCENDANT_PATH: descendantPath },
          exitCloseAfterMs: 10,
          killAfterMs: 25,
          forceKillAfterMs: 25,
        }),
      )

      const descendantPid = Number.parseInt(readFileSync(descendantPath, "utf8"), 10)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(ProcessCleanupError)
        expect(result.left.stdout).toBe("parent-output")
      }
      expect(processIsRunning(descendantPid)).toBe(false)
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.scopedLive("finishes at the cleanup deadline when detached inherited stdio never closes", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const descendantPath = join(directory, "detached-descendant")
      const script = `
        const { spawn } = require('node:child_process')
        const fs = require('node:fs')
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true,
          stdio: ['ignore', 'inherit', 'inherit'],
        })
        child.unref()
        fs.writeFileSync(process.env.DESCENDANT_PATH, String(child.pid))
      `
      const cli = testRunner(yield* ProcessService)
      const startedAt = Date.now()
      const result = yield* Effect.either(
        cli.run(process.execPath, ["-e", script], {
          env: { DESCENDANT_PATH: descendantPath },
          exitCloseAfterMs: 10,
          killAfterMs: 20,
          forceKillAfterMs: 20,
        }),
      )
      const elapsedMs = Date.now() - startedAt
      const descendantPid = Number.parseInt(readFileSync(descendantPath, "utf8"), 10)
      yield* Effect.addFinalizer(() => Effect.sync(() => killIfRunning(descendantPid)))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(ProcessCleanupError)
      expect(elapsedMs).toBeLessThan(1_000)
      expect(processIsRunning(descendantPid)).toBe(true)
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.scopedLive("finds commands from user-local bin when PATH is sparse", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectory
      const localBin = join(home, ".local", "bin")
      const commandPath = join(localBin, "diffdash-test-command")
      yield* Effect.sync(() => {
        mkdirSync(localBin, { recursive: true })
        writeFileSync(commandPath, "#!/bin/sh\nprintf local-bin", "utf8")
        chmodSync(commandPath, 0o755)
      })

      const cli = testRunner(yield* ProcessService)
      const result = yield* cli.run("diffdash-test-command", [], {
        env: { HOME: home, PATH: "" },
      })

      expect(result.stdout).toBe("local-bin")
    }).pipe(Effect.provide(ProcessService.layer)),
  )
})
