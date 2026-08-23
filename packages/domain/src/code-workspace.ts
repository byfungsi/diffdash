import { Schema } from "effect"

import { DiffFileStatus } from "./diff"
import { CodeLineChangeRange } from "./code-line-change"
import { HostedReviewLocator } from "./git-provider"
import { GitCommitSha } from "./repository-comparison"
import { RepositoryRelativePath } from "./repository-path"
import { ReviewProjectId, ReviewRevision, ReviewSnapshotId } from "./review-identity"

/** Opaque authority for one renderer-owned managed Code workspace. */
export const CodeWorkspaceLeaseId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
  Schema.brand("CodeWorkspaceLeaseId"),
)

/** Opaque authority for one renderer-owned managed Code workspace. */
export type CodeWorkspaceLeaseId = typeof CodeWorkspaceLeaseId.Type

/** Exact source identity materialized for the general project Code ribbon. */
export class ProjectHeadCodeWorkspaceTarget extends Schema.TaggedClass<ProjectHeadCodeWorkspaceTarget>()(
  "projectHead",
  { projectId: ReviewProjectId },
) {}

/** Exact hosted-review revision materialized when Code is opened from a diff. */
export class HostedReviewCodeWorkspaceTarget extends Schema.TaggedClass<HostedReviewCodeWorkspaceTarget>()(
  "hostedReview",
  {
    projectId: ReviewProjectId,
    review: HostedReviewLocator,
    revision: ReviewRevision,
  },
) {}

/** Exact persisted local-review snapshot materialized when Code is opened from a local diff. */
export class LocalReviewSnapshotCodeWorkspaceTarget extends Schema.TaggedClass<LocalReviewSnapshotCodeWorkspaceTarget>()(
  "localReviewSnapshot",
  {
    projectId: ReviewProjectId,
    snapshotId: ReviewSnapshotId,
  },
) {}

/** Exact Git revision materialized for repository-comparison diffs. */
export class ProjectRevisionCodeWorkspaceTarget extends Schema.TaggedClass<ProjectRevisionCodeWorkspaceTarget>()(
  "projectRevision",
  {
    projectId: ReviewProjectId,
    revision: GitCommitSha,
  },
) {}

/** Source identity requested by a Code workspace consumer. */
export const CodeWorkspaceTarget = Schema.Union([
  ProjectHeadCodeWorkspaceTarget,
  ProjectRevisionCodeWorkspaceTarget,
  HostedReviewCodeWorkspaceTarget,
  LocalReviewSnapshotCodeWorkspaceTarget,
]).pipe(Schema.toTaggedUnion("_tag"))

/** Source identity requested by a Code workspace consumer. */
export type CodeWorkspaceTarget = typeof CodeWorkspaceTarget.Type

/** Managed Code workspace returned after its detached checkout is ready. */
export class CodeWorkspaceLease extends Schema.Class<CodeWorkspaceLease>("CodeWorkspaceLease")({
  id: CodeWorkspaceLeaseId,
  revision: ReviewRevision,
  gitRevision: Schema.OptionFromNullOr(GitCommitSha),
  expiresAtMs: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
}) {}

/** One immediate filesystem child inside a managed Code workspace. */
export class CodeWorkspaceEntry extends Schema.Class<CodeWorkspaceEntry>("CodeWorkspaceEntry")({
  path: RepositoryRelativePath,
  kind: Schema.Literals(["directory", "file"]),
}) {}

/** Bounded immediate children returned for one managed checkout directory. */
export class CodeWorkspaceDirectoryPage extends Schema.Class<CodeWorkspaceDirectoryPage>(
  "CodeWorkspaceDirectoryPage",
)({
  entries: Schema.Array(CodeWorkspaceEntry).pipe(Schema.check(Schema.isMaxLength(500))),
  nextOffset: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
}) {}

/** Bounded filename matches returned from a Core-owned workspace index. */
export class CodeWorkspaceSearchResult extends Schema.Class<CodeWorkspaceSearchResult>(
  "CodeWorkspaceSearchResult",
)({
  paths: Schema.Array(RepositoryRelativePath).pipe(Schema.check(Schema.isMaxLength(100))),
  nextOffset: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
}) {}

/** Recoverable reason a managed Code file was not returned. */
export const CodeWorkspaceFileReadRejectionReason = Schema.Literals([
  "binary",
  "invalidUtf8",
  "ioFailure",
  "missing",
  "notRegularFile",
  "oversized",
  "unsafeSymlink",
])

/** Recoverable reason a managed Code file was not returned. */
export type CodeWorkspaceFileReadRejectionReason = typeof CodeWorkspaceFileReadRejectionReason.Type

/** Result of reading one repository-relative file from a managed Code workspace. */
export const CodeWorkspaceFileReadResult = Schema.TaggedUnion({
  content: {
    path: RepositoryRelativePath,
    content: Schema.String,
  },
  rejected: {
    path: RepositoryRelativePath,
    reason: CodeWorkspaceFileReadRejectionReason,
  },
})

/** Result of reading one repository-relative file from a managed Code workspace. */
export type CodeWorkspaceFileReadResult = typeof CodeWorkspaceFileReadResult.Type

/** UTF-8 source returned from a managed Code workspace. */
export const CodeWorkspaceFileContent = CodeWorkspaceFileReadResult.cases.content

/** Recoverable managed Code file rejection. */
export const CodeWorkspaceFileReadRejected = CodeWorkspaceFileReadResult.cases.rejected

/** Recoverable reason a managed Code workspace operation failed. */
export const CodeWorkspaceFailureReason = Schema.Literals([
  "invalidPath",
  "leaseExpired",
  "leaseNotFound",
  "repositoryNotFound",
  "repositoryUnavailable",
  "revisionUnavailable",
  "snapshotUnavailable",
  "workspaceUnavailable",
])

/** Recoverable reason a managed Code workspace operation failed. */
export type CodeWorkspaceFailureReason = typeof CodeWorkspaceFailureReason.Type

/** Expected managed Code workspace failure safe to cross the renderer boundary. */
export class CodeWorkspaceError extends Schema.TaggedError<CodeWorkspaceError>()(
  "CodeWorkspaceError",
  {
    operation: Schema.String,
    reason: CodeWorkspaceFailureReason,
    message: Schema.String,
  },
) {}

/** One changed path from the linked checkout backing a project-head Code workspace. */
export class CodeWorkspaceFileChange extends Schema.Class<CodeWorkspaceFileChange>(
  "CodeWorkspaceFileChange",
)({
  path: RepositoryRelativePath,
  status: DiffFileStatus,
}) {}

/** Bounded working-tree changes associated with a managed Code workspace. */
export class CodeWorkspaceChangesResult extends Schema.Class<CodeWorkspaceChangesResult>(
  "CodeWorkspaceChangesResult",
)({
  changes: Schema.Array(CodeWorkspaceFileChange).pipe(Schema.check(Schema.isMaxLength(5_000))),
  truncated: Schema.Boolean,
}) {}

/** Bounded changed-line ranges for one file in a Code workspace. */
export class CodeWorkspaceLineChangesResult extends Schema.Class<CodeWorkspaceLineChangesResult>(
  "CodeWorkspaceLineChangesResult",
)({
  changes: Schema.Array(CodeLineChangeRange).pipe(Schema.check(Schema.isMaxLength(5_000))),
  truncated: Schema.Boolean,
}) {}
