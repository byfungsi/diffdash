import { Schema } from "effect"

import { ParsedDiff } from "./diff"
import { ParsedDiffFile } from "./diff"
import { HostedReviewDetail, HostedReviewDiff } from "./git-provider"
import { LocalReviewDetail, LocalReviewDiff } from "./local-review"
import { RepositoryComparisonDetail, RepositoryComparisonDiff } from "./repository-comparison"
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
export const ReviewSnapshot = Schema.Union(
  HostedReviewSnapshot,
  LocalReviewSnapshot,
  RepositoryComparisonSnapshot,
)

/** A coherent local or provider-backed review revision. */
export type ReviewSnapshot = typeof ReviewSnapshot.Type

/** File-tree metadata for one parsed file without raw patch text or hunks. */
export class ReviewSnapshotFileInventory extends Schema.Class<ReviewSnapshotFileInventory>(
  "ReviewSnapshotFileInventory",
)({
  fileId: ReviewFileId,
  patchHash: ReviewFilePatchHash,
  reviewKey: Schema.String,
  path: Schema.String,
  oldPath: Schema.NullOr(Schema.String),
  status: ParsedDiffFile.fields.status,
  additions: Schema.Number,
  deletions: Schema.Number,
  hunkCount: Schema.Int.pipe(Schema.nonNegative()),
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
export const ReviewSnapshotManifest = Schema.Union(
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
  RepositoryComparisonSnapshotManifest,
)

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
  if (snapshot instanceof HostedReviewSnapshot) {
    return HostedReviewSnapshotManifest.make({ ...identity, detail: snapshot.detail })
  }
  if (snapshot instanceof LocalReviewSnapshot) {
    return LocalReviewSnapshotManifest.make({ ...identity, detail: snapshot.detail })
  }
  return RepositoryComparisonSnapshotManifest.make({ ...identity, detail: snapshot.detail })
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
    additions: file.additions,
    deletions: file.deletions,
    hunkCount: file.hunks.length,
  })
