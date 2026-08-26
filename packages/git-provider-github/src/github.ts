import { Deferred, Effect, Option, Predicate, Schema, Stream } from "effect"

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
  HostedReviewCheck,
  HostedReviewDetail,
  HostedReviewComment,
  HostedReviewLocator,
  HostedReviewMergeState,
  HostedReviewNumber,
  HostedReviewSummary,
  HostedReviewDiffSourceTarget,
  ProviderActor,
  ProviderRepositoryId,
  REVIEW_DIFF_MAX_CHUNK_BYTES,
  RepositoryComparisonRef,
  RepositoryNamespace,
  RepositoryRelativePath,
  ResolvedHostedRepository,
  ChangedFile,
  DiagnosticOperation,
  ReviewCommit,
  makeReviewKey,
  ReviewDiffAcquisition,
  ReviewDiffAvailabilityFailure,
  ReviewDiffByteCompletion,
  ReviewDiffGeneration,
  ReviewDiffGenerationTracker,
  ReviewDiffRevisionChanged,
  ReviewDiffSemanticIdentity,
  ReviewDiffSourceFacts,
  ReviewDiffSourceFailure,
  ReviewDiffSourceOffer,
  ReviewRevision,
  UnifiedBytesMethod,
  WebUrl,
  type DiffFileStatus,
  type GitProviderRegistration,
  type ReviewDiffByteChunk,
  type ReviewDiffSource,
  type ReviewDiffSourceError,
} from "@diffdash/git-provider"
import {
  ProcessExit,
  ProcessExitError,
  processRequest,
  type ProcessOutputPolicyInput,
  type ProcessRunner,
} from "@diffdash/process"

const GH_STREAM_MINIMUM_VERSION = [2, 7, 0] as const
const GH_STREAM_STDERR_BYTES = 256 * 1024

const GitHubOperation = Schema.Literals([
  "listAccessibleRepositories",
  "getReview",
  "listReviewChecks",
  "updateReviewBranch",
  "getReviewDecision",
  "resolveRepository",
  "searchRepositories",
  "listReviews",
  "getReviewDiff.metadata",
  "getReviewDiff.qualify",
  "getReviewDiff",
  "submitReviewDecision",
  "closeReview",
  "mergeReview",
  "repositoryUrl",
  "fileUrl",
  "bootstrapBareRepository",
  "checkoutSpec",
  "listSearchScopes.user",
  "listSearchScopes.orgs",
  "listAssignedReviews",
])
type GitHubOperation = typeof GitHubOperation.Type

const reviewSubmissionFlag = {
  approved: "--approve",
  changesRequested: "--request-changes",
  commented: "--comment",
} as const

const reviewMergeFlag = {
  merge: "--merge",
  squash: "--squash",
  rebase: "--rebase",
} as const

/** Configuration for one GitHub.com or GitHub Enterprise provider instance. */
export interface GitHubProviderConfig {
  readonly id?: string
  readonly host?: string
  readonly displayName?: string
  /** Qualified `gh` executable path; defaults to PATH discovery. */
  readonly executable?: string
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
  readonly resolveRepository: NonNullable<GitProviderRegistration["resolveRepository"]>
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
  readonly listReviewChecks: NonNullable<GitProviderRegistration["listReviewChecks"]>
  readonly updateReviewBranch: NonNullable<GitProviderRegistration["updateReviewBranch"]>
}

/** A typed failure for malformed GitHub CLI JSON output. */
export class GitHubCliParseError extends Schema.TaggedError<GitHubCliParseError>()(
  "GitHubCliParseError",
  {
    operation: GitHubOperation,
    output: Schema.String,
    cause: Schema.ErrorInstance(),
  },
) {}

const GhRepoOwnerJson = Schema.Union([
  Schema.String,
  Schema.Struct({ login: Schema.optional(Schema.String) }),
])
const GhRepoJson = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  nameWithOwner: Schema.optional(Schema.String),
  fullName: Schema.optional(Schema.String),
  owner: Schema.optional(GhRepoOwnerJson),
  url: Schema.optional(WebUrl),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  isPrivate: Schema.optional(Schema.Boolean),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
})
type GhRepoJson = typeof GhRepoJson.Type
const GhResolvedRepositoryJson = Schema.Struct({
  id: Schema.String,
  nameWithOwner: Schema.String,
  url: WebUrl,
})

const GhActorJson = Schema.Struct({ login: Schema.String })
const GhPullRequestJson = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.NullOr(GhActorJson),
  state: Schema.String,
  url: WebUrl,
  isDraft: Schema.Boolean,
  baseRefName: BranchRevision.fields.name,
  baseRefOid: Schema.optional(Schema.NullOr(ReviewRevision)),
  headRefName: BranchRevision.fields.name,
  headRefOid: Schema.optional(Schema.NullOr(ReviewRevision)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
})
type GhPullRequestJson = typeof GhPullRequestJson.Type

const GhPullRequestDetailJson = GhPullRequestJson.pipe(
  Schema.fieldsAssign({
    mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
    mergeStateStatus: Schema.Literals([
      "BEHIND",
      "BLOCKED",
      "CLEAN",
      "DIRTY",
      "DRAFT",
      "HAS_HOOKS",
      "UNKNOWN",
      "UNSTABLE",
    ]),
    files: Schema.Array(
      Schema.Struct({
        path: RepositoryRelativePath,
        additions: Schema.Number,
        deletions: Schema.Number,
        changeType: Schema.optional(Schema.String),
      }),
    ),
    commits: Schema.Array(
      Schema.Struct({
        oid: ReviewRevision,
        messageHeadline: Schema.String,
        authoredDate: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
    comments: Schema.optional(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            author: Schema.optional(
              Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) })),
            ),
            body: Schema.NullOr(Schema.String),
            createdAt: Schema.optional(Schema.NullOr(Schema.String)),
            url: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    ),
    reviews: Schema.optional(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            author: Schema.optional(
              Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) })),
            ),
            body: Schema.NullOr(Schema.String),
            submittedAt: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    ),
  }),
)
type GhPullRequestDetailJson = typeof GhPullRequestDetailJson.Type
const GhReviewCheckJson = Schema.Struct({
  bucket: Schema.Literals(["pass", "fail", "pending", "skipping", "cancel"]),
  completedAt: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.Unknown),
  event: Schema.optional(Schema.Unknown),
  link: Schema.String,
  name: Schema.String,
  startedAt: Schema.optional(Schema.Unknown),
  state: Schema.optional(Schema.Unknown),
  workflow: Schema.optional(Schema.Unknown),
})
type GhReviewCheckJson = typeof GhReviewCheckJson.Type

const GhViewerRepositoriesJson = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({
      repositories: Schema.Struct({ nodes: Schema.Array(Schema.NullOr(GhRepoJson)) }),
    }),
  }),
})
const GhSearchScopeJson = Schema.Struct({ login: Schema.String })
const GhDiffMetadataJson = Schema.Struct({
  headRefOid: Schema.optional(Schema.NullOr(ReviewRevision)),
})

const sourceFailure = (
  generation: ReviewDiffGeneration,
  message: string,
  cause?: unknown,
): ReviewDiffSourceFailure => {
  const taggedCause = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }))(cause),
  )
  const causeTag = taggedCause?.["_tag"]
  const fields = { generation, method: "unifiedBytes" as const, message }
  return causeTag === undefined
    ? ReviewDiffSourceFailure.make(fields)
    : ReviewDiffSourceFailure.make({ ...fields, causeTag })
}
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
const GhReviewRequestJson = GhPullRequestJson.pipe(
  Schema.fieldsAssign({
    repository: Schema.Struct({ name: Schema.String, owner: GhActorJson }),
  }),
)
const GhReviewRequestSearchJson = Schema.Struct({
  data: Schema.Struct({
    search: Schema.Struct({ nodes: Schema.Array(Schema.NullOr(GhReviewRequestJson)) }),
  }),
})

const decodeJson = <A, I>(operation: GitHubOperation, output: string, schema: Schema.Codec<A, I>) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(output).pipe(
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
const prDetailFields = [
  prListFields,
  "files",
  "commits",
  "comments",
  "reviews",
  "mergeable",
  "mergeStateStatus",
].join(",")
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
  (providerId: ReturnType<typeof GitProviderId.make>, operation: GitHubOperation) =>
  (cause: unknown) => {
    const stderr = Option.getOrNull(
      Schema.decodeUnknownOption(Schema.Struct({ stderr: Schema.String }))(cause),
    )?.stderr
    return GitProviderOperationError.make({
      providerId,
      operation: DiagnosticOperation.make(operation),
      message:
        stderr !== undefined && stderr.trim().length > 0
          ? stderr.trim()
          : Predicate.isError(cause) && cause.message.length > 0
            ? cause.message
            : `GitHub operation ${operation} failed`,
      cause: Schema.is(Schema.ErrorInstance())(cause) ? cause : new Error(String(cause)),
    })
  }

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

const actor = (login: string | undefined) =>
  ProviderActor.make({ id: null, username: login ?? "unknown", displayName: null, avatarUrl: null })

const normalizeChangeType = (changeType: string | undefined): DiffFileStatus => {
  switch (changeType?.toUpperCase()) {
    case "ADDED":
      return "added"
    case "DELETED":
    case "REMOVED":
      return "deleted"
    case "RENAMED":
      return "renamed"
    default:
      return "modified"
  }
}

const summary = (
  providerId: ReturnType<typeof GitProviderId.make>,
  namespace: string,
  name: string,
  pullRequest: GhPullRequestJson,
) =>
  HostedReviewSummary.make({
    locator: HostedReviewLocator.make({
      repository: locator(providerId, namespace, name),
      number: HostedReviewNumber.make(pullRequest.number),
    }),
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
      ChangedFile.make({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        changeType: normalizeChangeType(file.changeType),
      }),
    ),
    commits: pullRequest.commits.map((commit) =>
      ReviewCommit.make({
        revision: commit.oid,
        title: commit.messageHeadline,
        authoredAt: commit.authoredDate ?? null,
      }),
    ),
    comments: [
      ...(pullRequest.comments ?? []).map((comment) =>
        HostedReviewComment.make({
          author: actor(comment.author?.login),
          body: comment.body ?? "",
          createdAt: comment.createdAt ?? null,
          url:
            comment.url !== undefined && comment.url !== null && Schema.is(WebUrl)(comment.url)
              ? comment.url
              : null,
        }),
      ),
      ...(pullRequest.reviews ?? [])
        .filter((review) => review.body !== null && review.body.trim().length > 0)
        .map((review) =>
          HostedReviewComment.make({
            author: actor(review.author?.login),
            body: review.body ?? "",
            createdAt: review.submittedAt ?? null,
            url: null,
          }),
        ),
    ].sort((left, right) => {
      if (left.createdAt === null) return right.createdAt === null ? 0 : 1
      if (right.createdAt === null) return -1
      return left.createdAt.localeCompare(right.createdAt)
    }),
    mergeState: normalizeMergeState(pullRequest),
  })

const normalizeMergeState = (
  pullRequest: Pick<
    GhPullRequestDetailJson,
    "state" | "isDraft" | "mergeable" | "mergeStateStatus"
  >,
) => {
  if (
    pullRequest.isDraft ||
    pullRequest.state !== "OPEN" ||
    pullRequest.mergeStateStatus === "DRAFT"
  ) {
    return HostedReviewMergeState.make({
      status: "unavailable",
      reason: pullRequest.isDraft
        ? "Draft reviews cannot be merged."
        : "This review cannot be merged.",
    })
  }
  if (pullRequest.mergeable === "CONFLICTING" || pullRequest.mergeStateStatus === "DIRTY") {
    return HostedReviewMergeState.make({
      status: "conflicting",
      reason: "The review branch has merge conflicts.",
    })
  }
  if (pullRequest.mergeStateStatus === "BEHIND") {
    return HostedReviewMergeState.make({
      status: "behind",
      reason: "The review branch is behind the base branch.",
    })
  }
  if (pullRequest.mergeStateStatus === "BLOCKED") {
    return HostedReviewMergeState.make({
      status: "blocked",
      reason: "Repository rules currently block this merge.",
    })
  }
  if (
    pullRequest.mergeable === "MERGEABLE" &&
    (pullRequest.mergeStateStatus === "CLEAN" ||
      pullRequest.mergeStateStatus === "HAS_HOOKS" ||
      pullRequest.mergeStateStatus === "UNSTABLE")
  ) {
    return HostedReviewMergeState.make({
      status: "ready",
      reason: "This review is ready to merge.",
    })
  }
  return HostedReviewMergeState.make({
    status: "checking",
    reason: "Merge readiness is still being checked.",
  })
}

const nullableString = (value: unknown) =>
  Option.getOrNull(Schema.decodeUnknownOption(Schema.String)(value))

const nullableCheckTimestamp = (value: unknown) =>
  Option.getOrNull(Schema.decodeUnknownOption(HostedReviewCheck.fields.startedAt)(value))

const reviewCheck = (check: GhReviewCheckJson) =>
  HostedReviewCheck.make({
    status:
      check.bucket === "pass"
        ? "passed"
        : check.bucket === "fail"
          ? "failed"
          : check.bucket === "pending"
            ? "pending"
            : check.bucket === "skipping"
              ? "skipped"
              : "cancelled",
    name: check.name,
    workflow: nullableString(check.workflow),
    description: nullableString(check.description),
    startedAt: nullableCheckTimestamp(check.startedAt),
    completedAt: nullableCheckTimestamp(check.completedAt),
    detailsUrl: Schema.is(WebUrl)(check.link) ? check.link : null,
  })

const repository = (
  providerId: ReturnType<typeof GitProviderId.make>,
  host: string,
  operation: GitHubOperation,
  output: string,
  row: GhRepoJson,
) =>
  Effect.gen(function* () {
    const fullName = row.nameWithOwner ?? row.fullName ?? ""
    const segments = fullName.split("/").filter(Boolean)
    const fallbackName = segments.at(-1) ?? ""
    const fallbackNamespace = segments.slice(0, -1).join("/")
    const namespace = Schema.is(Schema.String)(row.owner)
      ? row.owner
      : (row.owner?.login ?? fallbackNamespace)
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
      url: row.url ?? WebUrl.make(`https://${host}/${namespace}/${name}`),
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

const readDiffMetadata = (
  processes: ProcessRunner,
  executable: string,
  host: string,
  review: HostedReviewLocator,
) => {
  const repo = repositoryArgument(host, review.repository.namespace, review.repository.name)
  return processes
    .run(
      processRequest(
        executable,
        ["pr", "view", String(review.number), "--repo", repo, "--json", "headRefOid"],
        { timeoutMs: 20_000 },
      ),
    )
    .pipe(
      Effect.flatMap((result) =>
        decodeJson("getReviewDiff.metadata", result.stdout, GhDiffMetadataJson),
      ),
      Effect.flatMap((metadata) =>
        metadata.headRefOid === null || metadata.headRefOid === undefined
          ? Effect.fail(new Error("GitHub pull request metadata omitted headRefOid"))
          : Effect.succeed(metadata.headRefOid),
      ),
    )
}

/** Opens a version-qualified, bounded raw-byte source for one GitHub pull request. */
export const createGitHubReviewDiffSource = Effect.fn("GitHub.createReviewDiffSource")(function* (
  config: GitHubProviderConfig,
  processes: ProcessRunner,
  review: HostedReviewLocator,
): Effect.fn.Return<ReviewDiffSource, GitProviderOperationError> {
  const host = normalizeHost(config.host)
  const providerId = GitProviderId.make(config.id ?? "github")
  const executable = config.executable ?? "gh"
  if (review.repository.providerId !== providerId) {
    return yield* GitProviderOperationError.make({
      providerId,
      operation: DiagnosticOperation.make("getReviewDiff"),
      message: `Repository belongs to ${review.repository.providerId}, not ${providerId}`,
    })
  }

  const qualify = (args: readonly string[]) =>
    processes
      .run(processRequest(executable, args, { timeoutMs: 5_000 }))
      .pipe(Effect.mapError(operationError(providerId, "getReviewDiff.qualify")))
  const versionOutput = yield* qualify(["--version"])
  const version = parseGitHubCliVersion(versionOutput.stdout)
  if (version === null || !versionAtLeast(version, GH_STREAM_MINIMUM_VERSION)) {
    return yield* GitProviderOperationError.make({
      providerId,
      operation: DiagnosticOperation.make("getReviewDiff.qualify"),
      message: "GitHub CLI does not meet the minimum streaming diff version (2.7.0)",
    })
  }
  const help = yield* qualify(["pr", "diff", "--help"])
  if (!/(?:^|\s)--color(?:[=\s]|$)/m.test(help.stdout)) {
    return yield* GitProviderOperationError.make({
      providerId,
      operation: DiagnosticOperation.make("getReviewDiff.qualify"),
      message: "GitHub CLI pr diff does not support explicit color disabling",
    })
  }

  const expectedRevision = yield* readDiffMetadata(processes, executable, host, review).pipe(
    Effect.mapError(operationError(providerId, "getReviewDiff.metadata")),
  )
  const cancellation = yield* Deferred.make<void>()
  const generations = new ReviewDiffGenerationTracker()
  const repo = repositoryArgument(host, review.repository.namespace, review.repository.name)
  const semanticIdentity = ReviewDiffSemanticIdentity.make(
    `github:gh-pr-diff:v1:${host}/${review.repository.namespace}/${review.repository.name}#${review.number}@${expectedRevision}`,
  )
  const offer = ReviewDiffSourceOffer.make({
    target: HostedReviewDiffSourceTarget.make({ review, reviewKey: makeReviewKey(review) }),
    expectedRevision,
    semanticIdentity,
    methods: [UnifiedBytesMethod.make({ maxChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES })],
    facts: ReviewDiffSourceFacts.make({
      origin: "remote",
      revisionKind: "mutable",
      reproducible: false,
      complete: true,
      declaredBytes: null,
    }),
  })

  const unifiedBytes = (acquisition: ReviewDiffAcquisition) => {
    let totalBytes = 0
    return Stream.unwrap(
      Effect.gen(function* () {
        yield* generations.begin(acquisition.generation)
        if (acquisition.expectedRevision !== expectedRevision) {
          return yield* ReviewDiffRevisionChanged.make({
            generation: acquisition.generation,
            method: "unifiedBytes",
            message: "GitHub review diff acquisition expected another revision",
            expectedRevision: acquisition.expectedRevision,
            actualRevision: expectedRevision,
          })
        }
        const before = yield* readDiffMetadata(processes, executable, host, review).pipe(
          Effect.mapError((cause) =>
            sourceFailure(
              acquisition.generation,
              "GitHub metadata-before verification failed",
              cause,
            ),
          ),
        )
        if (before !== expectedRevision) {
          return yield* ReviewDiffRevisionChanged.make({
            generation: acquisition.generation,
            method: "unifiedBytes",
            message: "GitHub review revision changed before byte acquisition",
            expectedRevision,
            actualRevision: before,
          })
        }

        return processes
          .streamBytes(
            processRequest(
              executable,
              ["pr", "diff", String(review.number), "--repo", repo, "--color", "never"],
              {
                timeoutMs: 10 * 60 * 1_000,
                env: { NO_COLOR: "1", CLICOLOR: "0", CLICOLOR_FORCE: "0", TERM: "dumb" },
                stdout: { maxBytes: 0, overflow: "truncate" },
                stderr: { maxBytes: GH_STREAM_STDERR_BYTES, overflow: "error" },
                maxByteChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES,
                maxBufferedBytes: 1024 * 1024,
                maxReservedBytes: 1024 * 1024,
              },
            ),
            { cancellation: Deferred.await(cancellation) },
          )
          .pipe(
            Stream.mapEffect(
              (
                event,
              ): Effect.Effect<
                ReviewDiffByteChunk | ReviewDiffByteCompletion,
                ReviewDiffRevisionChanged | ReviewDiffSourceFailure
              > => {
                if (!Schema.is(ProcessExit)(event)) {
                  totalBytes += event.bytes.byteLength
                  return Effect.succeed({ bytes: event.bytes })
                }
                return readDiffMetadata(processes, executable, host, review).pipe(
                  Effect.mapError((cause) =>
                    sourceFailure(
                      acquisition.generation,
                      "GitHub metadata-after verification failed",
                      cause,
                    ),
                  ),
                  Effect.flatMap((after) =>
                    after === expectedRevision
                      ? Effect.succeed(
                          ReviewDiffByteCompletion.make({
                            generation: acquisition.generation,
                            revision: expectedRevision,
                            semanticIdentity,
                            totalBytes,
                          }),
                        )
                      : ReviewDiffRevisionChanged.make({
                          generation: acquisition.generation,
                          method: "unifiedBytes",
                          message: "GitHub review revision changed during byte acquisition",
                          expectedRevision,
                          actualRevision: after,
                        }),
                  ),
                )
              },
            ),
            Stream.mapError(
              (cause): ReviewDiffSourceError =>
                Schema.is(ReviewDiffRevisionChanged)(cause) ||
                Schema.is(ReviewDiffAvailabilityFailure)(cause) ||
                Schema.is(ReviewDiffSourceFailure)(cause)
                  ? cause
                  : Schema.is(ProcessExitError)(cause)
                    ? classifyDiffAvailabilityFailure(acquisition.generation, cause)
                    : sourceFailure(acquisition.generation, "GitHub raw diff stream failed", cause),
            ),
          )
      }),
    )
  }

  return {
    offer,
    unifiedBytes,
    close: Deferred.succeed(cancellation, undefined).pipe(
      Effect.asVoid,
      Effect.mapError(() =>
        sourceFailure(ReviewDiffGeneration.make("source-close"), "GitHub source close failed"),
      ),
    ),
  }
})

const classifyDiffAvailabilityFailure = (
  generation: ReviewDiffGeneration,
  cause: ProcessExitError,
): ReviewDiffAvailabilityFailure | ReviewDiffSourceFailure => {
  const diagnostic = `${cause.stderr}\n${cause.message}`.toLowerCase()
  const availabilityFailure = (
    category: ReviewDiffAvailabilityFailure["category"],
    diagnosticCode?: string,
  ) => {
    const fields = {
      generation,
      method: "unifiedBytes" as const,
      message: "GitHub could not provide the complete generated review diff",
      category,
    }
    return diagnosticCode === undefined
      ? ReviewDiffAvailabilityFailure.make(fields)
      : ReviewDiffAvailabilityFailure.make({ ...fields, diagnosticCode })
  }
  if (
    /\b(?:http\s*)?406\b/.test(diagnostic) ||
    /diff.{0,32}(?:too large|exceeded)/.test(diagnostic)
  ) {
    return availabilityFailure("providerGenerationLimit", "http-406")
  }
  if (
    /\b(?:http\s*)?401\b/.test(diagnostic) ||
    /authentication required|not authenticated/.test(diagnostic)
  ) {
    return availabilityFailure("authenticationRequired", "http-401")
  }
  if (/\b(?:http\s*)?403\b/.test(diagnostic) || /permission denied|forbidden/.test(diagnostic)) {
    return availabilityFailure("authorizationRequired", "http-403")
  }
  if (/\b(?:http\s*)?50[0234]\b/.test(diagnostic)) {
    return availabilityFailure("transientProviderFailure", "http-5xx")
  }
  return sourceFailure(generation, "GitHub raw diff stream failed", cause)
}

/** Inspects installation, authentication, and repository-search support for one GitHub host. */
export const inspectGitHubCli = (
  processes: ProcessRunner,
  config: Pick<GitHubProviderConfig, "host" | "executable"> = {},
): Effect.Effect<GitHubCliInspection> => {
  const host = normalizeHost(config.host)
  const executable = config.executable ?? "gh"
  return processes.run(processRequest(executable, ["--version"], { timeoutMs: 5_000 })).pipe(
    Effect.flatMap((result) => {
      const version = parseGitHubCliVersion(result.stdout)
      return Effect.all(
        [
          processes
            .run(
              processRequest(executable, ["search", "repos", "--help", ...hostArgs(host)], {
                timeoutMs: 5_000,
              }),
            )
            .pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            ),
          processes
            .run(
              processRequest(executable, ["auth", "status", "--hostname", host], {
                timeoutMs: 10_000,
              }),
            )
            .pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
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
    Effect.catch(() =>
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
  processes: ProcessRunner,
): GitHubProviderRegistration => {
  const host = normalizeHost(config.host)
  const executable = config.executable ?? "gh"
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
      reviewClosure: true,
      reviewMerge: true,
      reviewMergeBypass: true,
      reviewChecks: true,
      reviewBranchUpdates: true,
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
  const run = (
    operation: GitHubOperation,
    args: readonly string[],
    timeoutMs = 20_000,
    stdout?: ProcessOutputPolicyInput,
  ) =>
    processes
      .run(
        processRequest(
          executable,
          args,
          stdout === undefined ? { timeoutMs } : { timeoutMs, stdout },
        ),
      )
      .pipe(Effect.mapError(operationError(providerId, operation)))
  const decode = <A, I>(operation: GitHubOperation, output: string, schema: Schema.Codec<A, I>) =>
    decodeJson(operation, output, schema).pipe(
      Effect.mapError(operationError(providerId, operation)),
    )
  const requireProvider = (
    repositoryLocator: HostedRepositoryLocator,
    operation: GitHubOperation,
  ) =>
    repositoryLocator.providerId === providerId
      ? Effect.succeed(repositoryLocator)
      : GitProviderOperationError.make({
          providerId,
          operation: DiagnosticOperation.make(operation),
          message: `Repository belongs to ${repositoryLocator.providerId}, not ${providerId}`,
        })
  const repositoryWebUrl = (repositoryLocator: HostedRepositoryLocator) => {
    const namespace = repositoryLocator.namespace.split("/").map(encodeURIComponent).join("/")
    return WebUrl.make(`https://${host}/${namespace}/${encodeURIComponent(repositoryLocator.name)}`)
  }

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
    return yield* Effect.forEach(
      response.data.viewer.repositories.nodes.filter(Predicate.isNotNullish),
      (row) =>
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

  const listReviewChecks = Effect.fn("GitHub.listReviewChecks")(function* (
    review: HostedReviewLocator,
  ) {
    yield* requireProvider(review.repository, "listReviewChecks")
    const args = [
      "pr",
      "checks",
      String(review.number),
      "--repo",
      repositoryArgument(host, review.repository.namespace, review.repository.name),
      "--json",
      "bucket,completedAt,description,event,link,name,startedAt,state,workflow",
    ]
    const output = yield* processes
      .run(processRequest(executable, args, { timeoutMs: 20_000 }))
      .pipe(
        Effect.map((result) => result.stdout),
        Effect.catch((cause) =>
          Schema.is(ProcessExitError)(cause) &&
          (cause.exitCode === 1 || cause.exitCode === 8) &&
          !cause.stdoutTruncated
            ? Effect.succeed(cause.stdout)
            : Effect.fail(cause),
        ),
        Effect.mapError(operationError(providerId, "listReviewChecks")),
      )
    const checks = yield* decode("listReviewChecks", output, Schema.Array(GhReviewCheckJson))
    return checks.map(reviewCheck)
  })

  const getReviewDiffSource = (review: HostedReviewLocator) =>
    createGitHubReviewDiffSource(config, processes, review)

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
    const state = reviews
      .filter(Predicate.isNotNullish)
      .find((item) => item.author?.login.toLowerCase() === viewer)?.state
    switch (state) {
      case "APPROVED":
        return "approved" as const
      case "CHANGES_REQUESTED":
        return "changesRequested" as const
      case "COMMENTED":
        return "commented" as const
      default:
        return "none" as const
    }
  })

  const checkoutSpec = Effect.fn("GitHub.checkoutSpec")(function* (
    review: HostedReviewLocator,
    revision: ReviewRevision,
  ) {
    yield* requireProvider(review.repository, "checkoutSpec")
    return HostedReviewCheckoutSpec.make({
      repository: review.repository,
      review,
      remoteUrl: `https://${host}/${review.repository.namespace}/${review.repository.name}.git`,
      fetchRef: RepositoryComparisonRef.make(`refs/pull/${review.number}/head`),
      revision,
    })
  })

  const registration: GitHubProviderRegistration = {
    descriptor,
    publishingTools: ["gh"],
    diagnose: inspectGitHubCli(processes, { host, executable }).pipe(
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
    resolveRepository: Effect.fn("GitHub.resolveRepository")(function* (repositoryLocator) {
      yield* requireProvider(repositoryLocator, "resolveRepository")
      const result = yield* run("resolveRepository", [
        "repo",
        "view",
        repositoryArgument(host, repositoryLocator.namespace, repositoryLocator.name),
        "--json",
        "id,nameWithOwner,url",
      ])
      const resolved = yield* decode("resolveRepository", result.stdout, GhResolvedRepositoryJson)
      const separator = resolved.nameWithOwner.lastIndexOf("/")
      if (separator <= 0 || separator === resolved.nameWithOwner.length - 1) {
        return yield* GitProviderOperationError.make({
          providerId,
          operation: DiagnosticOperation.make("resolveRepository"),
          message: "GitHub returned an invalid repository nameWithOwner",
        })
      }
      return ResolvedHostedRepository.make({
        locator: locator(
          providerId,
          resolved.nameWithOwner.slice(0, separator),
          resolved.nameWithOwner.slice(separator + 1),
        ),
        providerRepositoryId: ProviderRepositoryId.make(resolved.id),
        url: resolved.url,
      })
    }),
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
    listReviewChecks,
    updateReviewBranch: Effect.fn("GitHub.updateReviewBranch")(function* (review) {
      yield* requireProvider(review.repository, "updateReviewBranch")
      yield* run("updateReviewBranch", [
        "pr",
        "update-branch",
        String(review.number),
        "--repo",
        repositoryArgument(host, review.repository.namespace, review.repository.name),
      ])
      return undefined
    }),
    getReviewDiffSource,
    getReviewDecision,
    submitReviewDecision: Effect.fn("GitHub.submitReviewDecision")(function* (review, submission) {
      yield* requireProvider(review.repository, "submitReviewDecision")
      yield* run("submitReviewDecision", [
        "pr",
        "review",
        String(review.number),
        "--repo",
        repositoryArgument(host, review.repository.namespace, review.repository.name),
        reviewSubmissionFlag[submission.decision],
        "--body",
        submission.body,
      ])
      return undefined
    }),
    closeReview: Effect.fn("GitHub.closeReview")(function* (review) {
      yield* requireProvider(review.repository, "closeReview")
      yield* run("closeReview", [
        "pr",
        "close",
        String(review.number),
        "--repo",
        repositoryArgument(host, review.repository.namespace, review.repository.name),
      ])
      return undefined
    }),
    mergeReview: Effect.fn("GitHub.mergeReview")(
      function* (review, method, bypassRules, expectedHeadRevision) {
        yield* requireProvider(review.repository, "mergeReview")
        yield* run("mergeReview", [
          "pr",
          "merge",
          String(review.number),
          "--repo",
          repositoryArgument(host, review.repository.namespace, review.repository.name),
          reviewMergeFlag[method],
          "--match-head-commit",
          expectedHeadRevision,
          ...(bypassRules ? ["--admin"] : []),
        ])
        return undefined
      },
    ),
    repositoryUrl: (repositoryLocator) =>
      requireProvider(repositoryLocator, "repositoryUrl").pipe(
        Effect.as(repositoryWebUrl(repositoryLocator)),
      ),
    fileUrl: (repositoryLocator, path, revision) => {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/")
      return requireProvider(repositoryLocator, "fileUrl").pipe(
        Effect.as(
          WebUrl.make(
            `${repositoryWebUrl(repositoryLocator)}/blob/${encodeURIComponent(revision)}/${encodedPath}`,
          ),
        ),
      )
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
    checkoutSpec,
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
        .filter(Predicate.isNotNullish)
        .map((row) => summary(providerId, row.repository.owner.login, row.repository.name, row))
    }),
  }
  return registration
}
