import { AppStateGetAdmissionMiddleware } from "@diffdash/core-rpc/admission"
import {
  AppStateGetDefect,
  AppStateGetIdentityMismatchFailure,
  AppStateGetLifecycleRejectedFailure,
} from "@diffdash/core-rpc/failure"
import { HostRequestContext } from "@diffdash/core-rpc/identity"
import { getCoreRpcMethodPolicy } from "@diffdash/core-rpc/method-policy"
import { Effect, Layer, Option, Schema } from "effect"

import { CoreLifecycle } from "./core-lifecycle"

/** Enforces identity and ready-state admission around `AppState.get`. */
export const coreRpcAdmissionLayer = Layer.effect(
  AppStateGetAdmissionMiddleware,
  Effect.gen(function* () {
    const lifecycle = yield* CoreLifecycle

    return (effect, options) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(HostRequestContext)(options.payload).pipe(
          Effect.orDie,
        )
        return yield* Effect.gen(function* () {
          yield* Option.match(getCoreRpcMethodPolicy(options.rpc), {
            onNone: () => Effect.die("Core RPC AppState.get is missing its method policy."),
            onSome: () => Effect.void,
          })
          yield* lifecycle.admitBusinessRequest(request).pipe(
            Effect.catchTags({
              CoreBusinessIdentityMismatchError: (error) =>
                Effect.fail(
                  AppStateGetIdentityMismatchFailure.make({
                    code: "CORE_REQUEST_IDENTITY_MISMATCH",
                    method: "AppState.get",
                    applicationInstanceId: error.applicationInstanceId,
                    processEpoch: error.processEpoch,
                    requestId: error.requestId,
                    retryClass: "automatic",
                    safeMessage:
                      "DiffDash Core rejected a request for a different process identity.",
                  }),
                ),
              CoreBusinessLifecycleRejectedError: (error) =>
                Effect.fail(
                  AppStateGetLifecycleRejectedFailure.make({
                    code: "CORE_LIFECYCLE_REJECTED",
                    method: "AppState.get",
                    applicationInstanceId: request.applicationInstanceId,
                    processEpoch: request.processEpoch,
                    requestId: error.requestId,
                    lifecycle: error.lifecycle,
                    retryClass: "automatic",
                    safeMessage: "DiffDash Core is not ready to serve application requests.",
                  }),
                ),
            }),
          )
          return yield* lifecycle.interruptOnDrain(effect)
        }).pipe(
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
        )
      })
  }),
)
