import { Context, Effect, Layer, Schema } from "effect"

import {
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitProviderId,
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
  GitProviderDescriptor,
  GitProviderDiagnostic,
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
  GitProviderTerminology,
} from "@diffdash/domain/git-provider"

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

/** Provider-neutral account or organization available as a repository search scope. */
export class GitRepositorySearchScope extends Schema.Class<GitRepositorySearchScope>(
  "GitRepositorySearchScope",
)({
  login: Schema.String,
  kind: Schema.Literal("user", "organization"),
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
  /** Executables or agent tools capable of publishing provider-side review state. */
  readonly publishingTools: readonly string[]
  readonly diagnose: Effect.Effect<GitProviderDiagnostic, GitProviderOperationError>
  readonly parseRemote: (
    remoteUrl: string,
  ) => Effect.Effect<HostedRepositoryLocator | null, GitProviderOperationError>
  readonly searchRepositories: (
    input: GitRepositorySearchInput,
  ) => Effect.Effect<readonly HostedRepository[], GitProviderOperationError>
  readonly listSearchScopes?: () => Effect.Effect<
    readonly GitRepositorySearchScope[],
    GitProviderOperationError
  >
  readonly listAssignedReviews?: () => Effect.Effect<
    readonly HostedReviewSummary[],
    GitProviderOperationError
  >
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
  readonly checkoutSpecAtRevision?: (
    review: HostedReviewLocator,
    revision: string,
  ) => Effect.Effect<HostedReviewCheckoutSpec, GitProviderOperationError>
}

/** Registry of configured hosted Git provider instances. */
export class GitProviderRegistry extends Context.Tag("@diffdash/GitProviderRegistry")<
  GitProviderRegistry,
  {
    readonly list: Effect.Effect<readonly GitProviderRegistration[]>
    readonly get: (
      providerId: GitProviderId,
    ) => Effect.Effect<GitProviderRegistration, UnknownGitProviderError>
    readonly resolveRemote: (
      remoteUrl: string,
    ) => Effect.Effect<
      HostedRepositoryLocator | null,
      AmbiguousGitRemoteError | GitProviderOperationError
    >
  }
>() {
  /** Builds a registry and fails immediately when instance IDs collide. */
  static readonly layer = (registrations: readonly GitProviderRegistration[]) =>
    Layer.effect(
      GitProviderRegistry,
      Effect.gen(function* () {
        const providers = new Map<GitProviderId, GitProviderRegistration>()
        for (const registration of registrations) {
          if (providers.has(registration.descriptor.id)) {
            return yield* DuplicateGitProviderError.make({
              providerId: registration.descriptor.id,
            })
          }
          providers.set(registration.descriptor.id, registration)
        }

        return GitProviderRegistry.of({
          list: Effect.succeed([...providers.values()]),
          get: (providerId) =>
            Effect.fromNullable(providers.get(providerId)).pipe(
              Effect.orElseFail(() => UnknownGitProviderError.make({ providerId })),
            ),
          resolveRemote: Effect.fn("GitProviderRegistry.resolveRemote")(function* (remoteUrl) {
            const matches = (yield* Effect.all(
              [...providers.values()].map((provider) => provider.parseRemote(remoteUrl)),
              { concurrency: "unbounded" },
            )).filter((match): match is HostedRepositoryLocator => match !== null)
            if (matches.length > 1) {
              return yield* AmbiguousGitRemoteError.make({
                remoteUrl,
                providerIds: matches.map(({ providerId }) => providerId),
              })
            }
            return matches[0] ?? null
          }),
        })
      }),
    )
}
