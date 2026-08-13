import {
  HostedRepositorySource,
  makeHostedRepositoryLocator,
  makeHostedReviewLocator,
} from "@diffdash/domain/git-provider"
import { workingTreeReviewTarget } from "@diffdash/domain/local-review"
import { ProjectWorkspaceState } from "@diffdash/domain/project-workspace"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import {
  GitCommitSha,
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import { describe, expect, it } from "vitest"

import { resolveProjectWorkspaceState, selectedReviewTargetForPersistence } from "./workspace-state"

const repo = Repo.make({
  id: ReviewProjectId.make("github:fungsi/diffdash"),
  source: HostedRepositorySource.make({
    locator: makeHostedRepositoryLocator("github", "fungsi", "diffdash"),
  }),
  checkout: LinkedCheckout.make({
    remoteUrl: "https://github.com/fungsi/diffdash",
    path: RepositoryCheckoutPath.make("/workspace/diffdash"),
  }),
  isFavorite: true,
  lastOpenedAt: "2026-08-02T00:00:00.000Z",
  lastSyncedAt: null,
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
})

describe("project workspace state", () => {
  it("defaults a first open to Reviews without a selection", () => {
    expect(resolveProjectWorkspaceState(repo, null)).toEqual({
      activeRibbon: "reviews",
      notice: null,
      selectedReview: null,
    })
  })

  it("restores hosted and local targets losslessly", () => {
    const hosted = HostedReviewTarget.make({
      kind: "hosted",
      review: makeHostedReviewLocator("github", "fungsi", "diffdash", 51),
    })
    const local = workingTreeReviewTarget(RepositoryCheckoutPath.make("/workspace/diffdash"))

    expect(
      resolveProjectWorkspaceState(
        repo,
        ProjectWorkspaceState.make({
          projectId: repo.id,
          activeRibbon: "threads",
          selectedReviewTarget: hosted,
          updatedAt: "2026-08-02T00:00:00.000Z",
        }),
      ),
    ).toEqual({
      activeRibbon: "threads",
      notice: null,
      selectedReview: { kind: "hosted", review: hosted.review },
    })
    expect(selectedReviewTargetForPersistence({ kind: "localDiff", target: local })).toEqual(local)
  })

  it("rehydrates structural repository comparisons at the persistence boundary", () => {
    const target = {
      kind: "repositoryComparison" as const,
      repository: { ...makeHostedRepositoryLocator("github", "fungsi", "diffdash") },
      baseRef: RepositoryComparisonRef.make("v1.0.0"),
      headRef: RepositoryComparisonRef.make("v1.1.0"),
      baseSha: GitCommitSha.make("a".repeat(40)),
      headSha: GitCommitSha.make("b".repeat(40)),
      mergeBaseSha: GitCommitSha.make("c".repeat(40)),
    }

    const persisted = selectedReviewTargetForPersistence({
      kind: "repositoryComparison",
      target,
    })

    expect(persisted).toBeInstanceOf(RepositoryComparisonTarget)
    expect(persisted).toEqual(target)
  })

  it("falls back visibly for malformed, mismatched, and foreign targets", () => {
    const malformed = resolveProjectWorkspaceState(repo, { activeRibbon: "files" })
    const mismatched = resolveProjectWorkspaceState(
      repo,
      ProjectWorkspaceState.make({
        projectId: ReviewProjectId.make("github:other/project"),
        activeRibbon: "files",
        selectedReviewTarget: null,
        updatedAt: "2026-08-02T00:00:00.000Z",
      }),
    )
    const foreign = resolveProjectWorkspaceState(
      repo,
      ProjectWorkspaceState.make({
        projectId: repo.id,
        activeRibbon: "files",
        selectedReviewTarget: HostedReviewTarget.make({
          kind: "hosted",
          review: makeHostedReviewLocator("github", "other", "project", 1),
        }),
        updatedAt: "2026-08-02T00:00:00.000Z",
      }),
    )

    for (const resolved of [malformed, mismatched, foreign]) {
      expect(resolved.activeRibbon).toBe("reviews")
      expect(resolved.selectedReview).toBeNull()
      expect(resolved.notice).not.toBeNull()
    }
  })
})
