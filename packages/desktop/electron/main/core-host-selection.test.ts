import { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc/identity"
import { CoreHealth } from "@diffdash/core-rpc/lifecycle"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"

import {
  CoreHostCandidateError,
  selectCoreHost,
  type CoreHostCandidate,
  type CoreHostFallbackLatch,
} from "./core-host-selection"

const session = (host: "bun" | "utility") => ({
  applicationInstanceId: ApplicationInstanceId.make("app-selection"),
  processEpoch: CoreProcessEpoch.make(`epoch-${host}`),
  health: CoreHealth.make({
    applicationInstanceId: ApplicationInstanceId.make("app-selection"),
    processEpoch: CoreProcessEpoch.make(`epoch-${host}`),
    lifecycle: "awaitingOwnership",
  }),
  state: Effect.succeed("awaitingOwnership" as const),
})

const candidateFailure = CoreHostCandidateError.make({
  reason: "qualification-failed",
  qualificationCapability: "sqlite",
  safeMessage: "DiffDash could not prepare a Core host candidate.",
})
const startupFailure = CoreHostCandidateError.make({
  reason: "startup-failed",
  qualificationCapability: null,
  safeMessage: "DiffDash could not prepare a Core host candidate.",
})

const candidate = (
  host: "bun" | "utility",
  qualify: Effect.Effect<void, CoreHostCandidateError> = Effect.void,
  start: Effect.Effect<ReturnType<typeof session>, CoreHostCandidateError> = Effect.succeed(
    session(host),
  ),
): CoreHostCandidate => ({ host, qualify, start })

const makeLatch = (initiallyAllowed = true) =>
  Effect.gen(function* () {
    const allowed = yield* Ref.make(initiallyAllowed)
    const latch: CoreHostFallbackLatch = {
      fallbackAllowed: Ref.get(allowed),
      disableBeforeOwnershipAuthorization: Ref.set(allowed, false),
    }
    return { allowed, latch }
  })

describe("Core host selection", () => {
  it.effect("auto falls back from unqualified Bun to the utility path", () =>
    Effect.gen(function* () {
      const { latch } = yield* makeLatch()
      const selected = yield* selectCoreHost(
        "auto",
        [candidate("utility"), candidate("bun", Effect.fail(candidateFailure))],
        latch,
      )

      expect(selected.host).toBe("utility")
    }),
  )

  it.effect("forced Bun reports qualification failure without utility fallback", () =>
    Effect.gen(function* () {
      const { latch } = yield* makeLatch()
      const failure = yield* selectCoreHost(
        "bun",
        [candidate("bun", Effect.fail(candidateFailure)), candidate("utility")],
        latch,
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        mode: "bun",
        host: "bun",
        reason: "qualification-failed",
        qualificationCapability: "sqlite",
      })
    }),
  )

  it.effect("forced utility preserves the utility candidate without probing Bun", () =>
    Effect.gen(function* () {
      const { latch } = yield* makeLatch()
      const selected = yield* selectCoreHost(
        "utility",
        [candidate("bun", Effect.die("must not run")), candidate("utility")],
        latch,
      )

      expect(selected.host).toBe("utility")
    }),
  )

  it.effect("stops fallback once the pre-ownership latch is closed", () =>
    Effect.gen(function* () {
      const { allowed, latch } = yield* makeLatch()
      const selected = yield* selectCoreHost("auto", [candidate("bun")], latch)
      yield* selected.disableFallbackBeforeOwnershipAuthorization
      expect(yield* Ref.get(allowed)).toBe(false)

      const failure = yield* selectCoreHost(
        "auto",
        [candidate("bun", Effect.void, Effect.fail(startupFailure)), candidate("utility")],
        latch,
      ).pipe(Effect.flip)
      expect(failure.reason).toBe("fallback-disabled")
    }),
  )
})
