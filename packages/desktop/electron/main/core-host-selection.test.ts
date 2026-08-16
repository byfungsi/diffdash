import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  DatabaseOwnershipAuthorizationId,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import { AuthorizeDatabaseOwnershipRequest, CoreHealth } from "@diffdash/core-rpc/lifecycle"
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
  authorizeDatabaseOwnership: (request: AuthorizeDatabaseOwnershipRequest) =>
    Effect.succeed({ ...request, lifecycle: "recovering" as const }),
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

  it.effect("forced Bun skips unavailable Bun paths without falling back to utility", () =>
    Effect.gen(function* () {
      const { latch } = yield* makeLatch()
      const selected = yield* selectCoreHost(
        "bun",
        [
          candidate("bun", Effect.fail(candidateFailure)),
          candidate("utility", Effect.die("must not run")),
          candidate("bun"),
        ],
        latch,
      )

      expect(selected.host).toBe("bun")
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

  it.effect("retries a transient startup failure with a fresh candidate attempt", () =>
    Effect.gen(function* () {
      const { latch } = yield* makeLatch()
      const attempts = yield* Ref.make(0)
      const selected = yield* selectCoreHost(
        "bun",
        [
          candidate(
            "bun",
            Effect.void,
            Ref.updateAndGet(attempts, (current) => current + 1).pipe(
              Effect.flatMap((attempt) =>
                attempt < 3 ? Effect.fail(startupFailure) : Effect.succeed(session("bun")),
              ),
            ),
          ),
        ],
        latch,
      )

      expect(selected.host).toBe("bun")
      expect(yield* Ref.get(attempts)).toBe(3)
    }),
  )

  it.effect("stops fallback once the pre-ownership latch is closed", () =>
    Effect.gen(function* () {
      const { allowed, latch } = yield* makeLatch()
      const selected = yield* selectCoreHost("auto", [candidate("bun")], latch)
      yield* selected.authorizeDatabaseOwnership(
        AuthorizeDatabaseOwnershipRequest.make({
          applicationInstanceId: selected.session.applicationInstanceId,
          processEpoch: selected.session.processEpoch,
          requestId: HostRequestId.make("h:ownership-selection"),
          authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-selection"),
        }),
      )
      expect(yield* Ref.get(allowed)).toBe(false)

      const failure = yield* selectCoreHost(
        "auto",
        [candidate("bun", Effect.void, Effect.fail(startupFailure)), candidate("utility")],
        latch,
      ).pipe(Effect.flip)
      expect(failure.reason).toBe("fallback-disabled")
    }),
  )

  it.effect("persists the fallback boundary before sending ownership authorization", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([])
      const selected = yield* selectCoreHost(
        "utility",
        [
          candidate(
            "utility",
            Effect.void,
            Effect.succeed({
              ...session("utility"),
              authorizeDatabaseOwnership: (request) =>
                Ref.update(events, (current) => [...current, "authorize"]).pipe(
                  Effect.as({ ...request, lifecycle: "recovering" as const }),
                ),
            }),
          ),
        ],
        {
          fallbackAllowed: Effect.succeed(true),
          disableBeforeOwnershipAuthorization: Ref.update(events, (current) => [
            ...current,
            "latch",
          ]),
        },
      )

      yield* selected.authorizeDatabaseOwnership(
        AuthorizeDatabaseOwnershipRequest.make({
          applicationInstanceId: selected.session.applicationInstanceId,
          processEpoch: selected.session.processEpoch,
          requestId: HostRequestId.make("h:ownership-order"),
          authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-order"),
        }),
      )

      expect(yield* Ref.get(events)).toEqual(["latch", "authorize"])
    }),
  )
})
