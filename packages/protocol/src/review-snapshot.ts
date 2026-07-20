import { ParsedDiffFile } from "@diffdash/domain/diff"
import { HostedReviewLocator } from "@diffdash/domain/git-provider"
import { LocalReviewTarget } from "@diffdash/domain/local-review"
import {
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
  ReviewSnapshotFileInventory,
} from "@diffdash/domain/review-context"
import { ReviewFileId, ReviewHunkId, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import { Schema } from "effect"

/** Maximum files that one explicit renderer page request may select. */
export const REVIEW_SNAPSHOT_PAGE_FILE_LIMIT = 8

/** Maximum encoded page-state bytes before the Electron success envelope is added. */
export const REVIEW_SNAPSHOT_PAGE_MAX_BYTES = 512 * 1_024

/** Maximum search matches requested from one server-side result page. */
export const REVIEW_SNAPSHOT_SEARCH_RESULT_LIMIT = 200

/** Maximum encoded server-side search page bytes before its success envelope is added. */
export const REVIEW_SNAPSHOT_SEARCH_MAX_BYTES = 256 * 1_024

/** Opaque stable cursor for a bounded parsed-diff file page. */
export const ReviewSnapshotPageCursor = Schema.String.pipe(
  Schema.pattern(/^page:v1:[0-9]+:[0-9a-f]{8}$/),
  Schema.brand("ReviewSnapshotPageCursor"),
)

/** Opaque stable cursor for a bounded parsed-diff file page. */
export type ReviewSnapshotPageCursor = typeof ReviewSnapshotPageCursor.Type

/** Opaque stable cursor for a bounded revision-keyed search page. */
export const ReviewSnapshotSearchCursor = Schema.String.pipe(
  Schema.pattern(/^search:v1:[0-9]+:[0-9a-f]{8}$/),
  Schema.brand("ReviewSnapshotSearchCursor"),
)

/** Opaque stable cursor for a bounded revision-keyed search page. */
export type ReviewSnapshotSearchCursor = typeof ReviewSnapshotSearchCursor.Type

/** Reason a renderer must reacquire its review manifest. */
export const ReviewSnapshotExpiredReason = Schema.Literal("expired", "evicted", "mismatched")

/** Reason a renderer must reacquire its review manifest. */
export type ReviewSnapshotExpiredReason = typeof ReviewSnapshotExpiredReason.Type

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

/** Renderer request for a bounded parsed-file page. */
export class ReviewSnapshotPageRequest extends Schema.Class<ReviewSnapshotPageRequest>(
  "ReviewSnapshotPageRequest",
)({
  snapshotId: ReviewSnapshotId,
  cursor: Schema.NullOr(ReviewSnapshotPageCursor),
  fileIds: Schema.Array(ReviewFileId).pipe(Schema.maxItems(REVIEW_SNAPSHOT_PAGE_FILE_LIMIT)),
}) {}

/** Parsed files returned without truncation under one response budget. */
export class ReviewSnapshotPageAvailable extends Schema.TaggedClass<ReviewSnapshotPageAvailable>()(
  "available",
  {
    snapshotId: ReviewSnapshotId,
    files: Schema.Array(ParsedDiffFile).pipe(Schema.maxItems(REVIEW_SNAPSHOT_PAGE_FILE_LIMIT)),
    nextCursor: Schema.NullOr(ReviewSnapshotPageCursor),
  },
) {}

/** Typed state for a single parsed file that cannot fit one complete response. */
export class ReviewSnapshotFileTooLarge extends Schema.TaggedClass<ReviewSnapshotFileTooLarge>()(
  "fileTooLarge",
  {
    snapshotId: ReviewSnapshotId,
    file: ReviewSnapshotFileInventory,
    maxResponseBytes: Schema.Int.pipe(Schema.positive()),
  },
) {}

/** Typed stale state instructing the renderer to reacquire the review. */
export class ReviewSnapshotExpired extends Schema.TaggedClass<ReviewSnapshotExpired>()("expired", {
  snapshotId: ReviewSnapshotId,
  reason: ReviewSnapshotExpiredReason,
}) {}

/** Bounded parsed-file page, explicit too-large-file state, or stale snapshot state. */
export const ReviewSnapshotPageResponse = Schema.Union(
  ReviewSnapshotPageAvailable,
  ReviewSnapshotFileTooLarge,
  ReviewSnapshotExpired,
)

/** Bounded parsed-file page, explicit too-large-file state, or stale snapshot state. */
export type ReviewSnapshotPageResponse = typeof ReviewSnapshotPageResponse.Type

/** Bounded revision-keyed literal search request. */
export class ReviewSnapshotSearchRequest extends Schema.Class<ReviewSnapshotSearchRequest>(
  "ReviewSnapshotSearchRequest",
)({
  snapshotId: ReviewSnapshotId,
  query: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512)),
  cursor: Schema.NullOr(ReviewSnapshotSearchCursor),
  limit: Schema.Int.pipe(Schema.between(1, REVIEW_SNAPSHOT_SEARCH_RESULT_LIMIT)),
}) {}

/** Semantic side occupied by one immutable parsed-diff search match. */
export const ReviewSnapshotSearchSide = Schema.Literal("additions", "context", "deletions")

/** Semantic side occupied by one immutable parsed-diff search match. */
export type ReviewSnapshotSearchSide = typeof ReviewSnapshotSearchSide.Type

/** One exact literal occurrence in the complete cached parsed diff. */
export class ReviewSnapshotSearchMatch extends Schema.Class<ReviewSnapshotSearchMatch>(
  "ReviewSnapshotSearchMatch",
)({
  id: Schema.String,
  fileId: ReviewFileId,
  filePath: Schema.String,
  reviewKey: Schema.String,
  hunkId: ReviewHunkId,
  hunkLineIndex: Schema.Int.pipe(Schema.nonNegative()),
  newLineNumber: Schema.NullOr(Schema.Int.pipe(Schema.positive())),
  oldLineNumber: Schema.NullOr(Schema.Int.pipe(Schema.positive())),
  side: ReviewSnapshotSearchSide,
  text: Schema.String,
  start: Schema.Int.pipe(Schema.nonNegative()),
  end: Schema.Int.pipe(Schema.nonNegative()),
}) {}

/** One bounded search page plus the complete revision-keyed match count. */
export class ReviewSnapshotSearchAvailable extends Schema.TaggedClass<ReviewSnapshotSearchAvailable>()(
  "available",
  {
    snapshotId: ReviewSnapshotId,
    matches: Schema.Array(ReviewSnapshotSearchMatch).pipe(
      Schema.maxItems(REVIEW_SNAPSHOT_SEARCH_RESULT_LIMIT),
    ),
    totalMatches: Schema.Int.pipe(Schema.nonNegative()),
    nextCursor: Schema.NullOr(ReviewSnapshotSearchCursor),
  },
) {}

/** Bounded search result page or stale snapshot state. */
export const ReviewSnapshotSearchResponse = Schema.Union(
  ReviewSnapshotSearchAvailable,
  ReviewSnapshotExpired,
)

/** Bounded search result page or stale snapshot state. */
export type ReviewSnapshotSearchResponse = typeof ReviewSnapshotSearchResponse.Type

/** Hosted or local manifest returned by the acquisition channels. */
export const AcquiredReviewSnapshotManifest = Schema.Union(
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
)

/** Hosted or local manifest returned by the acquisition channels. */
export type AcquiredReviewSnapshotManifest = typeof AcquiredReviewSnapshotManifest.Type
