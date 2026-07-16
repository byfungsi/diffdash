import { Effect, Schema } from "effect"

import {
  BranchRevision,
  GitProviderCapabilities,
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitProviderId,
  GitProviderKind,
  GitProviderOperationError,
  GitProviderTerminology,
  HostedRepository,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewCheckoutSpec,
  HostedReviewDetail,
  HostedReviewDiff,
  HostedReviewLocator,
  HostedReviewNumber,
  HostedReviewSummary,
  ProviderActor,
  RepositoryNamespace,
  ReviewChangedFile,
  ReviewCommit,
  type GitProviderRegistration,
  type ReviewDecision,
} from "@diffdash/git-provider"
import type { CliRunner } from "@diffdash/process/cli"

/** Configuration for one GitHub.com or GitHub Enterprise provider instance. */
export interface GitHubProviderConfig {
  readonly id?: string
  readonly host?: string
  readonly displayName?: string
}

/** GitHub account or organization available as a repository search scope. */
export interface GitHubSearchScope {
  readonly login: string
  readonly kind: "user" | "organization"
}

/** Detailed GitHub CLI health used by application prerequisite diagnostics. */
export interface GitHubCliInspection {
  readonly installed: boolean
  readonly authenticated: boolean
  readonly searchRepositoriesAvailable: boolean
  readonly supported: boolean
  readonly version: string | null
}

/** GitHub provider extensions needed by the current desktop compatibility adapter. */
export interface GitHubProviderRegistration extends GitProviderRegistration {
  readonly listSearchScopes: () => Effect.Effect<
    readonly GitHubSearchScope[],
    GitProviderOperationError
  >
  readonly listAccessibleRepositories: () => Effect.Effect<
    readonly HostedRepository[],
    GitProviderOperationError
  >
  readonly listAssignedReviews: () => Effect.Effect<
    readonly HostedReviewSummary[],
    GitProviderOperationError
  >
  readonly checkoutSpecAtRevision: (
    review: HostedReviewLocator,
    revision: string,
  ) => Effect.Effect<HostedReviewCheckoutSpec, GitProviderOperationError>
}

/** A typed failure for malformed GitHub CLI JSON output. */
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

const GhActorJson = Schema.Struct({ login: Schema.String })
const GhPullRequestJson = Schema.Struct({
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
})
type GhPullRequestJson = typeof GhPullRequestJson.Type

const GhPullRequestDetailJson = Schema.extend(
  GhPullRequestJson,
  Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        additions: Schema.Number,
        deletions: Schema.Number,
        changeType: Schema.optional(Schema.String),
      }),
    ),
    commits: Schema.Array(
      Schema.Struct({
        oid: Schema.String,
        messageHeadline: Schema.String,
        authoredDate: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
)
type GhPullRequestDetailJson = typeof GhPullRequestDetailJson.Type

const GhViewerRepositoriesJson = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({
      repositories: Schema.Struct({ nodes: Schema.Array(Schema.NullOr(GhRepoJson)) }),
    }),
  }),
})
const GhSearchScopeJson = Schema.Struct({ login: Schema.String })
const GhDiffMetadataJson = Schema.Struct({
  headRefOid: Schema.optional(Schema.NullOr(Schema.String)),
})
const GhViewerApprovalJson = Schema.Struct({
  data: Schema.Struct({
    viewer: GhActorJson,
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            latestReviews: Schema.Struct({
              nodes: Schema.Array(
                Schema.NullOr(
                  Schema.Struct({ author: Schema.NullOr(GhActorJson), state: Schema.String }),
                ),
              ),
            }),
          }),
        ),
      }),
    ),
  }),
})
const GhReviewRequestJson = Schema.extend(
  GhPullRequestJson,
  Schema.Struct({
    repository: Schema.Struct({ name: Schema.String, owner: GhActorJson }),
  }),
)
const GhReviewRequestSearchJson = Schema.Struct({
  data: Schema.Struct({
    search: Schema.Struct({ nodes: Schema.Array(Schema.NullOr(GhReviewRequestJson)) }),
  }),
})

const decodeJson = <A, I>(operation: string, output: string, schema: Schema.Schema<A, I>) =>
  Schema.decodeUnknown(Schema.parseJson(schema))(output).pipe(
    Effect.mapError((cause) => GitHubCliParseError.make({ operation, output, cause })),
  )

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
const repositorySearchFields = "fullName,name,owner,url,description,isPrivate,updatedAt"

const accessibleRepositoriesQuery = `
query($first: Int!) {
  viewer {
    repositories(
      first: $first
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes { name nameWithOwner owner { login } url description isPrivate updatedAt }
    }
  }
}`
const reviewRequestsQuery = `
query($searchQuery: String!, $first: Int!) {
  search(type: ISSUE, query: $searchQuery, first: $first) {
    nodes {
      ... on PullRequest {
        number title body author { login } state url isDraft
        baseRefName baseRefOid headRefName headRefOid createdAt updatedAt
        repository { name owner { login } }
      }
    }
  }
}`
const viewerApprovalQuery = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      latestReviews(first: 100) { nodes { state author { login } } }
    }
  }
}`

const normalizeHost = (host = "github.com") =>
  host
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase()

const hostArgs = (host: string) => (host === "github.com" ? [] : ["--hostname", host])
const repositoryArgument = (host: string, namespace: string, name: string) =>
  host === "github.com" ? `${namespace}/${name}` : `${host}/${namespace}/${name}`

const operationError =
  (providerId: ReturnType<typeof GitProviderId.make>, operation: string) => (cause: unknown) =>
    GitProviderOperationError.make({
      providerId,
      operation,
      message:
        typeof cause === "object" &&
        cause !== null &&
        "stderr" in cause &&
        typeof cause.stderr === "string" &&
        cause.stderr.trim().length > 0
          ? cause.stderr.trim()
          : cause instanceof Error && cause.message.length > 0
            ? cause.message
            : `GitHub operation ${operation} failed`,
      cause,
    })

const locator = (
  providerId: ReturnType<typeof GitProviderId.make>,
  namespace: string,
  name: string,
) =>
  HostedRepositoryLocator.make({
    providerId,
    namespace: RepositoryNamespace.make(namespace),
    name: HostedRepositoryName.make(name),
  })

const reviewLocator = (repository: HostedRepositoryLocator, number: number) =>
  HostedReviewLocator.make({ repository, number: HostedReviewNumber.make(number) })

const actor = (login: string | undefined) =>
  ProviderActor.make({ id: null, username: login ?? "unknown", displayName: null, avatarUrl: null })

const summary = (
  providerId: ReturnType<typeof GitProviderId.make>,
  namespace: string,
  name: string,
  pullRequest: GhPullRequestJson,
) =>
  HostedReviewSummary.make({
    locator: reviewLocator(locator(providerId, namespace, name), pullRequest.number),
    title: pullRequest.title,
    body: pullRequest.body ?? null,
    author: actor(pullRequest.author?.login),
    state: pullRequest.state,
    decision: "none",
    url: pullRequest.url,
    draft: pullRequest.isDraft,
    base: BranchRevision.make({
      name: pullRequest.baseRefName,
      revision: pullRequest.baseRefOid ?? null,
    }),
    head: BranchRevision.make({
      name: pullRequest.headRefName,
      revision: pullRequest.headRefOid ?? null,
    }),
    createdAt: pullRequest.createdAt ?? null,
    updatedAt: pullRequest.updatedAt ?? null,
  })

const detail = (
  providerId: ReturnType<typeof GitProviderId.make>,
  namespace: string,
  name: string,
  pullRequest: GhPullRequestDetailJson,
) =>
  HostedReviewDetail.make({
    summary: summary(providerId, namespace, name, pullRequest),
    files: pullRequest.files.map((file) =>
      ReviewChangedFile.make({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.changeType ?? "modified",
      }),
    ),
    commits: pullRequest.commits.map((commit) =>
      ReviewCommit.make({
        revision: commit.oid,
        title: commit.messageHeadline,
        authoredAt: commit.authoredDate ?? null,
      }),
    ),
  })

const repository = (
  providerId: ReturnType<typeof GitProviderId.make>,
  host: string,
  operation: string,
  output: string,
  row: GhRepoJson,
) =>
  Effect.gen(function* () {
    const fullName = row.nameWithOwner ?? row.fullName ?? ""
    const segments = fullName.split("/").filter(Boolean)
    const fallbackName = segments.at(-1) ?? ""
    const fallbackNamespace = segments.slice(0, -1).join("/")
    const namespace =
      typeof row.owner === "string" ? row.owner : (row.owner?.login ?? fallbackNamespace)
    const name = row.name ?? fallbackName
    if (namespace.length === 0 || name.length === 0) {
      return yield* GitHubCliParseError.make({
        operation,
        output,
        cause: new Error("GitHub repository row is missing owner or name"),
      })
    }
    return HostedRepository.make({
      locator: locator(providerId, namespace, name),
      url: row.url ?? `https://${host}/${namespace}/${name}`,
      description: row.description ?? null,
      isPrivate: row.isPrivate ?? false,
      updatedAt: row.updatedAt ?? null,
    })
  })

/** Parses a GitHub remote for one configured host without accepting another host. */
export const parseGitHubRemote = (
  remoteUrl: string,
  config: Pick<GitHubProviderConfig, "id" | "host"> = {},
): HostedRepositoryLocator | null => {
  const host = normalizeHost(config.host)
  const providerId = GitProviderId.make(config.id ?? "github")
  const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match =
    new RegExp(`^git@${escapedHost}:([^/]+(?:/[^/]+)*)/([^/]+?)(?:\\.git)?$`, "i").exec(
      remoteUrl,
    ) ??
    new RegExp(`^https://${escapedHost}/([^/]+(?:/[^/]+)*)/([^/]+?)(?:\\.git)?/?$`, "i").exec(
      remoteUrl,
    ) ??
    new RegExp(`^ssh://git@${escapedHost}/([^/]+(?:/[^/]+)*)/([^/]+?)(?:\\.git)?/?$`, "i").exec(
      remoteUrl,
    )
  const namespace = match?.[1]
  const name = match?.[2]
  return namespace === undefined || name === undefined ? null : locator(providerId, namespace, name)
}

/** Parses the semantic version reported by `gh --version`. */
export const parseGitHubCliVersion = (output: string) => {
  const match = /\bgh version v?(\d+)\.(\d+)\.(\d+)\b/i.exec(output)
  if (match === null) return null
  const version = [Number(match[1]), Number(match[2]), Number(match[3])]
  return version.every(Number.isSafeInteger) ? version.join(".") : null
}

const versionAtLeast = (version: string, minimum: readonly number[]) => {
  const parts = version.split(".").map(Number)
  for (const [index, minimumPart] of minimum.entries()) {
    const part = parts[index] ?? 0
    if (part !== minimumPart) return part > minimumPart
  }
  return true
}

/** Inspects installation, authentication, and repository-search support for one GitHub host. */
export const inspectGitHubCli = (
  cli: CliRunner,
  config: Pick<GitHubProviderConfig, "host"> = {},
): Effect.Effect<GitHubCliInspection> => {
  const host = normalizeHost(config.host)
  return cli.run("gh", ["--version"], { timeoutMs: 5_000 }).pipe(
    Effect.flatMap((result) => {
      const version = parseGitHubCliVersion(result.stdout)
      return Effect.all(
        [
          cli
            .run("gh", ["search", "repos", "--help", ...hostArgs(host)], {
              timeoutMs: 5_000,
            })
            .pipe(
              Effect.as(true),
              Effect.catchAll(() => Effect.succeed(false)),
            ),
          cli.run("gh", ["auth", "status", "--hostname", host], { timeoutMs: 10_000 }).pipe(
            Effect.as(true),
            Effect.catchAll(() => Effect.succeed(false)),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(([searchRepositoriesAvailable, authenticated]) => ({
          installed: true,
          authenticated,
          searchRepositoriesAvailable,
          supported:
            version !== null && versionAtLeast(version, [2, 7, 0]) && searchRepositoriesAvailable,
          version,
        })),
      )
    }),
    Effect.catchAll(() =>
      Effect.succeed({
        installed: false,
        authenticated: false,
        searchRepositoriesAvailable: false,
        supported: false,
        version: null,
      }),
    ),
  )
}

/** Creates an SDK registration backed by the authenticated `gh` CLI. */
export const createGitHubProvider = (
  config: GitHubProviderConfig,
  cli: CliRunner,
): GitHubProviderRegistration => {
  const host = normalizeHost(config.host)
  const providerId = GitProviderId.make(config.id ?? "github")
  const descriptor = GitProviderDescriptor.make({
    id: providerId,
    kind: GitProviderKind.make("github"),
    displayName: config.displayName ?? (host === "github.com" ? "GitHub" : `GitHub (${host})`),
    host,
    capabilities: GitProviderCapabilities.make({
      repositorySearch: true,
      searchScopes: true,
      assignedReviews: true,
      reviewDecisions: true,
      fileUrls: true,
      remoteWorkspaceBootstrap: true,
    }),
    terminology: GitProviderTerminology.make({
      repositorySingular: "repository",
      repositoryPlural: "repositories",
      reviewSingular: "pull request",
      reviewPlural: "pull requests",
    }),
  })
  const run = (operation: string, args: readonly string[], timeoutMs = 20_000) =>
    cli.run("gh", args, { timeoutMs }).pipe(Effect.mapError(operationError(providerId, operation)))
  const decode = <A, I>(operation: string, output: string, schema: Schema.Schema<A, I>) =>
    decodeJson(operation, output, schema).pipe(
      Effect.mapError(operationError(providerId, operation)),
    )
  const requireProvider = (repositoryLocator: HostedRepositoryLocator, operation: string) =>
    repositoryLocator.providerId === providerId
      ? Effect.succeed(repositoryLocator)
      : GitProviderOperationError.make({
          providerId,
          operation,
          message: `Repository belongs to ${repositoryLocator.providerId}, not ${providerId}`,
        })

  const listAccessibleRepositories = Effect.fn("GitHub.listAccessibleRepositories")(function* () {
    const result = yield* run("listAccessibleRepositories", [
      "api",
      "graphql",
      ...hostArgs(host),
      "-f",
      `query=${accessibleRepositoriesQuery}`,
      "-F",
      "first=100",
    ])
    const response = yield* decode(
      "listAccessibleRepositories",
      result.stdout,
      GhViewerRepositoriesJson,
    )
    return yield* Effect.forEach(response.data.viewer.repositories.nodes.filter(isDefined), (row) =>
      repository(providerId, host, "listAccessibleRepositories", result.stdout, row).pipe(
        Effect.mapError(operationError(providerId, "listAccessibleRepositories")),
      ),
    )
  })

  const getReview = Effect.fn("GitHub.getReview")(function* (review: HostedReviewLocator) {
    yield* requireProvider(review.repository, "getReview")
    const result = yield* run("getReview", [
      "pr",
      "view",
      String(review.number),
      "--repo",
      repositoryArgument(host, review.repository.namespace, review.repository.name),
      "--json",
      prDetailFields,
    ])
    const value = yield* decode("getReview", result.stdout, GhPullRequestDetailJson)
    return detail(providerId, review.repository.namespace, review.repository.name, value)
  })

  const getReviewDecision = Effect.fn("GitHub.getReviewDecision")(function* (
    review: HostedReviewLocator,
  ) {
    yield* requireProvider(review.repository, "getReviewDecision")
    const result = yield* run("getReviewDecision", [
      "api",
      "graphql",
      ...hostArgs(host),
      "-f",
      `query=${viewerApprovalQuery}`,
      "-F",
      `owner=${review.repository.namespace}`,
      "-F",
      `name=${review.repository.name}`,
      "-F",
      `number=${review.number}`,
    ])
    const response = yield* decode("getReviewDecision", result.stdout, GhViewerApprovalJson)
    const viewer = response.data.viewer.login.toLowerCase()
    const reviews = response.data.repository?.pullRequest?.latestReviews.nodes ?? []
    return reviews
      .filter(isDefined)
      .some((item) => item.author?.login.toLowerCase() === viewer && item.state === "APPROVED")
      ? ("approved" as const)
      : ("none" as const)
  })

  const checkoutSpecAtRevision = Effect.fn("GitHub.checkoutSpecAtRevision")(function* (
    review: HostedReviewLocator,
    revision: string,
  ) {
    yield* requireProvider(review.repository, "checkoutSpecAtRevision")
    return HostedReviewCheckoutSpec.make({
      repository: review.repository,
      review,
      remoteUrl: `https://${host}/${review.repository.namespace}/${review.repository.name}.git`,
      fetchRef: `refs/pull/${review.number}/head`,
      revision,
    })
  })

  const registration: GitHubProviderRegistration = {
    descriptor,
    diagnose: inspectGitHubCli(cli, { host }).pipe(
      Effect.map((inspection) =>
        GitProviderDiagnostic.make({
          providerId,
          available: inspection.supported,
          authenticated: inspection.authenticated,
          message: inspection.supported
            ? null
            : inspection.installed
              ? "GitHub CLI is unavailable, unsupported, or missing repository search support."
              : "GitHub CLI was not found in PATH.",
        }),
      ),
    ),
    parseRemote: (remoteUrl) =>
      Effect.succeed(parseGitHubRemote(remoteUrl, { id: providerId, host })),
    searchRepositories: Effect.fn("GitHub.searchRepositories")(function* (input) {
      const query = input.query.trim()
      const namespaces = [...new Set(input.namespaces.map((value) => value.trim()).filter(Boolean))]
      if (query.length === 0) return yield* listAccessibleRepositories()
      if (namespaces.length === 0) return []
      const result = yield* run("searchRepositories", [
        "search",
        "repos",
        query,
        "--owner",
        namespaces.join(","),
        "--json",
        repositorySearchFields,
        "--limit",
        "30",
        ...hostArgs(host),
      ])
      const rows = yield* decode("searchRepositories", result.stdout, Schema.Array(GhRepoJson))
      return yield* Effect.forEach(rows, (row) =>
        repository(providerId, host, "searchRepositories", result.stdout, row).pipe(
          Effect.mapError(operationError(providerId, "searchRepositories")),
        ),
      )
    }),
    listReviews: Effect.fn("GitHub.listReviews")(function* (repositoryLocator) {
      yield* requireProvider(repositoryLocator, "listReviews")
      const result = yield* run("listReviews", [
        "pr",
        "list",
        "--repo",
        repositoryArgument(host, repositoryLocator.namespace, repositoryLocator.name),
        "--state",
        "open",
        "--json",
        prListFields,
        "--limit",
        "50",
      ])
      const rows = yield* decode("listReviews", result.stdout, Schema.Array(GhPullRequestJson))
      return rows.map((row) =>
        summary(providerId, repositoryLocator.namespace, repositoryLocator.name, row),
      )
    }),
    getReview,
    getReviewDiff: Effect.fn("GitHub.getReviewDiff")(function* (review) {
      yield* requireProvider(review.repository, "getReviewDiff")
      const repo = repositoryArgument(host, review.repository.namespace, review.repository.name)
      const metadataResult = yield* run("getReviewDiff.metadata", [
        "pr",
        "view",
        String(review.number),
        "--repo",
        repo,
        "--json",
        "headRefOid",
      ])
      const metadata = yield* decode(
        "getReviewDiff.metadata",
        metadataResult.stdout,
        GhDiffMetadataJson,
      )
      const diffResult = yield* run(
        "getReviewDiff",
        ["pr", "diff", String(review.number), "--repo", repo],
        60_000,
      )
      return HostedReviewDiff.make({
        locator: review,
        headRevision: metadata.headRefOid ?? null,
        diff: diffResult.stdout,
        fetchedAt: new Date().toISOString(),
      })
    }),
    getReviewDecision,
    submitReviewDecision: Effect.fn("GitHub.submitReviewDecision")(function* (review, decision) {
      yield* requireProvider(review.repository, "submitReviewDecision")
      if (decision !== "approved") {
        return yield* GitProviderOperationError.make({
          providerId,
          operation: "submitReviewDecision",
          message: `GitHub decision ${decision satisfies ReviewDecision} is not supported without a review body`,
        })
      }
      yield* run("submitReviewDecision", [
        "pr",
        "review",
        String(review.number),
        "--repo",
        repositoryArgument(host, review.repository.namespace, review.repository.name),
        "--approve",
      ])
    }),
    repositoryUrl: (repositoryLocator) => {
      const namespace = repositoryLocator.namespace.split("/").map(encodeURIComponent).join("/")
      return `https://${host}/${namespace}/${encodeURIComponent(repositoryLocator.name)}`
    },
    fileUrl: (repositoryLocator, path, revision) => {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/")
      return `${registration.repositoryUrl(repositoryLocator)}/blob/${encodeURIComponent(revision)}/${encodedPath}`
    },
    bootstrapBareRepository: Effect.fn("GitHub.bootstrapBareRepository")(
      function* (repositoryLocator, destination) {
        yield* requireProvider(repositoryLocator, "bootstrapBareRepository")
        yield* run(
          "bootstrapBareRepository",
          [
            "repo",
            "clone",
            repositoryArgument(host, repositoryLocator.namespace, repositoryLocator.name),
            destination,
            "--",
            "--bare",
          ],
          10 * 60 * 1_000,
        )
      },
    ),
    checkoutSpec: Effect.fn("GitHub.checkoutSpec")(function* (review) {
      const reviewDetail = yield* getReview(review)
      const revision = reviewDetail.summary.head.revision
      if (revision === null) {
        return yield* GitProviderOperationError.make({
          providerId,
          operation: "checkoutSpec",
          message: "GitHub pull request is missing its head revision",
        })
      }
      return yield* checkoutSpecAtRevision(review, revision)
    }),
    listSearchScopes: Effect.fn("GitHub.listSearchScopes")(function* () {
      const userResult = yield* run("listSearchScopes.user", ["api", "user", ...hostArgs(host)])
      const user = yield* decode("listSearchScopes.user", userResult.stdout, GhSearchScopeJson)
      const orgsResult = yield* run("listSearchScopes.orgs", [
        "api",
        "user/orgs",
        ...hostArgs(host),
      ])
      const orgs = yield* decode(
        "listSearchScopes.orgs",
        orgsResult.stdout,
        Schema.Array(GhSearchScopeJson),
      )
      const seen = new Set<string>()
      return [
        { login: user.login, kind: "user" as const },
        ...orgs.map(({ login }) => ({ login, kind: "organization" as const })),
      ].filter(({ login }) => {
        const key = login.trim().toLowerCase()
        if (key.length === 0 || seen.has(key)) return false
        seen.add(key)
        return true
      })
    }),
    listAccessibleRepositories,
    listAssignedReviews: Effect.fn("GitHub.listAssignedReviews")(function* () {
      const result = yield* run("listAssignedReviews", [
        "api",
        "graphql",
        ...hostArgs(host),
        "-f",
        `query=${reviewRequestsQuery}`,
        "-F",
        "searchQuery=type:pr state:open review-requested:@me",
        "-F",
        "first=20",
      ])
      const response = yield* decode(
        "listAssignedReviews",
        result.stdout,
        GhReviewRequestSearchJson,
      )
      return response.data.search.nodes
        .filter(isDefined)
        .map((row) => summary(providerId, row.repository.owner.login, row.repository.name, row))
    }),
    checkoutSpecAtRevision,
  }
  return registration
}

const isDefined = <A>(value: A | null | undefined): value is A =>
  value !== null && value !== undefined
