import { Context, Effect, Layer, Schema } from "effect"

import {
  type GitProviderDescriptor,
  type GitProviderDiagnostic,
  type GitProviderId,
  type HostedRepository,
  type HostedRepositoryLocator,
  ResolvedHostedRepository,
  type HostedReviewLocator,
  type HostedReviewDetail,
  type HostedReviewDiff,
  type HostedReviewSummary,
} from "@diffdash/domain/git-provider"
import {
  GitProviderOperationError,
  GitProviderRegistry,
  type HostedReviewCheckoutSpec,
  type UnknownGitProviderError,
} from "@diffdash/git-provider"
import { RepositorySearchScope, type RepositorySearchRequest } from "@diffdash/domain/repository"

/** A typed failure for unsupported or malformed provider remote URLs. */
export class GitProviderRemoteParseError extends Schema.TaggedError<GitProviderRemoteParseError>()(
  "GitProviderRemoteParseError",
  { remoteUrl: Schema.String },
) {}

/** Expected failures from selecting or invoking one hosted Git provider. */
export type GitProviderCallError = UnknownGitProviderError | GitProviderOperationError

/** Provider-neutral hosted Git orchestration backed only by the provider registry. */
export class GitProvider extends Context.Tag("@diffdash/GitProvider")<
  GitProvider,
  {
    readonly listProviders: Effect.Effect<readonly GitProviderDescriptor[]>
    readonly diagnoseProviders: Effect.Effect<readonly GitProviderDiagnostic[]>
    readonly parseRemoteUrl: (
      remoteUrl: string,
    ) => Effect.Effect<HostedRepositoryLocator, GitProviderRemoteParseError>
    readonly resolveRepository: (
      repository: HostedRepositoryLocator,
    ) => Effect.Effect<ResolvedHostedRepository, GitProviderCallError>
    readonly repositoryUrl: (
      repository: HostedRepositoryLocator,
    ) => Effect.Effect<string, GitProviderCallError>
    readonly fileUrl: (
      repository: HostedRepositoryLocator,
      filePath: string,
      revision: string,
    ) => Effect.Effect<string, GitProviderCallError>
    readonly searchRepositories: (
      request: RepositorySearchRequest,
    ) => Effect.Effect<readonly HostedRepository[], GitProviderCallError>
    readonly listSearchScopes: (
      providerId: GitProviderId,
    ) => Effect.Effect<readonly RepositorySearchScope[], GitProviderCallError>
    readonly listHostedReviews: (
      repository: HostedRepositoryLocator,
    ) => Effect.Effect<readonly HostedReviewSummary[], GitProviderCallError>
    readonly listAssignedReviews: (
      providerId: GitProviderId,
    ) => Effect.Effect<readonly HostedReviewSummary[], GitProviderCallError>
    readonly getHostedReview: (
      review: HostedReviewLocator,
    ) => Effect.Effect<HostedReviewDetail, GitProviderCallError>
    readonly refreshHostedReview: (
      review: HostedReviewLocator,
    ) => Effect.Effect<HostedReviewDetail, GitProviderCallError>
    readonly getHostedReviewDiff: (
      review: HostedReviewLocator,
    ) => Effect.Effect<HostedReviewDiff, GitProviderCallError>
    readonly getReviewDecision: (
      review: HostedReviewLocator,
    ) => Effect.Effect<import("@diffdash/domain/git-provider").ReviewDecision, GitProviderCallError>
    readonly submitReviewDecision: (
      review: HostedReviewLocator,
      decision: import("@diffdash/domain/git-provider").ReviewDecision,
    ) => Effect.Effect<void, GitProviderCallError>
    readonly hostedReviewCheckoutSpec: (
      review: HostedReviewLocator,
      revision: string,
    ) => Effect.Effect<HostedReviewCheckoutSpec, GitProviderCallError>
    readonly bootstrapBareRepository: (
      repository: HostedRepositoryLocator,
      destination: string,
    ) => Effect.Effect<void, GitProviderCallError>
    readonly isAvailable: (providerId: GitProviderId) => Effect.Effect<boolean>
  }
>() {
  static readonly layer = Layer.effect(
    GitProvider,
    Effect.gen(function* () {
      const registry = yield* GitProviderRegistry
      const provider = (providerId: GitProviderId) => registry.get(providerId)
      return GitProvider.of({
        listProviders: registry.list.pipe(
          Effect.map((providers) => providers.map(({ descriptor }) => descriptor)),
        ),
        diagnoseProviders: registry.list.pipe(
          Effect.flatMap((providers) =>
            Effect.all(
              providers.map((registration) =>
                registration.diagnose.pipe(
                  Effect.catchAll((error) =>
                    Effect.succeed({
                      providerId: registration.descriptor.id,
                      available: false,
                      authenticated: false,
                      message: error.message,
                    }),
                  ),
                ),
              ),
              { concurrency: "unbounded" },
            ),
          ),
        ),
        parseRemoteUrl: (remoteUrl) =>
          registry.resolveRemote(remoteUrl).pipe(
            Effect.flatMap((locator) =>
              locator === null
                ? GitProviderRemoteParseError.make({ remoteUrl })
                : Effect.succeed(locator),
            ),
            Effect.mapError(() => GitProviderRemoteParseError.make({ remoteUrl })),
          ),
        resolveRepository: (repository) =>
          provider(repository.providerId).pipe(
            Effect.flatMap((registration) =>
              registration.resolveRepository === undefined
                ? Effect.map(registration.repositoryUrl(repository), (url) =>
                    ResolvedHostedRepository.make({
                      locator: repository,
                      providerRepositoryId: null,
                      url,
                    }),
                  )
                : registration.resolveRepository(repository),
            ),
          ),
        repositoryUrl: (repository) =>
          provider(repository.providerId).pipe(
            Effect.flatMap((registration) => registration.repositoryUrl(repository)),
          ),
        fileUrl: (repository, filePath, revision) =>
          provider(repository.providerId).pipe(
            Effect.flatMap((registration) => registration.fileUrl(repository, filePath, revision)),
          ),
        searchRepositories: (request) =>
          provider(request.providerId).pipe(
            Effect.flatMap((registration) =>
              registration.searchRepositories({
                query: request.query,
                namespaces: request.owners,
              }),
            ),
          ),
        listSearchScopes: (providerId) =>
          provider(providerId).pipe(
            Effect.flatMap(
              (registration) =>
                registration.listSearchScopes?.() ?? unsupported(providerId, "listSearchScopes"),
            ),
            Effect.map((scopes) => scopes.map((scope) => RepositorySearchScope.make(scope))),
          ),
        listHostedReviews: (repository) =>
          provider(repository.providerId).pipe(
            Effect.flatMap((registration) => registration.listReviews(repository)),
          ),
        listAssignedReviews: (providerId) =>
          provider(providerId).pipe(
            Effect.flatMap(
              (registration) =>
                registration.listAssignedReviews?.() ??
                unsupported(providerId, "listAssignedReviews"),
            ),
          ),
        getHostedReview: (review) =>
          provider(review.repository.providerId).pipe(
            Effect.flatMap((registration) => registration.getReview(review)),
          ),
        refreshHostedReview: (review) =>
          provider(review.repository.providerId).pipe(
            Effect.flatMap((registration) => registration.getReview(review)),
          ),
        getHostedReviewDiff: (review) =>
          provider(review.repository.providerId).pipe(
            Effect.flatMap((registration) => registration.getReviewDiff(review)),
          ),
        getReviewDecision: (review) =>
          provider(review.repository.providerId).pipe(
            Effect.flatMap((registration) => registration.getReviewDecision(review)),
          ),
        submitReviewDecision: (review, decision) =>
          provider(review.repository.providerId).pipe(
            Effect.flatMap((registration) => registration.submitReviewDecision(review, decision)),
          ),
        hostedReviewCheckoutSpec: (review, revision) =>
          provider(review.repository.providerId).pipe(
            Effect.flatMap(
              (registration) =>
                registration.checkoutSpecAtRevision?.(review, revision) ??
                registration.checkoutSpec(review),
            ),
          ),
        bootstrapBareRepository: (repository, destination) =>
          provider(repository.providerId).pipe(
            Effect.flatMap((registration) =>
              registration.bootstrapBareRepository(repository, destination),
            ),
          ),
        isAvailable: (providerId) =>
          provider(providerId).pipe(
            Effect.flatMap((registration) => registration.diagnose),
            Effect.map((diagnostic) => diagnostic.available && diagnostic.authenticated),
            Effect.catchAll(() => Effect.succeed(false)),
          ),
      })
    }),
  )
}

const unsupported = (providerId: GitProviderId, operation: string) =>
  GitProviderOperationError.make({
    providerId,
    operation,
    message: `${operation} is not supported by this provider`,
  })
