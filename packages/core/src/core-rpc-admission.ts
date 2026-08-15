import {
  AppStateGetAdmissionMiddleware,
  WalkthroughCancelAdmissionMiddleware,
  WalkthroughGetOperationAdmissionMiddleware,
  WalkthroughGetStoredAdmissionMiddleware,
  WalkthroughStartAdmissionMiddleware,
} from "@diffdash/core-rpc/admission"
import {
  AppStateGetDefect,
  AppStateGetIdentityMismatchFailure,
  AppStateGetLifecycleRejectedFailure,
} from "@diffdash/core-rpc/failure"
import { HostRequestContext } from "@diffdash/core-rpc/identity"
import type { CoreLifecycleState } from "@diffdash/core-rpc/lifecycle"
import { getCoreRpcMethodPolicy } from "@diffdash/core-rpc/method-policy"
import {
  WalkthroughCancelDefect,
  WalkthroughGetOperationDefect,
  WalkthroughGetStoredDefect,
  WalkthroughStartDefect,
} from "@diffdash/core-rpc/walkthrough-rpc"
import {
  CancelWalkthroughRequest,
  GetStoredWalkthroughRequest,
  GetWalkthroughOperationRequest,
  StartWalkthroughRequest,
  WalkthroughCancelAdmissionFailure,
  WalkthroughGetOperationAdmissionFailure,
  WalkthroughGetStoredAdmissionFailure,
  WalkthroughStartAdmissionFailure,
} from "@diffdash/core-rpc/walkthrough"
import { Effect, Layer, Option, Schema } from "effect"

import { CoreLifecycle } from "./core-lifecycle"

const appStateAdmissionLayer = Layer.effect(
  AppStateGetAdmissionMiddleware,
  Effect.gen(function* () {
    const lifecycle = yield* CoreLifecycle

    return (effect, options) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(HostRequestContext)(options.payload).pipe(
          Effect.orDie,
        )
        return yield* Effect.gen(function* () {
          yield* requireMethodPolicy(options.rpc)
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

const walkthroughStartAdmissionLayer = Layer.effect(
  WalkthroughStartAdmissionMiddleware,
  Effect.gen(function* () {
    const lifecycle = yield* CoreLifecycle

    return (effect, options) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(StartWalkthroughRequest)(
          options.payload,
        ).pipe(Effect.orDie)
        return yield* Effect.gen(function* () {
          yield* requireMethodPolicy(options.rpc)
          yield* lifecycle.admitBusinessRequest(request).pipe(
            Effect.catchTags({
              CoreBusinessIdentityMismatchError: () =>
                Effect.fail(
                  WalkthroughStartAdmissionFailure.make({
                    ...walkthroughAdmissionDetail(request, "CORE_RESTARTED"),
                    method: "Walkthroughs.start",
                    operationId: null,
                  }),
                ),
              CoreBusinessLifecycleRejectedError: (error) =>
                Effect.fail(
                  WalkthroughStartAdmissionFailure.make({
                    ...walkthroughAdmissionDetail(request, lifecycleCode(error.lifecycle)),
                    method: "Walkthroughs.start",
                    operationId: null,
                  }),
                ),
            }),
          )
          return yield* effect
        }).pipe(
          Effect.catchDefect(() =>
            Effect.die(
              WalkthroughStartDefect.make({
                ...walkthroughDefectDetail(request),
                method: "Walkthroughs.start",
                operationId: null,
              }),
            ),
          ),
        )
      })
  }),
)

const walkthroughGetOperationAdmissionLayer = Layer.effect(
  WalkthroughGetOperationAdmissionMiddleware,
  Effect.gen(function* () {
    const lifecycle = yield* CoreLifecycle

    return (effect, options) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(GetWalkthroughOperationRequest)(
          options.payload,
        ).pipe(Effect.orDie)
        return yield* Effect.gen(function* () {
          yield* requireMethodPolicy(options.rpc)
          yield* lifecycle.admitBusinessRequest(request).pipe(
            Effect.catchTags({
              CoreBusinessIdentityMismatchError: () =>
                Effect.fail(
                  WalkthroughGetOperationAdmissionFailure.make({
                    ...walkthroughAdmissionDetail(request, "CORE_RESTARTED"),
                    method: "Walkthroughs.getOperation",
                    operationId: request.operationId,
                  }),
                ),
              CoreBusinessLifecycleRejectedError: (error) =>
                Effect.fail(
                  WalkthroughGetOperationAdmissionFailure.make({
                    ...walkthroughAdmissionDetail(request, lifecycleCode(error.lifecycle)),
                    method: "Walkthroughs.getOperation",
                    operationId: request.operationId,
                  }),
                ),
            }),
          )
          return yield* lifecycle.interruptOnDrain(effect)
        }).pipe(
          Effect.catchDefect(() =>
            Effect.die(
              WalkthroughGetOperationDefect.make({
                ...walkthroughDefectDetail(request),
                method: "Walkthroughs.getOperation",
                operationId: request.operationId,
              }),
            ),
          ),
        )
      })
  }),
)

const walkthroughCancelAdmissionLayer = Layer.effect(
  WalkthroughCancelAdmissionMiddleware,
  Effect.gen(function* () {
    const lifecycle = yield* CoreLifecycle

    return (effect, options) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(CancelWalkthroughRequest)(
          options.payload,
        ).pipe(Effect.orDie)
        return yield* Effect.gen(function* () {
          yield* requireMethodPolicy(options.rpc)
          yield* lifecycle.admitBusinessRequest(request).pipe(
            Effect.catchTags({
              CoreBusinessIdentityMismatchError: () =>
                Effect.fail(
                  WalkthroughCancelAdmissionFailure.make({
                    ...walkthroughAdmissionDetail(request, "CORE_RESTARTED"),
                    method: "Walkthroughs.cancel",
                    operationId: request.operationId,
                  }),
                ),
              CoreBusinessLifecycleRejectedError: (error) =>
                Effect.fail(
                  WalkthroughCancelAdmissionFailure.make({
                    ...walkthroughAdmissionDetail(request, lifecycleCode(error.lifecycle)),
                    method: "Walkthroughs.cancel",
                    operationId: request.operationId,
                  }),
                ),
            }),
          )
          return yield* Effect.uninterruptible(effect)
        }).pipe(
          Effect.catchDefect(() =>
            Effect.die(
              WalkthroughCancelDefect.make({
                ...walkthroughDefectDetail(request),
                method: "Walkthroughs.cancel",
                operationId: request.operationId,
              }),
            ),
          ),
        )
      })
  }),
)

const walkthroughGetStoredAdmissionLayer = Layer.effect(
  WalkthroughGetStoredAdmissionMiddleware,
  Effect.gen(function* () {
    const lifecycle = yield* CoreLifecycle

    return (effect, options) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(GetStoredWalkthroughRequest)(
          options.payload,
        ).pipe(Effect.orDie)
        return yield* Effect.gen(function* () {
          yield* requireMethodPolicy(options.rpc)
          yield* lifecycle.admitBusinessRequest(request).pipe(
            Effect.catchTags({
              CoreBusinessIdentityMismatchError: () =>
                Effect.fail(
                  WalkthroughGetStoredAdmissionFailure.make({
                    ...walkthroughAdmissionDetail(request, "CORE_RESTARTED"),
                    method: "Walkthroughs.getStored",
                    operationId: null,
                  }),
                ),
              CoreBusinessLifecycleRejectedError: (error) =>
                Effect.fail(
                  WalkthroughGetStoredAdmissionFailure.make({
                    ...walkthroughAdmissionDetail(request, lifecycleCode(error.lifecycle)),
                    method: "Walkthroughs.getStored",
                    operationId: null,
                  }),
                ),
            }),
          )
          return yield* lifecycle.interruptOnDrain(effect)
        }).pipe(
          Effect.catchDefect(() =>
            Effect.die(
              WalkthroughGetStoredDefect.make({
                ...walkthroughDefectDetail(request),
                method: "Walkthroughs.getStored",
                operationId: null,
              }),
            ),
          ),
        )
      })
  }),
)

/** Enforces identity, lifecycle, drain, and defect policy for active Core business RPCs. */
export const coreRpcAdmissionLayer = Layer.mergeAll(
  appStateAdmissionLayer,
  walkthroughStartAdmissionLayer,
  walkthroughGetOperationAdmissionLayer,
  walkthroughCancelAdmissionLayer,
  walkthroughGetStoredAdmissionLayer,
)

const requireMethodPolicy = (rpc: Parameters<typeof getCoreRpcMethodPolicy>[0]) =>
  Option.match(getCoreRpcMethodPolicy(rpc), {
    onNone: () => Effect.die("Core business RPC is missing its method policy."),
    onSome: () => Effect.void,
  })

const lifecycleCodes = {
  starting: "CORE_UNAVAILABLE",
  awaitingOwnership: "CORE_UNAVAILABLE",
  recovering: "CORE_UNAVAILABLE",
  ready: "CORE_UNAVAILABLE",
  draining: "CORE_DRAINING",
  stopped: "CORE_DRAINING",
  failed: "CORE_UNAVAILABLE",
} as const satisfies Record<CoreLifecycleState, "CORE_UNAVAILABLE" | "CORE_DRAINING">

const lifecycleCode = (lifecycle: CoreLifecycleState) => lifecycleCodes[lifecycle]

const walkthroughAdmissionDetail = (
  request: HostRequestContext,
  code: "CORE_UNAVAILABLE" | "CORE_RESTARTED" | "CORE_DRAINING",
) => ({
  _tag: "WalkthroughPublicFailure" as const,
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: request.requestId,
  code,
  providerId: null,
  modelId: null,
  retryClass: "automatic" as const,
  remediation: "retry" as const,
  safeMessage:
    code === "CORE_DRAINING"
      ? "DiffDash Core is draining."
      : code === "CORE_RESTARTED"
        ? "DiffDash Core restarted before serving the walkthrough request."
        : "DiffDash Core is not ready to serve walkthrough requests.",
  attempts: [],
  diagnostic: null,
})

const walkthroughDefectDetail = (request: HostRequestContext) => ({
  _tag: "WalkthroughPublicFailure" as const,
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: request.requestId,
  code: "WALKTHROUGH_INTERNAL_ERROR" as const,
  providerId: null,
  modelId: null,
  retryClass: "notRetryable" as const,
  remediation: "contactSupport" as const,
  safeMessage: "DiffDash Core encountered an internal walkthrough error." as const,
  attempts: [],
  diagnostic: null,
})
