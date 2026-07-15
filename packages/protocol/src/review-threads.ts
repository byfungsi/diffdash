import {
  MarkdownBody,
  ReviewThreadAnchor,
  ReviewThreadId,
  ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import { Schema } from "effect"

/** Request to append a follow-up user message to an existing local review thread. */
export class AddReviewThreadUserMessageRequest extends Schema.Class<AddReviewThreadUserMessageRequest>(
  "AddReviewThreadUserMessageRequest",
)({
  threadId: ReviewThreadId,
  bodyMarkdown: MarkdownBody,
}) {}

/** Request to create a local thread against the latest coherent review snapshot. */
export class CreateReviewThreadRequest extends Schema.Class<CreateReviewThreadRequest>(
  "CreateReviewThreadRequest",
)({
  target: ReviewThreadTarget,
  expectedBaseRevision: ReviewRevision,
  expectedHeadRevision: ReviewRevision,
  anchor: ReviewThreadAnchor,
  bodyMarkdown: MarkdownBody,
}) {}

/** Renderer request to run the local agent for the latest unanswered user message. */
export class RunReviewThreadAgentRequest extends Schema.Class<RunReviewThreadAgentRequest>(
  "RunReviewThreadAgentRequest",
)({
  threadId: ReviewThreadId,
  target: ReviewThreadTarget,
}) {}

/** Request carrying one validated review thread identity. */
export class ReviewThreadIdRequest extends Schema.Class<ReviewThreadIdRequest>(
  "ReviewThreadIdRequest",
)({
  threadId: ReviewThreadId,
}) {}
