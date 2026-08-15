import {
  AppStateGetAdmissionMiddleware,
  ReviewAgentCancelAdmissionMiddleware,
  ReviewAgentGetOperationAdmissionMiddleware,
  ReviewAgentStartAdmissionMiddleware,
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
import { getCoreRpcMethodPolicy, type CoreRpcMethodPolicy } from "@diffdash/core-rpc/method-policy"
import {
  CORE_RPC_INCOMPLETE_BUFFER_BYTES,
  CORE_RPC_MAX_CONCURRENCY,
} from "@diffdash/core-rpc/transport"
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
import {
  ReviewAgentCancelFailure,
  ReviewAgentGetOperationFailure,
  ReviewAgentOperationRequest,
  ReviewAgentStartFailure,
  StartReviewAgentOperationRequest,
} from "@diffdash/core-rpc/review-agent"
import { Effect, Fiber, FiberSet, Layer, Option, Predicate, Schema, Semaphore } from "effect"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"

import { CoreLifecycle } from "./core-lifecycle"

const methodPolicyParser = RpcSerialization.makeMsgPack({
  useRecords: true,
  maxBufferSize: CORE_RPC_INCOMPLETE_BUFFER_BYTES,
}).makeUnsafe()

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
          const policy = yield* requireMethodPolicy(options.rpc)
          yield* requireRequestBudget(request, policy).pipe(
            Effect.mapError(() =>
              WalkthroughStartAdmissionFailure.make({
                ...walkthroughAdmissionDetail(request, "REQUEST_TOO_LARGE"),
                method: "Walkthroughs.start",
                operationId: null,
              }),
            ),
          )
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
          return yield* lifecycle.interruptOnDrain(effect).pipe(
            Effect.timeoutOrElse({
              duration: policy.deadlineMs,
              orElse: () =>
                Effect.fail(
                  WalkthroughStartAdmissionFailure.make({
                    ...walkthroughAdmissionDetail(request, "REQUEST_DEADLINE_EXCEEDED"),
                    method: "Walkthroughs.start",
                    operationId: null,
                  }),
                ),
            }),
          )
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
          const policy = yield* requireMethodPolicy(options.rpc)
          yield* requireRequestBudget(request, policy).pipe(
            Effect.mapError(() =>
              WalkthroughGetOperationAdmissionFailure.make({
                ...walkthroughAdmissionDetail(request, "REQUEST_TOO_LARGE"),
                method: "Walkthroughs.getOperation",
                operationId: request.operationId,
              }),
            ),
          )
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
          return yield* lifecycle.interruptOnDrain(effect).pipe(
            Effect.timeoutOrElse({
              duration: policy.deadlineMs,
              orElse: () =>
                Effect.fail(
                  WalkthroughGetOperationAdmissionFailure.make({
                    ...walkthroughAdmissionDetail(request, "REQUEST_DEADLINE_EXCEEDED"),
                    method: "Walkthroughs.getOperation",
                    operationId: request.operationId,
                  }),
                ),
            }),
          )
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
    const cancellations = yield* FiberSet.make()
    const cancellationCapacity = yield* Semaphore.make(CORE_RPC_MAX_CONCURRENCY)

    return (effect, options) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(CancelWalkthroughRequest)(
          options.payload,
        ).pipe(Effect.orDie)
        return yield* Effect.gen(function* () {
          const policy = yield* requireMethodPolicy(options.rpc)
          yield* requireRequestBudget(request, policy).pipe(
            Effect.mapError(() =>
              WalkthroughCancelAdmissionFailure.make({
                ...walkthroughAdmissionDetail(request, "REQUEST_TOO_LARGE"),
                method: "Walkthroughs.cancel",
                operationId: request.operationId,
              }),
            ),
          )
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
          const cancellation = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const acquired = yield* cancellationCapacity.takeIfAvailable(1)
              if (!acquired)
                return yield* Effect.fail(
                  WalkthroughCancelAdmissionFailure.make({
                    ...walkthroughAdmissionDetail(request, "CORE_RPC_ERROR"),
                    method: "Walkthroughs.cancel",
                    operationId: request.operationId,
                  }),
                )
              return yield* FiberSet.run(
                cancellations,
                Effect.uninterruptible(effect).pipe(
                  Effect.ensuring(cancellationCapacity.release(1)),
                ),
              )
            }),
          )
          return yield* Fiber.join(cancellation).pipe(
            Effect.timeoutOrElse({
              duration: policy.deadlineMs,
              orElse: () =>
                Effect.fail(
                  WalkthroughCancelAdmissionFailure.make({
                    ...walkthroughAdmissionDetail(request, "REQUEST_DEADLINE_EXCEEDED"),
                    method: "Walkthroughs.cancel",
                    operationId: request.operationId,
                  }),
                ),
            }),
          )
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
          const policy = yield* requireMethodPolicy(options.rpc)
          yield* requireRequestBudget(request, policy).pipe(
            Effect.mapError(() =>
              WalkthroughGetStoredAdmissionFailure.make({
                ...walkthroughAdmissionDetail(request, "REQUEST_TOO_LARGE"),
                method: "Walkthroughs.getStored",
                operationId: null,
              }),
            ),
          )
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
          return yield* lifecycle.interruptOnDrain(effect).pipe(
            Effect.timeoutOrElse({
              duration: policy.deadlineMs,
              orElse: () =>
                Effect.fail(
                  WalkthroughGetStoredAdmissionFailure.make({
                    ...walkthroughAdmissionDetail(request, "REQUEST_DEADLINE_EXCEEDED"),
                    method: "Walkthroughs.getStored",
                    operationId: null,
                  }),
                ),
            }),
          )
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

const reviewAgentStartAdmissionLayer = Layer.effect(
  ReviewAgentStartAdmissionMiddleware,
  Effect.gen(function* () {
    const lifecycle = yield* CoreLifecycle
    return (effect, options) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(StartReviewAgentOperationRequest)(
          options.payload,
        ).pipe(Effect.orDie)
        return yield* admitReviewAgentRequest(lifecycle, request, options.rpc, effect).pipe(
          Effect.catch((code) =>
            Predicate.isString(code)
              ? Effect.fail(
                  ReviewAgentStartFailure.make({
                    ...requestIdentity(request),
                    method: "ReviewAgents.start",
                    runId: null,
                    code: reviewAgentAdmissionCode(code),
                    safeMessage: reviewAgentAdmissionMessage(code),
                  }),
                )
              : Effect.fail(code),
          ),
          Effect.catchDefect(() =>
            Effect.die(
              ReviewAgentStartFailure.make({
                ...requestIdentity(request),
                method: "ReviewAgents.start",
                runId: null,
                code: "REVIEW_AGENT_INTERNAL_ERROR",
                safeMessage: "DiffDash Core encountered an internal review-agent error.",
              }),
            ),
          ),
        )
      })
  }),
)

const reviewAgentGetOperationAdmissionLayer = Layer.effect(
  ReviewAgentGetOperationAdmissionMiddleware,
  Effect.gen(function* () {
    const lifecycle = yield* CoreLifecycle
    return (effect, options) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(ReviewAgentOperationRequest)(
          options.payload,
        ).pipe(Effect.orDie)
        return yield* admitReviewAgentRequest(lifecycle, request, options.rpc, effect).pipe(
          Effect.catch((code) =>
            Predicate.isString(code)
              ? Effect.fail(
                  ReviewAgentGetOperationFailure.make({
                    ...requestIdentity(request),
                    method: "ReviewAgents.getOperation",
                    runId: request.runId,
                    code: reviewAgentAdmissionCode(code),
                    safeMessage: reviewAgentAdmissionMessage(code),
                  }),
                )
              : Effect.fail(code),
          ),
          Effect.catchDefect(() =>
            Effect.die(
              ReviewAgentGetOperationFailure.make({
                ...requestIdentity(request),
                method: "ReviewAgents.getOperation",
                runId: request.runId,
                code: "REVIEW_AGENT_INTERNAL_ERROR",
                safeMessage: "DiffDash Core encountered an internal review-agent error.",
              }),
            ),
          ),
        )
      })
  }),
)

const reviewAgentCancelAdmissionLayer = Layer.effect(
  ReviewAgentCancelAdmissionMiddleware,
  Effect.gen(function* () {
    const lifecycle = yield* CoreLifecycle
    return (effect, options) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(ReviewAgentOperationRequest)(
          options.payload,
        ).pipe(Effect.orDie)
        return yield* admitReviewAgentRequest(
          lifecycle,
          request,
          options.rpc,
          Effect.uninterruptible(effect),
        ).pipe(
          Effect.catch((code) =>
            Predicate.isString(code)
              ? Effect.fail(
                  ReviewAgentCancelFailure.make({
                    ...requestIdentity(request),
                    method: "ReviewAgents.cancel",
                    runId: request.runId,
                    code: reviewAgentAdmissionCode(code),
                    safeMessage: reviewAgentAdmissionMessage(code),
                  }),
                )
              : Effect.fail(code),
          ),
          Effect.catchDefect(() =>
            Effect.die(
              ReviewAgentCancelFailure.make({
                ...requestIdentity(request),
                method: "ReviewAgents.cancel",
                runId: request.runId,
                code: "REVIEW_AGENT_INTERNAL_ERROR",
                safeMessage: "DiffDash Core encountered an internal review-agent error.",
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
  reviewAgentStartAdmissionLayer,
  reviewAgentGetOperationAdmissionLayer,
  reviewAgentCancelAdmissionLayer,
)

const admitReviewAgentRequest = Effect.fn("Core.ReviewAgents.admit")(function* <A, E, R>(
  lifecycle: CoreLifecycle["Service"],
  request: HostRequestContext,
  rpc: Parameters<typeof getCoreRpcMethodPolicy>[0],
  effect: Effect.Effect<A, E, R>,
) {
  const policy = yield* requireMethodPolicy(rpc)
  yield* requireRequestBudget(request, policy).pipe(
    Effect.mapError(() => "REVIEW_AGENT_INTERNAL_ERROR" as const),
  )
  yield* lifecycle
    .admitBusinessRequest(request)
    .pipe(Effect.mapError(() => "CORE_DRAINING" as const))
  return yield* lifecycle.interruptOnDrain(effect).pipe(
    Effect.timeoutOrElse({
      duration: policy.deadlineMs,
      orElse: () => Effect.fail("REVIEW_AGENT_INTERNAL_ERROR" as const),
    }),
  )
})

const reviewAgentAdmissionCode = (code: string) =>
  code === "CORE_DRAINING" ? ("CORE_DRAINING" as const) : ("REVIEW_AGENT_INTERNAL_ERROR" as const)

const reviewAgentAdmissionMessage = (code: string) =>
  code === "CORE_DRAINING"
    ? "DiffDash Core is draining."
    : "DiffDash Core could not admit the review-agent request."

const requestIdentity = (request: HostRequestContext) => ({
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: request.requestId,
})

const requireMethodPolicy = (rpc: Parameters<typeof getCoreRpcMethodPolicy>[0]) =>
  Option.match(getCoreRpcMethodPolicy(rpc), {
    onNone: () => Effect.die("Core business RPC is missing its method policy."),
    onSome: Effect.succeed,
  })

const requireRequestBudget = (request: HostRequestContext, policy: CoreRpcMethodPolicy) =>
  Effect.sync(() => methodPolicyParser.encode(request)).pipe(
    Effect.filterOrFail(
      (encoded) =>
        encoded !== undefined &&
        (Predicate.isString(encoded) ? Buffer.byteLength(encoded) : encoded.byteLength) <=
          policy.maxRequestBytes,
      () => undefined,
    ),
    Effect.asVoid,
  )

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
  code:
    | "CORE_UNAVAILABLE"
    | "CORE_RESTARTED"
    | "CORE_DRAINING"
    | "CORE_RPC_ERROR"
    | "REQUEST_TOO_LARGE"
    | "REQUEST_DEADLINE_EXCEEDED",
) => ({
  _tag: "WalkthroughPublicFailure" as const,
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: request.requestId,
  code,
  providerId: null,
  modelId: null,
  retryClass: code === "REQUEST_TOO_LARGE" ? ("notRetryable" as const) : ("automatic" as const),
  remediation: code === "REQUEST_TOO_LARGE" ? ("none" as const) : ("retry" as const),
  safeMessage:
    code === "CORE_DRAINING"
      ? "DiffDash Core is draining."
      : code === "CORE_RESTARTED"
        ? "DiffDash Core restarted before serving the walkthrough request."
        : code === "CORE_RPC_ERROR"
          ? "DiffDash Core has no capacity for another cancellation request."
          : code === "REQUEST_TOO_LARGE"
            ? "The walkthrough request exceeded its size limit."
            : code === "REQUEST_DEADLINE_EXCEEDED"
              ? "The walkthrough request exceeded its deadline."
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
