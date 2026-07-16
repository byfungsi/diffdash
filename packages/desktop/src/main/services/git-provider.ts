import { Context, Effect, Layer, Schema } from "effect"

import {
  type GitProviderDescriptor,
  type GitProviderDiagnostic,
  type GitProviderId,
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
import {
  RepositorySearchResult,
  RepositorySearchScope,
  type RepositorySearchRequest,
} from "@diffdash/domain/repository"
import {
  PullRequestCommit,
  PullRequestDetail,
  PullRequestDiff,
  PullRequestFile,
  PullRequestSummary,
  ReviewActor,
} from "@diffdash/domain/pull-request"

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
    ) => Effect.Effect<readonly RepositorySearchResult[], unknown>
    readonly listSearchScopes: (
      providerId: GitProviderId,
    ) => Effect.Effect<readonly RepositorySearchScope[], unknown>
    readonly listPullRequests: (
      repository: HostedRepositoryLocator,
    ) => Effect.Effect<readonly PullRequestSummary[], unknown>
    readonly listReviewRequests: (
      providerId: GitProviderId,
    ) => Effect.Effect<readonly PullRequestSummary[], unknown>
    readonly getPullRequestDetail: (
      review: HostedReviewLocator,
    ) => Effect.Effect<PullRequestDetail, unknown>
    readonly refreshPullRequestDetail: (
      review: HostedReviewLocator,
    ) => Effect.Effect<PullRequestDetail, unknown>
    readonly getPullRequestDiff: (
      review: HostedReviewLocator,
    ) => Effect.Effect<PullRequestDiff, unknown>
    readonly hasApprovedPullRequest: (
      review: HostedReviewLocator,
    ) => Effect.Effect<boolean, unknown>
    readonly approvePullRequest: (review: HostedReviewLocator) => Effect.Effect<void, unknown>
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
            Effect.map((registration) => registration.repositoryUrl(repository)),
          ),
        fileUrl: (repository, filePath, revision) =>
          provider(repository.providerId).pipe(
            Effect.map((registration) => registration.fileUrl(repository, filePath, revision)),
          ),
        searchRepositories: (request) =>
          provider(request.providerId).pipe(
            Effect.flatMap((registration) =>
              registration.searchRepositories({
                query: request.query,
                namespaces: request.owners,
              }),
            ),
            Effect.map((repositories) => repositories.map(toRepositorySearchResult)),
          ),
        listSearchScopes: (providerId) =>
          provider(providerId).pipe(
            Effect.flatMap(
              (registration) =>
                registration.listSearchScopes?.() ?? unsupported(providerId, "listSearchScopes"),
            ),
            Effect.map((scopes) => scopes.map((scope) => RepositorySearchScope.make(scope))),
          ),
        listPullRequests: (repository) =>
          provider(repository.providerId).pipe(
            Effect.flatMap((registration) => registration.listReviews(repository)),
            Effect.map((reviews) => reviews.map(toPullRequestSummary)),
          ),
        listReviewRequests: (providerId) =>
          provider(providerId).pipe(
            Effect.flatMap(
              (registration) =>
                registration.listAssignedReviews?.() ??
                unsupported(providerId, "listAssignedReviews"),
            ),
            Effect.map((reviews) => reviews.map(toPullRequestSummary)),
          ),
        getPullRequestDetail: (review) =>
          provider(review.repository.providerId).pipe(
            Effect.flatMap((registration) => registration.getReview(review)),
            Effect.map(toPullRequestDetail),
          ),
        refreshPullRequestDetail: (review) =>
          provider(review.repository.providerId).pipe(
            Effect.flatMap((registration) => registration.getReview(review)),
            Effect.map(toPullRequestDetail),
          ),
        getPullRequestDiff: (review) =>
          provider(review.repository.providerId).pipe(
            Effect.flatMap((registration) => registration.getReviewDiff(review)),
            Effect.map(toPullRequestDiff),
          ),
        hasApprovedPullRequest: (review) =>
          provider(review.repository.providerId).pipe(
            Effect.flatMap((registration) => registration.getReviewDecision(review)),
            Effect.map((decision) => decision === "approved"),
          ),
        approvePullRequest: (review) =>
          provider(review.repository.providerId).pipe(
            Effect.flatMap((registration) => registration.submitReviewDecision(review, "approved")),
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

const toRepositorySearchResult = (repository: {
  readonly locator: HostedRepositoryLocator
  readonly url: string
  readonly description: string | null
  readonly isPrivate: boolean
  readonly updatedAt: string | null
}) =>
  RepositorySearchResult.make({
    providerId: repository.locator.providerId,
    owner: repository.locator.namespace,
    name: repository.locator.name,
    nameWithOwner: `${repository.locator.namespace}/${repository.locator.name}`,
    url: repository.url,
    description: repository.description,
    isPrivate: repository.isPrivate,
    updatedAt: repository.updatedAt,
  })

const unsupported = (providerId: GitProviderId, operation: string) =>
  GitProviderOperationError.make({
    providerId,
    operation,
    message: `${operation} is not supported by this provider`,
  })

const toPullRequestSummary = (review: HostedReviewSummary) =>
  PullRequestSummary.make({
    providerId: review.locator.repository.providerId,
    repoOwner: review.locator.repository.namespace,
    repoName: review.locator.repository.name,
    number: review.locator.number,
    title: review.title,
    body: review.body,
    author: ReviewActor.make({ login: review.author.username }),
    state: review.state,
    url: review.url,
    isDraft: review.draft,
    baseRefName: review.base.name,
    baseRefOid: review.base.revision,
    headRefName: review.head.name,
    headRefOid: review.head.revision,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  })

const toPullRequestDetail = (review: HostedReviewDetail) => {
  const summary = toPullRequestSummary(review.summary)
  return PullRequestDetail.make({
    ...summary,
    files: review.files.map((file) => PullRequestFile.make(file)),
    commits: review.commits.map((commit) =>
      PullRequestCommit.make({
        oid: commit.revision,
        messageHeadline: commit.title,
        authoredDate: commit.authoredAt,
      }),
    ),
  })
}

const toPullRequestDiff = (review: HostedReviewDiff) =>
  PullRequestDiff.make({
    providerId: review.locator.repository.providerId,
    repoOwner: review.locator.repository.namespace,
    repoName: review.locator.repository.name,
    number: review.locator.number,
    headRefOid: review.headRevision,
    diff: review.diff,
    fetchedAt: review.fetchedAt,
  })
