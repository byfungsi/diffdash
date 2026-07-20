import { Context, Effect, Layer, Schema } from "effect"

import {
  type GitProviderDescriptor,
  type GitProviderDiagnostic,
  type GitProviderId,
  type HostedRepository,
  type HostedRepositoryLocator,
  type HostedReviewLocator,
  type HostedReviewDetail,
  type HostedReviewDiff,
  type HostedReviewSummary,
} from "@diffdash/domain/git-provider"
import {
  GitProviderOperationError,
  GitProviderRegistry,
  type HostedReviewCheckoutSpec,
} from "@diffdash/git-provider"
import { RepositorySearchScope, type RepositorySearchRequest } from "@diffdash/domain/repository"

/** A typed failure for unsupported or malformed provider remote URLs. */
export class GitProviderRemoteParseError extends Schema.TaggedError<GitProviderRemoteParseError>()(
  "GitProviderRemoteParseError",
  { remoteUrl: Schema.String },
) {}

/** Provider-neutral hosted Git orchestration backed only by the provider registry. */
export class GitProvider extends Context.Tag("@diffdash/GitProvider")<
  GitProvider,
  {
    readonly listProviders: Effect.Effect<readonly GitProviderDescriptor[]>
    readonly diagnoseProviders: Effect.Effect<readonly GitProviderDiagnostic[]>
    readonly parseRemoteUrl: (
      remoteUrl: string,
    ) => Effect.Effect<HostedRepositoryLocator, GitProviderRemoteParseError>
    readonly repositoryUrl: (repository: HostedRepositoryLocator) => Effect.Effect<string, unknown>
    readonly fileUrl: (
      repository: HostedRepositoryLocator,
      filePath: string,
      revision: string,
    ) => Effect.Effect<string, unknown>
    readonly searchRepositories: (
      request: RepositorySearchRequest,
    ) => Effect.Effect<readonly HostedRepository[], unknown>
    readonly listSearchScopes: (
      providerId: GitProviderId,
    ) => Effect.Effect<readonly RepositorySearchScope[], unknown>
    readonly listHostedReviews: (
      repository: HostedRepositoryLocator,
    ) => Effect.Effect<readonly HostedReviewSummary[], unknown>
    readonly listAssignedReviews: (
      providerId: GitProviderId,
    ) => Effect.Effect<readonly HostedReviewSummary[], unknown>
    readonly getHostedReview: (
      review: HostedReviewLocator,
    ) => Effect.Effect<HostedReviewDetail, unknown>
    readonly refreshHostedReview: (
      review: HostedReviewLocator,
    ) => Effect.Effect<HostedReviewDetail, unknown>
    readonly getHostedReviewDiff: (
      review: HostedReviewLocator,
    ) => Effect.Effect<HostedReviewDiff, unknown>
    readonly getReviewDecision: (
      review: HostedReviewLocator,
    ) => Effect.Effect<import("@diffdash/domain/git-provider").ReviewDecision, unknown>
    readonly submitReviewDecision: (
      review: HostedReviewLocator,
      decision: import("@diffdash/domain/git-provider").ReviewDecision,
    ) => Effect.Effect<void, unknown>
    readonly hostedReviewCheckoutSpec: (
      review: HostedReviewLocator,
      revision: string,
    ) => Effect.Effect<HostedReviewCheckoutSpec, unknown>
    readonly bootstrapBareRepository: (
      repository: HostedRepositoryLocator,
      destination: string,
    ) => Effect.Effect<void, unknown>
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
            Effect.map((diagnostic) => diagnostic.available),
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
