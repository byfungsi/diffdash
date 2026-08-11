import { CoreControlRpcs } from "@diffdash/core-rpc/control"
import {
  CoreAuthorizeDatabaseOwnershipDefect,
  CoreHealthDefect,
  CoreShutdownDefect,
} from "@diffdash/core-rpc/failure"
import { Effect } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"

import { CoreLifecycle } from "./core-lifecycle"

/** Final native Effect RPC handlers for Core bootstrap, ownership admission, and shutdown. */
export const coreControlRpcHandlersLayer = CoreControlRpcs.toLayer(
  Effect.gen(function* () {
    const lifecycle = yield* CoreLifecycle
    return {
      "Core.health": (request) =>
        lifecycle.health(request).pipe(
          Effect.catchDefect(() =>
            Effect.die(
              CoreHealthDefect.make({
                method: "Core.health",
                code: "CORE_INTERNAL_ERROR",
                applicationInstanceId: request.applicationInstanceId,
                processEpoch: request.processEpoch,
                requestId: request.requestId,
                retryClass: "notRetryable",
                safeMessage: "DiffDash Core encountered an internal control-plane error.",
              }),
            ),
          ),
        ),
      "Core.authorizeDatabaseOwnership": (request) =>
        Rpc.uninterruptible(
          lifecycle.authorizeDatabaseOwnership(request).pipe(
            Effect.catchDefect(() =>
              Effect.die(
                CoreAuthorizeDatabaseOwnershipDefect.make({
                  method: "Core.authorizeDatabaseOwnership",
                  code: "CORE_INTERNAL_ERROR",
                  applicationInstanceId: request.applicationInstanceId,
                  processEpoch: request.processEpoch,
                  requestId: request.requestId,
                  retryClass: "notRetryable",
                  safeMessage: "DiffDash Core encountered an internal control-plane error.",
                }),
              ),
            ),
          ),
        ),
      "Core.shutdown": (request) =>
        Rpc.uninterruptible(
          lifecycle.shutdown(request).pipe(
            Effect.catchDefect(() =>
              Effect.die(
                CoreShutdownDefect.make({
                  method: "Core.shutdown",
                  code: "CORE_INTERNAL_ERROR",
                  applicationInstanceId: request.applicationInstanceId,
                  processEpoch: request.processEpoch,
                  requestId: request.requestId,
                  retryClass: "notRetryable",
                  safeMessage: "DiffDash Core encountered an internal control-plane error.",
                }),
              ),
            ),
          ),
        ),
    }
  }),
)
