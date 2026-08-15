import { AppStateBusinessRpcs } from "@diffdash/core-rpc/business"
import { AppStateReadFailure } from "@diffdash/core-rpc/failure"
import { AppState } from "@diffdash/settings/app-state"
import { Effect } from "effect"

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
