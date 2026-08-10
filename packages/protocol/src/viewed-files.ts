import { HostedReviewLocator } from "@diffdash/domain/git-provider"
import { LocalReviewTarget } from "@diffdash/domain/local-review"
import {
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import { ReviewFilePatchHash, ReviewKey } from "@diffdash/domain/review-identity"
import { Schema } from "effect"

/** Persisted viewed-file identity returned for one review scope. */
export class ViewedFileRecord extends Schema.Class<ViewedFileRecord>("ViewedFileRecord")({
  reviewKey: ReviewKey,
  patchHash: ReviewFilePatchHash,
}) {}

/** Content-scoped viewed-file lookup for one hosted review target. */
export class HostedViewedFilesRequest extends Schema.Class<HostedViewedFilesRequest>(
  "HostedViewedFilesRequest",
)({
  review: HostedReviewLocator,
  baseRefName: RepositoryComparisonRef,
}) {}

/** Content-scoped viewed-file mutation for one hosted review target. */
export class SetHostedViewedFileRequest extends Schema.Class<SetHostedViewedFileRequest>(
  "SetHostedViewedFileRequest",
)({
  review: HostedReviewLocator,
  baseRefName: RepositoryComparisonRef,
  reviewKey: ReviewKey,
  patchHash: ReviewFilePatchHash,
  viewed: Schema.Boolean,
}) {}

/** Content-scoped viewed-file lookup for one local review target. */
export class LocalViewedFilesRequest extends Schema.Class<LocalViewedFilesRequest>(
  "LocalViewedFilesRequest",
)({
  target: LocalReviewTarget,
  sourceBranch: Schema.NullOr(RepositoryComparisonRef),
}) {}

/** Content-scoped viewed-file mutation for one local review target. */
export class SetLocalViewedFileRequest extends Schema.Class<SetLocalViewedFileRequest>(
  "SetLocalViewedFileRequest",
)({
  target: LocalReviewTarget,
  sourceBranch: Schema.NullOr(RepositoryComparisonRef),
  reviewKey: ReviewKey,
  patchHash: ReviewFilePatchHash,
  viewed: Schema.Boolean,
}) {}

/** Content-scoped viewed-file lookup for one immutable repository comparison. */
export class RepositoryComparisonViewedFilesRequest extends Schema.Class<RepositoryComparisonViewedFilesRequest>(
  "RepositoryComparisonViewedFilesRequest",
)({
  target: RepositoryComparisonTarget,
}) {}

/** Content-scoped viewed-file mutation for one immutable repository comparison. */
export class SetRepositoryComparisonViewedFileRequest extends Schema.Class<SetRepositoryComparisonViewedFileRequest>(
  "SetRepositoryComparisonViewedFileRequest",
)({
  target: RepositoryComparisonTarget,
  reviewKey: ReviewKey,
  patchHash: ReviewFilePatchHash,
  viewed: Schema.Boolean,
}) {}
