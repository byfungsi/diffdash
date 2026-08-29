import {
  CommentNote,
  CommentNoteContext,
  CommentNoteId,
  CommentNoteSubject,
  MAX_COMMENT_NOTES_PER_PROJECT,
} from "@diffdash/domain/comment-note"
import { OpenCodeConnectionSelection } from "@diffdash/domain/comment"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { MarkdownBody } from "@diffdash/domain/review-thread"
import { Schema } from "effect"

/** Context-scoped request for every collected source note. */
export class ListCommentNotesRequest extends Schema.Class<ListCommentNotesRequest>(
  "ListCommentNotesRequest",
)({ projectId: ReviewProjectId, context: CommentNoteContext }) {}

/** Request to persist one collected source note. */
export class CreateCommentNoteRequest extends Schema.Class<CreateCommentNoteRequest>(
  "CreateCommentNoteRequest",
)({
  projectId: ReviewProjectId,
  context: CommentNoteContext,
  subject: CommentNoteSubject,
  body: MarkdownBody,
}) {}

/** Request to remove one collected source note from its owning context. */
export class DeleteCommentNoteRequest extends Schema.Class<DeleteCommentNoteRequest>(
  "DeleteCommentNoteRequest",
)({ projectId: ReviewProjectId, context: CommentNoteContext, noteId: CommentNoteId }) {}

/** Request to remove every collected source note from one context. */
export class ClearCommentNotesRequest extends Schema.Class<ClearCommentNotesRequest>(
  "ClearCommentNotesRequest",
)({ projectId: ReviewProjectId, context: CommentNoteContext }) {}

/** Request to send the current ordered context-note snapshot to OpenCode. */
export class SendCommentNotesRequest extends Schema.Class<SendCommentNotesRequest>(
  "SendCommentNotesRequest",
)({
  projectId: ReviewProjectId,
  context: CommentNoteContext,
  connection: OpenCodeConnectionSelection,
}) {}

export { SendCommentNotesReceipt } from "@diffdash/domain/comment-note"

/** Bounded ordered context note list returned through IPC. */
export const CommentNoteList = Schema.Array(CommentNote).pipe(
  Schema.check(Schema.isMaxLength(MAX_COMMENT_NOTES_PER_PROJECT)),
)
