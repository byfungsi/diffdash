import { AppStateBusinessRpcs } from "@diffdash/core-rpc/business"
import { AppStateGetAdmissionMiddleware } from "@diffdash/core-rpc/admission"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  HostRequestContext,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import { AppState as SharedAppState } from "@diffdash/domain/app-state"
import { AppState, AppStateError } from "@diffdash/settings/app-state"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import { coreBusinessRpcHandlersLayer } from "./core-business-rpc-handlers"

const request = HostRequestContext.make({
  applicationInstanceId: ApplicationInstanceId.make("app-1"),
  processEpoch: CoreProcessEpoch.make("epoch-1"),
  requestId: HostRequestId.make("h:request-1"),
})

const state = SharedAppState.make({ onboardingCompleted: true })

const makeTestLayer = (get: Effect.Effect<SharedAppState, AppStateError>) =>
  coreBusinessRpcHandlersLayer.pipe(
    Layer.provideMerge(Layer.succeed(AppStateGetAdmissionMiddleware, (effect) => effect)),
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

describe("Core business RPC handlers", () => {
  it.effect("reads application state through the native RPC handler", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(AppStateBusinessRpcs)
      expect(yield* client["AppState.get"](request)).toEqual(state)
    }).pipe(Effect.provide(makeTestLayer(Effect.succeed(state)))),
  )

  it.effect("maps application-state read failures to a stable plain value", () => {
    const storageFailure = AppStateError.make({
      operation: "read",
      cause: new Error("private /Users/example/repository/path"),
    })

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(AppStateBusinessRpcs)
      const failure = yield* client["AppState.get"](request).pipe(Effect.flip)

      expect(failure).toEqual({
        _tag: "AppStateReadFailure",
        code: "APP_STATE_READ_FAILED",
        method: "AppState.get",
        ...request,
        retryClass: "userAction",
        safeMessage: "DiffDash could not read application state.",
      })
      expect(JSON.stringify(failure)).not.toContain("/Users/example")
    }).pipe(Effect.provide(makeTestLayer(Effect.fail(storageFailure))))
  })
})
