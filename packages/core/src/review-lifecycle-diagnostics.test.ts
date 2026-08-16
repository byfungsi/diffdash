import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"

import {
  ReviewLifecycleDiagnostics,
  reviewLifecycleDiagnosticsLayer,
} from "./review-lifecycle-diagnostics"

describe("ReviewLifecycleDiagnostics", () => {
  it.effect("records exact disposed session and superseded acquisition identities", () =>
    Effect.gen(function* () {
      const diagnostics = yield* ReviewLifecycleDiagnostics

      yield* diagnostics.sessionOpened("session:prior")
      yield* diagnostics.sessionDisposed("session:prior")
      yield* diagnostics.sessionOpened("session:replacement")

      const armed = yield* diagnostics.holdNextAcquisition
      expect(armed).toBe(true)
      const held = yield* diagnostics
        .acquisitionStarted("core:operation-prior")
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect((yield* diagnostics.snapshot).acquisitions.activeOperationIds).toEqual([
        "core:operation-prior",
      ])

      yield* diagnostics.acquisitionSuperseded("core:operation-prior")
      yield* Fiber.join(held)
      yield* diagnostics.acquisitionFinished("core:operation-prior", false)

      const snapshot = yield* diagnostics.snapshot
      expect(snapshot).toEqual({
        acquisitions: {
          activeOperationIds: [],
          started: 1,
          completed: 0,
          superseded: 1,
          drained: 1,
          failed: 0,
          lastStartedOperationId: "core:operation-prior",
          lastSupersededOperationId: "core:operation-prior",
          lastDrainedOperationId: "core:operation-prior",
        },
        sessions: {
          activeSessionId: "session:replacement",
          opened: 2,
          disposed: 1,
          lastDisposedSessionId: "session:prior",
        },
      })
    }).pipe(Effect.provide(reviewLifecycleDiagnosticsLayer)),
  )
})
