import { Schema } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

import {
  CoreReviewSessionAdmissionMiddleware,
  CoreReviewSessionCloseAdmissionMiddleware,
  CoreReviewSessionOpenAdmissionMiddleware,
} from "./review-session-rpc-admission"
import {
  CoreRpcDeadlineMilliseconds,
  CoreRpcMethodPolicy,
  CoreRpcMethodPolicyAnnotation,
  CoreRpcPayloadBytes,
  type CoreRpcMethodPolicy as CoreRpcMethodPolicyType,
} from "./method-policy"
import {
  CoreResolvedReviewTarget,
  CoreReviewInventoryPage,
  CoreReviewInventoryRequest,
  CoreReviewRange,
  CoreReviewRangeRequest,
  CoreReviewSearchPublication,
  CoreReviewSearchRequest,
  CoreReviewSessionFailure,
  CoreReviewSessionRequest,
  CoreReviewSessionState,
  CoreReviewTargetRequest,
  OpenCoreReviewSessionRequest,
} from "./review-session"

const KIB = 1_024
const DefectValue = Schema.NullishOr(Schema.ObjectKeyword)
const ReviewSessionDefect = CoreReviewSessionFailure.pipe(Schema.decodeTo(DefectValue))

const policy = (options: {
  readonly deadlineMs: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
  readonly mutationClass?: "read" | "idempotentMutation"
  readonly cancellation?: "interruptible" | "uninterruptible"
}): CoreRpcMethodPolicyType =>
  CoreRpcMethodPolicy.make({
    deadlineMs: CoreRpcDeadlineMilliseconds.make(options.deadlineMs),
    maxRequestBytes: CoreRpcPayloadBytes.make(options.maxRequestBytes),
    maxResponseBytes: CoreRpcPayloadBytes.make(options.maxResponseBytes),
    cancellation: options.cancellation ?? "interruptible",
    requiredScope: "review",
    mutationClass: options.mutationClass ?? "read",
    idempotency: "idempotent",
    restartBehavior: "failOnRestart",
    requiredHostCapabilities: [],
  })

const make = <Tag extends string, Payload extends Schema.Top, Success extends Schema.Top>(
  tag: Tag,
  payload: Payload,
  success: Success,
  methodPolicy: CoreRpcMethodPolicyType,
) =>
  Rpc.make(tag, {
    payload,
    success,
    error: CoreReviewSessionFailure,
    defect: ReviewSessionDefect,
  }).annotate(CoreRpcMethodPolicyAnnotation, methodPolicy)

/** Opens and supersedes the application-wide foreground review session. */
export const CoreReviewSessionOpenRpc = make(
  "Reviews.openSession",
  OpenCoreReviewSessionRequest,
  CoreReviewSessionState,
  policy({
    deadlineMs: 10_000,
    maxRequestBytes: 8 * KIB,
    maxResponseBytes: 8 * KIB,
    mutationClass: "idempotentMutation",
    cancellation: "uninterruptible",
  }),
).middleware(CoreReviewSessionOpenAdmissionMiddleware)

/** Reads authoritative state for one exact progressive session version. */
export const CoreReviewSessionCurrentRpc = make(
  "Reviews.currentSession",
  CoreReviewSessionRequest,
  CoreReviewSessionState,
  policy({ deadlineMs: 2_000, maxRequestBytes: 8 * KIB, maxResponseBytes: 8 * KIB }),
).middleware(CoreReviewSessionAdmissionMiddleware)

/** Deterministically closes one exact progressive session version. */
export const CoreReviewSessionCloseRpc = make(
  "Reviews.closeSession",
  CoreReviewSessionRequest,
  CoreReviewSessionState,
  policy({
    deadlineMs: 5_000,
    maxRequestBytes: 8 * KIB,
    maxResponseBytes: 8 * KIB,
    mutationClass: "idempotentMutation",
    cancellation: "uninterruptible",
  }),
).middleware(CoreReviewSessionCloseAdmissionMiddleware)

/** Reads one bounded changed-file inventory page. */
export const CoreReviewInventoryRpc = make(
  "Reviews.inventory",
  CoreReviewInventoryRequest,
  CoreReviewInventoryPage,
  policy({ deadlineMs: 5_000, maxRequestBytes: 8 * KIB, maxResponseBytes: 128 * KIB }),
).middleware(CoreReviewSessionAdmissionMiddleware)

/** Reads immediately available complete committed blocks. */
export const CoreReviewRangeReadRpc = make(
  "Ranges.read",
  CoreReviewRangeRequest,
  CoreReviewRange,
  policy({ deadlineMs: 10_000, maxRequestBytes: 8 * KIB, maxResponseBytes: 384 * KIB }),
).middleware(CoreReviewSessionAdmissionMiddleware)

/** Waits interruptibly for a bounded committed range. */
export const CoreReviewRangeWaitRpc = make(
  "Ranges.wait",
  CoreReviewRangeRequest,
  CoreReviewRange,
  policy({ deadlineMs: 30_000, maxRequestBytes: 8 * KIB, maxResponseBytes: 384 * KIB }),
).middleware(CoreReviewSessionAdmissionMiddleware)

/** Resolves one semantic file/hunk/line target without preceding range loads. */
export const CoreReviewTargetResolveRpc = make(
  "Navigation.resolveTarget",
  CoreReviewTargetRequest,
  CoreResolvedReviewTarget,
  policy({ deadlineMs: 10_000, maxRequestBytes: 8 * KIB, maxResponseBytes: 16 * KIB }),
).middleware(CoreReviewSessionAdmissionMiddleware)

/** Streams bounded provisional updates followed by one exact fixed-space search result. */
export const CoreReviewSearchRpc = Rpc.make("Search.scan", {
  payload: CoreReviewSearchRequest,
  success: CoreReviewSearchPublication,
  error: CoreReviewSessionFailure,
  defect: ReviewSessionDefect,
  stream: true,
})
  .middleware(CoreReviewSessionAdmissionMiddleware)
  .annotate(
    CoreRpcMethodPolicyAnnotation,
    policy({ deadlineMs: 60_000, maxRequestBytes: 16 * KIB, maxResponseBytes: 384 * KIB }),
  )

/** Native progressive review session, range, target, and fixed-space search declarations. */
export const CoreProgressiveReviewRpcs = RpcGroup.make(
  CoreReviewSessionOpenRpc,
  CoreReviewSessionCurrentRpc,
  CoreReviewSessionCloseRpc,
  CoreReviewInventoryRpc,
  CoreReviewRangeReadRpc,
  CoreReviewRangeWaitRpc,
  CoreReviewTargetResolveRpc,
  CoreReviewSearchRpc,
)
