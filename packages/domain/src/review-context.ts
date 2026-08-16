import { Match, Schema } from "effect"

import { ParsedDiff } from "./diff"
import { DiffFileStatus, DiffFileVisibility, type ParsedDiffFile } from "./diff"
import { HostedReviewDetail, HostedReviewDiff, HostedReviewLocator } from "./git-provider"
import { LocalReviewDetail, LocalReviewDiff, LocalReviewTarget } from "./local-review"
import {
  RepositoryComparisonDetail,
  RepositoryComparisonDiff,
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "./repository-comparison"
import { RepositoryRelativePath } from "./repository-path"
import { UtcIsoTimestamp } from "./domain-scalar"
import { WebUrl } from "./web-url"
import {
  ReviewFileId,
  ReviewFilePatchHash,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
  ReviewSnapshotId,
} from "./review-identity"

/** Coherent metadata and diff content for one hosted review revision. */
export class HostedReviewSnapshot extends Schema.TaggedClass<HostedReviewSnapshot>()("hosted", {
  snapshotId: ReviewSnapshotId,
  reviewKey: ReviewKey,
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
  detail: HostedReviewDetail,
  diff: HostedReviewDiff,
  parsedDiff: ParsedDiff,
}) {}

/** Coherent metadata and diff content for one local working-tree revision. */
export class LocalReviewSnapshot extends Schema.TaggedClass<LocalReviewSnapshot>()("local", {
  snapshotId: ReviewSnapshotId,
  reviewKey: ReviewKey,
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
  detail: LocalReviewDetail,
  diff: LocalReviewDiff,
  parsedDiff: ParsedDiff,
}) {}

/** Coherent metadata and diff content for one immutable repository comparison. */
export class RepositoryComparisonSnapshot extends Schema.TaggedClass<RepositoryComparisonSnapshot>()(
  "repositoryComparison",
  {
    snapshotId: ReviewSnapshotId,
    reviewKey: ReviewKey,
    baseRevision: ReviewRevision,
    headRevision: ReviewRevision,
    detail: RepositoryComparisonDetail,
    diff: RepositoryComparisonDiff,
    parsedDiff: ParsedDiff,
  },
) {}

/** A coherent local or provider-backed review revision. */
export const ReviewSnapshot = Schema.Union([
  HostedReviewSnapshot,
  LocalReviewSnapshot,
  RepositoryComparisonSnapshot,
])

/** A coherent local or provider-backed review revision. */
export type ReviewSnapshot = typeof ReviewSnapshot.Type

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
])

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

/** Renderer-safe hosted snapshot metadata and complete file inventory. */
export class HostedReviewSnapshotManifest extends Schema.TaggedClass<HostedReviewSnapshotManifest>()(
  "hosted",
  {
    projectId: ReviewProjectId,
    snapshotId: ReviewSnapshotId,
    reviewKey: ReviewKey,
    baseRevision: ReviewRevision,
    headRevision: ReviewRevision,
    detail: HostedReviewDetail,
    files: Schema.Array(ReviewSnapshotFileInventory),
  },
) {}

/** Renderer-safe local snapshot metadata and complete file inventory. */
export class LocalReviewSnapshotManifest extends Schema.TaggedClass<LocalReviewSnapshotManifest>()(
  "local",
  {
    projectId: ReviewProjectId,
    snapshotId: ReviewSnapshotId,
    reviewKey: ReviewKey,
    baseRevision: ReviewRevision,
    headRevision: ReviewRevision,
    detail: LocalReviewDetail,
    files: Schema.Array(ReviewSnapshotFileInventory),
  },
) {}

/** Renderer-safe immutable comparison metadata and complete file inventory. */
export class RepositoryComparisonSnapshotManifest extends Schema.TaggedClass<RepositoryComparisonSnapshotManifest>()(
  "repositoryComparison",
  {
    projectId: ReviewProjectId,
    snapshotId: ReviewSnapshotId,
    reviewKey: ReviewKey,
    baseRevision: ReviewRevision,
    headRevision: ReviewRevision,
    detail: RepositoryComparisonDetail,
    files: Schema.Array(ReviewSnapshotFileInventory),
  },
) {}

/** Renderer-safe snapshot metadata without raw complete diff or parsed hunks. */
export const ReviewSnapshotManifest = Schema.Union([
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
  RepositoryComparisonSnapshotManifest,
])

/** Renderer-safe snapshot metadata without raw complete diff or parsed hunks. */
export type ReviewSnapshotManifest = typeof ReviewSnapshotManifest.Type

/** Projects an internally coherent hosted snapshot into renderer-safe manifest metadata. */
export function makeReviewSnapshotManifest(
  snapshot: HostedReviewSnapshot,
  projectId: ReviewProjectId,
): HostedReviewSnapshotManifest

/** Projects an internally coherent local snapshot into renderer-safe manifest metadata. */
export function makeReviewSnapshotManifest(
  snapshot: LocalReviewSnapshot,
  projectId: ReviewProjectId,
): LocalReviewSnapshotManifest

/** Projects an immutable comparison snapshot into renderer-safe manifest metadata. */
export function makeReviewSnapshotManifest(
  snapshot: RepositoryComparisonSnapshot,
  projectId: ReviewProjectId,
): RepositoryComparisonSnapshotManifest

/** Projects an internally coherent snapshot into renderer-safe manifest metadata. */
export function makeReviewSnapshotManifest(
  snapshot: ReviewSnapshot,
  projectId: ReviewProjectId,
): ReviewSnapshotManifest

/** Projects an internally coherent snapshot into renderer-safe manifest metadata. */
export function makeReviewSnapshotManifest(
  snapshot: ReviewSnapshot,
  projectId: ReviewProjectId,
): ReviewSnapshotManifest {
  const identity = {
    projectId,
    snapshotId: snapshot.snapshotId,
    reviewKey: snapshot.reviewKey,
    baseRevision: snapshot.baseRevision,
    headRevision: snapshot.headRevision,
    files: snapshot.parsedDiff.files.map(makeReviewSnapshotFileInventory),
  }
  return Match.value(snapshot).pipe(
    Match.tag("hosted", (hosted) =>
      HostedReviewSnapshotManifest.make({ ...identity, detail: hosted.detail }),
    ),
    Match.tag("local", (local) =>
      LocalReviewSnapshotManifest.make({ ...identity, detail: local.detail }),
    ),
    Match.tag("repositoryComparison", (comparison) =>
      RepositoryComparisonSnapshotManifest.make({ ...identity, detail: comparison.detail }),
    ),
    Match.exhaustive,
  )
}

/** Projects one parsed file into renderer-safe inventory metadata. */
export const makeReviewSnapshotFileInventory = (file: ParsedDiffFile) =>
  ReviewSnapshotFileInventory.make({
    fileId: file.fileId,
    patchHash: file.patchHash,
    reviewKey: file.reviewKey,
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    visibility: file.visibility,
    additions: file.additions,
    deletions: file.deletions,
    hunkCount: file.hunks.length,
  })
