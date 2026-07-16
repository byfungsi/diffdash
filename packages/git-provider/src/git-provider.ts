import { Effect, Schema } from "effect"

import {
  GitProviderCapabilities,
  GitProviderId,
  GitProviderKind,
  HostedRepository,
  HostedRepositoryLocator,
  HostedReviewDetail,
  HostedReviewDiff,
  HostedReviewLocator,
  HostedReviewSummary,
  ReviewDecision,
} from "@diffdash/domain/git-provider"

export {
  BranchRevision,
  GitProviderCapabilities,
  GitProviderId,
  GitProviderKind,
  HostedRepository,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewDetail,
  HostedReviewDiff,
  HostedReviewLocator,
  HostedReviewNumber,
  HostedReviewSummary,
  ProviderActor,
  RepositoryNamespace,
  ReviewChangedFile,
  ReviewCommit,
  ReviewDecision,
} from "@diffdash/domain/git-provider"

/** Human-readable provider vocabulary used by provider-neutral UI. */
export class GitProviderTerminology extends Schema.Class<GitProviderTerminology>(
  "GitProviderTerminology",
)({
  repositorySingular: Schema.String,
  repositoryPlural: Schema.String,
  reviewSingular: Schema.String,
  reviewPlural: Schema.String,
}) {}

/** Serializable description of one configured provider instance. */
export class GitProviderDescriptor extends Schema.Class<GitProviderDescriptor>(
  "GitProviderDescriptor",
)({
  id: GitProviderId,
  kind: GitProviderKind,
  displayName: Schema.String,
  host: Schema.String,
  capabilities: GitProviderCapabilities,
  terminology: GitProviderTerminology,
}) {}

/** Provider health exposed without leaking provider-specific command output. */
export class GitProviderDiagnostic extends Schema.Class<GitProviderDiagnostic>(
  "GitProviderDiagnostic",
)({
  providerId: GitProviderId,
  available: Schema.Boolean,
  authenticated: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
}) {}

/** Provider-owned checkout instructions consumed by local workspace management. */
export class HostedReviewCheckoutSpec extends Schema.Class<HostedReviewCheckoutSpec>(
  "HostedReviewCheckoutSpec",
)({
  repository: HostedRepositoryLocator,
  review: HostedReviewLocator,
  remoteUrl: Schema.String,
  fetchRef: Schema.String,
  revision: Schema.String,
}) {}

/** Provider-neutral repository search input. */
export class GitRepositorySearchInput extends Schema.Class<GitRepositorySearchInput>(
  "GitRepositorySearchInput",
)({
  query: Schema.String,
  namespaces: Schema.Array(Schema.String),
}) {}

/** Unknown configured provider ID. */
export class UnknownGitProviderError extends Schema.TaggedError<UnknownGitProviderError>()(
  "UnknownGitProviderError",
  { providerId: GitProviderId },
) {}

/** Duplicate configured provider ID. */
export class DuplicateGitProviderError extends Schema.TaggedError<DuplicateGitProviderError>()(
  "DuplicateGitProviderError",
  { providerId: GitProviderId },
) {}

/** More than one registered provider accepted the same remote. */
export class AmbiguousGitRemoteError extends Schema.TaggedError<AmbiguousGitRemoteError>()(
  "AmbiguousGitRemoteError",
  { remoteUrl: Schema.String, providerIds: Schema.Array(GitProviderId) },
) {}

/** Recoverable failure returned by one provider implementation. */
export class GitProviderOperationError extends Schema.TaggedError<GitProviderOperationError>()(
  "GitProviderOperationError",
  {
    providerId: GitProviderId,
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** Errors exposed by provider and registry operations. */
export type GitProviderError =
  | UnknownGitProviderError
  | DuplicateGitProviderError
  | AmbiguousGitRemoteError
  | GitProviderOperationError

/** Complete leaf-provider contract implemented by hosted Git integrations. */
export interface GitProviderRegistration {
  readonly descriptor: GitProviderDescriptor
  readonly diagnose: Effect.Effect<GitProviderDiagnostic, GitProviderOperationError>
  readonly parseRemote: (
    remoteUrl: string,
  ) => Effect.Effect<HostedRepositoryLocator | null, GitProviderOperationError>
  readonly searchRepositories: (
    input: GitRepositorySearchInput,
  ) => Effect.Effect<readonly HostedRepository[], GitProviderOperationError>
  readonly listReviews: (
    repository: HostedRepositoryLocator,
  ) => Effect.Effect<readonly HostedReviewSummary[], GitProviderOperationError>
  readonly getReview: (
    review: HostedReviewLocator,
  ) => Effect.Effect<HostedReviewDetail, GitProviderOperationError>
  readonly getReviewDiff: (
    review: HostedReviewLocator,
  ) => Effect.Effect<HostedReviewDiff, GitProviderOperationError>
  readonly getReviewDecision: (
    review: HostedReviewLocator,
  ) => Effect.Effect<ReviewDecision, GitProviderOperationError>
  readonly submitReviewDecision: (
    review: HostedReviewLocator,
    decision: ReviewDecision,
  ) => Effect.Effect<void, GitProviderOperationError>
  readonly repositoryUrl: (repository: HostedRepositoryLocator) => string
  readonly fileUrl: (repository: HostedRepositoryLocator, path: string, revision: string) => string
  readonly bootstrapBareRepository: (
    repository: HostedRepositoryLocator,
    destination: string,
  ) => Effect.Effect<void, GitProviderOperationError>
  readonly checkoutSpec: (
    review: HostedReviewLocator,
  ) => Effect.Effect<HostedReviewCheckoutSpec, GitProviderOperationError>
}
