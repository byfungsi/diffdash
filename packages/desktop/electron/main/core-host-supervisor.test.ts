import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import { TestClock } from "effect/testing"

import { makeCoreHostCrashCircuit, superviseReadyCoreHost } from "./core-host-supervisor"

describe("Core host supervisor", () => {
  it.effect("opens each host circuit after repeated crashes inside the window", () =>
    Effect.gen(function* () {
      const circuit = yield* makeCoreHostCrashCircuit({
        maximumCrashes: 3,
        windowMilliseconds: 60_000,
      })

      expect(yield* circuit.recordCrash("utility")).toBe("closed")
      yield* TestClock.adjust("10 seconds")
      expect(yield* circuit.recordCrash("utility")).toBe("closed")
      yield* TestClock.adjust("10 seconds")
      expect(yield* circuit.recordCrash("utility")).toBe("open")
      expect(yield* circuit.recordCrash("bun")).toBe("closed")
    }),
  )

  it.effect("expires crashes outside the circuit window", () =>
    Effect.gen(function* () {
      const circuit = yield* makeCoreHostCrashCircuit({
        maximumCrashes: 2,
        windowMilliseconds: 1_000,
      })
      expect(yield* circuit.recordCrash("bun")).toBe("closed")
      yield* TestClock.adjust("2 seconds")
      expect(yield* circuit.recordCrash("bun")).toBe("closed")
    }),
  )

  it.effect("cleans host-death resources before returning restart eligibility", () =>
    Effect.gen(function* () {
      const cleaned = yield* Ref.make(false)
      const circuit = yield* makeCoreHostCrashCircuit({
        maximumCrashes: 2,
        windowMilliseconds: 60_000,
      })
      const result = yield* superviseReadyCoreHost({
        host: "utility",
        process: { awaitExit: Effect.succeed(9), kill: () => false },
        isDraining: Effect.succeed(false),
        cleanupAfterHostDeath: Ref.set(cleaned, true),
        crashCircuit: circuit,
      })

      expect(yield* Ref.get(cleaned)).toBe(true)
      expect(result).toEqual({ host: "utility", exitCode: 9, outcome: "restart-eligible" })
    }),
  )

  it.effect("reports utility unavailable when repeated supervised failures open its circuit", () =>
    Effect.gen(function* () {
      const circuit = yield* makeCoreHostCrashCircuit({
        maximumCrashes: 2,
        windowMilliseconds: 60_000,
      })
      const supervise = () =>
        superviseReadyCoreHost({
          host: "utility",
          process: { awaitExit: Effect.succeed(1), kill: () => false },
          isDraining: Effect.succeed(false),
          cleanupAfterHostDeath: Effect.void,
          crashCircuit: circuit,
        })

      expect((yield* supervise()).outcome).toBe("restart-eligible")
      expect((yield* supervise()).outcome).toBe("unavailable")
    }),
  )

  it.effect("treats a supervised exit during drain as an expected stop", () =>
    Effect.gen(function* () {
      const circuit = yield* makeCoreHostCrashCircuit({
        maximumCrashes: 1,
        windowMilliseconds: 60_000,
      })
      const result = yield* superviseReadyCoreHost({
        host: "bun",
        process: { awaitExit: Effect.succeed(0), kill: () => false },
        isDraining: Effect.succeed(true),
        cleanupAfterHostDeath: Effect.void,
        crashCircuit: circuit,
      })

      expect(result.outcome).toBe("stopped")
      expect(yield* circuit.recordCrash("bun")).toBe("open")
    }),
  )
})
