import { Match, Schema } from "effect"
import { AgentRunId } from "./agent-run-id"
import { NonNegativeInteger, PositiveInteger, UtcIsoTimestamp } from "./domain-scalar"
import { AgentProviderFailure } from "./provider-failure"
import {
  CancelledAgentRun,
  CompletedAgentRun,
  FailedAgentRun,
  InterruptedAgentRun,
  RunningAgentRun,
} from "./agent-run"
import { ReviewThreadId } from "./review-thread-id"

import { LocalReviewTarget } from "./local-review"
import { HostedReviewLocator } from "./git-provider"
import { RepositoryComparisonTarget } from "./repository-comparison"
import { RepositoryRelativePath } from "./repository-path"
import { findProjectedDiffHunkLine, projectDiffHunkLines } from "./diff-hunk-lines"

export { LocalReviewTarget } from "./local-review"

import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
} from "./review-identity"
import type { ParsedDiff } from "./diff"

export { ReviewThreadId } from "./review-thread-id"

/** Persistent identity for one message in a local review thread. */
export const ReviewThreadMessageId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("ReviewThreadMessageId"),
)

/** Persistent identity for one message in a local review thread. */
export type ReviewThreadMessageId = typeof ReviewThreadMessageId.Type

/** Markdown content stored as a review thread message, including empty pending agent messages. */
export const MarkdownBody = Schema.String.pipe(Schema.brand("MarkdownBody"))

/** Markdown content stored as a review thread message. */
export type MarkdownBody = typeof MarkdownBody.Type

/** Anchor applying to the complete review rather than one changed file. */
export class ReviewLevelAnchor extends Schema.TaggedClass<ReviewLevelAnchor>()("review", {}) {}

/** Anchor applying to one changed file. */
export class FileReviewAnchor extends Schema.TaggedClass<FileReviewAnchor>()("file", {
  fileId: ReviewFileId,
  filePath: RepositoryRelativePath,
  oldPath: Schema.NullOr(RepositoryRelativePath),
}) {}

/** Anchor applying to one parsed diff hunk. */
export class HunkReviewAnchor extends Schema.TaggedClass<HunkReviewAnchor>()("hunk", {
  fileId: ReviewFileId,
  filePath: RepositoryRelativePath,
  oldPath: Schema.NullOr(RepositoryRelativePath),
  hunkId: ReviewHunkId,
  hunkFingerprint: ReviewHunkFingerprint,
  header: Schema.String,
  oldStart: NonNegativeInteger,
  oldLines: NonNegativeInteger,
  newStart: NonNegativeInteger,
  newLines: NonNegativeInteger,
}) {}

/** Side of a split diff containing an anchored line. */
export const ReviewLineSide = Schema.Literals(["old", "new"])

/** Side of a split diff containing an anchored line. */
export type ReviewLineSide = typeof ReviewLineSide.Type

/** Anchor applying to one old-side or new-side diff line. */
export class LineReviewAnchor extends Schema.TaggedClass<LineReviewAnchor>()("line", {
  fileId: ReviewFileId,
  filePath: RepositoryRelativePath,
  oldPath: Schema.NullOr(RepositoryRelativePath),
  hunkId: ReviewHunkId,
  hunkFingerprint: ReviewHunkFingerprint,
  hunkHeader: Schema.String,
  side: ReviewLineSide,
  lineNumber: PositiveInteger,
  lineContent: Schema.String,
}) {}

/** Any diff location that an agent may reference in a response. */
export const ReviewAnchor = Schema.Union([
  ReviewLevelAnchor,
  FileReviewAnchor,
  HunkReviewAnchor,
  LineReviewAnchor,
])

/** Any diff location that an agent may reference in a response. */
export type ReviewAnchor = typeof ReviewAnchor.Type

/** The exact line scope required by every persisted local review thread. */
export const ReviewThreadAnchor = LineReviewAnchor

/** The exact line scope required by every persisted local review thread. */
export type ReviewThreadAnchor = typeof ReviewThreadAnchor.Type

/** Current relationship between an original anchor and the latest review revision. */
export const CurrentReviewAnchor = Schema.TaggedUnion({
  Active: { anchor: ReviewThreadAnchor },
  Outdated: {},
  Unresolved: {},
})

/** Current relationship between an original anchor and the latest review revision. */
export type CurrentReviewAnchor = typeof CurrentReviewAnchor.Type

/** A local DiffDash-only review discussion. */
export class ReviewThread extends Schema.Class<ReviewThread>("ReviewThread")({
  id: ReviewThreadId,
  repoId: ReviewProjectId,
  reviewKey: ReviewKey,
  prNumber: Schema.NullOr(PositiveInteger),
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
  currentBaseRevision: ReviewRevision,
  currentHeadRevision: ReviewRevision,
  originalAnchor: ReviewThreadAnchor,
  currentAnchor: CurrentReviewAnchor,
  createdAt: UtcIsoTimestamp,
  updatedAt: UtcIsoTimestamp,
}) {
  /** The current navigable anchor, or null when the mapping is not active. */
  get activeAnchor(): ReviewThreadAnchor | null {
    return Match.valueTags(this.currentAnchor, {
      Active: ({ anchor }) => anchor,
      Outdated: () => null,
      Unresolved: () => null,
    })
  }

  /** The current anchor when active, otherwise the immutable original location for display. */
  get displayAnchor(): ReviewThreadAnchor {
    return Match.valueTags(this.currentAnchor, {
      Active: ({ anchor }) => anchor,
      Outdated: () => this.originalAnchor,
      Unresolved: () => this.originalAnchor,
    })
  }
}

const ReviewThreadMessageIdentity = {
  id: ReviewThreadMessageId,
  threadId: ReviewThreadId,
  sequence: NonNegativeInteger,
  createdAt: UtcIsoTimestamp,
  updatedAt: UtcIsoTimestamp,
}

/** A complete user-authored message, which never owns an agent run or failure. */
export class UserReviewThreadMessage extends Schema.TaggedClass<UserReviewThreadMessage>()("User", {
  ...ReviewThreadMessageIdentity,
  bodyMarkdown: MarkdownBody,
}) {}

/** An agent response reserved for a running provider execution. */
export class PendingAgentReviewThreadMessage extends Schema.TaggedClass<PendingAgentReviewThreadMessage>()(
  "Pending",
  {
    ...ReviewThreadMessageIdentity,
    agentRunId: AgentRunId,
  },
) {}

/** A complete agent response linked to its provider execution. */
export class CompletedAgentReviewThreadMessage extends Schema.TaggedClass<CompletedAgentReviewThreadMessage>()(
  "Completed",
  {
    ...ReviewThreadMessageIdentity,
    bodyMarkdown: MarkdownBody,
    agentRunId: AgentRunId,
  },
) {}

/** Failure details retained for a provider-owned agent response failure. */
export class ProviderReviewThreadMessageFailure extends Schema.TaggedClass<ProviderReviewThreadMessageFailure>()(
  "Provider",
  { details: AgentProviderFailure },
) {}

/** A non-provider failure that interrupted or prevented an agent response. */
export class InternalReviewThreadMessageFailure extends Schema.TaggedClass<InternalReviewThreadMessageFailure>()(
  "Internal",
  {},
) {}

/** Failure details required by every failed agent response. */
export const ReviewThreadMessageFailure = Schema.Union([
  ProviderReviewThreadMessageFailure,
  InternalReviewThreadMessageFailure,
])

/** Failure details required by every failed agent response. */
export type ReviewThreadMessageFailure = typeof ReviewThreadMessageFailure.Type

/** A failed agent response linked to its failed provider execution. */
export class FailedAgentReviewThreadMessage extends Schema.TaggedClass<FailedAgentReviewThreadMessage>()(
  "Failed",
  {
    ...ReviewThreadMessageIdentity,
    agentRunId: AgentRunId,
    failure: ReviewThreadMessageFailure,
  },
) {}

/** One invariant-preserving user or agent message stored in a local review thread. */
export const ReviewThreadMessage = Schema.Union([
  UserReviewThreadMessage,
  PendingAgentReviewThreadMessage,
  CompletedAgentReviewThreadMessage,
  FailedAgentReviewThreadMessage,
])

/** One invariant-preserving user or agent message stored in a local review thread. */
export type ReviewThreadMessage = typeof ReviewThreadMessage.Type

/** A user conversation entry, which has no provider execution. */
export class UserReviewTurn extends Schema.TaggedClass<UserReviewTurn>()("User", {
  message: UserReviewThreadMessage,
}) {}

/** A pending agent conversation entry with a matching running execution. */
export class PendingAgentReviewTurn extends Schema.TaggedClass<PendingAgentReviewTurn>()(
  "Pending",
  {
    message: PendingAgentReviewThreadMessage,
    run: RunningAgentRun,
  },
) {}

/** A completed agent conversation entry with a matching completed execution. */
export class CompletedAgentReviewTurn extends Schema.TaggedClass<CompletedAgentReviewTurn>()(
  "Completed",
  {
    message: CompletedAgentReviewThreadMessage,
    run: CompletedAgentRun,
  },
) {}

/** A failed agent conversation entry with a matching failed execution. */
export class FailedAgentReviewTurn extends Schema.TaggedClass<FailedAgentReviewTurn>()("Failed", {
  message: FailedAgentReviewThreadMessage,
  run: FailedAgentRun,
}) {}

/** A cancelled agent conversation entry with its linked terminal response. */
export class CancelledAgentReviewTurn extends Schema.TaggedClass<CancelledAgentReviewTurn>()(
  "Cancelled",
  {
    message: FailedAgentReviewThreadMessage,
    run: CancelledAgentRun,
  },
) {}

/** An interrupted agent conversation entry with its linked terminal response. */
export class InterruptedAgentReviewTurn extends Schema.TaggedClass<InterruptedAgentReviewTurn>()(
  "Interrupted",
  {
    message: FailedAgentReviewThreadMessage,
    run: InterruptedAgentRun,
  },
) {}

/** One authoritative conversation projection joining a message to its run when applicable. */
export const ReviewTurn = Schema.Union([
  UserReviewTurn,
  PendingAgentReviewTurn,
  CompletedAgentReviewTurn,
  FailedAgentReviewTurn,
  CancelledAgentReviewTurn,
  InterruptedAgentReviewTurn,
])

/** One authoritative conversation projection joining a message to its run when applicable. */
export type ReviewTurn = typeof ReviewTurn.Type

/** A local review thread together with its deterministically ordered conversation turns. */
export class ReviewThreadDetails extends Schema.Class<ReviewThreadDetails>("ReviewThreadDetails")({
  thread: ReviewThread,
  conversation: Schema.Array(ReviewTurn),
}) {
  /** Ordered messages derived from the authoritative message/run conversation projection. */
  get messages(): readonly ReviewThreadMessage[] {
    return this.conversation.map((turn) => turn.message)
  }
}

/** Input for atomically creating a local thread and its initial user message. */
export class CreateReviewThreadInput extends Schema.Class<CreateReviewThreadInput>(
  "CreateReviewThreadInput",
)({
  repoId: ReviewProjectId,
  reviewKey: ReviewKey,
  prNumber: Schema.NullOr(PositiveInteger),
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
  anchor: ReviewThreadAnchor,
  bodyMarkdown: MarkdownBody,
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
  repoId: ReviewProjectId,
  reviewKey: ReviewKey,
}) {}

/** Strict revision scope used when callers need only threads mapped to one head. */
export class ReviewThreadRevisionKey extends Schema.Class<ReviewThreadRevisionKey>(
  "ReviewThreadRevisionKey",
)({
  repoId: ReviewProjectId,
  reviewKey: ReviewKey,
  headRevision: ReviewRevision,
}) {}

/** Renderer-safe locator for one hosted review. */
export class HostedReviewTarget extends Schema.Class<HostedReviewTarget>("HostedReviewTarget")({
  kind: Schema.Literal("hosted"),
  review: HostedReviewLocator,
}) {}

/** Renderer-safe locator resolved into a canonical review snapshot by the main process. */
export const ReviewThreadTarget = Schema.Union([
  HostedReviewTarget,
  LocalReviewTarget,
  RepositoryComparisonTarget,
])

/** Renderer-safe locator resolved into a canonical review snapshot by the main process. */
export type ReviewThreadTarget = typeof ReviewThreadTarget.Type

/** Thread creation was scoped to a review revision that is no longer current. */
export class ReviewThreadRevisionChangedError extends Schema.TaggedError<ReviewThreadRevisionChangedError>()(
  "ReviewThreadRevisionChangedError",
  {
    expectedBaseRevision: ReviewRevision,
    expectedHeadRevision: ReviewRevision,
    currentBaseRevision: ReviewRevision,
    currentHeadRevision: ReviewRevision,
  },
) {}

/** Thread creation referenced an anchor absent from the requested immutable revision. */
export class ReviewThreadAnchorInvalidError extends Schema.TaggedError<ReviewThreadAnchorInvalidError>()(
  "ReviewThreadAnchorInvalidError",
  { reviewKey: ReviewKey },
) {}

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
) =>
  findProjectedDiffHunkLine(projectDiffHunkLines(hunk), {
    side: anchor.side,
    lineNumber: anchor.lineNumber,
    content: anchor.lineContent,
  }) !== null
