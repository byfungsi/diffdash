import { HostedReviewLocator } from "@diffdash/domain/git-provider"
import { LocalReviewTarget } from "@diffdash/domain/local-review"
import { ReviewFilePatchHash } from "@diffdash/domain/review-identity"
import { Schema } from "effect"

/** Persisted viewed-file identity returned for one review scope. */
export class ViewedFileRecord extends Schema.Class<ViewedFileRecord>("ViewedFileRecord")({
  reviewKey: Schema.String,
  patchHash: ReviewFilePatchHash,
}) {}

/** Content-scoped viewed-file lookup for one hosted review target. */
export class HostedViewedFilesRequest extends Schema.Class<HostedViewedFilesRequest>(
  "HostedViewedFilesRequest",
)({
  review: HostedReviewLocator,
  baseRefName: Schema.NonEmptyString,
}) {}

/** Content-scoped viewed-file mutation for one hosted review target. */
export class SetHostedViewedFileRequest extends Schema.Class<SetHostedViewedFileRequest>(
  "SetHostedViewedFileRequest",
)({
  review: HostedReviewLocator,
  baseRefName: Schema.NonEmptyString,
  reviewKey: Schema.String,
  patchHash: ReviewFilePatchHash,
  viewed: Schema.Boolean,
}) {}

/** Content-scoped viewed-file lookup for one local review target. */
export class LocalViewedFilesRequest extends Schema.Class<LocalViewedFilesRequest>(
  "LocalViewedFilesRequest",
)({
  target: LocalReviewTarget,
  sourceBranch: Schema.NullOr(Schema.NonEmptyString),
}) {}

/** Content-scoped viewed-file mutation for one local review target. */
export class SetLocalViewedFileRequest extends Schema.Class<SetLocalViewedFileRequest>(
  "SetLocalViewedFileRequest",
)({
  target: LocalReviewTarget,
  sourceBranch: Schema.NullOr(Schema.NonEmptyString),
  reviewKey: Schema.String,
  patchHash: ReviewFilePatchHash,
  viewed: Schema.Boolean,
}) {}
