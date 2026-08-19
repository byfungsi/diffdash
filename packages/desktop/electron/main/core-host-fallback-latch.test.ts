import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import { makeCoreHostFallbackLatch } from "./core-host-fallback-latch"

const makeDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-core-fallback-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

describe("Core host fallback latch", () => {
  it.effect("durably disables fallback before ownership authorization and remains idempotent", () =>
    Effect.gen(function* () {
      const directory = yield* makeDirectory
      const path = join(directory, "fallback-disabled.json")
      const latch = makeCoreHostFallbackLatch(path)
      expect(yield* latch.fallbackAllowed).toBe(true)

      yield* latch.disableBeforeOwnershipAuthorization
      yield* latch.disableBeforeOwnershipAuthorization

      expect(yield* makeCoreHostFallbackLatch(path).fallbackAllowed).toBe(false)
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        schemaVersion: 1,
        fallbackAllowed: false,
      })
    }),
  )

  it.effect("fails closed when persisted latch evidence is malformed", () =>
    Effect.gen(function* () {
      const directory = yield* makeDirectory
      const path = join(directory, "fallback-disabled.json")
      writeFileSync(path, "not-json", { mode: 0o600 })
      const latch = makeCoreHostFallbackLatch(path)

      expect(yield* latch.fallbackAllowed).toBe(false)
      expect(
        Result.isFailure(yield* Effect.result(latch.disableBeforeOwnershipAuthorization)),
      ).toBe(true)
    }),
  )
})
