import { CoreControlRpcs } from "@diffdash/core-rpc/control"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  DatabaseOwnershipAuthorizationId,
  HostRequestContext,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import {
  AuthorizeDatabaseOwnershipRequest,
  CoreHealth,
  CoreShutdownAcknowledged,
  DatabaseOwnershipAuthorized,
} from "@diffdash/core-rpc/lifecycle"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import { coreControlRpcHandlersLayer } from "./core-control-rpc-handlers"
import { CoreLifecycle, coreLifecycleLayer } from "./core-lifecycle"

const identity = {
  applicationInstanceId: ApplicationInstanceId.make("app-1"),
  processEpoch: CoreProcessEpoch.make("epoch-1"),
}

const request = HostRequestContext.make({
  ...identity,
  requestId: HostRequestId.make("h:request-1"),
})

const authorizationId = DatabaseOwnershipAuthorizationId.make("ownership-1")
const authorizationRequest = AuthorizeDatabaseOwnershipRequest.make({
  ...request,
  authorizationId,
})

const makeTestLayer = () =>
  coreControlRpcHandlersLayer.pipe(Layer.provideMerge(coreLifecycleLayer(identity)))

describe("Core control RPC handlers", () => {
  it.effect("authorizes ownership once and drives recovery through graceful shutdown", () =>
    Effect.gen(function* () {
      const lifecycle = yield* CoreLifecycle
      const client = yield* RpcTest.makeClient(CoreControlRpcs)

      expect((yield* client["Core.health"](request)).lifecycle).toBe("starting")

      yield* lifecycle.awaitOwnershipAuthorization
      expect((yield* client["Core.health"](request)).lifecycle).toBe("awaitingOwnership")

      const authorized = yield* client["Core.authorizeDatabaseOwnership"](authorizationRequest)
      expect(authorized).toEqual({
        ...identity,
        authorizationId,
        lifecycle: "recovering",
      })

      expect(yield* client["Core.authorizeDatabaseOwnership"](authorizationRequest)).toEqual(
        authorized,
      )

      yield* lifecycle.completeRecovery
      expect((yield* client["Core.health"](request)).lifecycle).toBe("ready")
      expect(
        (yield* client["Core.authorizeDatabaseOwnership"](authorizationRequest)).lifecycle,
      ).toBe("ready")

      expect((yield* client["Core.shutdown"](request)).lifecycle).toBe("draining")
      expect((yield* client["Core.shutdown"](request)).lifecycle).toBe("draining")

      yield* lifecycle.completeShutdown
      expect((yield* client["Core.health"](request)).lifecycle).toBe("stopped")
      expect((yield* client["Core.shutdown"](request)).lifecycle).toBe("stopped")
    }).pipe(Effect.provide(makeTestLayer())),
  )

  it.effect("keeps ownership authorization running after client interruption", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const completed = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const authorized = DatabaseOwnershipAuthorized.make({
        ...identity,
        authorizationId,
        lifecycle: "recovering",
      })
      const blockingLifecycle = CoreLifecycle.of({
        admitBusinessRequest: () => Effect.void,
        health: () =>
          Effect.succeed(
            CoreHealth.make({
              ...identity,
              lifecycle: "awaitingOwnership",
            }),
          ),
        authorizeDatabaseOwnership: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Deferred.succeed(completed, undefined)),
            Effect.as(authorized),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        shutdown: () =>
          Effect.succeed(
            CoreShutdownAcknowledged.make({
              ...identity,
              lifecycle: "draining",
            }),
          ),
        interruptOnDrain: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
        ownershipAuthorization: Effect.never,
        authenticatedHostDied: Effect.void,
        awaitOwnershipAuthorization: Effect.void,
        completeRecovery: Effect.void,
        completeShutdown: Effect.void,
        fail: Effect.void,
      })
      const blockingLayer = coreControlRpcHandlersLayer.pipe(
        Layer.provide(Layer.succeed(CoreLifecycle, blockingLifecycle)),
      )

      yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(CoreControlRpcs)
        const callFiber = yield* client["Core.authorizeDatabaseOwnership"](
          authorizationRequest,
        ).pipe(Effect.forkChild)

        yield* Deferred.await(started)
        const interruptFiber = yield* Fiber.interrupt(callFiber).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(completed)
        expect(yield* Deferred.isDone(interrupted)).toBe(false)
        yield* Fiber.await(interruptFiber)
      }).pipe(Effect.provide(blockingLayer))
    }),
  )

  it.effect("projects unexpected handler defects to a method-scoped safe value", () =>
    Effect.gen(function* () {
      const defectingLifecycle = CoreLifecycle.of({
        admitBusinessRequest: () => Effect.void,
        health: () => Effect.die(new Error("private /Users/example/repository/path")),
        authorizeDatabaseOwnership: () => Effect.die("unused"),
        shutdown: () => Effect.die("unused"),
        interruptOnDrain: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
        ownershipAuthorization: Effect.never,
        authenticatedHostDied: Effect.void,
        awaitOwnershipAuthorization: Effect.void,
        completeRecovery: Effect.void,
        completeShutdown: Effect.void,
        fail: Effect.void,
      })
      const defectingLayer = coreControlRpcHandlersLayer.pipe(
        Layer.provide(Layer.succeed(CoreLifecycle, defectingLifecycle)),
      )

      yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(CoreControlRpcs)
        const defect = yield* client["Core.health"](request).pipe(
          Effect.catchDefect(Effect.succeed),
        )

        expect(defect).toEqual({
          _tag: "CoreControlDefect",
          code: "CORE_INTERNAL_ERROR",
          method: "Core.health",
          ...request,
          retryClass: "notRetryable",
          safeMessage: "DiffDash Core encountered an internal control-plane error.",
        })
        expect(JSON.stringify(defect)).not.toContain("/Users/example")
      }).pipe(Effect.provide(defectingLayer))
    }),
  )

  it.effect("rejects stale application and process identities without changing state", () =>
    Effect.gen(function* () {
      const lifecycle = yield* CoreLifecycle
      const client = yield* RpcTest.makeClient(CoreControlRpcs)
      yield* lifecycle.awaitOwnershipAuthorization

      const staleRequest = HostRequestContext.make({
        applicationInstanceId: identity.applicationInstanceId,
        processEpoch: CoreProcessEpoch.make("epoch-stale"),
        requestId: HostRequestId.make("h:request-stale"),
      })
      const failure = yield* client["Core.health"](staleRequest).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "CoreIdentityMismatchFailure",
        code: "CORE_REQUEST_IDENTITY_MISMATCH",
        method: "Core.health",
        ...identity,
        requestId: staleRequest.requestId,
      })
      expect(failure).not.toBeInstanceOf(Error)

      const staleAuthorization = AuthorizeDatabaseOwnershipRequest.make({
        ...authorizationRequest,
        processEpoch: staleRequest.processEpoch,
        requestId: HostRequestId.make("h:authorization-stale"),
      })
      const authorizationFailure = yield* client["Core.authorizeDatabaseOwnership"](
        staleAuthorization,
      ).pipe(Effect.flip)
      expect(authorizationFailure).toMatchObject({
        _tag: "CoreIdentityMismatchFailure",
        method: "Core.authorizeDatabaseOwnership",
        requestId: staleAuthorization.requestId,
      })
      expect((yield* client["Core.health"](request)).lifecycle).toBe("awaitingOwnership")
    }).pipe(Effect.provide(makeTestLayer())),
  )

  it.effect(
    "rejects conflicting ownership authorization and invalid implementation transitions",
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* CoreLifecycle
        const client = yield* RpcTest.makeClient(CoreControlRpcs)

        const prematureRecovery = yield* lifecycle.completeRecovery.pipe(Effect.flip)
        expect(prematureRecovery).toMatchObject({
          _tag: "CoreLifecycleTransitionError",
          from: "starting",
          to: "ready",
        })

        yield* lifecycle.awaitOwnershipAuthorization
        yield* client["Core.authorizeDatabaseOwnership"](authorizationRequest)

        const conflicting = AuthorizeDatabaseOwnershipRequest.make({
          ...request,
          requestId: HostRequestId.make("h:request-conflict"),
          authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-2"),
        })
        const failure = yield* client["Core.authorizeDatabaseOwnership"](conflicting).pipe(
          Effect.flip,
        )

        expect(failure).toMatchObject({
          _tag: "CoreOwnershipAuthorizationMismatchFailure",
          code: "CORE_OWNERSHIP_AUTHORIZATION_MISMATCH",
          method: "Core.authorizeDatabaseOwnership",
          lifecycle: "recovering",
          requestId: conflicting.requestId,
        })
        expect(failure).not.toBeInstanceOf(Error)
        expect((yield* client["Core.health"](request)).lifecycle).toBe("recovering")
      }).pipe(Effect.provide(makeTestLayer())),
  )

  it.effect("rejects shutdown before authenticated transport reaches ownership admission", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoreControlRpcs)
      const failure = yield* client["Core.shutdown"](request).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "CoreLifecycleRejectedFailure",
        code: "CORE_LIFECYCLE_REJECTED",
        method: "Core.shutdown",
        lifecycle: "starting",
      })
      expect((yield* client["Core.health"](request)).lifecycle).toBe("starting")
    }).pipe(Effect.provide(makeTestLayer())),
  )

  it.effect("reports failure and still permits explicit draining", () =>
    Effect.gen(function* () {
      const lifecycle = yield* CoreLifecycle
      const client = yield* RpcTest.makeClient(CoreControlRpcs)

      yield* lifecycle.fail
      expect((yield* client["Core.health"](request)).lifecycle).toBe("failed")
      expect((yield* client["Core.shutdown"](request)).lifecycle).toBe("draining")
    }).pipe(Effect.provide(makeTestLayer())),
  )

  it.effect("interrupts concurrent recovery when shutdown begins draining", () =>
    Effect.gen(function* () {
      const lifecycle = yield* CoreLifecycle
      const client = yield* RpcTest.makeClient(CoreControlRpcs)
      const recoveryStarted = yield* Deferred.make<void>()
      const recoveryInterrupted = yield* Deferred.make<void>()

      yield* lifecycle.awaitOwnershipAuthorization
      yield* client["Core.authorizeDatabaseOwnership"](authorizationRequest)

      const recoveryFiber = yield* lifecycle
        .interruptOnDrain(
          Deferred.succeed(recoveryStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(recoveryInterrupted, undefined)),
          ),
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(recoveryStarted)
      expect((yield* client["Core.shutdown"](request)).lifecycle).toBe("draining")
      yield* Deferred.await(recoveryInterrupted)

      const recoveryExit = yield* Fiber.await(recoveryFiber)
      expect(Exit.isFailure(recoveryExit)).toBe(true)
      if (Exit.isFailure(recoveryExit)) {
        expect(Cause.hasInterrupts(recoveryExit.cause)).toBe(true)
      }

      const completionFailure = yield* lifecycle.completeRecovery.pipe(Effect.flip)
      expect(completionFailure).toMatchObject({
        _tag: "CoreLifecycleTransitionError",
        from: "draining",
        to: "ready",
      })
    }).pipe(Effect.provide(makeTestLayer())),
  )
})
