import {
  CoreReviewSessionAdmissionMiddleware,
  CoreReviewSessionCloseAdmissionMiddleware,
  CoreReviewSessionOpenAdmissionMiddleware,
} from "@diffdash/core-rpc/review-session-rpc-admission"
import {
  CoreReviewInventoryRequest,
  CoreReviewRangeRequest,
  CoreReviewSearchRequest,
  CoreReviewSessionFailure,
  CoreReviewSessionRequest,
  CoreReviewTargetRequest,
  OpenCoreReviewSessionRequest,
  type CoreReviewSessionFailure as CoreReviewSessionFailureType,
} from "@diffdash/core-rpc/review-session"
import { getCoreRpcMethodPolicy } from "@diffdash/core-rpc/method-policy"
import { Effect, Layer, Option, Schema } from "effect"
import type * as Rpc from "effect/unstable/rpc/Rpc"

import { CoreLifecycle } from "./core-lifecycle"

const ExactSessionRequest = Schema.Union([
  CoreReviewSessionRequest,
  CoreReviewInventoryRequest,
  CoreReviewRangeRequest,
  CoreReviewTargetRequest,
  CoreReviewSearchRequest,
])

const openAdmissionLayer = Layer.effect(
  CoreReviewSessionOpenAdmissionMiddleware,
  Effect.gen(function* () {
    const lifecycle = yield* CoreLifecycle
    return (effect, options) =>
      Schema.decodeUnknownEffect(OpenCoreReviewSessionRequest)(options.payload).pipe(
        Effect.orDie,
        Effect.flatMap((request) =>
          admitReviewSession(lifecycle, request, "Reviews.openSession", options.rpc, effect),
        ),
      )
  }),
)

const sessionAdmissionLayer = Layer.effect(
  CoreReviewSessionAdmissionMiddleware,
  Effect.gen(function* () {
    const lifecycle = yield* CoreLifecycle
    return (effect, options) =>
      Schema.decodeUnknownEffect(ExactSessionRequest)(options.payload).pipe(
        Effect.orDie,
        Effect.flatMap((request) =>
          admitReviewSession(lifecycle, request, options.rpc._tag, options.rpc, effect),
        ),
      )
  }),
)

const closeAdmissionLayer = Layer.effect(
  CoreReviewSessionCloseAdmissionMiddleware,
  Effect.gen(function* () {
    const lifecycle = yield* CoreLifecycle
    return (effect, options) =>
      Schema.decodeUnknownEffect(CoreReviewSessionRequest)(options.payload).pipe(
        Effect.orDie,
        Effect.flatMap((request) =>
          admitReviewSession(
            lifecycle,
            request,
            "Reviews.closeSession",
            options.rpc,
            Effect.uninterruptible(effect),
          ),
        ),
      )
  }),
)

/** Enforces Core epoch, lifecycle, deadline, and drain policy for progressive review RPCs. */
export const coreProgressiveReviewRpcAdmissionLayer = Layer.mergeAll(
  openAdmissionLayer,
  sessionAdmissionLayer,
  closeAdmissionLayer,
)

const admitReviewSession = Effect.fn("Core.ProgressiveReview.admit")(function* <A, E, R>(
  lifecycle: CoreLifecycle["Service"],
  request: typeof OpenCoreReviewSessionRequest.Type | typeof ExactSessionRequest.Type,
  method: string,
  rpc: Rpc.Any,
  effect: Effect.Effect<A, E, R>,
) {
  const declaredMethod = Schema.decodeUnknownOption(CoreReviewSessionFailure.fields.method)(method)
  const safeMethod = Option.getOrElse(declaredMethod, () => "Reviews.currentSession" as const)
  const fail = (
    code: CoreReviewSessionFailureType["code"],
    safeMessage: string,
  ): Effect.Effect<never, CoreReviewSessionFailureType> =>
    Effect.fail(
      CoreReviewSessionFailure.make({
        applicationInstanceId: request.applicationInstanceId,
        processEpoch: request.processEpoch,
        requestId: request.requestId,
        method: safeMethod,
        code,
        retryClass:
          code === "REQUEST_TOO_LARGE" || code === "RESPONSE_TOO_LARGE"
            ? "notRetryable"
            : "automatic",
        safeMessage,
      }),
    )
  const policy = yield* Option.match(getCoreRpcMethodPolicy(rpc), {
    onNone: () => Effect.die("Progressive review RPC is missing its method policy."),
    onSome: Effect.succeed,
  })
  yield* lifecycle.admitBusinessRequest(request).pipe(
    Effect.catchTags({
      CoreBusinessIdentityMismatchError: () =>
        fail("CORE_RESTARTED", "DiffDash Core restarted before serving this review request."),
      CoreBusinessLifecycleRejectedError: () =>
        fail("CORE_DRAINING", "DiffDash Core is not ready to serve progressive reviews."),
    }),
  )
  return yield* lifecycle.interruptOnDrain(effect).pipe(
    Effect.timeoutOrElse({
      duration: policy.deadlineMs,
      orElse: () =>
        fail("REQUEST_DEADLINE_EXCEEDED", "The progressive review request exceeded its deadline."),
    }),
    Effect.catchDefect(() =>
      Effect.die(
        CoreReviewSessionFailure.make({
          applicationInstanceId: request.applicationInstanceId,
          processEpoch: request.processEpoch,
          requestId: request.requestId,
          method: safeMethod,
          code: "REVIEW_SESSION_INTERNAL_ERROR",
          retryClass: "notRetryable",
          safeMessage: "DiffDash Core encountered an internal progressive review error.",
        }),
      ),
    ),
  )
})
