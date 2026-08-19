import { HostedReviewLocator } from "@diffdash/domain/git-provider"
import { LocalReviewTarget } from "@diffdash/domain/local-review"
import { RepositoryComparisonTarget } from "@diffdash/domain/repository-comparison"
import { Repo } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
  RepositoryComparisonSnapshotManifest,
} from "@diffdash/domain/review-context"
import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
} from "@diffdash/domain/review-identity"
import { Schema } from "effect"
import { OpenRepositoryComparisonCommand } from "./cli-navigation"

/** Stable identity for one exact literal occurrence in an immutable review snapshot. */
export const ReviewSnapshotSearchMatchId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("ReviewSnapshotSearchMatchId"),
)

/** Stable identity for one exact literal occurrence in an immutable review snapshot. */
export type ReviewSnapshotSearchMatchId = typeof ReviewSnapshotSearchMatchId.Type

/** Renderer request for a hosted review manifest backed by an immutable cached snapshot. */
export class AcquireHostedReviewSnapshotRequest extends Schema.Class<AcquireHostedReviewSnapshotRequest>(
  "AcquireHostedReviewSnapshotRequest",
)({
  review: HostedReviewLocator,
}) {}

/** Renderer request for a local review manifest backed by an immutable cached snapshot. */
export class AcquireLocalReviewSnapshotRequest extends Schema.Class<AcquireLocalReviewSnapshotRequest>(
  "AcquireLocalReviewSnapshotRequest",
)({
  target: LocalReviewTarget,
}) {}

/** Exact saved repository and immutable target resolved from one CLI command. */
export class ResolvedRepositoryComparison extends Schema.Class<ResolvedRepositoryComparison>(
  "ResolvedRepositoryComparison",
)({
  repo: Repo,
  target: Schema.Union([RepositoryComparisonTarget, LocalReviewTarget]),
}) {}

/** Renderer request to resolve and pin one repository comparison command. */
export class ResolveRepositoryComparisonRequest extends Schema.Class<ResolveRepositoryComparisonRequest>(
  "ResolveRepositoryComparisonRequest",
)({
  command: OpenRepositoryComparisonCommand,
}) {}

/** Renderer request for an immutable repository comparison manifest. */
export class AcquireRepositoryComparisonSnapshotRequest extends Schema.Class<AcquireRepositoryComparisonSnapshotRequest>(
  "AcquireRepositoryComparisonSnapshotRequest",
)({
  target: RepositoryComparisonTarget,
}) {}

/** Opens one file at the comparison's immutable head revision. */
export class OpenRepositoryComparisonFileRequest extends Schema.Class<OpenRepositoryComparisonFileRequest>(
  "OpenRepositoryComparisonFileRequest",
)({
  target: RepositoryComparisonTarget,
  filePath: RepositoryRelativePath,
}) {}

/** Gets or generates a walkthrough for one immutable repository comparison. */
export class RepositoryComparisonWalkthroughRequest extends Schema.Class<RepositoryComparisonWalkthroughRequest>(
  "RepositoryComparisonWalkthroughRequest",
)({
  target: RepositoryComparisonTarget,
  regenerate: Schema.Boolean,
}) {}

/** Starts review search at the beginning of one file in snapshot order. */
export class ReviewSnapshotSearchFileAnchor extends Schema.TaggedClass<ReviewSnapshotSearchFileAnchor>()(
  "file",
  {
    fileId: ReviewFileId,
  },
) {}

/** Semantic side occupied by one immutable parsed-diff search match. */
export const ReviewSnapshotSearchSide = Schema.Literals(["additions", "context", "deletions"])

/** Semantic side occupied by one immutable parsed-diff search match. */
export type ReviewSnapshotSearchSide = typeof ReviewSnapshotSearchSide.Type

/** One exact literal occurrence in the complete cached parsed diff. */
export class ReviewSnapshotSearchMatch extends Schema.Class<ReviewSnapshotSearchMatch>(
  "ReviewSnapshotSearchMatch",
)({
  id: ReviewSnapshotSearchMatchId,
  fileId: ReviewFileId,
  filePath: RepositoryRelativePath,
  reviewKey: ReviewKey,
  hunkId: ReviewHunkId,
  hunkFingerprint: ReviewHunkFingerprint,
  hunkLineIndex: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  newLineNumber: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
  oldLineNumber: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
  side: ReviewSnapshotSearchSide,
  text: Schema.String,
  start: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  end: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
}) {}

/** Hosted or local manifest returned by the acquisition channels. */
export const AcquiredReviewSnapshotManifest = Schema.Union([
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
  RepositoryComparisonSnapshotManifest,
])

/** Hosted or local manifest returned by the acquisition channels. */
export type AcquiredReviewSnapshotManifest = typeof AcquiredReviewSnapshotManifest.Type
