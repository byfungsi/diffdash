import { Context, Effect, Layer, Schema } from "effect"

import {
  type GitProviderDescriptor,
  type GitProviderDiagnostic,
  type GitFileRevision,
  type GitProviderId,
  type HostedRepository,
  type HostedRepositoryLocator,
  ResolvedHostedRepository,
  type HostedReviewLocator,
  type HostedReviewDetail,
  type HostedReviewSummary,
} from "@diffdash/domain/git-provider"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import {
  GitProviderOperationError,
  DiagnosticOperation,
  GitProviderRegistry,
  type HostedReviewCheckoutSpec,
  type ReviewDiffSource,
  type UnknownGitProviderError,
} from "@diffdash/git-provider"
import { RepositorySearchScope, type RepositorySearchRequest } from "@diffdash/domain/repository"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { CoreWebUrl, type CoreAbsolutePath } from "../core-configuration"
import { CoreExpectedCause } from "../core-error-cause"

const ReviewContextOperation = Schema.Literals([
  "hosted.diff",
  "hosted.detailAfter",
  "hosted.snapshot",
  "local.snapshot",
])

type ReviewContextOperation = typeof ReviewContextOperation.Type

/** Bounded acquisition failure category safe to project across process boundaries. */
export const ReviewContextFailureCategory = Schema.Literals([
  "authenticationRequired",
  "authorizationRequired",
  "providerUnavailable",
  "reviewChanged",
  "fallbackFailed",
  "cacheFull",
  "contentTooLarge",
  "cancelled",
  "acquisitionFailed",
])

/** Bounded acquisition failure category safe to project across process boundaries. */
export type ReviewContextFailureCategory = typeof ReviewContextFailureCategory.Type

/** A typed failure to acquire one coherent review metadata and diff snapshot. */
export class ReviewContextError extends Schema.TaggedError<ReviewContextError>()(
  "ReviewContextError",
  {
    operation: ReviewContextOperation,
    category: ReviewContextFailureCategory,
    reason: Schema.String,
    cause: CoreExpectedCause,
  },
) {}

/** A typed failure for unsupported or malformed provider remote URLs. */
export class GitProviderRemoteParseError extends Schema.TaggedError<GitProviderRemoteParseError>()(
  "GitProviderRemoteParseError",
  { remoteUrl: Schema.String },
) {}

/** Expected failures from selecting or invoking one hosted Git provider. */
export type GitProviderCallError = UnknownGitProviderError | GitProviderOperationError

/** Provider-neutral hosted Git orchestration backed only by the provider registry. */
export class GitProvider extends Context.Service<
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
    ) => Effect.Effect<CoreWebUrl, GitProviderCallError>
    readonly fileUrl: (
      repository: HostedRepositoryLocator,
      filePath: RepositoryRelativePath,
      revision: GitFileRevision,
    ) => Effect.Effect<CoreWebUrl, GitProviderCallError>
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
    readonly getHostedReviewDetail: (
      review: HostedReviewLocator,
    ) => Effect.Effect<HostedReviewDetail, GitProviderCallError>
    readonly getReviewDiffSource: (
      review: HostedReviewLocator,
    ) => Effect.Effect<ReviewDiffSource, GitProviderCallError>
    readonly getReviewDecision: (
      review: HostedReviewLocator,
    ) => Effect.Effect<import("@diffdash/domain/git-provider").ReviewDecision, GitProviderCallError>
    readonly submitReviewDecision: (
      review: HostedReviewLocator,
      decision: import("@diffdash/domain/git-provider").ReviewDecision,
    ) => Effect.Effect<void, GitProviderCallError>
    readonly hostedReviewCheckoutSpec: (
      review: HostedReviewLocator,
      revision: ReviewRevision,
    ) => Effect.Effect<HostedReviewCheckoutSpec, GitProviderCallError>
    readonly bootstrapBareRepository: (
      repository: HostedRepositoryLocator,
      destination: CoreAbsolutePath,
    ) => Effect.Effect<void, GitProviderCallError>
    readonly isAvailable: (providerId: GitProviderId) => Effect.Effect<boolean>
  }
>()("@diffdash/GitProvider") {
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
                  Effect.catch((error) =>
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
        getHostedReviewDetail: (review) =>
          provider(review.repository.providerId).pipe(
            Effect.flatMap((registration) => registration.getReview(review)),
          ),
        getReviewDiffSource: (review) =>
          provider(review.repository.providerId).pipe(
            Effect.flatMap((registration) => registration.getReviewDiffSource(review)),
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
            Effect.flatMap((registration) => registration.checkoutSpec(review, revision)),
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
            Effect.catch(() => Effect.succeed(false)),
          ),
      })
    }),
  )
}

const unsupported = (
  providerId: GitProviderId,
  operation: "listAssignedReviews" | "listSearchScopes",
) =>
  GitProviderOperationError.make({
    providerId,
    operation: DiagnosticOperation.make(operation),
    message: `${operation} is not supported by this provider`,
  })
