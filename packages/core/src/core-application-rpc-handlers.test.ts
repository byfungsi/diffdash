import { CoreApplicationRpcs } from "@diffdash/core-rpc/application-rpc"
import { GitProviderId } from "@diffdash/domain/git-provider"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  DatabaseOwnershipAuthorizationId,
  HostRequestContext,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import { AuthorizeDatabaseOwnershipRequest } from "@diffdash/core-rpc/lifecycle"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import { coreApplicationRpcHandlersLayer } from "./core-application-rpc-handlers"
import { CoreLifecycle, coreLifecycleLayer } from "./core-lifecycle"
import { CoreRuntimeServices } from "./core-runtime-services"
import { ReviewLifecycleDiagnostics } from "./review-lifecycle-diagnostics"

const identity = {
  applicationInstanceId: ApplicationInstanceId.make("app-application-rpc"),
  processEpoch: CoreProcessEpoch.make("epoch-application-rpc"),
} as const

const request = HostRequestContext.make({
  ...identity,
  requestId: HostRequestId.make("h:application-rpc"),
})

const authorizationRequest = AuthorizeDatabaseOwnershipRequest.make({
  ...request,
  authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-application-rpc"),
})

const emptyDiagnostics = {
  acquisitions: {
    activeOperationIds: [],
    started: 0,
    completed: 0,
    superseded: 0,
    drained: 0,
    failed: 0,
    lastStartedOperationId: null,
    lastSupersededOperationId: null,
    lastDrainedOperationId: null,
  },
  sessions: {
    activeSessionId: null,
    opened: 0,
    disposed: 0,
    lastDisposedSessionId: null,
  },
} as const

const makeTestLayer = (snapshot: ReviewLifecycleDiagnostics["Service"]["snapshot"]) => {
  const lifecycleLayer = coreLifecycleLayer(identity)
  const runtimeLayer = Layer.mock(CoreRuntimeServices, {
    reviewLifecycleDiagnostics: Effect.succeed(
      ReviewLifecycleDiagnostics.of({
        snapshot,
        holdNextAcquisition: Effect.succeed(true),
        acquisitionStarted: () => Effect.void,
        acquisitionSuperseded: () => Effect.void,
        acquisitionFinished: () => Effect.void,
        sessionOpened: () => Effect.void,
        sessionDisposed: () => Effect.void,
      }),
    ),
  })
  const handlersLayer = coreApplicationRpcHandlersLayer.pipe(
    Layer.provide(Layer.merge(lifecycleLayer, runtimeLayer)),
  )

  return Layer.merge(lifecycleLayer, handlersLayer)
}

const becomeReady = Effect.gen(function* () {
  const lifecycle = yield* CoreLifecycle
  yield* lifecycle.awaitOwnershipAuthorization
  yield* lifecycle.authorizeDatabaseOwnership(authorizationRequest)
  yield* lifecycle.completeRecovery
})

describe("Core application RPC handlers admission", () => {
  it.effect("rejects requests until Core is ready without invoking the method", () =>
    Effect.gen(function* () {
      const invocations = yield* Ref.make(0)
      const snapshot = Ref.update(invocations, (count) => count + 1).pipe(
        Effect.as(emptyDiagnostics),
      )

      return yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(CoreApplicationRpcs)
        const failure = yield* client["E2E.reviewLifecycleDiagnostics"](request).pipe(Effect.flip)

        expect(failure).toMatchObject({
          _tag: "CoreApplicationFailure",
          ...request,
          method: "E2E.reviewLifecycleDiagnostics",
          code: "CORE_LIFECYCLE_REJECTED",
          retryClass: "automatic",
          safeMessage: "DiffDash Core is not ready to serve application requests.",
        })
        expect(yield* Ref.get(invocations)).toBe(0)
      }).pipe(Effect.provide(makeTestLayer(snapshot)))
    }),
  )

  it.effect("rejects a stale process identity before invoking the method", () =>
    Effect.gen(function* () {
      const invocations = yield* Ref.make(0)
      const snapshot = Ref.update(invocations, (count) => count + 1).pipe(
        Effect.as(emptyDiagnostics),
      )

      return yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(CoreApplicationRpcs)
        yield* becomeReady
        const staleRequest = HostRequestContext.make({
          ...request,
          processEpoch: CoreProcessEpoch.make("epoch-stale"),
        })
        const failure = yield* client["E2E.reviewLifecycleDiagnostics"](staleRequest).pipe(
          Effect.flip,
        )

        expect(failure).toMatchObject({
          method: "E2E.reviewLifecycleDiagnostics",
          code: "CORE_REQUEST_IDENTITY_MISMATCH",
          safeMessage: "DiffDash Core rejected a request for a different process identity.",
        })
        expect(yield* Ref.get(invocations)).toBe(0)
      }).pipe(Effect.provide(makeTestLayer(snapshot)))
    }),
  )

  it.effect("returns a typed drain failure for admitted interruptible work", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const snapshot = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))

      return yield* Effect.gen(function* () {
        const lifecycle = yield* CoreLifecycle
        const client = yield* RpcTest.makeClient(CoreApplicationRpcs)
        yield* becomeReady
        const requestFiber = yield* client["E2E.reviewLifecycleDiagnostics"](request).pipe(
          Effect.forkScoped,
        )
        yield* Deferred.await(started)
        yield* lifecycle.shutdown(request)

        const failure = yield* Fiber.join(requestFiber).pipe(Effect.flip)
        expect(failure).toMatchObject({
          method: "E2E.reviewLifecycleDiagnostics",
          code: "CORE_DRAINING",
          safeMessage: "DiffDash Core is draining and cannot complete this application request.",
        })
      }).pipe(Effect.provide(makeTestLayer(snapshot)))
    }),
  )

  it.effect("enforces the declared deadline and interrupts the operation", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const snapshot = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      )

      return yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(CoreApplicationRpcs)
        yield* becomeReady
        const requestFiber = yield* client["E2E.reviewLifecycleDiagnostics"](request).pipe(
          Effect.forkScoped,
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust("5 seconds")

        const failure = yield* Fiber.join(requestFiber).pipe(Effect.flip)
        expect(failure).toMatchObject({
          method: "E2E.reviewLifecycleDiagnostics",
          code: "REQUEST_DEADLINE_EXCEEDED",
          safeMessage: "The Core application request exceeded its deadline.",
        })
        yield* Deferred.await(interrupted)
      }).pipe(Effect.provide(makeTestLayer(snapshot)))
    }),
  )

  it.effect("applies interruptible cancellation from the method policy", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const snapshot = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      )

      return yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(CoreApplicationRpcs)
        yield* becomeReady
        const requestFiber = yield* client["E2E.reviewLifecycleDiagnostics"](request).pipe(
          Effect.forkScoped,
        )
        yield* Deferred.await(started)
        yield* Fiber.interrupt(requestFiber)
        yield* Deferred.await(interrupted)
      }).pipe(Effect.provide(makeTestLayer(snapshot)))
    }),
  )

  it.effect("rejects an oversized request before resolving operation authority", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoreApplicationRpcs)
      yield* becomeReady
      const failure = yield* client["GitProviders.searchRepositories"]({
        ...request,
        providerId: GitProviderId.make("github"),
        query: "x".repeat(300 * 1_024),
        namespaces: [],
      }).pipe(Effect.flip)

      expect(failure).toMatchObject({
        method: "GitProviders.searchRepositories",
        code: "REQUEST_TOO_LARGE",
        retryClass: "notRetryable",
        safeMessage: "The Core application request exceeded its size limit.",
      })
    }).pipe(Effect.provide(makeTestLayer(Effect.succeed(emptyDiagnostics)))),
  )

  it.effect("rejects an oversized success through the method failure contract", () => {
    const snapshot = Effect.succeed({
      ...emptyDiagnostics,
      acquisitions: {
        ...emptyDiagnostics.acquisitions,
        activeOperationIds: Array.from(
          { length: 100 },
          (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(196)}`,
        ),
      },
    })

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoreApplicationRpcs)
      yield* becomeReady
      const failure = yield* client["E2E.reviewLifecycleDiagnostics"](request).pipe(Effect.flip)

      expect(failure).toMatchObject({
        method: "E2E.reviewLifecycleDiagnostics",
        code: "RESPONSE_TOO_LARGE",
        retryClass: "notRetryable",
        safeMessage: "The Core application response exceeded its size limit.",
      })
    }).pipe(Effect.provide(makeTestLayer(snapshot)))
  })
})
