import { makeHostedRepositoryLocator } from "@diffdash/domain/git-provider"
import type { ProjectWorkspaceRibbon } from "@diffdash/domain/project-workspace"
import { ProjectWorkspaceState } from "@diffdash/domain/project-workspace"
import type { Repo } from "@diffdash/domain/repository"
import { RepositoryComparisonTarget } from "@diffdash/domain/repository-comparison"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import { Result, Schema } from "effect"

import type { SelectedReviewTarget } from "@/review/review-subject"

/** Renderer workspace state after validating persisted data against its active project. */
export interface ResolvedProjectWorkspaceState {
  readonly activeRibbon: ProjectWorkspaceRibbon
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

  const target = state.selectedReviewTarget
  if (target === null) {
    return { activeRibbon: state.activeRibbon, notice: null, selectedReview: null }
  }

  if (target.kind === "hosted") {
    const belongsToProject = repo.matchesHosted(target.review.repository)
    return belongsToProject
      ? {
          activeRibbon: state.activeRibbon,
          notice: null,
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
          activeRibbon: state.activeRibbon,
          notice: null,
          selectedReview: { kind: "repositoryComparison", target },
        }
      : defaultProjectWorkspaceState(
          "The saved repository comparison no longer belongs to this project. Reviews opened without a selection.",
        )
  }

  return repo.localPath === target.rootPath
    ? {
        activeRibbon: state.activeRibbon,
        notice: null,
        selectedReview: { kind: "localDiff", target },
      }
    : defaultProjectWorkspaceState(
        "The saved local review no longer belongs to this checkout. Reviews opened without a selection.",
      )
}

const defaultProjectWorkspaceState = (notice: string | null): ResolvedProjectWorkspaceState => ({
  activeRibbon: "reviews",
  notice,
  selectedReview: null,
})
