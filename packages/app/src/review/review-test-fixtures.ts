import {
  BranchRevision,
  GitProviderCapabilities,
  GitProviderDescriptor,
  GitProviderId,
  GitProviderKind,
  GitProviderTerminology,
  HostedReviewDetail,
  HostedReviewSummary,
  makeHostedReviewLocator,
  ProviderActor,
} from "@diffdash/domain/git-provider"
import { LocalReviewDetail, workingTreeReviewTarget } from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import {
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
} from "@diffdash/domain/review-context"
import {
  ReviewDiffIdentity,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import { WebUrl } from "@diffdash/domain/web-url"

/** Creates coherent hosted and local manifests for app review unit tests. */
export const makeReviewSelectionFixtures = () => {
  const locator = makeHostedReviewLocator("github", "fungsi", "diffdash", 12)
  const summary = HostedReviewSummary.make({
    locator,
    author: ProviderActor.make({
      id: null,
      username: "reviewer",
      displayName: null,
      avatarUrl: null,
    }),
    base: BranchRevision.make({
      name: RepositoryComparisonRef.make("main"),
      revision: ReviewRevision.make("base"),
    }),
    body: "Review body",
    createdAt: "2026-07-19T00:00:00Z",
    decision: "none",
    head: BranchRevision.make({
      name: RepositoryComparisonRef.make("feature"),
      revision: ReviewRevision.make("head"),
    }),
    draft: false,
    state: "OPEN",
    title: "Normalize review selection",
    updatedAt: "2026-07-19T00:00:00Z",
    url: WebUrl.make("https://example.test/review/12"),
  })
  const hostedManifest = HostedReviewSnapshotManifest.make({
    projectId: ReviewProjectId.make("github:fungsi/diffdash"),
    snapshotId: ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000000"),
    reviewKey: ReviewKey.make("github:fungsi/diffdash#12"),
    baseRevision: ReviewRevision.make("base"),
    headRevision: ReviewRevision.make("head"),
    detail: HostedReviewDetail.make({ summary, commits: [], files: [] }),
    files: [],
  })
  const localTarget = workingTreeReviewTarget(RepositoryCheckoutPath.make("/workspace/diffdash"))
  const localManifest = LocalReviewSnapshotManifest.make({
    projectId: ReviewProjectId.make("local:local/diffdash"),
    snapshotId: ReviewSnapshotId.make("snapshot:v1:11111111111111111111111111111111"),
    reviewKey: ReviewKey.make("local:/workspace/diffdash"),
    baseRevision: ReviewRevision.make("base"),
    headRevision: ReviewRevision.make("head"),
    detail: LocalReviewDetail.make({
      rootPath: RepositoryCheckoutPath.make("/workspace/diffdash"),
      repoName: "diffdash",
      branchName: RepositoryComparisonRef.make("feature"),
      comparison: localTarget.comparison,
      baseSha: ReviewRevision.make("base"),
      headSha: ReviewRevision.make("head"),
      diffHash: ReviewDiffIdentity.make("diff"),
      title: "Local changes",
      files: [],
      fetchedAt: "2026-07-19T00:00:00Z",
    }),
    files: [],
  })
  const provider = GitProviderDescriptor.make({
    id: GitProviderId.make("github"),
    kind: GitProviderKind.make("github"),
    displayName: "GitHub",
    host: "github.com",
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
      reviewAbbreviation: "PR",
    }),
  })
  return { hostedManifest, localManifest, localTarget, locator, provider }
}
