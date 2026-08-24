import {
  HostedRepositorySource,
  makeHostedRepositoryLocator,
  makeHostedReviewLocator,
} from "@diffdash/domain/git-provider"
import { workingTreeReviewTarget } from "@diffdash/domain/local-review"
import {
  PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
  PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
  PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID,
  ProjectWorkspaceState,
  REVIEW_COMMENTS_ACTIVITY_ID,
} from "@diffdash/domain/project-workspace"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import {
  GitCommitSha,
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import { Result } from "effect"
import { describe, expect, it } from "vitest"

import { TrustedExtensionRegistry } from "@/extensions/extension-registry"
import { coreWorkspaceExtension } from "@/extensions/core-workspace/core-workspace-extension"
import { reviewCommentsExtension } from "@/extensions/review-comments/review-comments-extension"
import {
  resolveProjectWorkspaceState as resolveWorkspaceState,
  selectedReviewTargetForPersistence,
} from "./workspace-state"

const availableActivityIds = [
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
  PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
  PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
  PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID,
  REVIEW_COMMENTS_ACTIVITY_ID,
]

const resolveProjectWorkspaceState = <Persisted>(repo: Repo, persisted: Persisted) =>
  resolveWorkspaceState(repo, persisted, availableActivityIds)

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
      activeSurface: "review",
      activeActivity: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
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
          activeSurface: "review",
          activeActivity: REVIEW_COMMENTS_ACTIVITY_ID,
          selectedReviewTarget: hosted,
          updatedAt: "2026-08-02T00:00:00.000Z",
        }),
      ),
    ).toEqual({
      activeSurface: "review",
      activeActivity: REVIEW_COMMENTS_ACTIVITY_ID,
      notice: null,
      selectedReview: { kind: "hosted", review: hosted.review },
    })
    expect(selectedReviewTargetForPersistence({ kind: "localDiff", target: local })).toEqual(local)
  })

  it("restores Code without requiring a selected review", () => {
    expect(
      resolveProjectWorkspaceState(
        repo,
        ProjectWorkspaceState.make({
          projectId: repo.id,
          activeSurface: "code",
          activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
          selectedReviewTarget: null,
          updatedAt: "2026-08-20T00:00:00.000Z",
        }),
      ),
    ).toEqual({
      activeSurface: "code",
      activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
      notice: null,
      selectedReview: null,
    })
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
    const malformed = resolveProjectWorkspaceState(repo, { activeActivity: "diffdash.core.files" })
    const mismatched = resolveProjectWorkspaceState(
      repo,
      ProjectWorkspaceState.make({
        projectId: ReviewProjectId.make("github:other/project"),
        activeSurface: "review",
        activeActivity: PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
        selectedReviewTarget: null,
        updatedAt: "2026-08-02T00:00:00.000Z",
      }),
    )
    const foreign = resolveProjectWorkspaceState(
      repo,
      ProjectWorkspaceState.make({
        projectId: repo.id,
        activeSurface: "review",
        activeActivity: PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
        selectedReviewTarget: HostedReviewTarget.make({
          kind: "hosted",
          review: makeHostedReviewLocator("github", "other", "project", 1),
        }),
        updatedAt: "2026-08-02T00:00:00.000Z",
      }),
    )

    for (const resolved of [malformed, mismatched, foreign]) {
      expect(resolved.activeSurface).toBe("review")
      expect(resolved.activeActivity).toBe(PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID)
      expect(resolved.selectedReview).toBeNull()
      expect(resolved.notice).not.toBeNull()
    }
  })

  it("repairs an unavailable extension activity without changing the source surface", () => {
    const resolved = resolveWorkspaceState(
      repo,
      ProjectWorkspaceState.make({
        projectId: repo.id,
        activeSurface: "code",
        activeActivity: REVIEW_COMMENTS_ACTIVITY_ID,
        selectedReviewTarget: null,
        updatedAt: "2026-08-20T00:00:00.000Z",
      }),
      [
        PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
        PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
        PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
        PROJECT_WORKSPACE_WALKTHROUGH_ACTIVITY_ID,
      ],
    )

    expect(resolved).toEqual({
      activeSurface: "code",
      activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
      notice:
        "The saved workspace activity is unavailable. A built-in activity was restored instead.",
      selectedReview: null,
    })
  })

  it("repairs an active disposed Comments contribution once without changing Code", () => {
    const registry = new TrustedExtensionRegistry()
    Result.getOrThrow(registry.register(coreWorkspaceExtension))
    const disposeComments = Result.getOrThrow(registry.register(reviewCommentsExtension))
    const persisted = ProjectWorkspaceState.make({
      projectId: repo.id,
      activeSurface: "code",
      activeActivity: REVIEW_COMMENTS_ACTIVITY_ID,
      selectedReviewTarget: null,
      updatedAt: "2026-08-20T00:00:00.000Z",
    })

    disposeComments()
    const repaired = resolveWorkspaceState(
      repo,
      persisted,
      registry.snapshot().projectActivities.map(({ id }) => id),
    )
    const restored = resolveWorkspaceState(
      repo,
      ProjectWorkspaceState.make({
        projectId: repo.id,
        activeSurface: repaired.activeSurface,
        activeActivity: repaired.activeActivity,
        selectedReviewTarget: null,
        updatedAt: "2026-08-20T00:00:01.000Z",
      }),
      registry.snapshot().projectActivities.map(({ id }) => id),
    )

    expect(repaired).toEqual({
      activeSurface: "code",
      activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
      notice:
        "The saved workspace activity is unavailable. A built-in activity was restored instead.",
      selectedReview: null,
    })
    expect(restored).toEqual({ ...repaired, notice: null })
  })
})
