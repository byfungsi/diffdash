import { Context, Effect, Schema } from "effect"

import type {
  ProviderRepositoryReference,
  PullRequestDetail,
  PullRequestDiff,
  PullRequestSummary,
  RepositorySearchResult,
  RepositorySearchScope,
} from "../../shared/domain"

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
      query: string,
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
    readonly isAvailable: Effect.Effect<boolean>
  }
>() {}
