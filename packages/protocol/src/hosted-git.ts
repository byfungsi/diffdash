import { Schema } from "effect"

import {
  GitFileRevision,
  GitProviderId,
  HostedReviewMergeMethod,
  HostedReviewSubmission,
  HostedRepositoryLocator,
  HostedReviewLocator,
} from "@diffdash/domain/git-provider"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewRevision } from "@diffdash/domain/review-identity"

/** Repository-relative path accepted by native file-opening requests. */
export const OpenRepositoryFilePath = RepositoryRelativePath

/** Repository-relative path accepted by native file-opening requests. */
export type OpenRepositoryFilePath = typeof OpenRepositoryFilePath.Type

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
  submission: HostedReviewSubmission,
}) {}

/** Request to close one hosted review. */
export class CloseHostedReviewRequest extends Schema.Class<CloseHostedReviewRequest>(
  "CloseHostedReviewRequest",
)({ review: HostedReviewLocator }) {}

/** Request to merge one hosted review with a provider-neutral strategy. */
export class MergeHostedReviewRequest extends Schema.Class<MergeHostedReviewRequest>(
  "MergeHostedReviewRequest",
)({
  review: HostedReviewLocator,
  method: HostedReviewMergeMethod,
  bypassRules: Schema.Boolean,
  expectedHeadRevision: ReviewRevision,
}) {}

/** Request to open a hosted review file locally or through its provider. */
export class OpenHostedReviewFileRequest extends Schema.Class<OpenHostedReviewFileRequest>(
  "OpenHostedReviewFileRequest",
)({
  review: HostedReviewLocator,
  filePath: OpenRepositoryFilePath,
  headRefName: GitFileRevision,
  headRevision: Schema.NullOr(ReviewRevision),
}) {}

/** Revision-scoped walkthrough lookup for one hosted review. */
export class HostedWalkthroughRequest extends Schema.Class<HostedWalkthroughRequest>(
  "HostedWalkthroughRequest",
)({
  review: HostedReviewLocator,
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
}) {}

/** Walkthrough generation request for one hosted review. */
export class GenerateHostedWalkthroughRequest extends Schema.Class<GenerateHostedWalkthroughRequest>(
  "GenerateHostedWalkthroughRequest",
)({ review: HostedReviewLocator, regenerate: Schema.Boolean }) {}
