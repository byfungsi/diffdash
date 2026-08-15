import { AgentRun } from "@diffdash/domain/agent-run"
import { AgentRunId } from "@diffdash/domain/agent-run-id"
import { ReviewKey, ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { ReviewThreadId, ReviewThreadTarget } from "@diffdash/domain/review-thread"
import { Schema } from "effect"

import { HostRequestContext } from "./identity"

const RequestIdentity = HostRequestContext.fields

/** Durable request that accepts one long-running review-agent response. */
export class StartReviewAgentOperationRequest extends Schema.Class<StartReviewAgentOperationRequest>(
  "StartReviewAgentOperationRequest",
)({
  ...RequestIdentity,
  threadId: ReviewThreadId,
  target: ReviewThreadTarget,
  repoId: ReviewProjectId,
  reviewKey: ReviewKey,
  expectedBaseRevision: ReviewRevision,
  expectedHeadRevision: ReviewRevision,
}) {}

/** Operation-scoped request shared by review-agent state and cancellation methods. */
export class ReviewAgentOperationRequest extends Schema.Class<ReviewAgentOperationRequest>(
  "ReviewAgentOperationRequest",
)({
  ...RequestIdentity,
  runId: AgentRunId,
}) {}

/** Prompt acknowledgement returned only after the running state is durable. */
export class ReviewAgentOperationAccepted extends Schema.Class<ReviewAgentOperationAccepted>(
  "ReviewAgentOperationAccepted",
)({
  ...RequestIdentity,
  runId: AgentRunId,
}) {}

/** Stable public failure codes for durable review-agent lifecycle methods. */
export const ReviewAgentOperationFailureCode = Schema.Literals([
  "CORE_DRAINING",
  "REVIEW_AGENT_OPERATION_NOT_FOUND",
  "REVIEW_AGENT_OPERATION_REJECTED",
  "REVIEW_AGENT_OPERATION_STORE",
  "REVIEW_AGENT_INTERNAL_ERROR",
])

/** Stable public failure codes for durable review-agent lifecycle methods. */
export type ReviewAgentOperationFailureCode = typeof ReviewAgentOperationFailureCode.Type

const FailureDetail = {
  ...RequestIdentity,
  code: ReviewAgentOperationFailureCode,
  safeMessage: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(512)),
  ),
} as const

/** Plain expected failure from `ReviewAgents.start`. */
export const ReviewAgentStartFailure = Schema.TaggedStruct("ReviewAgentOperationFailure", {
  ...FailureDetail,
  method: Schema.Literal("ReviewAgents.start"),
  runId: Schema.NullOr(AgentRunId),
}).annotate({ identifier: "ReviewAgentStartFailure" })

/** Plain expected failure from `ReviewAgents.start`. */
export type ReviewAgentStartFailure = typeof ReviewAgentStartFailure.Type

/** Plain expected failure from `ReviewAgents.getOperation`. */
export const ReviewAgentGetOperationFailure = Schema.TaggedStruct("ReviewAgentOperationFailure", {
  ...FailureDetail,
  method: Schema.Literal("ReviewAgents.getOperation"),
  runId: AgentRunId,
}).annotate({ identifier: "ReviewAgentGetOperationFailure" })

/** Plain expected failure from `ReviewAgents.getOperation`. */
export type ReviewAgentGetOperationFailure = typeof ReviewAgentGetOperationFailure.Type

/** Plain expected failure from `ReviewAgents.cancel`. */
export const ReviewAgentCancelFailure = Schema.TaggedStruct("ReviewAgentOperationFailure", {
  ...FailureDetail,
  method: Schema.Literal("ReviewAgents.cancel"),
  runId: AgentRunId,
}).annotate({ identifier: "ReviewAgentCancelFailure" })

/** Plain expected failure from `ReviewAgents.cancel`. */
export type ReviewAgentCancelFailure = typeof ReviewAgentCancelFailure.Type

/** Authoritative persisted state returned by operation query and cancellation. */
export const ReviewAgentOperationSnapshot = AgentRun

/** Authoritative persisted state returned by operation query and cancellation. */
export type ReviewAgentOperationSnapshot = typeof ReviewAgentOperationSnapshot.Type
