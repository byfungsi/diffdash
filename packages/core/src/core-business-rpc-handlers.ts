import { AppStateBusinessRpcs, AppStateUpdateRpcs } from "@diffdash/core-rpc/business"
import { CoreApplicationFailureCode } from "@diffdash/core-rpc/application-rpc"
import { AppStateReadFailure } from "@diffdash/core-rpc/failure"
import { AppState } from "@diffdash/settings/app-state"
import { Effect } from "effect"

import { CoreMethod } from "./core-contract"
import { CoreRuntimeServices } from "./core-runtime-services"

/** Native Effect RPC handlers for business operations already owned by Core. */
export const coreBusinessRpcHandlersLayer = AppStateBusinessRpcs.toLayer(
  Effect.gen(function* () {
    const appState = yield* AppState
    return {
      "AppState.get": (request) =>
        appState.get.pipe(
          Effect.mapError(() =>
            AppStateReadFailure.make({
              code: "APP_STATE_READ_FAILED",
              method: "AppState.get",
              applicationInstanceId: request.applicationInstanceId,
              processEpoch: request.processEpoch,
              requestId: request.requestId,
              retryClass: "userAction",
              safeMessage: "DiffDash could not read application state.",
            }),
          ),
        ),
    }
  }),
)

/** AppState handlers backed by the operation authority installed after ownership recovery. */
export const coreBusinessRpcHandlersWithRuntimeLayer = AppStateBusinessRpcs.toLayer(
  Effect.gen(function* () {
    const runtime = yield* CoreRuntimeServices
    return {
      "AppState.get": (request) =>
        runtime.operations.pipe(
          Effect.flatMap((operations) => operations.execute(CoreMethod.appStateGet, {})),
          Effect.mapError(() =>
            AppStateReadFailure.make({
              code: "APP_STATE_READ_FAILED",
              method: "AppState.get",
              applicationInstanceId: request.applicationInstanceId,
              processEpoch: request.processEpoch,
              requestId: request.requestId,
              retryClass: "userAction",
              safeMessage: "DiffDash could not read application state.",
            }),
          ),
        ),
    }
  }),
)

/** AppState mutation handler backed by the operation authority installed after recovery. */
export const coreAppStateUpdateRpcHandlersWithRuntimeLayer = AppStateUpdateRpcs.toLayer(
  Effect.gen(function* () {
    const runtime = yield* CoreRuntimeServices
    return {
      "AppState.update": (request) =>
        runtime.operations.pipe(
          Effect.flatMap((operations) =>
            operations.execute(CoreMethod.appStateUpdate, { state: request.state }),
          ),
          Effect.mapError(() => ({
            _tag: "CoreApplicationFailure" as const,
            applicationInstanceId: request.applicationInstanceId,
            processEpoch: request.processEpoch,
            requestId: request.requestId,
            method: "AppState.update" as const,
            code: CoreApplicationFailureCode.make("APP_STATE_WRITE_FAILED"),
            retryClass: "userAction" as const,
            safeMessage: "DiffDash could not update application state.",
          })),
        ),
    }
  }),
)
