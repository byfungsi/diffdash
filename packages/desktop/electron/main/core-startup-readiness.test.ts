import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  HostRequestContext,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import { CoreHealth } from "@diffdash/core-rpc/lifecycle"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { waitForCoreReadiness } from "./core-startup-readiness"

const identity = {
  applicationInstanceId: ApplicationInstanceId.make("app-readiness-test"),
  processEpoch: CoreProcessEpoch.make("epoch-readiness-test"),
}
const requestContext = () =>
  HostRequestContext.make({
    ...identity,
    requestId: HostRequestId.make("h:readiness-test"),
  })

describe("Core startup readiness", () => {
  it.effect("allows legitimate recovery beyond the former five-second polling limit", () =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      const waiting = yield* waitForCoreReadiness(
        {
          health: () =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) =>
                CoreHealth.make({
                  ...identity,
                  lifecycle: now - started >= 6_000 ? "ready" : "recovering",
                }),
              ),
            ),
        },
        requestContext,
      ).pipe(Effect.forkScoped)
      yield* TestClock.adjust("6 seconds")
      expect(yield* Fiber.join(waiting)).toBeUndefined()
    }),
  )

  it.effect("bounds an unresponsive health request and interrupts it on timeout", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>()
      const waiting = yield* waitForCoreReadiness(
        {
          health: () =>
            Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
        },
        requestContext,
      ).pipe(Effect.flip, Effect.forkScoped)
      yield* TestClock.adjust("60 seconds")
      expect(yield* Fiber.join(waiting)).toMatchObject({ reason: "timeout" })
      expect(yield* Deferred.isDone(interrupted)).toBe(true)
    }),
  )

  for (const lifecycle of ["failed", "draining"] as const) {
    it.effect(`fails immediately when Core is ${lifecycle}`, () =>
      Effect.gen(function* () {
        const failure = yield* waitForCoreReadiness(
          {
            health: () => Effect.succeed(CoreHealth.make({ ...identity, lifecycle })),
          },
          requestContext,
        ).pipe(Effect.flip)
        expect(failure).toMatchObject({ reason: lifecycle })
      }),
    )
  }
})
