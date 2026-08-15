import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  DatabaseOwnershipAuthorizationId,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import { AuthorizeDatabaseOwnershipRequest } from "@diffdash/core-rpc/lifecycle"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Ref } from "effect"

import { runCoreHostLifecycle } from "./core-host-lifecycle"
import {
  CoreAuthenticatedHostSession,
  type CoreAuthenticatedHostSessionOperations,
} from "./core-transport-authentication"
import { CoreLifecycle, makeCoreLifecycle } from "./core-lifecycle"
import { CoreOwnershipRecovery, CoreOwnershipRecoveryError } from "./core-ownership-recovery"

const identity = {
  applicationInstanceId: ApplicationInstanceId.make("app-host-lifecycle"),
  processEpoch: CoreProcessEpoch.make("epoch-host-lifecycle"),
} as const

const authorization = AuthorizeDatabaseOwnershipRequest.make({
  ...identity,
  requestId: HostRequestId.make("h:authorize-host-lifecycle"),
  authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-host-lifecycle"),
})

const makeHostSession = (death: Deferred.Deferred<void>): CoreAuthenticatedHostSessionOperations =>
  CoreAuthenticatedHostSession.of({
    authenticated: () => Effect.void,
    disconnected: () => Effect.void,
    awaitDeath: Deferred.await(death),
  })

describe("Core authenticated host lifecycle", () => {
  it.effect(
    "exits without acquiring resources when the host dies before ownership authorization",
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* makeCoreLifecycle(identity)
        const death = yield* Deferred.make<void>()
        const acquired = yield* Ref.make(false)
        const runner = yield* runCoreHostLifecycle(identity).pipe(
          Effect.provideService(CoreAuthenticatedHostSession, makeHostSession(death)),
          Effect.provideService(
            CoreOwnershipRecovery,
            CoreOwnershipRecovery.of({
              acquireAndRecover: () =>
                Ref.set(acquired, true).pipe(Effect.as({ release: Effect.void })),
            }),
          ),
          Effect.provideService(CoreLifecycle, lifecycle),
          Effect.forkScoped,
        )

        yield* lifecycle.awaitOwnershipAuthorization
        yield* Deferred.succeed(death, undefined)
        yield* Fiber.join(runner)

        expect(yield* Ref.get(acquired)).toBe(false)
        expect(yield* lifecycle.health({ ...authorization })).toMatchObject({
          lifecycle: "stopped",
        })
      }),
  )

  it.effect("releases acquired ownership resources before exiting after host death", () =>
    Effect.gen(function* () {
      const lifecycle = yield* makeCoreLifecycle(identity)
      const death = yield* Deferred.make<void>()
      const acquired = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const runner = yield* runCoreHostLifecycle(identity).pipe(
        Effect.provideService(CoreAuthenticatedHostSession, makeHostSession(death)),
        Effect.provideService(
          CoreOwnershipRecovery,
          CoreOwnershipRecovery.of({
            acquireAndRecover: () =>
              Deferred.succeed(acquired, undefined).pipe(
                Effect.as({ release: Deferred.succeed(released, undefined) }),
              ),
          }),
        ),
        Effect.provideService(CoreLifecycle, lifecycle),
        Effect.forkScoped,
      )

      yield* lifecycle.awaitOwnershipAuthorization
      yield* lifecycle.authorizeDatabaseOwnership(authorization)
      yield* Deferred.await(acquired)
      yield* Deferred.succeed(death, undefined)
      yield* Fiber.join(runner)

      expect(yield* Deferred.isDone(released)).toBe(true)
      expect(yield* lifecycle.health({ ...authorization })).toMatchObject({ lifecycle: "stopped" })
    }),
  )

  it.effect("fails closed after ownership authorization when recovery cannot start", () =>
    Effect.gen(function* () {
      const lifecycle = yield* makeCoreLifecycle(identity)
      const death = yield* Deferred.make<void>()
      const runner = yield* runCoreHostLifecycle(identity).pipe(
        Effect.provideService(CoreAuthenticatedHostSession, makeHostSession(death)),
        Effect.provideService(
          CoreOwnershipRecovery,
          CoreOwnershipRecovery.of({
            acquireAndRecover: () =>
              Effect.fail(
                CoreOwnershipRecoveryError.make({
                  stage: "ownership",
                  safeMessage: "DiffDash Core could not acquire and recover its owned resources.",
                }),
              ),
          }),
        ),
        Effect.provideService(CoreLifecycle, lifecycle),
        Effect.forkScoped,
      )

      yield* lifecycle.awaitOwnershipAuthorization
      yield* lifecycle.authorizeDatabaseOwnership(authorization)
      const exit = yield* Fiber.await(runner)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* lifecycle.health({ ...authorization })).toMatchObject({ lifecycle: "failed" })
      expect(JSON.stringify(exit)).not.toContain("socket")
    }),
  )
})
