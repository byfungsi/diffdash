import {
  BranchRevision,
  ChangedFile,
  GitProviderCapabilities,
  GitProviderDescriptor,
  GitProviderId,
  GitProviderKind,
  GitProviderTerminology,
  HostedRepository,
  HostedReviewDetail,
  HostedReviewMergeState,
  HostedReviewSummary,
  ProviderActor,
  ProviderActorId,
  ReviewCommit,
  makeHostedRepositoryLocator,
  makeHostedReviewLocator,
} from "@diffdash/domain/git-provider"
import {
  GitCommitSha,
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import { WebUrl } from "@diffdash/domain/web-url"
import type { HostedRepositorySearchRequest } from "@diffdash/protocol/hosted-git"
import { Redacted, Schema } from "effect"

import type { GithubPersonalAccessToken } from "./github-credentials"

const NullableString = Schema.NullOr(Schema.String)
const GithubOwnerResponse = Schema.Struct({
  id: Schema.Number,
  login: Schema.String,
  avatar_url: Schema.String,
})
const GithubRepositoryResponse = Schema.Struct({
  name: Schema.String,
  full_name: Schema.String,
  html_url: Schema.String,
  description: NullableString,
  private: Schema.Boolean,
  updated_at: NullableString,
  owner: GithubOwnerResponse,
})
const GithubRepositorySearchResponse = Schema.Struct({
  items: Schema.Array(GithubRepositoryResponse),
})
const GithubBranchResponse = Schema.Struct({
  ref: Schema.String,
  sha: Schema.String,
})
const GithubPullRequestResponse = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: NullableString,
  state: Schema.String,
  html_url: Schema.String,
  draft: Schema.Boolean,
  created_at: NullableString,
  updated_at: NullableString,
  user: GithubOwnerResponse,
  base: GithubBranchResponse,
  head: GithubBranchResponse,
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergeable_state: Schema.optional(Schema.String),
  changed_files: Schema.optional(Schema.Int),
})
const GithubPullRequestListResponse = Schema.Array(GithubPullRequestResponse)
const GithubChangedFileResponse = Schema.Struct({
  filename: Schema.String,
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
})
const GithubChangedFilesResponse = Schema.Array(GithubChangedFileResponse)
const GithubCommitResponse = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({
    message: Schema.String,
    author: Schema.NullOr(Schema.Struct({ date: NullableString })),
  }),
})
const GithubCommitsResponse = Schema.Array(GithubCommitResponse)
const GithubViewerResponse = Schema.Struct({
  login: Schema.String,
  avatar_url: Schema.String,
})

const GithubCommitIdentityResponse = Schema.Struct({
  sha: GitCommitSha,
  parents: Schema.Array(Schema.Struct({ sha: GitCommitSha })),
})
const GithubComparisonIdentityResponse = Schema.Struct({
  merge_base_commit: Schema.Struct({ sha: GitCommitSha }),
})

type GithubViewer = typeof GithubViewerResponse.Type

/** Safe GitHub boundary failure that never carries request headers or response bodies. */
export class GithubRequestError extends Schema.TaggedError<GithubRequestError>()(
  "GithubRequestError",
  {
    code: Schema.Literals(["authentication", "authorization", "rateLimit", "network", "response"]),
    safeMessage: Schema.String,
    status: Schema.NullOr(Schema.Int),
  },
) {}

/** Read-only GitHub provider descriptor used to capability-gate the shared DiffDash UI. */
export const githubCloudProvider = GitProviderDescriptor.make({
  id: GitProviderId.make("github"),
  kind: GitProviderKind.make("github"),
  displayName: "GitHub",
  host: "github.com",
  capabilities: GitProviderCapabilities.make({
    repositorySearch: true,
    searchScopes: false,
    assignedReviews: false,
    reviewDecisions: false,
    reviewClosure: false,
    reviewMerge: false,
    reviewMergeBypass: false,
    reviewChecks: false,
    reviewBranchUpdates: false,
    fileUrls: true,
    remoteWorkspaceBootstrap: false,
  }),
  terminology: GitProviderTerminology.make({
    repositorySingular: "repository",
    repositoryPlural: "repositories",
    reviewSingular: "pull request",
    reviewPlural: "pull requests",
    reviewAbbreviation: "PR",
  }),
})

/** Browser-side GitHub REST client that unwraps its redacted PAT only for final network I/O. */
export class GithubClient {
  constructor(
    private readonly token: GithubPersonalAccessToken,
    private readonly request: typeof fetch = fetch,
  ) {}

  /** Returns the authenticated GitHub identity, proving that the supplied PAT is currently valid. */
  async getViewer(): Promise<GithubViewer> {
    return this.getJson("/user", GithubViewerResponse)
  }

  /** Resolves an exact repository without relying on search indexing or open PR lists. */
  async getRepository(namespace: string, name: string): Promise<HostedRepository> {
    return toHostedRepository(
      await this.getJson(
        `/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
        GithubRepositoryResponse,
      ),
    )
  }

  /** Resolves branch/tag inputs once, then determines the immutable three-dot merge base. */
  async resolveComparison(
    namespace: string,
    name: string,
    baseRef: RepositoryComparisonRef,
    headRef: RepositoryComparisonRef,
  ): Promise<RepositoryComparisonTarget> {
    const prefix = `/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`
    const [base, head] = await Promise.all([
      this.getJson(
        `${prefix}/commits/${encodeURIComponent(baseRef)}`,
        GithubCommitIdentityResponse,
      ),
      this.getJson(
        `${prefix}/commits/${encodeURIComponent(headRef)}`,
        GithubCommitIdentityResponse,
      ),
    ])
    const comparison = await this.getJson(
      `${prefix}/compare/${base.sha}...${head.sha}`,
      GithubComparisonIdentityResponse,
    )
    return RepositoryComparisonTarget.make({
      kind: "repositoryComparison",
      repository: makeHostedRepositoryLocator("github", namespace, name),
      baseRef,
      headRef,
      baseSha: base.sha,
      headSha: head.sha,
      mergeBaseSha: comparison.merge_base_commit.sha,
    })
  }

  /** Resolves a commit against its first parent, matching GitHub's single-commit review. */
  async resolveCommit(
    namespace: string,
    name: string,
    ref: RepositoryComparisonRef,
  ): Promise<RepositoryComparisonTarget> {
    const commit = await this.getJson(
      `/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(ref)}`,
      GithubCommitIdentityResponse,
    )
    const parent = commit.parents[0]
    if (parent === undefined)
      throw GithubRequestError.make({
        code: "response",
        status: null,
        safeMessage: "Root commit reviews are not supported yet because this commit has no parent.",
      })
    return RepositoryComparisonTarget.make({
      kind: "repositoryComparison",
      repository: makeHostedRepositoryLocator("github", namespace, name),
      baseRef: RepositoryComparisonRef.make(parent.sha),
      headRef: ref,
      baseSha: parent.sha,
      headSha: commit.sha,
      mergeBaseSha: parent.sha,
    })
  }

  /** Fetches a comparison using only resolved revisions, not potentially moving branch names. */
  async getComparisonDiff(target: RepositoryComparisonTarget): Promise<string> {
    const response = await this.send(
      `/repos/${encodeURIComponent(target.repository.namespace)}/${encodeURIComponent(target.repository.name)}/compare/${target.mergeBaseSha}...${target.headSha}`,
      "application/vnd.github.diff",
    )
    return response.text()
  }

  /** Searches repositories visible to the authenticated GitHub identity. */
  async searchRepositories(
    input: HostedRepositorySearchRequest,
  ): Promise<readonly HostedRepository[]> {
    const query = input.query.trim()
    if (query.length === 0) return []
    const owners = input.namespaces.map((namespace) => `user:${namespace}`).join(" ")
    const search = owners.length === 0 ? query : `${query} ${owners}`
    const response = await this.getJson(
      `/search/repositories?q=${encodeURIComponent(search)}&per_page=30`,
      GithubRepositorySearchResponse,
    )
    return response.items.map(toHostedRepository)
  }

  /** Lists open pull requests for one GitHub repository. */
  async listPullRequests(namespace: string, name: string): Promise<readonly HostedReviewSummary[]> {
    const response = await this.getJson(
      `/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/pulls?state=open&per_page=100`,
      GithubPullRequestListResponse,
    )
    return response.map((pullRequest) => toHostedReviewSummary(namespace, name, pullRequest))
  }

  /** Loads provider-neutral detail for one pull request. */
  async getPullRequestInventorySummary(namespace: string, name: string, number: number) {
    const response = await this.getJson(
      `/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/pulls/${number}`,
      GithubPullRequestResponse,
    )
    return {
      summary: toHostedReviewSummary(namespace, name, response),
      fileCount: response.changed_files,
    }
  }

  /** Loads provider-neutral detail for one pull request. */
  async getPullRequestDetail(
    namespace: string,
    name: string,
    number: number,
  ): Promise<HostedReviewDetail> {
    const prefix = `/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/pulls/${number}`
    const [pullRequest, files, commits] = await Promise.all([
      this.getJson(prefix, GithubPullRequestResponse),
      this.getJson(`${prefix}/files?per_page=100`, GithubChangedFilesResponse),
      this.getJson(`${prefix}/commits?per_page=100`, GithubCommitsResponse),
    ])
    return HostedReviewDetail.make({
      summary: toHostedReviewSummary(namespace, name, pullRequest),
      files: files.map((file) =>
        ChangedFile.make({
          path: RepositoryRelativePath.make(file.filename),
          additions: file.additions,
          deletions: file.deletions,
          changeType: githubFileStatus(file.status),
        }),
      ),
      commits: commits.map((commit) =>
        ReviewCommit.make({
          revision: ReviewRevision.make(commit.sha),
          title: commit.commit.message.split("\n", 1)[0] ?? commit.commit.message,
          authoredAt: commit.commit.author?.date ?? null,
        }),
      ),
      mergeState: githubMergeState(pullRequest),
    })
  }

  /** Fetches the provider's unified diff representation for one pull request. */
  async getPullRequestDiff(namespace: string, name: string, number: number): Promise<string> {
    return (await this.openPullRequestDiff(namespace, name, number)).text()
  }

  /** Opens a credential-isolated diff stream without buffering its body. */
  async openPullRequestDiff(namespace: string, name: string, number: number): Promise<Response> {
    try {
      const response = await this.send(
        `/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/pulls/${number}`,
        "application/vnd.github.diff",
      )
      return response
    } catch (cause) {
      if (!Schema.is(GithubRequestError)(cause) || cause.status !== 406) throw cause
    }
    const unavailable = () =>
      GithubRequestError.make({
        code: "response",
        status: 406,
        safeMessage:
          "GitHub rejected the full diff and a public patch is unavailable. Large private pull requests are not supported yet.",
      })
    const repository = await this.getJson(
      `/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
      GithubRepositoryResponse,
    )
    if (repository.private) throw unavailable()
    try {
      const request = this.request
      const response = await request(
        `/api/public-pull-diff/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${number}`,
        {
          credentials: "omit",
          referrerPolicy: "no-referrer",
        },
      )
      if (!response.ok || !response.headers.get("content-type")?.startsWith("text/plain")) {
        await response.body?.cancel()
        throw unavailable()
      }
      return response
    } catch {
      throw unavailable()
    }
  }

  private async getJson<Value, Encoded>(
    path: string,
    schema: Schema.Codec<Value, Encoded>,
  ): Promise<Value> {
    const response = await this.send(path, "application/vnd.github+json")
    try {
      return Schema.decodeUnknownSync(schema)(await response.json())
    } catch {
      throw GithubRequestError.make({
        code: "response",
        safeMessage: "GitHub returned data DiffDash could not read.",
        status: response.status,
      })
    }
  }

  private async send(path: string, accept: string): Promise<Response> {
    let response: Response
    try {
      // Native browser fetch must not receive the GithubClient instance as its receiver.
      const request = this.request
      response = await request(`https://api.github.com${path}`, {
        headers: {
          Accept: accept,
          Authorization: `Bearer ${Redacted.value(this.token)}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      })
    } catch {
      throw GithubRequestError.make({
        code: "network",
        safeMessage: "DiffDash could not reach GitHub.",
        status: null,
      })
    }
    if (response.ok) return response
    const rateLimited =
      response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0"
    throw GithubRequestError.make({
      code: rateLimited
        ? "rateLimit"
        : response.status === 401
          ? "authentication"
          : response.status === 403
            ? "authorization"
            : "response",
      safeMessage: rateLimited
        ? "GitHub's API rate limit has been reached. Try again after it resets."
        : response.status === 401
          ? "The GitHub token is invalid or has been revoked."
          : response.status === 403
            ? "The GitHub token cannot access this resource."
            : "GitHub could not complete the request.",
      status: response.status,
    })
  }
}

const toHostedRepository = (repository: typeof GithubRepositoryResponse.Type): HostedRepository =>
  HostedRepository.make({
    locator: makeHostedRepositoryLocator("github", repository.owner.login, repository.name),
    url: WebUrl.make(repository.html_url),
    description: repository.description,
    isPrivate: repository.private,
    updatedAt: repository.updated_at,
  })

const githubActor = (actor: typeof GithubOwnerResponse.Type): ProviderActor =>
  ProviderActor.make({
    id: ProviderActorId.make(String(actor.id)),
    username: actor.login,
    displayName: null,
    avatarUrl: WebUrl.make(actor.avatar_url),
  })

const toHostedReviewSummary = (
  namespace: string,
  name: string,
  pullRequest: typeof GithubPullRequestResponse.Type,
): HostedReviewSummary =>
  HostedReviewSummary.make({
    locator: makeHostedReviewLocator("github", namespace, name, pullRequest.number),
    title: pullRequest.title,
    body: pullRequest.body,
    author: githubActor(pullRequest.user),
    state: pullRequest.state,
    decision: "none",
    url: WebUrl.make(pullRequest.html_url),
    draft: pullRequest.draft,
    base: BranchRevision.make({
      name: RepositoryComparisonRef.make(pullRequest.base.ref),
      revision: ReviewRevision.make(pullRequest.base.sha),
    }),
    head: BranchRevision.make({
      name: RepositoryComparisonRef.make(pullRequest.head.ref),
      revision: ReviewRevision.make(pullRequest.head.sha),
    }),
    createdAt: pullRequest.created_at,
    updatedAt: pullRequest.updated_at,
  })

const githubFileStatus = (status: string): "added" | "deleted" | "modified" | "renamed" => {
  if (status === "added") return "added"
  if (status === "removed") return "deleted"
  if (status === "renamed") return "renamed"
  return "modified"
}

const githubMergeState = (
  pullRequest: typeof GithubPullRequestResponse.Type,
): HostedReviewMergeState => {
  if (pullRequest.mergeable === false) {
    return HostedReviewMergeState.make({
      status: "conflicting",
      reason: "GitHub reports merge conflicts.",
    })
  }
  if (pullRequest.mergeable === true) {
    return HostedReviewMergeState.make({
      status: "ready",
      reason: "GitHub reports this pull request as mergeable.",
    })
  }
  return HostedReviewMergeState.make({
    status: pullRequest.mergeable_state === "behind" ? "behind" : "checking",
    reason: "GitHub is still calculating merge readiness.",
  })
}
