import { Schema } from "effect"

import { HostedReviewLocator, makeHostedRepositoryKey, makeHostedReviewKey } from "./git-provider"
import { LocalReviewComparison, LocalReviewTarget } from "./local-review"
import {
  GitCommitSha,
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "./repository-comparison"
import { RepositoryRelativePath } from "./repository-path"
import { NonNegativeInteger, PositiveInteger, UtcIsoTimestamp } from "./domain-scalar"
import { ReviewProjectId, ReviewRevision } from "./review-identity"
import { MarkdownBody, ReviewThreadAnchor, ReviewThreadTarget } from "./review-thread"

/** Maximum collected notes retained for one project. */
export const MAX_COMMENT_NOTES_PER_PROJECT = 1_000

/** Global behavior used when a user writes a source-line comment. */
export const CommentMode = Schema.Literals(["notes", "review"])

/** Global behavior used when a user writes a source-line comment. */
export type CommentMode = typeof CommentMode.Type

/** Persistent identity of one collected source note. */
export const CommentNoteId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("CommentNoteId"),
)

/** Persistent identity of one collected source note. */
export type CommentNoteId = typeof CommentNoteId.Type

/** Existing project-wide notes retained without assigning them to an arbitrary review. */
export class ProjectCommentNoteContext extends Schema.TaggedClass<ProjectCommentNoteContext>()(
  "project",
  {},
) {}

/** Stable hosted-review note collection matching viewed-file scope. */
export class HostedCommentNoteContext extends Schema.TaggedClass<HostedCommentNoteContext>()(
  "hosted",
  {
    review: HostedReviewLocator,
    baseRefName: RepositoryComparisonRef,
  },
) {}

/** Stable local-review note collection matching viewed-file scope. */
export class LocalCommentNoteContext extends Schema.TaggedClass<LocalCommentNoteContext>()(
  "local",
  {
    target: LocalReviewTarget,
    sourceBranch: Schema.NullOr(RepositoryComparisonRef),
  },
) {}

/** Immutable repository-comparison note collection matching viewed-file scope. */
export class RepositoryComparisonCommentNoteContext extends Schema.TaggedClass<RepositoryComparisonCommentNoteContext>()(
  "repositoryComparison",
  { target: RepositoryComparisonTarget },
) {}

/** Review context selecting one independently loaded collected-note set. */
export const CommentNoteContext = Schema.Union([
  ProjectCommentNoteContext,
  HostedCommentNoteContext,
  LocalCommentNoteContext,
  RepositoryComparisonCommentNoteContext,
]).pipe(Schema.toTaggedUnion("_tag"))

/** Review context selecting one independently loaded collected-note set. */
export type CommentNoteContext = typeof CommentNoteContext.Type

/** Canonical persistence identity for one collected-note context. */
export const CommentNoteContextKey = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(4_096)),
  Schema.brand("CommentNoteContextKey"),
)

/** Canonical persistence identity for one collected-note context. */
export type CommentNoteContextKey = typeof CommentNoteContextKey.Type

/** Derives the stable note identity with the same boundaries used by viewed-file persistence. */
export const commentNoteContextKey = (context: CommentNoteContext): CommentNoteContextKey =>
  CommentNoteContextKey.make(
    CommentNoteContext.match(context, {
      project: () => "project",
      hosted: ({ review, baseRefName }) =>
        `hosted:${encodeContextPart(makeHostedReviewKey(review))}:${encodeContextPart(baseRefName)}`,
      local: ({ target, sourceBranch }) => {
        const sourceIdentity = LocalReviewComparison.match(target.comparison, {
          revisionRange: ({ baseRef, headRef }) => `comparison:${baseRef}...${headRef}`,
          workingTree: () => (sourceBranch === null ? "detached" : `branch:${sourceBranch}`),
          branch: () => (sourceBranch === null ? "detached" : `branch:${sourceBranch}`),
          revision: () => (sourceBranch === null ? "detached" : `branch:${sourceBranch}`),
          lastCommit: () => (sourceBranch === null ? "detached" : `branch:${sourceBranch}`),
        })
        const comparisonTarget = LocalReviewComparison.match(target.comparison, {
          workingTree: () => "workingTree:",
          branch: ({ branchName }) => `branch:${branchName}`,
          revision: ({ revision }) => `branch:${revision}`,
          revisionRange: ({ baseRef, headRef }) => `branch:${baseRef}...${headRef}`,
          lastCommit: () => "branch:HEAD",
        })
        return `local:${encodeContextPart(sourceIdentity)}:${encodeContextPart(comparisonTarget)}`
      },
      repositoryComparison: ({ target }) =>
        `repositoryComparison:${encodeContextPart(makeHostedRepositoryKey(target.repository))}:${encodeContextPart(target.baseRef)}:${encodeContextPart(target.headRef)}`,
    }),
  )

const encodeContextPart = (value: string): string => `${String(value.length)}:${value}`

/** Captured Code or Review location retained even after its source becomes stale. */
export const CommentNoteSubject = Schema.TaggedUnion({
  ReviewLine: {
    target: ReviewThreadTarget,
    expectedBaseRevision: ReviewRevision,
    expectedHeadRevision: ReviewRevision,
    anchor: ReviewThreadAnchor,
  },
  CodeLine: {
    workspaceRevision: ReviewRevision,
    gitRevision: Schema.NullOr(GitCommitSha),
    path: RepositoryRelativePath,
    lineNumber: PositiveInteger,
    lineContent: Schema.String,
  },
})

/** Captured Code or Review location retained even after its source becomes stale. */
export type CommentNoteSubject = typeof CommentNoteSubject.Type

/** One project-scoped note collected for later copy or bulk agent delivery. */
export class CommentNote extends Schema.Class<CommentNote>("CommentNote")({
  id: CommentNoteId,
  projectId: ReviewProjectId,
  subject: CommentNoteSubject,
  body: MarkdownBody,
  createdAt: UtcIsoTimestamp,
}) {}

/** Authoritative count of notes accepted in one bulk agent delivery. */
export class SendCommentNotesReceipt extends Schema.Class<SendCommentNotesReceipt>(
  "SendCommentNotesReceipt",
)({ sentCount: NonNegativeInteger }) {}

/** Formats ordered collected notes as one self-contained Markdown agent prompt. */
export const formatCommentNotes = (notes: readonly CommentNote[]): string =>
  [
    "# DiffDash collected notes",
    "",
    "Review these source notes together. Preserve their order and address each one.",
    ...notes.flatMap((note, index) => formatCommentNote(note, index + 1)),
  ].join("\n")

const formatCommentNote = (note: CommentNote, position: number): readonly string[] => {
  const source = CommentNoteSubject.match(note.subject, {
    ReviewLine: ({ target, expectedBaseRevision, expectedHeadRevision, anchor }) => [
      "Source: DiffDash review line",
      `Base revision: ${expectedBaseRevision}`,
      `Head revision: ${expectedHeadRevision}`,
      "Review target:",
      "```json",
      JSON.stringify(target, null, 2),
      "```",
      "Captured line anchor:",
      "```json",
      JSON.stringify(anchor, null, 2),
      "```",
    ],
    CodeLine: ({ workspaceRevision, gitRevision, path, lineNumber, lineContent }) => [
      "Source: DiffDash code line",
      `Workspace revision: ${workspaceRevision}`,
      `Git revision: ${gitRevision ?? "uncommitted working tree"}`,
      `Path: ${path}`,
      `Line: ${String(lineNumber)}`,
      "Captured line content:",
      "```text",
      lineContent,
      "```",
    ],
  })
  return ["", `## Note ${String(position)}`, ...source, "", "Note:", note.body]
}
