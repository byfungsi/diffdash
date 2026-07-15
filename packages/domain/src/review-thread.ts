import { Schema } from "effect"

import { LocalReviewTarget } from "./local-review"

export { LocalReviewTarget } from "./local-review"

import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewRevision,
} from "./review-identity"
import type { ParsedDiff } from "./diff"

/** Persistent identity for one local DiffDash review thread. */
export const ReviewThreadId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ReviewThreadId"),
)

/** Persistent identity for one local DiffDash review thread. */
export type ReviewThreadId = typeof ReviewThreadId.Type

/** Persistent identity for one message in a local review thread. */
export const ReviewThreadMessageId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ReviewThreadMessageId"),
)

/** Persistent identity for one message in a local review thread. */
export type ReviewThreadMessageId = typeof ReviewThreadMessageId.Type

/** Markdown content stored as a review thread message, including empty pending agent messages. */
export const MarkdownBody = Schema.String.pipe(Schema.brand("MarkdownBody"))

/** Markdown content stored as a review thread message. */
export type MarkdownBody = typeof MarkdownBody.Type

/** Current relationship between an original anchor and the latest review revision. */
export const ReviewAnchorStatus = Schema.Literal("active", "outdated", "unresolved_anchor")

/** Current relationship between an original anchor and the latest review revision. */
export type ReviewAnchorStatus = typeof ReviewAnchorStatus.Type

/** Author type for a persisted local thread message. */
export const ReviewThreadMessageAuthor = Schema.Literal("user", "agent")

/** Author type for a persisted local thread message. */
export type ReviewThreadMessageAuthor = typeof ReviewThreadMessageAuthor.Type

/** Lifecycle status for a persisted local thread message. */
export const ReviewThreadMessageStatus = Schema.Literal("pending", "complete", "failed")

/** Lifecycle status for a persisted local thread message. */
export type ReviewThreadMessageStatus = typeof ReviewThreadMessageStatus.Type

/** Anchor applying to the complete review rather than one changed file. */
export class ReviewLevelAnchor extends Schema.TaggedClass<ReviewLevelAnchor>()("review", {}) {}

/** Anchor applying to one changed file. */
export class FileReviewAnchor extends Schema.TaggedClass<FileReviewAnchor>()("file", {
  fileId: ReviewFileId,
  filePath: Schema.String,
  oldPath: Schema.NullOr(Schema.String),
}) {}

/** Anchor applying to one parsed diff hunk. */
export class HunkReviewAnchor extends Schema.TaggedClass<HunkReviewAnchor>()("hunk", {
  fileId: ReviewFileId,
  filePath: Schema.String,
  oldPath: Schema.NullOr(Schema.String),
  hunkId: ReviewHunkId,
  hunkFingerprint: ReviewHunkFingerprint,
  header: Schema.String,
  oldStart: Schema.Number,
  oldLines: Schema.Number,
  newStart: Schema.Number,
  newLines: Schema.Number,
}) {}

/** Side of a split diff containing an anchored line. */
export const ReviewLineSide = Schema.Literal("old", "new")

/** Side of a split diff containing an anchored line. */
export type ReviewLineSide = typeof ReviewLineSide.Type

/** Anchor applying to one old-side or new-side diff line. */
export class LineReviewAnchor extends Schema.TaggedClass<LineReviewAnchor>()("line", {
  fileId: ReviewFileId,
  filePath: Schema.String,
  oldPath: Schema.NullOr(Schema.String),
  hunkId: ReviewHunkId,
  hunkFingerprint: ReviewHunkFingerprint,
  hunkHeader: Schema.String,
  side: ReviewLineSide,
  lineNumber: Schema.Number,
  lineContent: Schema.String,
}) {}

/** Any diff location that an agent may reference in a response. */
export const ReviewAnchor = Schema.Union(
  ReviewLevelAnchor,
  FileReviewAnchor,
  HunkReviewAnchor,
  LineReviewAnchor,
)

/** Any diff location that an agent may reference in a response. */
export type ReviewAnchor = typeof ReviewAnchor.Type

/** The exact line scope required by every persisted local review thread. */
export const ReviewThreadAnchor = LineReviewAnchor

/** The exact line scope required by every persisted local review thread. */
export type ReviewThreadAnchor = typeof ReviewThreadAnchor.Type

/** A local DiffDash-only review discussion. */
export class ReviewThread extends Schema.Class<ReviewThread>("ReviewThread")({
  id: ReviewThreadId,
  repoId: Schema.String,
  reviewKey: ReviewKey,
  prNumber: Schema.NullOr(Schema.Number),
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
  currentBaseRevision: ReviewRevision,
  currentHeadRevision: ReviewRevision,
  originalAnchor: ReviewThreadAnchor,
  currentAnchor: Schema.NullOr(ReviewThreadAnchor),
  anchorStatus: ReviewAnchorStatus,
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

/** One user or agent message stored in a local review thread. */
export class ReviewThreadMessage extends Schema.Class<ReviewThreadMessage>("ReviewThreadMessage")({
  id: ReviewThreadMessageId,
  threadId: ReviewThreadId,
  sequence: Schema.Number,
  author: ReviewThreadMessageAuthor,
  bodyMarkdown: MarkdownBody,
  status: ReviewThreadMessageStatus,
  agentRunId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

/** A local review thread together with its deterministically ordered messages. */
export class ReviewThreadDetails extends Schema.Class<ReviewThreadDetails>("ReviewThreadDetails")({
  thread: ReviewThread,
  messages: Schema.Array(ReviewThreadMessage),
}) {}

/** Input for atomically creating a local thread and its initial user message. */
export class CreateReviewThreadInput extends Schema.Class<CreateReviewThreadInput>(
  "CreateReviewThreadInput",
)({
  repoId: Schema.String,
  reviewKey: ReviewKey,
  prNumber: Schema.NullOr(Schema.Number),
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
  anchor: ReviewThreadAnchor,
  bodyMarkdown: MarkdownBody,
}) {}

/** Input for creating the one pending agent response belonging to a new line thread. */
export class CreatePendingReviewThreadAgentMessageInput extends Schema.Class<CreatePendingReviewThreadAgentMessageInput>(
  "CreatePendingReviewThreadAgentMessageInput",
)({
  threadId: ReviewThreadId,
  agentRunId: Schema.NullOr(Schema.String),
}) {}

/** Input to append a follow-up user message to an existing local line thread. */
export class AddReviewThreadUserMessageInput extends Schema.Class<AddReviewThreadUserMessageInput>(
  "AddReviewThreadUserMessageInput",
)({
  threadId: ReviewThreadId,
  bodyMarkdown: MarkdownBody,
}) {}

/** Scope for listing all carried and current threads belonging to one review. */
export class ReviewThreadListKey extends Schema.Class<ReviewThreadListKey>("ReviewThreadListKey")({
  repoId: Schema.String,
  reviewKey: ReviewKey,
}) {}

/** Strict revision scope used when callers need only threads mapped to one head. */
export class ReviewThreadRevisionKey extends Schema.Class<ReviewThreadRevisionKey>(
  "ReviewThreadRevisionKey",
)({
  repoId: Schema.String,
  reviewKey: ReviewKey,
  headRevision: ReviewRevision,
}) {}

/** Renderer-safe locator for one GitHub pull request review. */
export class PullRequestReviewTarget extends Schema.Class<PullRequestReviewTarget>(
  "PullRequestReviewTarget",
)({
  kind: Schema.Literal("pullRequest"),
  owner: Schema.String,
  name: Schema.String,
  number: Schema.Number,
}) {}

/** Renderer-safe locator resolved into a canonical review snapshot by the main process. */
export const ReviewThreadTarget = Schema.Union(PullRequestReviewTarget, LocalReviewTarget)

/** Renderer-safe locator resolved into a canonical review snapshot by the main process. */
export type ReviewThreadTarget = typeof ReviewThreadTarget.Type

/** Checks that an anchor still identifies exact content in a coherent parsed review snapshot. */
export const isReviewAnchorInParsedDiff = (anchor: ReviewThreadAnchor, diff: ParsedDiff) => {
  const file = diff.files.find(
    (candidate) =>
      candidate.fileId === anchor.fileId &&
      candidate.path === anchor.filePath &&
      candidate.oldPath === anchor.oldPath,
  )
  if (file === undefined) return false
  const hunk = file.hunks.find(
    (candidate) =>
      candidate.id === anchor.hunkId && candidate.fingerprint === anchor.hunkFingerprint,
  )
  if (hunk === undefined) return false
  return hunk.header === anchor.hunkHeader && hunkContainsLine(hunk, anchor)
}

const hunkContainsLine = (
  hunk: ParsedDiff["files"][number]["hunks"][number],
  anchor: LineReviewAnchor,
) => {
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  for (const line of hunk.lines) {
    if (line.startsWith(" ")) {
      if (
        ((anchor.side === "old" && anchor.lineNumber === oldLine) ||
          (anchor.side === "new" && anchor.lineNumber === newLine)) &&
        anchor.lineContent === line.slice(1)
      ) {
        return true
      }
      oldLine += 1
      newLine += 1
      continue
    }
    if (line.startsWith("-")) {
      if (
        anchor.side === "old" &&
        anchor.lineNumber === oldLine &&
        anchor.lineContent === line.slice(1)
      ) {
        return true
      }
      oldLine += 1
      continue
    }
    if (line.startsWith("+")) {
      if (
        anchor.side === "new" &&
        anchor.lineNumber === newLine &&
        anchor.lineContent === line.slice(1)
      ) {
        return true
      }
      newLine += 1
    }
  }
  return false
}
