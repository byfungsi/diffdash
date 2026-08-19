import { Clock, Effect, Ref, Schema } from "effect"

import { CoreHostKind, type CoreHostKind as CoreHostKindType } from "./core-host-selection"
import type { CoreProcessHandle } from "./core-process-launcher"

/** Bounds repeated Core host crashes before further restart attempts are denied. */
export interface CoreHostCrashCircuitPolicy {
  readonly maximumCrashes: number
  readonly windowMilliseconds: number
}

/** Per-runtime crash-window circuit used by the Core host supervisor. */
export interface CoreHostCrashCircuit {
  readonly recordCrash: (host: CoreHostKindType) => Effect.Effect<"closed" | "open">
  readonly reset: (host: CoreHostKindType) => Effect.Effect<void>
}

/** Sanitized terminal result when a ready Core host exits. */
export const ReadyCoreHostExit = Schema.Struct({
  host: CoreHostKind,
  exitCode: Schema.Number,
  outcome: Schema.Literals(["stopped", "restart-eligible", "unavailable"]),
}).annotate({ identifier: "ReadyCoreHostExit" })

/** Sanitized terminal result when a ready Core host exits. */
export type ReadyCoreHostExit = typeof ReadyCoreHostExit.Type

/** Creates an independently tracked crash-window circuit for Bun and utility hosts. */
export const makeCoreHostCrashCircuit = Effect.fn("makeCoreHostCrashCircuit")(function* (
  policy: CoreHostCrashCircuitPolicy,
) {
  const crashes = yield* Ref.make<Readonly<Record<CoreHostKindType, ReadonlyArray<number>>>>({
    bun: [],
    utility: [],
  })
  const maximumCrashes = Math.max(1, Math.trunc(policy.maximumCrashes))
  const windowMilliseconds = Math.max(1, Math.trunc(policy.windowMilliseconds))

  const recordCrash = Effect.fn("CoreHostCrashCircuit.recordCrash")(function* (
    host: CoreHostKindType,
  ) {
    const now = yield* Clock.currentTimeMillis
    const next = yield* Ref.modify(crashes, (state) => {
      const recent = state[host].filter((timestamp) => now - timestamp <= windowMilliseconds)
      const updated = [...recent, now]
      return [updated, { ...state, [host]: updated }] as const
    })
    return next.length >= maximumCrashes ? "open" : "closed"
  })
  const reset = Effect.fn("CoreHostCrashCircuit.reset")((host: CoreHostKindType) =>
    Ref.update(crashes, (state) => ({ ...state, [host]: [] })),
  )
  return { recordCrash, reset } satisfies CoreHostCrashCircuit
})

/** Watches a ready Core process, cleans host-owned resources, and applies its crash circuit. */
export const superviseReadyCoreHost = Effect.fn("superviseReadyCoreHost")(function* (options: {
  readonly host: CoreHostKindType
  readonly process: CoreProcessHandle
  readonly isDraining: Effect.Effect<boolean>
  readonly cleanupAfterHostDeath: Effect.Effect<void>
  readonly crashCircuit: CoreHostCrashCircuit
}) {
  const exitCode = yield* options.process.awaitExit
  yield* options.cleanupAfterHostDeath
  if (yield* options.isDraining) {
    return { host: options.host, exitCode, outcome: "stopped" } satisfies ReadyCoreHostExit
  }
  const circuit = yield* options.crashCircuit.recordCrash(options.host)
  return {
    host: options.host,
    exitCode,
    outcome: circuit === "open" ? "unavailable" : "restart-eligible",
  } satisfies ReadyCoreHostExit
})
