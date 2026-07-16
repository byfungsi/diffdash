import { Context, Effect, Layer, Schema } from "effect"

import {
  GitProviderId,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewLocator,
  HostedReviewNumber,
  RepositoryNamespace,
  type HostedReviewDetail,
  type HostedReviewDiff,
  type HostedReviewSummary,
} from "@diffdash/domain/git-provider"
import type { HostedReviewCheckoutSpec } from "@diffdash/git-provider"
import { createGitHubProvider } from "@diffdash/git-provider-github"
import { CliService } from "@diffdash/process/cli"
import {
  RepositorySearchRequest,
  RepositorySearchResult,
  RepositorySearchScope,
  type ProviderRepositoryReference,
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
  {
    remoteUrl: Schema.String,
  },
) {}

/** Provider-neutral source control and code-review operations used by the app. */
export class GitProvider extends Context.Tag("@diffdash/GitProvider")<
  GitProvider,
  {
    readonly parseRemoteUrl: (
      remoteUrl: string,
    ) => Effect.Effect<ProviderRepositoryReference, GitProviderRemoteParseError>
    readonly repositoryUrl: (owner: string, name: string) => string
    readonly fileUrl: (owner: string, name: string, filePath: string, ref: string) => string
    readonly searchRepositories: (
      request: RepositorySearchRequest,
    ) => Effect.Effect<readonly RepositorySearchResult[], unknown>
    readonly listSearchScopes: () => Effect.Effect<readonly RepositorySearchScope[], unknown>
    readonly listRepositories: () => Effect.Effect<readonly RepositorySearchResult[], unknown>
    readonly listPullRequests: (
      owner: string,
      name: string,
    ) => Effect.Effect<readonly PullRequestSummary[], unknown>
    readonly listReviewRequests: () => Effect.Effect<readonly PullRequestSummary[], unknown>
    readonly getPullRequestDetail: (
      owner: string,
      name: string,
      number: number,
    ) => Effect.Effect<PullRequestDetail, unknown>
    readonly refreshPullRequestDetail: (
      owner: string,
      name: string,
      number: number,
    ) => Effect.Effect<PullRequestDetail, unknown>
    readonly getPullRequestDiff: (
      owner: string,
      name: string,
      number: number,
    ) => Effect.Effect<PullRequestDiff, unknown>
    readonly hasApprovedPullRequest: (
      owner: string,
      name: string,
      number: number,
    ) => Effect.Effect<boolean, unknown>
    readonly approvePullRequest: (
      owner: string,
      name: string,
      number: number,
    ) => Effect.Effect<void, unknown>
    readonly hostedReviewCheckoutSpec: (
      owner: string,
      name: string,
      number: number,
      revision: string,
    ) => Effect.Effect<HostedReviewCheckoutSpec, unknown>
    readonly bootstrapBareRepository: (
      repository: HostedRepositoryLocator,
      destination: string,
    ) => Effect.Effect<void, unknown>
    readonly isAvailable: Effect.Effect<boolean>
  }
>() {
  /** GitHub.com compatibility layer while desktop transitions fully to the provider SDK. */
  static readonly layer = Layer.effect(
    GitProvider,
    Effect.gen(function* () {
      const cli = yield* CliService
      const github = createGitHubProvider({}, cli)

      return GitProvider.of({
        parseRemoteUrl: (remoteUrl) =>
          github.parseRemote(remoteUrl).pipe(
            Effect.flatMap((parsed) =>
              parsed === null
                ? GitProviderRemoteParseError.make({ remoteUrl })
                : Effect.succeed({
                    provider: parsed.providerId,
                    owner: parsed.namespace,
                    name: parsed.name,
                  }),
            ),
            Effect.mapError(() => GitProviderRemoteParseError.make({ remoteUrl })),
          ),
        repositoryUrl: (owner, name) => github.repositoryUrl(githubRepository(owner, name)),
        fileUrl: (owner, name, filePath, ref) =>
          github.fileUrl(githubRepository(owner, name), filePath, ref),
        searchRepositories: (request) => {
          if (request.query.trim().length === 0 || request.owners.length === 0)
            return Effect.succeed([])
          return github
            .searchRepositories({ query: request.query, namespaces: request.owners })
            .pipe(Effect.map((repositories) => repositories.map(toRepositorySearchResult)))
        },
        listSearchScopes: () =>
          github
            .listSearchScopes()
            .pipe(Effect.map((scopes) => scopes.map((scope) => RepositorySearchScope.make(scope)))),
        listRepositories: () =>
          github
            .listAccessibleRepositories()
            .pipe(Effect.map((repositories) => repositories.map(toRepositorySearchResult))),
        listPullRequests: (owner, name) =>
          github
            .listReviews(githubRepository(owner, name))
            .pipe(Effect.map((reviews) => reviews.map(toPullRequestSummary))),
        listReviewRequests: () =>
          github
            .listAssignedReviews()
            .pipe(Effect.map((reviews) => reviews.map(toPullRequestSummary))),
        getPullRequestDetail: (owner, name, number) =>
          github.getReview(githubReview(owner, name, number)).pipe(Effect.map(toPullRequestDetail)),
        refreshPullRequestDetail: (owner, name, number) =>
          github.getReview(githubReview(owner, name, number)).pipe(Effect.map(toPullRequestDetail)),
        getPullRequestDiff: (owner, name, number) =>
          github
            .getReviewDiff(githubReview(owner, name, number))
            .pipe(Effect.map(toPullRequestDiff)),
        hasApprovedPullRequest: (owner, name, number) =>
          github
            .getReviewDecision(githubReview(owner, name, number))
            .pipe(Effect.map((decision) => decision === "approved")),
        approvePullRequest: (owner, name, number) =>
          github.submitReviewDecision(githubReview(owner, name, number), "approved"),
        hostedReviewCheckoutSpec: (owner, name, number, revision) =>
          github.checkoutSpecAtRevision(githubReview(owner, name, number), revision),
        bootstrapBareRepository: github.bootstrapBareRepository,
        isAvailable: github.diagnose.pipe(
          Effect.map((diagnostic) => diagnostic.available),
          Effect.catchAll(() => Effect.succeed(false)),
        ),
      })
    }),
  )
}

const githubRepository = (owner: string, name: string) =>
  HostedRepositoryLocator.make({
    providerId: GitProviderId.make("github"),
    namespace: RepositoryNamespace.make(owner),
    name: HostedRepositoryName.make(name),
  })

const githubReview = (owner: string, name: string, number: number) =>
  HostedReviewLocator.make({
    repository: githubRepository(owner, name),
    number: HostedReviewNumber.make(number),
  })

const toRepositorySearchResult = (repository: {
  readonly locator: HostedRepositoryLocator
  readonly url: string
  readonly description: string | null
  readonly isPrivate: boolean
  readonly updatedAt: string | null
}) =>
  RepositorySearchResult.make({
    owner: repository.locator.namespace,
    name: repository.locator.name,
    nameWithOwner: `${repository.locator.namespace}/${repository.locator.name}`,
    url: repository.url,
    description: repository.description,
    isPrivate: repository.isPrivate,
    updatedAt: repository.updatedAt,
  })

const toPullRequestSummary = (review: HostedReviewSummary) =>
  PullRequestSummary.make({
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
    repoOwner: review.locator.repository.namespace,
    repoName: review.locator.repository.name,
    number: review.locator.number,
    headRefOid: review.headRevision,
    diff: review.diff,
    fetchedAt: review.fetchedAt,
  })
