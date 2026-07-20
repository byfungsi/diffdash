/* oxlint-disable eslint/no-underscore-dangle -- Tests assert Effect-compatible _tag discriminants. */
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
import {
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
} from "@diffdash/domain/review-context"
import { ReviewKey, ReviewRevision, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import { describe, expect, it } from "vitest"
import { projectReviewSelection, reviewSelectionSourceKeys } from "./review-selection"

const locator = makeHostedReviewLocator("github", "fungsi", "diffdash", 12)
const summary = HostedReviewSummary.make({
  locator,
  author: ProviderActor.make({
    id: null,
    username: "reviewer",
    displayName: null,
    avatarUrl: null,
  }),
  base: BranchRevision.make({ name: "main", revision: "base" }),
  body: "Review body",
  createdAt: "2026-07-19T00:00:00Z",
  decision: "none",
  head: BranchRevision.make({ name: "feature", revision: "head" }),
  draft: false,
  state: "OPEN",
  title: "Normalize review selection",
  updatedAt: "2026-07-19T00:00:00Z",
  url: "https://example.test/review/12",
})
const hostedManifest = HostedReviewSnapshotManifest.make({
  snapshotId: ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000000"),
  reviewKey: ReviewKey.make("github:fungsi/diffdash#12"),
  baseRevision: ReviewRevision.make("base"),
  headRevision: ReviewRevision.make("head"),
  detail: HostedReviewDetail.make({ summary, commits: [], files: [] }),
  files: [],
})
const localTarget = workingTreeReviewTarget("/workspace/diffdash")
const localManifest = LocalReviewSnapshotManifest.make({
  snapshotId: ReviewSnapshotId.make("snapshot:v1:11111111111111111111111111111111"),
  reviewKey: ReviewKey.make("local:/workspace/diffdash"),
  baseRevision: ReviewRevision.make("base"),
  headRevision: ReviewRevision.make("head"),
  detail: LocalReviewDetail.make({
    rootPath: "/workspace/diffdash",
    repoName: "diffdash",
    branchName: "feature",
    comparison: localTarget.comparison,
    baseSha: "base",
    headSha: "head",
    diffHash: "diff",
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

  it("owns source key, normalized subject, provider, status, and inventory", () => {
    const hosted = projectReviewSelection({
      target: { kind: "hosted", review: locator },
      hosted: { _tag: "ready", manifest: hostedManifest, refreshing: false },
      local: { _tag: "ready", manifest: localManifest, refreshing: false },
      providers: [provider],
    })
    expect(hosted).toMatchObject({
      _tag: "ready",
      source: { _tag: "hosted", provider },
      subject: { kind: "hosted" },
      status: "Opened PR #12: Normalize review selection",
      inventory: [],
    })

    const local = projectReviewSelection({
      target: { kind: "localDiff", target: localTarget },
      hosted: { _tag: "ready", manifest: hostedManifest, refreshing: false },
      local: { _tag: "ready", manifest: localManifest, refreshing: false },
      providers: [provider],
    })
    expect(local).toMatchObject({
      _tag: "ready",
      source: { _tag: "local" },
      subject: { kind: "localDiff" },
      status: "No local changes in diffdash",
      inventory: [],
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
})
