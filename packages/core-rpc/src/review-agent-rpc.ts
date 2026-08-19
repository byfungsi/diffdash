import { Schema } from "effect"
import { ReviewThreadDetails } from "@diffdash/domain/review-thread"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

import {
  ReviewAgentCancelAdmissionMiddleware,
  ReviewAgentGetOperationAdmissionMiddleware,
  ReviewAgentStartAdmissionMiddleware,
} from "./admission"
import {
  CoreRpcDeadlineMilliseconds,
  CoreRpcMethodPolicy,
  CoreRpcMethodPolicyAnnotation,
  CoreRpcPayloadBytes,
} from "./method-policy"
import {
  ReviewAgentCancelFailure,
  ReviewAgentGetOperationFailure,
  ReviewAgentOperationRequest,
  ReviewAgentOperationSnapshot,
  ReviewAgentStartFailure,
  StartReviewAgentOperationRequest,
} from "./review-agent"

const DefectValue = Schema.NullishOr(Schema.ObjectKeyword)

/** RPC defect codec whose wire form is a sanitized start failure. */
export const ReviewAgentStartDefectSchema = ReviewAgentStartFailure.pipe(
  Schema.decodeTo(DefectValue),
)

/** RPC defect codec whose wire form is a sanitized operation-query failure. */
export const ReviewAgentGetOperationDefectSchema = ReviewAgentGetOperationFailure.pipe(
  Schema.decodeTo(DefectValue),
)

/** RPC defect codec whose wire form is a sanitized cancellation failure. */
export const ReviewAgentCancelDefectSchema = ReviewAgentCancelFailure.pipe(
  Schema.decodeTo(DefectValue),
)

/** Business RPC that durably runs one review-agent response and returns its authoritative thread. */
export const ReviewAgentStartRpc = Rpc.make("ReviewThreads.runAgent", {
  payload: StartReviewAgentOperationRequest,
  success: ReviewThreadDetails,
  error: ReviewAgentStartFailure,
  defect: ReviewAgentStartDefectSchema,
})
  .middleware(ReviewAgentStartAdmissionMiddleware)
  .annotate(
    CoreRpcMethodPolicyAnnotation,
    CoreRpcMethodPolicy.make({
      deadlineMs: CoreRpcDeadlineMilliseconds.make(10 * 60_000),
      maxRequestBytes: CoreRpcPayloadBytes.make(16 * 1_024),
      maxResponseBytes: CoreRpcPayloadBytes.make(256 * 1_024),
      cancellation: "detachedAfterAcceptance",
      requiredScope: "review",
      mutationClass: "uncertainMutation",
      idempotency: "nonIdempotent",
      restartBehavior: "failOnRestart",
      requiredHostCapabilities: [],
    }),
  )

/** Business RPC that reads one review-agent operation from authoritative storage. */
export const ReviewAgentGetOperationRpc = Rpc.make("ReviewAgents.getOperation", {
  payload: ReviewAgentOperationRequest,
  success: ReviewAgentOperationSnapshot,
  error: ReviewAgentGetOperationFailure,
  defect: ReviewAgentGetOperationDefectSchema,
})
  .middleware(ReviewAgentGetOperationAdmissionMiddleware)
  .annotate(
    CoreRpcMethodPolicyAnnotation,
    CoreRpcMethodPolicy.make({
      deadlineMs: CoreRpcDeadlineMilliseconds.make(2_000),
      maxRequestBytes: CoreRpcPayloadBytes.make(2 * 1_024),
      maxResponseBytes: CoreRpcPayloadBytes.make(64 * 1_024),
      cancellation: "interruptible",
      requiredScope: "operation",
      mutationClass: "read",
      idempotency: "idempotent",
      restartBehavior: "resumeByOperationId",
      requiredHostCapabilities: [],
    }),
  )

/** Business RPC that durably cancels active provider work by `AgentRunId`. */
export const ReviewAgentCancelRpc = Rpc.make("ReviewAgents.cancel", {
  payload: ReviewAgentOperationRequest,
  success: ReviewAgentOperationSnapshot,
  error: ReviewAgentCancelFailure,
  defect: ReviewAgentCancelDefectSchema,
})
  .middleware(ReviewAgentCancelAdmissionMiddleware)
  .annotate(
    CoreRpcMethodPolicyAnnotation,
    CoreRpcMethodPolicy.make({
      deadlineMs: CoreRpcDeadlineMilliseconds.make(5_000),
      maxRequestBytes: CoreRpcPayloadBytes.make(2 * 1_024),
      maxResponseBytes: CoreRpcPayloadBytes.make(64 * 1_024),
      cancellation: "uninterruptible",
      requiredScope: "operation",
      mutationClass: "idempotentMutation",
      idempotency: "idempotent",
      restartBehavior: "resumeByOperationId",
      requiredHostCapabilities: [],
    }),
  )

/** Electron-to-Core review-agent durable operation declarations. */
export const ReviewAgentBusinessRpcs = RpcGroup.make(
  ReviewAgentStartRpc,
  ReviewAgentGetOperationRpc,
  ReviewAgentCancelRpc,
)
