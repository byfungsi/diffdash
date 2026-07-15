import { describe, expect, it } from "@effect/vitest"
import { Effect, Either } from "effect"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CliError, CliService } from "./cli"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-cli-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

describe("CliService", () => {
  it.effect("captures stdout from a successful command", () =>
    Effect.gen(function* () {
      const cli = yield* CliService
      const result = yield* cli.run(process.execPath, ["-e", "process.stdout.write('ok')"])

      expect(result.stdout).toBe("ok")
      expect(result.stderr).toBe("")
      expect(result.exitCode).toBe(0)
    }).pipe(Effect.provide(CliService.layer)),
  )

  it.effect("returns a typed error for a non-zero exit", () =>
    Effect.gen(function* () {
      const cli = yield* CliService
      const result = yield* Effect.either(
        cli.run(process.execPath, ["-e", "process.stderr.write('bad'); process.exit(7)"]),
      )

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(CliError)
        expect(result.left.exitCode).toBe(7)
        expect(result.left.stderr).toBe("bad")
      }
    }).pipe(Effect.provide(CliService.layer)),
  )

  it.scoped("finds commands from user-local bin when PATH is sparse", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectory
      const localBin = join(home, ".local", "bin")
      const commandPath = join(localBin, "diffdash-test-command")
      yield* Effect.sync(() => {
        mkdirSync(localBin, { recursive: true })
        writeFileSync(commandPath, "#!/bin/sh\nprintf local-bin", "utf8")
        chmodSync(commandPath, 0o755)
      })

      const cli = yield* CliService
      const result = yield* cli.run("diffdash-test-command", [], {
        env: { HOME: home, PATH: "" },
      })

      expect(result.stdout).toBe("local-bin")
    }).pipe(Effect.provide(CliService.layer)),
  )
})
