import { AppStateBusinessRpcs } from "@diffdash/core-rpc/business"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  DatabaseOwnershipAuthorizationId,
  HostRequestContext,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import { AuthorizeDatabaseOwnershipRequest } from "@diffdash/core-rpc/lifecycle"
import { AppState as SharedAppState } from "@diffdash/domain/app-state"
import { AppState } from "@diffdash/settings/app-state"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref } from "effect"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import { coreBusinessRpcHandlersLayer } from "./core-business-rpc-handlers"
import { CoreLifecycle, coreLifecycleLayer } from "./core-lifecycle"
import { coreRpcAdmissionLayer } from "./core-rpc-admission"

const identity = {
  applicationInstanceId: ApplicationInstanceId.make("app-1"),
  processEpoch: CoreProcessEpoch.make("epoch-1"),
} as const

const request = HostRequestContext.make({
  ...identity,
  requestId: HostRequestId.make("h:request-1"),
})

const authorizationRequest = AuthorizeDatabaseOwnershipRequest.make({
  ...request,
  authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-1"),
})

const state = SharedAppState.make({ onboardingCompleted: true })

const makeTestLayer = (get: Effect.Effect<SharedAppState>) => {
  const lifecycleLayer = coreLifecycleLayer(identity)
  const admissionLayer = coreRpcAdmissionLayer.pipe(Layer.provide(lifecycleLayer))
  const handlersLayer = coreBusinessRpcHandlersLayer.pipe(
    Layer.provide(
      Layer.succeed(
        AppState,
        AppState.of({
          get,
          save: (next) => Effect.succeed(next),
        }),
      ),
    ),
  )

  return Layer.mergeAll(lifecycleLayer, admissionLayer, handlersLayer)
}

const becomeReady = Effect.gen(function* () {
  const lifecycle = yield* CoreLifecycle
  yield* lifecycle.awaitOwnershipAuthorization
  yield* lifecycle.authorizeDatabaseOwnership(authorizationRequest)
  yield* lifecycle.completeRecovery
})

describe("Core RPC admission", () => {
  it.effect("rejects AppState.get before Core is ready without reading storage", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0)
      const testLayer = makeTestLayer(
        Ref.update(reads, (count) => count + 1).pipe(Effect.as(state)),
      )

      return yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(AppStateBusinessRpcs)
        const failure = yield* client["AppState.get"](request).pipe(Effect.flip)

        expect(failure).toEqual({
          _tag: "CoreLifecycleRejectedFailure",
          code: "CORE_LIFECYCLE_REJECTED",
          method: "AppState.get",
          ...request,
          lifecycle: "starting",
          retryClass: "automatic",
          safeMessage: "DiffDash Core is not ready to serve application requests.",
        })
        expect(yield* Ref.get(reads)).toBe(0)
      }).pipe(Effect.provide(testLayer))
    }),
  )

  it.effect("rejects AppState.get in every non-ready lifecycle state", () => {
    const scenarios: ReadonlyArray<
      readonly [
        "starting" | "awaitingOwnership" | "recovering" | "draining" | "stopped" | "failed",
        (lifecycle: CoreLifecycle["Service"]) => Effect.Effect<void, unknown>,
      ]
    > = [
      ["starting", () => Effect.void],
      ["awaitingOwnership", (lifecycle) => lifecycle.awaitOwnershipAuthorization],
      [
        "recovering",
        (lifecycle) =>
          lifecycle.awaitOwnershipAuthorization.pipe(
            Effect.andThen(lifecycle.authorizeDatabaseOwnership(authorizationRequest)),
            Effect.asVoid,
          ),
      ],
      [
        "draining",
        (lifecycle) =>
          lifecycle.awaitOwnershipAuthorization.pipe(
            Effect.andThen(lifecycle.shutdown(request)),
            Effect.asVoid,
          ),
      ],
      [
        "stopped",
        (lifecycle) =>
          lifecycle.awaitOwnershipAuthorization.pipe(
            Effect.andThen(lifecycle.shutdown(request)),
            Effect.andThen(lifecycle.completeShutdown),
          ),
      ],
      ["failed", (lifecycle) => lifecycle.fail],
    ]

    return Effect.forEach(scenarios, ([expectedLifecycle, arrange]) =>
      Effect.gen(function* () {
        const lifecycle = yield* CoreLifecycle
        const client = yield* RpcTest.makeClient(AppStateBusinessRpcs)
        yield* arrange(lifecycle)

        const failure = yield* client["AppState.get"](request).pipe(Effect.flip)
        expect(failure).toMatchObject({
          _tag: "CoreLifecycleRejectedFailure",
          method: "AppState.get",
          lifecycle: expectedLifecycle,
        })
      }).pipe(
        Effect.provide(
          makeTestLayer(Effect.die("AppState storage must not run before ready admission")),
        ),
      ),
    )
  })

  it.effect("rejects a stale process epoch before reading storage", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0)
      const testLayer = makeTestLayer(
        Ref.update(reads, (count) => count + 1).pipe(Effect.as(state)),
      )

      return yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(AppStateBusinessRpcs)
        const staleRequest = HostRequestContext.make({
          ...request,
          processEpoch: CoreProcessEpoch.make("epoch-stale"),
        })
        const failure = yield* client["AppState.get"](staleRequest).pipe(Effect.flip)

        expect(failure).toEqual({
          _tag: "CoreIdentityMismatchFailure",
          code: "CORE_REQUEST_IDENTITY_MISMATCH",
          method: "AppState.get",
          ...identity,
          requestId: request.requestId,
          retryClass: "automatic",
          safeMessage: "DiffDash Core rejected a request for a different process identity.",
        })
        expect(yield* Ref.get(reads)).toBe(0)
      }).pipe(Effect.provide(testLayer))
    }),
  )

  it.effect("serves AppState.get after recovery completes", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(AppStateBusinessRpcs)
      yield* becomeReady

      expect(yield* client["AppState.get"](request)).toEqual(state)
    }).pipe(Effect.provide(makeTestLayer(Effect.succeed(state)))),
  )

  it.effect("projects an admitted handler defect to the method-scoped safe value", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(AppStateBusinessRpcs)
      yield* becomeReady
      const defect = yield* client["AppState.get"](request).pipe(Effect.catchDefect(Effect.succeed))

      expect(defect).toEqual({
        _tag: "AppStateGetDefect",
        code: "APP_STATE_INTERNAL_ERROR",
        method: "AppState.get",
        ...request,
        retryClass: "notRetryable",
        safeMessage: "DiffDash Core encountered an internal application-state error.",
      })
      expect(JSON.stringify(defect)).not.toContain("/Users/example")
    }).pipe(
      Effect.provide(
        makeTestLayer(Effect.die(new Error("private /Users/example/repository/path"))),
      ),
    ),
  )

  it.effect("interrupts an admitted AppState.get when shutdown begins", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const testLayer = makeTestLayer(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      )

      return yield* Effect.gen(function* () {
        const lifecycle = yield* CoreLifecycle
        const client = yield* RpcTest.makeClient(AppStateBusinessRpcs)
        yield* becomeReady
        const requestFiber = yield* client["AppState.get"](request).pipe(Effect.forkScoped)
        yield* Deferred.await(started)

        yield* lifecycle.shutdown(request)
        yield* Deferred.await(interrupted)
        const exit = yield* Fiber.await(requestFiber)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) throw new Error("Expected the admitted request to be interrupted")
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }).pipe(Effect.provide(testLayer))
    }),
  )
})
