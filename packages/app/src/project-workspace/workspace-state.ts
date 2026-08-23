import { makeHostedRepositoryLocator } from "@diffdash/domain/git-provider"
import {
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
  type ProjectWorkspaceActivityId,
  ProjectWorkspaceState,
  type ProjectWorkspaceSurface,
  resolveProjectWorkspaceActivity,
} from "@diffdash/domain/project-workspace"
import type { Repo } from "@diffdash/domain/repository"
import { RepositoryComparisonTarget } from "@diffdash/domain/repository-comparison"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import { Match, Result, Schema } from "effect"

import type { SelectedReviewTarget } from "@/review/review-subject"

/** Renderer workspace state after validating persisted data against its active project. */
export interface ResolvedProjectWorkspaceState {
  readonly activeSurface: ProjectWorkspaceSurface
  readonly activeActivity: ProjectWorkspaceActivityId
  readonly notice: string | null
  readonly selectedReview: SelectedReviewTarget | null
}

/** Converts renderer selection into the lossless persisted review-target representation. */
export const selectedReviewTargetForPersistence = (selection: SelectedReviewTarget | null) => {
  if (selection === null) return null
  if (selection.kind === "hosted") {
    return HostedReviewTarget.make({ kind: "hosted", review: selection.review })
  }
  return selection.kind === "repositoryComparison"
    ? RepositoryComparisonTarget.make({
        ...selection.target,
        repository: makeHostedRepositoryLocator(
          selection.target.repository.providerId,
          selection.target.repository.namespace,
          selection.target.repository.name,
        ),
      })
    : selection.target
}

/** Restores persisted state only when its project and selected target still match the repository. */
export const resolveProjectWorkspaceState = <Persisted>(
  repo: Repo,
  persisted: Persisted,
  availableActivityIds: readonly ProjectWorkspaceActivityId[],
): ResolvedProjectWorkspaceState => {
  if (persisted === null) return defaultProjectWorkspaceState(null)

  const decoded = Schema.decodeUnknownResult(ProjectWorkspaceState)(persisted)
  if (Result.isFailure(decoded)) {
    return defaultProjectWorkspaceState(
      "Saved workspace state was invalid. Reviews opened without a selected review.",
    )
  }

  const state = decoded.success
  if (state.projectId !== repo.id) {
    return defaultProjectWorkspaceState(
      "Saved workspace state belonged to another project. Reviews opened without a selected review.",
    )
  }

  const activityResolution = resolveProjectWorkspaceActivity(
    {
      activeSurface: state.activeSurface,
      activeActivity: state.activeActivity,
    },
    availableActivityIds,
  )
  const selection = activityResolution.selection
  const activityNotice = Match.valueTags(activityResolution, {
    available: () => null,
    repaired: () =>
      "The saved workspace activity is unavailable. A built-in activity was restored instead.",
    unresolved: () => "No activity is available for the saved workspace surface.",
  })

  const target = state.selectedReviewTarget
  if (target === null) {
    return { ...selection, notice: activityNotice, selectedReview: null }
  }

  if (target.kind === "hosted") {
    const belongsToProject = repo.matchesHosted(target.review.repository)
    return belongsToProject
      ? {
          ...selection,
          notice: activityNotice,
          selectedReview: { kind: "hosted", review: target.review },
        }
      : defaultProjectWorkspaceState(
          "The saved pull request no longer belongs to this project. Reviews opened without a selection.",
        )
  }

  if (target.kind === "repositoryComparison") {
    const belongsToProject = repo.matchesHosted(target.repository)
    return belongsToProject
      ? {
          ...selection,
          notice: activityNotice,
          selectedReview: { kind: "repositoryComparison", target },
        }
      : defaultProjectWorkspaceState(
          "The saved repository comparison no longer belongs to this project. Reviews opened without a selection.",
        )
  }

  return repo.localPath === target.rootPath
    ? {
        ...selection,
        notice: activityNotice,
        selectedReview: { kind: "localDiff", target },
      }
    : defaultProjectWorkspaceState(
        "The saved local review no longer belongs to this checkout. Reviews opened without a selection.",
      )
}

const defaultProjectWorkspaceState = (notice: string | null): ResolvedProjectWorkspaceState => ({
  activeSurface: "review",
  activeActivity: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
  notice,
  selectedReview: null,
})
