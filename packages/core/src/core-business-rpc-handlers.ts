import { CoreBusinessRpcs } from "@diffdash/core-rpc/business"
import { AppStateGetDefect, AppStateReadFailure } from "@diffdash/core-rpc/failure"
import { AppState } from "@diffdash/settings/app-state"
import { Effect } from "effect"

/** Native Effect RPC handlers for business operations already owned by Core. */
export const coreBusinessRpcHandlersLayer = CoreBusinessRpcs.toLayer(
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
          Effect.catchDefect(() =>
            Effect.die(
              AppStateGetDefect.make({
                code: "APP_STATE_INTERNAL_ERROR",
                method: "AppState.get",
                applicationInstanceId: request.applicationInstanceId,
                processEpoch: request.processEpoch,
                requestId: request.requestId,
                retryClass: "notRetryable",
                safeMessage: "DiffDash Core encountered an internal application-state error.",
              }),
            ),
          ),
        ),
    }
  }),
)
