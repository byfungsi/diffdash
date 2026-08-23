import { Schema } from "effect"

import { DiffFileStatus, DiffFileVisibility } from "./diff"
import { HostedReviewDetail, HostedReviewLocator } from "./git-provider"
import { LocalReviewDetail, LocalReviewTarget } from "./local-review"
import {
  RepositoryComparisonDetail,
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "./repository-comparison"
import { RepositoryRelativePath } from "./repository-path"
import { NonNegativeInteger, UtcIsoTimestamp } from "./domain-scalar"
import { WebUrl } from "./web-url"
import {
  ReviewFileId,
  ReviewFilePatchHash,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
  ReviewSnapshotId,
} from "./review-identity"

const ReviewDescriptorText = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(4_096)),
)

/** Durable hosted metadata needed to resolve and execute operations without retaining a diff. */
export class HostedReviewDescriptor extends Schema.TaggedClass<HostedReviewDescriptor>()("hosted", {
  review: HostedReviewLocator,
  title: ReviewDescriptorText,
  authorUsername: ReviewDescriptorText,
  state: ReviewDescriptorText,
  draft: Schema.Boolean,
  baseRef: RepositoryComparisonRef,
  headRef: RepositoryComparisonRef,
  url: WebUrl,
}) {}

/** Durable local metadata needed to resolve and execute operations without retaining a diff. */
export class LocalReviewDescriptor extends Schema.TaggedClass<LocalReviewDescriptor>()("local", {
  target: LocalReviewTarget,
  repoName: ReviewDescriptorText,
  branchName: Schema.NullOr(RepositoryComparisonRef),
  title: ReviewDescriptorText,
  fetchedAt: UtcIsoTimestamp,
}) {}

/** Durable comparison metadata needed to resolve and execute operations without retaining a diff. */
export class RepositoryComparisonReviewDescriptor extends Schema.TaggedClass<RepositoryComparisonReviewDescriptor>()(
  "repositoryComparison",
  {
    target: RepositoryComparisonTarget,
    title: ReviewDescriptorText,
    fetchedAt: UtcIsoTimestamp,
  },
) {}

/** Bounded metadata and target facts persisted with an immutable review snapshot. */
export const ReviewDescriptor = Schema.Union([
  HostedReviewDescriptor,
  LocalReviewDescriptor,
  RepositoryComparisonReviewDescriptor,
]).pipe(Schema.toTaggedUnion("_tag"))

/** Bounded metadata and target facts persisted with an immutable review snapshot. */
export type ReviewDescriptor = typeof ReviewDescriptor.Type

/** File-tree metadata for one parsed file without raw patch text or hunks. */
export class ReviewSnapshotFileInventory extends Schema.Class<ReviewSnapshotFileInventory>(
  "ReviewSnapshotFileInventory",
)({
  fileId: ReviewFileId,
  patchHash: ReviewFilePatchHash,
  reviewKey: ReviewKey,
  path: RepositoryRelativePath,
  oldPath: Schema.NullOr(RepositoryRelativePath),
  status: DiffFileStatus,
  visibility: DiffFileVisibility,
  additions: Schema.Number,
  deletions: Schema.Number,
  hunkCount: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
}) {}

const HostedReviewSnapshotDetail = Schema.Struct({
  summary: HostedReviewDetail.fields.summary,
})

const LocalReviewSnapshotDetail = Schema.Struct({
  rootPath: LocalReviewDetail.fields.rootPath,
  repoName: LocalReviewDetail.fields.repoName,
  branchName: LocalReviewDetail.fields.branchName,
  comparison: LocalReviewDetail.fields.comparison,
  baseSha: LocalReviewDetail.fields.baseSha,
  headSha: LocalReviewDetail.fields.headSha,
  diffHash: LocalReviewDetail.fields.diffHash,
  title: LocalReviewDetail.fields.title,
  fetchedAt: LocalReviewDetail.fields.fetchedAt,
})

const RepositoryComparisonSnapshotDetail = Schema.Struct({
  target: RepositoryComparisonDetail.fields.target,
  title: RepositoryComparisonDetail.fields.title,
  fetchedAt: RepositoryComparisonDetail.fields.fetchedAt,
})

/** Renderer-safe hosted snapshot identity and bounded metadata. */
export class HostedReviewSnapshotManifest extends Schema.TaggedClass<HostedReviewSnapshotManifest>()(
  "hosted",
  {
    projectId: ReviewProjectId,
    snapshotId: ReviewSnapshotId,
    reviewKey: ReviewKey,
    baseRevision: ReviewRevision,
    headRevision: ReviewRevision,
    fileCount: NonNegativeInteger,
    detail: HostedReviewSnapshotDetail,
  },
) {}

/** Renderer-safe local snapshot identity and bounded metadata. */
export class LocalReviewSnapshotManifest extends Schema.TaggedClass<LocalReviewSnapshotManifest>()(
  "local",
  {
    projectId: ReviewProjectId,
    snapshotId: ReviewSnapshotId,
    reviewKey: ReviewKey,
    baseRevision: ReviewRevision,
    headRevision: ReviewRevision,
    fileCount: NonNegativeInteger,
    detail: LocalReviewSnapshotDetail,
  },
) {}

/** Renderer-safe immutable comparison identity and bounded metadata. */
export class RepositoryComparisonSnapshotManifest extends Schema.TaggedClass<RepositoryComparisonSnapshotManifest>()(
  "repositoryComparison",
  {
    projectId: ReviewProjectId,
    snapshotId: ReviewSnapshotId,
    reviewKey: ReviewKey,
    baseRevision: ReviewRevision,
    headRevision: ReviewRevision,
    fileCount: NonNegativeInteger,
    detail: RepositoryComparisonSnapshotDetail,
  },
) {}

/** Renderer-safe snapshot identity and bounded source metadata. */
export const ReviewSnapshotManifest = Schema.Union([
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
  RepositoryComparisonSnapshotManifest,
])

/** Renderer-safe snapshot identity and bounded source metadata. */
export type ReviewSnapshotManifest = typeof ReviewSnapshotManifest.Type
