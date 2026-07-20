import { Effect } from "effect"

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
  ChangedFile,
  ReviewCommit,
  sameHostedRepository,
  sameHostedReview,
  type GitProviderRegistration,
} from "@diffdash/git-provider"

/** Deterministic configuration for the non-GitHub provider used at provider boundaries and in E2E. */
export interface FixtureGitProviderConfig {
  readonly id?: string
  readonly host?: string
  readonly namespace?: string
  readonly repositoryName?: string
  readonly reviewNumber?: number
  readonly baseRevision?: string
  readonly headRevision?: string
  readonly remoteUrl?: string
  readonly bootstrapBareRepository?: (destination: string) => Effect.Effect<void, unknown>
}

/** Creates a complete second provider without importing desktop, renderer, protocol, or persistence code. */
export const createFixtureGitProvider = (
  config: FixtureGitProviderConfig = {},
): GitProviderRegistration => {
  const id = GitProviderId.make(config.id ?? "fixture")
  const host = config.host ?? "git.fixture.test"
  const namespace = RepositoryNamespace.make(config.namespace ?? "platform/backend")
  const name = HostedRepositoryName.make(config.repositoryName ?? "service")
  const reviewNumber = HostedReviewNumber.make(config.reviewNumber ?? 73)
  const baseRevision = config.baseRevision ?? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  const headRevision = config.headRevision ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  const repository = HostedRepositoryLocator.make({ providerId: id, namespace, name })
  const review = HostedReviewLocator.make({ repository, number: reviewNumber })
  const repositoryUrl = `https://${host}/${namespace}/${name}`
  const remoteUrl = config.remoteUrl ?? `${repositoryUrl}.git`
  const summary = HostedReviewSummary.make({
    locator: review,
    title: "Fixture merge request flow",
    body: "A deterministic non-GitHub hosted review.",
    author: ProviderActor.make({
      id: "fixture-user-1",
      username: "fixture-reviewer",
      displayName: "Fixture Reviewer",
      avatarUrl: null,
    }),
    state: "open",
    decision: "none",
    url: `${repositoryUrl}/merge-requests/${reviewNumber}`,
    draft: false,
    base: BranchRevision.make({ name: "main", revision: baseRevision }),
    head: BranchRevision.make({ name: "feature/fixture", revision: headRevision }),
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T01:00:00.000Z",
  })
  const requireRepository = (locator: HostedRepositoryLocator, operation: string) =>
    sameHostedRepository(locator, repository)
      ? Effect.void
      : GitProviderOperationError.make({
          providerId: id,
          operation,
          message: "Fixture repository locator does not match the configured repository",
        })
  const requireReview = (locator: HostedReviewLocator, operation: string) =>
    sameHostedReview(locator, review)
      ? Effect.void
      : GitProviderOperationError.make({
          providerId: id,
          operation,
          message: "Fixture review locator does not match the configured review",
        })

  return {
    publishingTools: ["fixture-forge"],
    descriptor: GitProviderDescriptor.make({
      id,
      kind: GitProviderKind.make("fixture"),
      displayName: "Fixture Forge",
      host,
      capabilities: GitProviderCapabilities.make({
        repositorySearch: true,
        searchScopes: false,
        assignedReviews: true,
        reviewDecisions: false,
        fileUrls: true,
        remoteWorkspaceBootstrap: true,
      }),
      terminology: GitProviderTerminology.make({
        repositorySingular: "project",
        repositoryPlural: "projects",
        reviewSingular: "merge request",
        reviewPlural: "merge requests",
        reviewAbbreviation: "MR",
      }),
    }),
    diagnose: Effect.succeed(
      GitProviderDiagnostic.make({
        providerId: id,
        available: true,
        authenticated: true,
        message: null,
      }),
    ),
    parseRemote: (candidate) =>
      Effect.succeed(candidate === remoteUrl || candidate === repositoryUrl ? repository : null),
    searchRepositories: () =>
      Effect.succeed([
        HostedRepository.make({
          locator: repository,
          url: repositoryUrl,
          description: "Fixture provider project",
          isPrivate: false,
          updatedAt: summary.updatedAt,
        }),
      ]),
    listAssignedReviews: () => Effect.succeed([summary]),
    listReviews: (locator) =>
      requireRepository(locator, "listReviews").pipe(Effect.as([summary] as const)),
    getReview: (locator) =>
      requireReview(locator, "getReview").pipe(
        Effect.as(
          HostedReviewDetail.make({
            summary,
            files: [
              ChangedFile.make({
                path: "src/fixture.ts",
                additions: 1,
                deletions: 1,
                changeType: "modified",
              }),
            ],
            commits: [
              ReviewCommit.make({
                revision: headRevision,
                title: "Exercise provider isolation",
                authoredAt: summary.updatedAt,
              }),
            ],
          }),
        ),
      ),
    getReviewDiff: (locator) =>
      requireReview(locator, "getReviewDiff").pipe(
        Effect.as(
          HostedReviewDiff.make({
            locator: review,
            headRevision,
            diff: [
              "diff --git a/src/fixture.ts b/src/fixture.ts",
              "index 1111111..2222222 100644",
              "--- a/src/fixture.ts",
              "+++ b/src/fixture.ts",
              "@@ -1 +1 @@",
              "-old fixture",
              "+new fixture",
            ].join("\n"),
            fetchedAt: "2026-07-16T01:00:00.000Z",
          }),
        ),
      ),
    getReviewDecision: (locator) =>
      requireReview(locator, "getReviewDecision").pipe(Effect.as("none" as const)),
    submitReviewDecision: () =>
      GitProviderOperationError.make({
        providerId: id,
        operation: "submitReviewDecision",
        message: "Fixture Forge does not support review decisions",
      }),
    repositoryUrl: (locator) =>
      requireRepository(locator, "repositoryUrl").pipe(Effect.as(repositoryUrl)),
    fileUrl: (locator, path, revision) =>
      requireRepository(locator, "fileUrl").pipe(
        Effect.as(
          `${repositoryUrl}/files/${encodeURIComponent(revision)}/${path
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`,
        ),
      ),
    bootstrapBareRepository: (locator, destination) =>
      requireRepository(locator, "bootstrapBareRepository").pipe(
        Effect.andThen(config.bootstrapBareRepository?.(destination) ?? Effect.void),
        Effect.mapError((cause) =>
          GitProviderOperationError.make({
            providerId: id,
            operation: "bootstrapBareRepository",
            message: "Fixture Forge could not bootstrap its repository",
            cause,
          }),
        ),
      ),
    checkoutSpec: (locator) =>
      requireReview(locator, "checkoutSpec").pipe(
        Effect.as(
          HostedReviewCheckoutSpec.make({
            repository,
            review,
            remoteUrl,
            fetchRef: `refs/merge-requests/${reviewNumber}/head`,
            revision: headRevision,
          }),
        ),
      ),
  }
}
