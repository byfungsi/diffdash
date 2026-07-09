import { describe, expect, it } from "@effect/vitest"
import { Effect, Either } from "effect"

import { CliError, CliService } from "./cli"

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
})
