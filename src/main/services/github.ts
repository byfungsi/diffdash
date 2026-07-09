import { Effect, Layer, Schema } from "effect"

import {
  PullRequestCommit,
  PullRequestDetail,
  PullRequestDiff,
  PullRequestFile,
  PullRequestSummary,
  RepositorySearchResult,
  RepositorySearchScope,
  ReviewActor,
} from "../../shared/domain"
import { CliService, type CliError, type CliResult, type CliRunOptions } from "./cli"
import { GitProvider, GitProviderRemoteParseError } from "./git-provider"

type CliRunner = {
  readonly run: (
    command: string,
    args: readonly string[],
    options?: CliRunOptions,
  ) => Effect.Effect<CliResult, CliError>
}

/** A typed failure for parsing GitHub CLI JSON output. */
export class GitHubCliParseError extends Schema.TaggedError<GitHubCliParseError>()(
  "GitHubCliParseError",
  {
    operation: Schema.String,
    output: Schema.String,
    cause: Schema.Defect,
  },
) {}

const GhRepoOwnerJson = Schema.Union(
  Schema.String,
  Schema.Struct({ login: Schema.optional(Schema.String) }),
)

const GhRepoJson = Schema.Struct({
  name: Schema.optional(Schema.String),
  nameWithOwner: Schema.optional(Schema.String),
  fullName: Schema.optional(Schema.String),
  owner: Schema.optional(GhRepoOwnerJson),
  url: Schema.optional(Schema.String),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  isPrivate: Schema.optional(Schema.Boolean),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
})
type GhRepoJson = typeof GhRepoJson.Type

const GhSearchScopeJson = Schema.Struct({
  login: Schema.String,
})

const GhViewerRepositoriesJson = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({
      repositories: Schema.Struct({
        nodes: Schema.Array(Schema.NullOr(GhRepoJson)),
      }),
    }),
  }),
})

const GhViewerRepositoriesJsonFromJson = Schema.parseJson(GhViewerRepositoriesJson)
const GhRepoJsonArrayFromJson = Schema.parseJson(Schema.Array(GhRepoJson))
const GhSearchScopeJsonFromJson = Schema.parseJson(GhSearchScopeJson)
const GhSearchScopeJsonArrayFromJson = Schema.parseJson(Schema.Array(GhSearchScopeJson))

const GhActorJson = Schema.Struct({
  login: Schema.String,
})

const GhPullRequestJson = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  author: GhActorJson,
  state: Schema.String,
  url: Schema.String,
  isDraft: Schema.Boolean,
  baseRefName: Schema.String,
  baseRefOid: Schema.optional(Schema.NullOr(Schema.String)),
  headRefName: Schema.String,
  headRefOid: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
})
type GhPullRequestJson = typeof GhPullRequestJson.Type

const GhPullRequestFileJson = Schema.Struct({
  path: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  changeType: Schema.optional(Schema.String),
})

const GhPullRequestCommitJson = Schema.Struct({
  oid: Schema.String,
  messageHeadline: Schema.String,
  authoredDate: Schema.optional(Schema.NullOr(Schema.String)),
})

const GhPullRequestDetailJson = Schema.extend(
  GhPullRequestJson,
  Schema.Struct({
    files: Schema.Array(GhPullRequestFileJson),
    commits: Schema.Array(GhPullRequestCommitJson),
  }),
)
type GhPullRequestDetailJson = typeof GhPullRequestDetailJson.Type

const GhPullRequestJsonArrayFromJson = Schema.parseJson(Schema.Array(GhPullRequestJson))
const GhPullRequestDetailJsonFromJson = Schema.parseJson(GhPullRequestDetailJson)

const GhPullRequestDiffMetadataJson = Schema.Struct({
  headRefOid: Schema.optional(Schema.NullOr(Schema.String)),
})

const GhPullRequestDiffMetadataJsonFromJson = Schema.parseJson(GhPullRequestDiffMetadataJson)

const GhPullRequestViewerReviewJson = Schema.Struct({
  author: Schema.NullOr(GhActorJson),
  state: Schema.String,
})

const GhPullRequestViewerApprovalJson = Schema.Struct({
  data: Schema.Struct({
    viewer: GhActorJson,
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            latestReviews: Schema.Struct({
              nodes: Schema.Array(Schema.NullOr(GhPullRequestViewerReviewJson)),
            }),
          }),
        ),
      }),
    ),
  }),
})

const GhPullRequestViewerApprovalJsonFromJson = Schema.parseJson(GhPullRequestViewerApprovalJson)

const GhReviewRequestPullRequestJson = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.NullOr(GhActorJson),
  state: Schema.String,
  url: Schema.String,
  isDraft: Schema.Boolean,
  baseRefName: Schema.String,
  baseRefOid: Schema.optional(Schema.NullOr(Schema.String)),
  headRefName: Schema.String,
  headRefOid: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  repository: Schema.Struct({
    name: Schema.String,
    owner: GhActorJson,
  }),
})
type GhReviewRequestPullRequestJson = typeof GhReviewRequestPullRequestJson.Type

const GhReviewRequestSearchJson = Schema.Struct({
  data: Schema.Struct({
    search: Schema.Struct({
      nodes: Schema.Array(Schema.NullOr(GhReviewRequestPullRequestJson)),
    }),
  }),
})

const GhReviewRequestSearchJsonFromJson = Schema.parseJson(GhReviewRequestSearchJson)

/** Git provider implementation backed by the authenticated `gh` CLI. */
export const GitHubProvider = {
  layer: Layer.effect(
    GitProvider,
    Effect.gen(function* () {
      const cli = yield* CliService
      const decodeViewerRepositories = (operation: string, output: string) =>
        Schema.decodeUnknown(GhViewerRepositoriesJsonFromJson)(output).pipe(
          Effect.map((response) => response.data.viewer.repositories.nodes.filter(isDefined)),
          Effect.flatMap((repos) =>
            Effect.forEach(repos, (repo) => toSearchResult(operation, output, repo)),
          ),
          Effect.mapError((cause) =>
            cause instanceof GitHubCliParseError
              ? cause
              : GitHubCliParseError.make({ operation, output, cause }),
          ),
        )
      const decodeRepositorySearch = (operation: string, output: string) =>
        Schema.decodeUnknown(GhRepoJsonArrayFromJson)(output).pipe(
          Effect.flatMap((repos) =>
            Effect.forEach(repos.filter(isDefined), (repo) =>
              toSearchResult(operation, output, repo),
            ),
          ),
          Effect.mapError((cause) =>
            cause instanceof GitHubCliParseError
              ? cause
              : GitHubCliParseError.make({ operation, output, cause }),
          ),
        )
      const decodeSearchScope = (operation: string, output: string) =>
        Schema.decodeUnknown(GhSearchScopeJsonFromJson)(output).pipe(
          Effect.map((scope) => scope.login),
          Effect.mapError((cause) => GitHubCliParseError.make({ operation, output, cause })),
        )
      const decodeSearchScopes = (operation: string, output: string) =>
        Schema.decodeUnknown(GhSearchScopeJsonArrayFromJson)(output).pipe(
          Effect.map((scopes) => scopes.map((scope) => scope.login)),
          Effect.mapError((cause) => GitHubCliParseError.make({ operation, output, cause })),
        )
      const decodePullRequests = (owner: string, name: string, operation: string, output: string) =>
        Schema.decodeUnknown(GhPullRequestJsonArrayFromJson)(output).pipe(
          Effect.map((prs) => prs.map((pr) => toPullRequestSummary(owner, name, pr))),
          Effect.mapError((cause) => GitHubCliParseError.make({ operation, output, cause })),
        )
      const decodePullRequestDetail = (
        owner: string,
        name: string,
        operation: string,
        output: string,
      ) =>
        Schema.decodeUnknown(GhPullRequestDetailJsonFromJson)(output).pipe(
          Effect.map((pr) => toPullRequestDetail(owner, name, pr)),
          Effect.mapError((cause) => GitHubCliParseError.make({ operation, output, cause })),
        )
      const decodePullRequestDiffMetadata = (operation: string, output: string) =>
        Schema.decodeUnknown(GhPullRequestDiffMetadataJsonFromJson)(output).pipe(
          Effect.mapError((cause) => GitHubCliParseError.make({ operation, output, cause })),
        )
      const decodePullRequestViewerApproval = (operation: string, output: string) =>
        Schema.decodeUnknown(GhPullRequestViewerApprovalJsonFromJson)(output).pipe(
          Effect.map((response) => {
            const viewerLogin = response.data.viewer.login.toLowerCase()
            const reviews = response.data.repository?.pullRequest?.latestReviews.nodes ?? []
            return reviews
              .filter(isDefined)
              .some(
                (review) =>
                  review.author?.login.toLowerCase() === viewerLogin && review.state === "APPROVED",
              )
          }),
          Effect.mapError((cause) => GitHubCliParseError.make({ operation, output, cause })),
        )
      const decodeReviewRequests = (operation: string, output: string) =>
        Schema.decodeUnknown(GhReviewRequestSearchJsonFromJson)(output).pipe(
          Effect.map((response) => response.data.search.nodes.filter(isDefined)),
          Effect.map((prs) => prs.map(toReviewRequestSummary)),
          Effect.mapError((cause) => GitHubCliParseError.make({ operation, output, cause })),
        )

      return GitProvider.of({
        parseRemoteUrl: parseGitHubRemote,
        repositoryUrl: (owner, name) => `https://github.com/${owner}/${name}`,
        fileUrl: githubFileUrl,
        isAvailable: cli.run("gh", ["--version"]).pipe(
          Effect.as(true),
          Effect.catchAll(() => Effect.succeed(false)),
        ),
        searchRepositories: Effect.fn("GitProvider.searchRepositories")(function (query) {
          const searchQuery = parseRepositorySearchQuery(query)
          if (searchQuery.owner !== null) {
            return searchRepositoriesByOwner(
              cli,
              "searchRepositories",
              searchQuery,
              decodeRepositorySearch,
            )
          }

          return listAccessibleRepositories(
            cli,
            "searchRepositories",
            decodeViewerRepositories,
          ).pipe(
            Effect.map((repos) =>
              searchQuery.term.length === 0
                ? []
                : repos.filter((repo) => matchesRepositoryQuery(repo, searchQuery)).slice(0, 30),
            ),
          )
        }),
        listSearchScopes: Effect.fn("GitProvider.listSearchScopes")(function () {
          return Effect.gen(function* () {
            const userResult = yield* cli.run("gh", ["api", "user"], { timeoutMs: 20_000 })
            const userLogin = yield* decodeSearchScope("listSearchScopes.user", userResult.stdout)
            const orgsResult = yield* cli.run("gh", ["api", "user/orgs"], { timeoutMs: 20_000 })
            const orgLogins = yield* decodeSearchScopes("listSearchScopes.orgs", orgsResult.stdout)

            return toSearchScopes(userLogin, orgLogins)
          })
        }),
        listRepositories: Effect.fn("GitProvider.listRepositories")(function () {
          return listAccessibleRepositories(cli, "listRepositories", decodeViewerRepositories)
        }),
        listPullRequests: Effect.fn("GitProvider.listPullRequests")(function (owner, name) {
          return cli
            .run(
              "gh",
              [
                "pr",
                "list",
                "--repo",
                `${owner}/${name}`,
                "--state",
                "open",
                "--json",
                prListFields,
                "--limit",
                "50",
              ],
              { timeoutMs: 20_000 },
            )
            .pipe(
              Effect.flatMap((result) =>
                decodePullRequests(owner, name, "listPullRequests", result.stdout),
              ),
            )
        }),
        listReviewRequests: Effect.fn("GitProvider.listReviewRequests")(function () {
          return cli
            .run(
              "gh",
              [
                "api",
                "graphql",
                "-f",
                `query=${reviewRequestsQuery}`,
                "-F",
                "searchQuery=type:pr state:open review-requested:@me",
                "-F",
                "first=20",
              ],
              { timeoutMs: 20_000 },
            )
            .pipe(
              Effect.flatMap((result) => decodeReviewRequests("listReviewRequests", result.stdout)),
            )
        }),
        getPullRequestDetail: Effect.fn("GitProvider.getPullRequestDetail")(
          function (owner, name, number) {
            return fetchPullRequestDetail(cli, owner, name, number, decodePullRequestDetail)
          },
        ),
        refreshPullRequestDetail: Effect.fn("GitProvider.refreshPullRequestDetail")(
          function (owner, name, number) {
            return fetchPullRequestDetail(cli, owner, name, number, decodePullRequestDetail)
          },
        ),
        getPullRequestDiff: Effect.fn("GitProvider.getPullRequestDiff")(
          function (owner, name, number) {
            return fetchPullRequestDiff(cli, owner, name, number, decodePullRequestDiffMetadata)
          },
        ),
        hasApprovedPullRequest: Effect.fn("GitProvider.hasApprovedPullRequest")(
          function (owner, name, number) {
            return fetchPullRequestViewerApproval(
              cli,
              owner,
              name,
              number,
              decodePullRequestViewerApproval,
            )
          },
        ),
        approvePullRequest: Effect.fn("GitProvider.approvePullRequest")(
          function (owner, name, number) {
            return cli
              .run(
                "gh",
                ["pr", "review", String(number), "--repo", `${owner}/${name}`, "--approve"],
                { timeoutMs: 20_000 },
              )
              .pipe(Effect.asVoid)
          },
        ),
      })
    }),
  ),
}

const prListFields = [
  "number",
  "title",
  "body",
  "author",
  "state",
  "url",
  "isDraft",
  "baseRefName",
  "baseRefOid",
  "headRefName",
  "headRefOid",
  "createdAt",
  "updatedAt",
].join(",")

const prDetailFields = [prListFields, "files", "commits"].join(",")

const accessibleRepositoriesQuery = `
query($first: Int!) {
  viewer {
    repositories(
      first: $first
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes {
        name
        nameWithOwner
        owner { login }
        url
        description
        isPrivate
        updatedAt
      }
    }
  }
}`

const reviewRequestsQuery = `
query($searchQuery: String!, $first: Int!) {
  search(type: ISSUE, query: $searchQuery, first: $first) {
    nodes {
      ... on PullRequest {
        number
        title
        body
        author { login }
        state
        url
        isDraft
        baseRefName
        baseRefOid
        headRefName
        headRefOid
        createdAt
        updatedAt
        repository {
          name
          owner { login }
        }
      }
    }
  }
}`

const pullRequestViewerApprovalQuery = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      latestReviews(first: 100) {
        nodes {
          state
          author { login }
        }
      }
    }
  }
}`

const listAccessibleRepositories = (
  cli: CliRunner,
  operation: string,
  decodeViewerRepositories: (
    operation: string,
    output: string,
  ) => Effect.Effect<readonly RepositorySearchResult[], GitHubCliParseError>,
) =>
  cli
    .run(
      "gh",
      ["api", "graphql", "-f", `query=${accessibleRepositoriesQuery}`, "-F", "first=100"],
      { timeoutMs: 20_000 },
    )
    .pipe(Effect.flatMap((result) => decodeViewerRepositories(operation, result.stdout)))

const repositorySearchFields = "fullName,name,owner,url,description,isPrivate,updatedAt"

/** Parse a GitHub remote URL into provider repository identity. */
export const parseGitHubRemote = (remoteUrl: string) =>
  Effect.gen(function* () {
    const match =
      remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/) ??
      remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/) ??
      remoteUrl.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/)

    if (match === null) {
      return yield* GitProviderRemoteParseError.make({ remoteUrl })
    }

    const owner = match[1]
    const name = match[2]

    if (owner === undefined || name === undefined) {
      return yield* GitProviderRemoteParseError.make({ remoteUrl })
    }

    return { provider: "github" as const, owner, name }
  })

const githubFileUrl = (owner: string, name: string, filePath: string, ref: string) => {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/")
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/blob/${encodeURIComponent(ref)}/${encodedPath}`
}

const searchRepositoriesByOwner = (
  cli: CliRunner,
  operation: string,
  query: ReturnType<typeof parseRepositorySearchQuery>,
  decodeRepositorySearch: (
    operation: string,
    output: string,
  ) => Effect.Effect<readonly RepositorySearchResult[], GitHubCliParseError>,
) => {
  if (query.term.length === 0) return Effect.succeed([] as readonly RepositorySearchResult[])

  return cli
    .run(
      "gh",
      [
        "search",
        "repos",
        query.term,
        "--owner",
        query.owner ?? "",
        "--json",
        repositorySearchFields,
        "--limit",
        "30",
      ],
      { timeoutMs: 20_000 },
    )
    .pipe(Effect.flatMap((result) => decodeRepositorySearch(operation, result.stdout)))
}

const parseRepositorySearchQuery = (query: string) => {
  const normalizedQuery = query.trim().toLowerCase()
  const ownerMatch = /(?:^|\s)(?:owner|org|user):([^\s]+)/.exec(normalizedQuery)
  const owner = ownerMatch?.[1] ?? null
  const term = normalizedQuery.replace(/(?:^|\s)(?:owner|org|user):[^\s]+/g, " ").trim()

  return { owner, term }
}

const matchesRepositoryQuery = (
  repo: RepositorySearchResult,
  query: ReturnType<typeof parseRepositorySearchQuery>,
) => {
  if (query.owner !== null && repo.owner.toLowerCase() !== query.owner) return false

  return (
    repo.nameWithOwner.toLowerCase().includes(query.term) ||
    repo.name.toLowerCase().includes(query.term) ||
    repo.owner.toLowerCase().includes(query.term) ||
    (repo.description?.toLowerCase().includes(query.term) ?? false)
  )
}

const fetchPullRequestDetail = (
  cli: CliRunner,
  owner: string,
  name: string,
  number: number,
  decodePullRequestDetail: (
    owner: string,
    name: string,
    operation: string,
    output: string,
  ) => Effect.Effect<PullRequestDetail, GitHubCliParseError>,
) =>
  cli
    .run(
      "gh",
      ["pr", "view", String(number), "--repo", `${owner}/${name}`, "--json", prDetailFields],
      { timeoutMs: 20_000 },
    )
    .pipe(
      Effect.flatMap((result) =>
        decodePullRequestDetail(owner, name, "getPullRequestDetail", result.stdout),
      ),
    )

const fetchPullRequestDiff = (
  cli: CliRunner,
  owner: string,
  name: string,
  number: number,
  decodePullRequestDiffMetadata: (
    operation: string,
    output: string,
  ) => Effect.Effect<typeof GhPullRequestDiffMetadataJson.Type, GitHubCliParseError>,
) =>
  Effect.gen(function* () {
    const metadataResult = yield* cli.run(
      "gh",
      ["pr", "view", String(number), "--repo", `${owner}/${name}`, "--json", "headRefOid"],
      { timeoutMs: 20_000 },
    )
    const metadata = yield* decodePullRequestDiffMetadata(
      "getPullRequestDiff.metadata",
      metadataResult.stdout,
    )
    const diffResult = yield* cli.run(
      "gh",
      ["pr", "diff", String(number), "--repo", `${owner}/${name}`],
      { timeoutMs: 60_000 },
    )

    return PullRequestDiff.make({
      repoOwner: owner,
      repoName: name,
      number,
      headRefOid: metadata.headRefOid ?? null,
      diff: diffResult.stdout,
      fetchedAt: new Date().toISOString(),
    })
  })

const fetchPullRequestViewerApproval = (
  cli: CliRunner,
  owner: string,
  name: string,
  number: number,
  decodePullRequestViewerApproval: (
    operation: string,
    output: string,
  ) => Effect.Effect<boolean, GitHubCliParseError>,
) =>
  cli
    .run(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query=${pullRequestViewerApprovalQuery}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${number}`,
      ],
      { timeoutMs: 20_000 },
    )
    .pipe(
      Effect.flatMap((result) =>
        decodePullRequestViewerApproval("hasApprovedPullRequest", result.stdout),
      ),
    )

const toSearchResult = (operation: string, output: string, repo: GhRepoJson) =>
  Effect.gen(function* () {
    const nameWithOwner = repo.nameWithOwner ?? repo.fullName ?? ""
    const [ownerFromFullName, nameFromFullName] = nameWithOwner.split("/")
    const owner =
      typeof repo.owner === "string" ? repo.owner : (repo.owner?.login ?? ownerFromFullName ?? "")
    const name = repo.name ?? nameFromFullName ?? ""

    if (owner.length === 0 || name.length === 0) {
      return yield* GitHubCliParseError.make({
        operation,
        output,
        cause: new Error("GitHub repository row is missing owner or name"),
      })
    }

    return RepositorySearchResult.make({
      owner,
      name,
      nameWithOwner: `${owner}/${name}`,
      url: repo.url ?? `https://github.com/${owner}/${name}`,
      description: repo.description ?? null,
      isPrivate: repo.isPrivate ?? false,
      updatedAt: repo.updatedAt ?? null,
    })
  })

const toSearchScopes = (userLogin: string, orgLogins: readonly string[]) => {
  const seen = new Set<string>()
  const scopes: RepositorySearchScope[] = []
  const addScope = (login: string, kind: RepositorySearchScope["kind"]) => {
    const normalizedLogin = login.trim()
    const dedupeKey = normalizedLogin.toLowerCase()
    if (normalizedLogin.length === 0 || seen.has(dedupeKey)) return

    seen.add(dedupeKey)
    scopes.push(RepositorySearchScope.make({ kind, login: normalizedLogin }))
  }

  addScope(userLogin, "user")
  for (const orgLogin of orgLogins) {
    addScope(orgLogin, "organization")
  }

  return scopes
}

const isDefined = <A>(value: A | null | undefined): value is A =>
  value !== null && value !== undefined

const toPullRequestSummary = (owner: string, name: string, pr: GhPullRequestJson) =>
  PullRequestSummary.make({
    repoOwner: owner,
    repoName: name,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? null,
    author: ReviewActor.make({ login: pr.author.login }),
    state: pr.state,
    url: pr.url,
    isDraft: pr.isDraft,
    baseRefName: pr.baseRefName,
    baseRefOid: pr.baseRefOid ?? null,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid ?? null,
    createdAt: pr.createdAt ?? null,
    updatedAt: pr.updatedAt ?? null,
  })

const toReviewRequestSummary = (pr: GhReviewRequestPullRequestJson) =>
  PullRequestSummary.make({
    repoOwner: pr.repository.owner.login,
    repoName: pr.repository.name,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? null,
    author: ReviewActor.make({ login: pr.author?.login ?? "unknown" }),
    state: pr.state,
    url: pr.url,
    isDraft: pr.isDraft,
    baseRefName: pr.baseRefName,
    baseRefOid: pr.baseRefOid ?? null,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid ?? null,
    createdAt: pr.createdAt ?? null,
    updatedAt: pr.updatedAt ?? null,
  })

const toPullRequestDetail = (owner: string, name: string, pr: GhPullRequestDetailJson) =>
  PullRequestDetail.make({
    repoOwner: owner,
    repoName: name,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? null,
    author: ReviewActor.make({ login: pr.author.login }),
    state: pr.state,
    url: pr.url,
    isDraft: pr.isDraft,
    baseRefName: pr.baseRefName,
    baseRefOid: pr.baseRefOid ?? null,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid ?? null,
    createdAt: pr.createdAt ?? null,
    updatedAt: pr.updatedAt ?? null,
    files: pr.files.map((file) =>
      PullRequestFile.make({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.changeType ?? "modified",
      }),
    ),
    commits: pr.commits.map((commit) =>
      PullRequestCommit.make({
        oid: commit.oid,
        messageHeadline: commit.messageHeadline,
        authoredDate: commit.authoredDate ?? null,
      }),
    ),
  })
