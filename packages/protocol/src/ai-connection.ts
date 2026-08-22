import {
  CommentDestination,
  CommentSubmission,
  CommentSubmissionReceipt,
  OpenCodeSessionId,
} from "@diffdash/domain/comment"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { Schema } from "effect"

export {
  OpenCodeConnection,
  OpenCodeSessionId,
  OpenCodeSessionSummary,
} from "@diffdash/domain/comment"

/** Project-scoped query for the newest or matching OpenCode sessions. */
export class ListOpenCodeSessionsRequest extends Schema.Class<ListOpenCodeSessionsRequest>(
  "ListOpenCodeSessionsRequest",
)({
  projectId: ReviewProjectId,
  search: Schema.OptionFromNullOr(
    Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(500))),
  ),
}) {}

/** Request to select a session and switch it to plan mode when available. */
export class ConnectOpenCodeSessionRequest extends Schema.Class<ConnectOpenCodeSessionRequest>(
  "ConnectOpenCodeSessionRequest",
)({
  sessionId: OpenCodeSessionId,
  projectId: ReviewProjectId,
}) {}

/** One validated comment forwarded to an already-selected OpenCode session. */
export class SubmitCommentRequest extends Schema.Class<SubmitCommentRequest>(
  "SubmitCommentRequest",
)({
  destination: CommentDestination,
  submission: CommentSubmission,
}) {}

/** Schema used by IPC and Core RPC for an authoritative submission receipt. */
export const SubmitCommentReceipt = CommentSubmissionReceipt
