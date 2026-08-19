/* oxlint-disable eslint/no-underscore-dangle -- Tests assert Effect-compatible _tag discriminants. */
import {
  BranchRevision,
  GitProviderCapabilities,
  GitProviderDescriptor,
  GitProviderId,
  GitProviderKind,
  GitProviderTerminology,
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
import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { projectReviewSelection, reviewSelectionSourceKeys } from "./review-selection"
import { RendererReview } from "./review-subject"

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
  fileCount: 0,
  detail: { summary },
})
const localTarget = workingTreeReviewTarget(RepositoryCheckoutPath.make("/workspace/diffdash"))
const localManifest = LocalReviewSnapshotManifest.make({
  projectId: ReviewProjectId.make("local:local/diffdash"),
  snapshotId: ReviewSnapshotId.make("snapshot:v1:11111111111111111111111111111111"),
  reviewKey: ReviewKey.make("local:/workspace/diffdash"),
  baseRevision: ReviewRevision.make("base"),
  headRevision: ReviewRevision.make("head"),
  fileCount: 0,
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

describe("review selection projection", () => {
  it("projects none, loading, and failure without consulting the inactive source", () => {
    expect(
      projectReviewSelection({
        target: null,
        hosted: { _tag: "failure", error: new Error("inactive") },
        local: { _tag: "failure", error: new Error("inactive") },
        providers: [provider],
      }),
    ).toEqual({ _tag: "none" })

    const loading = projectReviewSelection({
      target: { kind: "hosted", review: locator },
      hosted: { _tag: "loading" },
      local: { _tag: "failure", error: new Error("inactive") },
      providers: [provider],
    })
    expect(loading).toMatchObject({ _tag: "loading", status: "Opening PR #12..." })

    const failure = projectReviewSelection({
      target: { kind: "localDiff", target: localTarget },
      hosted: { _tag: "failure", error: new Error("inactive") },
      local: { _tag: "failure", error: new Error("Local snapshot unavailable") },
      providers: [provider],
    })
    expect(failure).toMatchObject({ _tag: "failure" })
    expect(failure._tag === "failure" ? failure.status : "").toContain("Local snapshot unavailable")
  })

  it("owns one source-tagged renderer review with its authoritative manifest", () => {
    const hosted = projectReviewSelection({
      target: { kind: "hosted", review: locator },
      hosted: { _tag: "ready", manifest: hostedManifest, refreshing: false },
      local: { _tag: "ready", manifest: localManifest, refreshing: false },
      providers: [provider],
    })
    expect(hosted).toMatchObject({
      _tag: "ready",
      review: {
        _tag: "hosted",
        baseRevision: "base",
        headRevision: "head",
        identity: "hosted:github:fungsi/diffdash#12",
        manifest: hostedManifest,
        provider,
        repositoryLabel: "fungsi/diffdash",
        title: "Normalize review selection",
      },
      status: "Opened PR #12: Normalize review selection",
    })

    const local = projectReviewSelection({
      target: { kind: "localDiff", target: localTarget },
      hosted: { _tag: "ready", manifest: hostedManifest, refreshing: false },
      local: { _tag: "ready", manifest: localManifest, refreshing: false },
      providers: [provider],
    })
    expect(local).toMatchObject({
      _tag: "ready",
      review: {
        _tag: "local",
        baseRevision: "base",
        headRevision: "head",
        manifest: localManifest,
        repositoryLabel: "/workspace/diffdash",
        title: "Local changes",
      },
      status: "Opened local changes in diffdash",
    })
  })

  it("sets exactly one source atom key", () => {
    expect(reviewSelectionSourceKeys({ kind: "hosted", review: locator })).toMatchObject({
      local: "",
    })
    expect(reviewSelectionSourceKeys({ kind: "localDiff", target: localTarget })).toMatchObject({
      hosted: "",
    })
  })

  it("rejects a renderer source tag paired with another source manifest", () => {
    const decoded = Schema.decodeUnknownResult(RendererReview)({
      _tag: "hosted",
      manifest: localManifest,
      provider: null,
    })

    expect(Result.isFailure(decoded)).toBe(true)
  })
})
