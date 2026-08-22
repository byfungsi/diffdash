import { Schema } from "effect"

import { PositiveInteger } from "./domain-scalar"
import { GitCommitSha } from "./repository-comparison"
import { RepositoryCheckoutPath } from "./repository"
import { RepositoryRelativePath } from "./repository-path"
import { ReviewProjectId, ReviewRevision } from "./review-identity"
import {
  MarkdownBody,
  ReviewThreadAnchor,
  ReviewThreadId,
  ReviewThreadTarget,
} from "./review-thread"

const CommentLineFields = {
  path: RepositoryRelativePath,
  lineNumber: PositiveInteger,
  lineContent: Schema.String,
}

/** Exact source location discussed by a user-authored comment. */
export const CommentSubject = Schema.TaggedUnion({
  ReviewLine: {
    target: ReviewThreadTarget,
    expectedBaseRevision: ReviewRevision,
    expectedHeadRevision: ReviewRevision,
    anchor: ReviewThreadAnchor,
  },
  CodeLine: {
    ...CommentLineFields,
    projectId: ReviewProjectId,
    revision: GitCommitSha,
  },
})

/** Exact source location discussed by a user-authored comment. */
export type CommentSubject = typeof CommentSubject.Type

/** OpenCode V2 session identity accepted by the shared service API. */
export const OpenCodeSessionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^ses_[A-Za-z0-9]+$/u)),
  Schema.brand("OpenCodeSessionId"),
)

/** OpenCode V2 session identity accepted by the shared service API. */
export type OpenCodeSessionId = typeof OpenCodeSessionId.Type

/** Bounded session metadata displayed by DiffDash's connection picker. */
export class OpenCodeSessionSummary extends Schema.Class<OpenCodeSessionSummary>(
  "OpenCodeSessionSummary",
)({
  id: OpenCodeSessionId,
  title: Schema.String,
  directory: RepositoryCheckoutPath,
  updatedAt: Schema.Number,
}) {}

/** Project-scoped OpenCode connection selected by the user. */
export class OpenCodeConnectionSelection extends Schema.Class<OpenCodeConnectionSelection>(
  "OpenCodeConnectionSelection",
)({
  projectId: ReviewProjectId,
  session: OpenCodeSessionSummary,
  planMode: Schema.Boolean,
}) {}

/** Result of validating and preparing an OpenCode session. */
export class OpenCodeConnection extends Schema.Class<OpenCodeConnection>("OpenCodeConnection")({
  sessionId: OpenCodeSessionId,
  planMode: Schema.Boolean,
}) {}

/** System that exclusively owns a newly submitted comment. */
export const CommentDestination = Schema.TaggedUnion({
  DiffDash: {},
  OpenCode: { connection: OpenCodeConnectionSelection },
})

/** System that exclusively owns a newly submitted comment. */
export type CommentDestination = typeof CommentDestination.Type

/** Initial comment or follow-up submitted against an exact source subject. */
export const CommentSubmission = Schema.TaggedUnion({
  Start: { subject: CommentSubject, body: MarkdownBody },
  FollowUp: { subject: CommentSubject, threadId: ReviewThreadId, body: MarkdownBody },
})

/** Initial comment or follow-up submitted against an exact source subject. */
export type CommentSubmission = typeof CommentSubmission.Type

/** Authoritative result of routing one comment to exactly one destination. */
export const CommentSubmissionReceipt = Schema.TaggedUnion({
  StoredLocally: { threadId: ReviewThreadId, agentAccepted: Schema.Boolean },
  Forwarded: { sessionId: OpenCodeSessionId },
})

/** Authoritative result of routing one comment to exactly one destination. */
export type CommentSubmissionReceipt = typeof CommentSubmissionReceipt.Type

/** Expected rejection when a destination cannot own the requested subject. */
export class CommentSubmissionUnsupportedError extends Schema.TaggedError<CommentSubmissionUnsupportedError>()(
  "CommentSubmissionUnsupportedError",
  { destination: Schema.Literal("DiffDash"), subject: Schema.Literal("CodeLine") },
) {}

/** Expected rejection when a comment subject no longer matches its selected project or thread. */
export class CommentSubjectMismatchError extends Schema.TaggedError<CommentSubjectMismatchError>()(
  "CommentSubjectMismatchError",
  { reason: Schema.NonEmptyString },
) {}

/** Expected UI rejection when an existing thread no longer has a known source subject. */
export class CommentSubjectUnavailableError extends Schema.TaggedError<CommentSubjectUnavailableError>()(
  "CommentSubjectUnavailableError",
  { threadId: ReviewThreadId },
) {}

/** Expected rejection when a comment surface is rendered outside the application provider. */
export class CommentSubmissionUnavailableError extends Schema.TaggedError<CommentSubmissionUnavailableError>()(
  "CommentSubmissionUnavailableError",
  {},
) {}
