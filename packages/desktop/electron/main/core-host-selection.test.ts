import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  DatabaseOwnershipAuthorizationId,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import { AuthorizeDatabaseOwnershipRequest, CoreHealth } from "@diffdash/core-rpc/lifecycle"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Ref } from "effect"

import {
  CoreHostCandidateError,
  selectCoreHost,
  type CoreHostCandidate,
} from "./core-host-selection"
import { makeCoreHostRuntimePin } from "./core-host-runtime-pin"

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

describe("Core host selection", () => {
  it.effect("auto falls back from unqualified Bun to the utility path", () =>
    Effect.gen(function* () {
      const runtimePin = yield* makeCoreHostRuntimePin()
      const selected = yield* selectCoreHost(
        "auto",
        [candidate("utility"), candidate("bun", Effect.fail(candidateFailure))],
        runtimePin,
      )

      expect(selected.host).toBe("utility")
    }),
  )

  it.effect("forced Bun reports qualification failure without utility fallback", () =>
    Effect.gen(function* () {
      const runtimePin = yield* makeCoreHostRuntimePin()
      const failure = yield* selectCoreHost(
        "bun",
        [candidate("bun", Effect.fail(candidateFailure)), candidate("utility")],
        runtimePin,
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
      const runtimePin = yield* makeCoreHostRuntimePin()
      const selected = yield* selectCoreHost(
        "bun",
        [
          candidate("bun", Effect.fail(candidateFailure)),
          candidate("utility", Effect.die("must not run")),
          candidate("bun"),
        ],
        runtimePin,
      )

      expect(selected.host).toBe("bun")
    }),
  )

  it.effect("auto tries every Bun path after Bun is pinned", () =>
    Effect.gen(function* () {
      const runtimePin = yield* makeCoreHostRuntimePin()
      yield* runtimePin.pinBeforeOwnershipAuthorization("bun")
      const selected = yield* selectCoreHost(
        "auto",
        [
          candidate("bun", Effect.fail(candidateFailure)),
          candidate("bun"),
          candidate("utility", Effect.die("must not run")),
        ],
        runtimePin,
      )

      expect(selected.host).toBe("bun")
    }),
  )

  it.effect("forced utility preserves the utility candidate without probing Bun", () =>
    Effect.gen(function* () {
      const runtimePin = yield* makeCoreHostRuntimePin()
      const selected = yield* selectCoreHost(
        "utility",
        [candidate("bun", Effect.die("must not run")), candidate("utility")],
        runtimePin,
      )

      expect(selected.host).toBe("utility")
    }),
  )

  it.effect("retries a transient startup failure with a fresh candidate attempt", () =>
    Effect.gen(function* () {
      const runtimePin = yield* makeCoreHostRuntimePin()
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
        runtimePin,
      )

      expect(selected.host).toBe("bun")
      expect(yield* Ref.get(attempts)).toBe(3)
    }),
  )

  it.effect("does not fall back to utility after Bun ownership authorization", () =>
    Effect.gen(function* () {
      const runtimePin = yield* makeCoreHostRuntimePin()
      const selected = yield* selectCoreHost("auto", [candidate("bun")], runtimePin)
      yield* selected.authorizeDatabaseOwnership(
        AuthorizeDatabaseOwnershipRequest.make({
          applicationInstanceId: selected.session.applicationInstanceId,
          processEpoch: selected.session.processEpoch,
          requestId: HostRequestId.make("h:ownership-selection"),
          authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-selection"),
        }),
      )
      expect(yield* runtimePin.selectedHost).toEqual(Option.some("bun"))

      const failure = yield* selectCoreHost(
        "auto",
        [
          candidate("bun", Effect.void, Effect.fail(startupFailure)),
          candidate("utility", Effect.die("must not switch runtimes")),
        ],
        runtimePin,
      ).pipe(Effect.flip)
      expect(failure.reason).toBe("startup-failed")
      expect(failure.host).toBe("bun")
    }),
  )

  it.effect("pins the runtime before sending ownership authorization", () =>
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
          selectedHost: Effect.succeed(Option.none()),
          pinBeforeOwnershipAuthorization: (host) =>
            Ref.update(events, (current) => [...current, `pin:${host}`]),
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

      expect(yield* Ref.get(events)).toEqual(["pin:utility", "authorize"])
    }),
  )

  it.effect("restarts the bundled runtime without probing unavailable or newly installed Bun", () =>
    Effect.gen(function* () {
      const runtimePin = yield* makeCoreHostRuntimePin()
      const selected = yield* selectCoreHost(
        "auto",
        [candidate("bun", Effect.fail(candidateFailure)), candidate("utility")],
        runtimePin,
      )
      yield* selected.authorizeDatabaseOwnership(
        AuthorizeDatabaseOwnershipRequest.make({
          applicationInstanceId: selected.session.applicationInstanceId,
          processEpoch: selected.session.processEpoch,
          requestId: HostRequestId.make("h:utility-first-start"),
          authorizationId: DatabaseOwnershipAuthorizationId.make("utility-first-start"),
        }),
      )

      const restarted = yield* selectCoreHost(
        "auto",
        [
          candidate("bun", Effect.die("must not probe Bun after utility ownership")),
          candidate("utility"),
        ],
        runtimePin,
      )
      expect(restarted.host).toBe("utility")
    }),
  )

  it.effect(
    "allows a new application to select utility after a previous application used Bun",
    () =>
      Effect.gen(function* () {
        const previousApplication = yield* makeCoreHostRuntimePin()
        yield* previousApplication.pinBeforeOwnershipAuthorization("bun")
        const newApplication = yield* makeCoreHostRuntimePin()
        const selected = yield* selectCoreHost(
          "auto",
          [candidate("bun", Effect.fail(candidateFailure)), candidate("utility")],
          newApplication,
        )

        expect(selected.host).toBe("utility")
        expect(yield* previousApplication.selectedHost).toEqual(Option.some("bun"))
      }),
  )

  it.effect("rejects forced runtime changes after ownership authorization", () =>
    Effect.gen(function* () {
      const runtimePin = yield* makeCoreHostRuntimePin()
      yield* runtimePin.pinBeforeOwnershipAuthorization("utility")
      const failure = yield* selectCoreHost(
        "bun",
        [candidate("bun", Effect.die("must not start"))],
        runtimePin,
      ).pipe(Effect.flip)
      expect(failure.reason).toBe("fallback-disabled")
    }),
  )

  it.effect("rejects competing authorizations for different runtimes", () =>
    Effect.gen(function* () {
      const runtimePin = yield* makeCoreHostRuntimePin()
      const bun = yield* selectCoreHost("bun", [candidate("bun")], runtimePin)
      const utility = yield* selectCoreHost(
        "utility",
        [
          candidate(
            "utility",
            Effect.void,
            Effect.succeed({
              ...session("utility"),
              authorizeDatabaseOwnership: () =>
                Effect.die("must not authorize a competing runtime"),
            }),
          ),
        ],
        runtimePin,
      )
      const request = AuthorizeDatabaseOwnershipRequest.make({
        applicationInstanceId: bun.session.applicationInstanceId,
        processEpoch: bun.session.processEpoch,
        requestId: HostRequestId.make("h:competing-authorization"),
        authorizationId: DatabaseOwnershipAuthorizationId.make("competing-authorization"),
      })
      yield* bun.authorizeDatabaseOwnership(request)
      const failure = yield* utility.authorizeDatabaseOwnership(request).pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "CoreHostSelectionError", reason: "fallback-disabled" })
    }),
  )
})
