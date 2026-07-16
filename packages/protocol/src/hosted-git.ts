import { Schema } from "effect"

import {
  GitProviderId,
  HostedRepositoryLocator,
  HostedReviewLocator,
  ReviewDecision,
} from "@diffdash/domain/git-provider"

/** Request selecting one configured hosted provider. */
export class HostedProviderRequest extends Schema.Class<HostedProviderRequest>(
  "HostedProviderRequest",
)({ providerId: GitProviderId }) {}

/** Request selecting one hosted repository. */
export class HostedRepositoryRequest extends Schema.Class<HostedRepositoryRequest>(
  "HostedRepositoryRequest",
)({ repository: HostedRepositoryLocator }) {}

/** Provider-scoped repository search request. */
export class HostedRepositorySearchRequest extends Schema.Class<HostedRepositorySearchRequest>(
  "HostedRepositorySearchRequest",
)({
  providerId: GitProviderId,
  query: Schema.String,
  namespaces: Schema.Array(Schema.String),
}) {}

/** Request selecting one hosted review. */
export class HostedReviewRequest extends Schema.Class<HostedReviewRequest>("HostedReviewRequest")({
  review: HostedReviewLocator,
}) {}

/** Request to submit a provider-neutral review decision. */
export class SubmitHostedReviewDecisionRequest extends Schema.Class<SubmitHostedReviewDecisionRequest>(
  "SubmitHostedReviewDecisionRequest",
)({
  review: HostedReviewLocator,
  decision: ReviewDecision,
}) {}

/** Request to open a hosted review file locally or through its provider. */
export class OpenHostedReviewFileRequest extends Schema.Class<OpenHostedReviewFileRequest>(
  "OpenHostedReviewFileRequest",
)({
  review: HostedReviewLocator,
  filePath: Schema.String,
  headRefName: Schema.String,
  headRevision: Schema.NullOr(Schema.String),
}) {}

/** Revision-scoped viewed-file lookup for one hosted review. */
export class HostedViewedFilesRequest extends Schema.Class<HostedViewedFilesRequest>(
  "HostedViewedFilesRequest",
)({ review: HostedReviewLocator, headRevision: Schema.String }) {}

/** Revision-scoped viewed-file mutation for one hosted review. */
export class SetHostedViewedFileRequest extends Schema.Class<SetHostedViewedFileRequest>(
  "SetHostedViewedFileRequest",
)({
  review: HostedReviewLocator,
  headRevision: Schema.String,
  reviewKey: Schema.String,
  filePath: Schema.String,
  viewed: Schema.Boolean,
}) {}

/** Revision-scoped walkthrough lookup for one hosted review. */
export class HostedWalkthroughRequest extends Schema.Class<HostedWalkthroughRequest>(
  "HostedWalkthroughRequest",
)({
  review: HostedReviewLocator,
  baseRevision: Schema.String,
  headRevision: Schema.String,
}) {}

/** Walkthrough generation request for one hosted review. */
export class GenerateHostedWalkthroughRequest extends Schema.Class<GenerateHostedWalkthroughRequest>(
  "GenerateHostedWalkthroughRequest",
)({ review: HostedReviewLocator, regenerate: Schema.Boolean }) {}
