/* oxlint-disable eslint/no-underscore-dangle -- Protocol unions use Effect-compatible _tag discriminants. */
import {
  makeHostedReviewLocator,
  type HostedRepositoryLocator,
} from "@diffdash/domain/git-provider"
import { workingTreeReviewTarget, type LocalReviewTarget } from "@diffdash/domain/local-review"
import type {
  ProjectOpenResult,
  ProjectRemoteSelectionRequired,
  ProjectWorkspaceActivityId,
  ProjectWorkspaceState,
  ProjectWorkspaceStateInput,
  ProjectWorkspaceSurface,
} from "@diffdash/domain/project-workspace"
import {
  PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
  ProjectWorkspaceStateInput as ProjectWorkspaceStateInputSchema,
} from "@diffdash/domain/project-workspace"
import type { Repo } from "@diffdash/domain/repository"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import type { OpenRepositoryComparisonCommand } from "@diffdash/protocol/cli-navigation"
import type { ResolvedRepositoryComparison } from "@diffdash/protocol/review-snapshot"
import { Match, Option } from "effect"

import {
  resolveProjectWorkspaceState,
  selectedReviewTargetForPersistence,
} from "@/project-workspace/workspace-state"
import type { SelectedReviewTarget } from "@/review/review-subject"

/** User intent retained while a local checkout requires hosted-remote disambiguation. */
export type ProjectOpenIntent =
  | { readonly kind: "reviews" }
  | { readonly kind: "workingTree" }
  | { readonly kind: "pullRequest"; readonly number: number }
  | { readonly kind: "branchDiff"; readonly branchName: string | null }
  | { readonly kind: "lastCommit" }

/** React-independent project state produced by session orchestration. */
export type ProjectSessionProjection = {
  readonly repo: Repo
  readonly activeSurface: ProjectWorkspaceSurface
  readonly activeActivity: ProjectWorkspaceActivityId
  readonly selectedReview: SelectedReviewTarget | null
  readonly notice: string | null
}

/** Continuation retained when opening a checkout requires remote selection. */
export type PendingProjectRemoteSelection = {
  readonly intent: ProjectOpenIntent
  readonly selection: ProjectRemoteSelectionRequired
}

type OpenedProjectSession = {
  readonly _tag: "opened"
  readonly projection: ProjectSessionProjection
  readonly persistence: Promise<void>
  readonly reviewType: "pull_request" | "local_diff" | null
}

/** Result of opening a local checkout through the project session. */
export type ProjectSessionOpenResult =
  | OpenedProjectSession
  | { readonly _tag: "remoteSelectionRequired"; readonly pending: PendingProjectRemoteSelection }

/** Result of restoring persisted state, including explicit stale-completion rejection. */
export type ProjectSessionRestoreResult =
  | {
      readonly _tag: "restored"
      readonly projection: ProjectSessionProjection
      readonly persistence: Promise<void> | null
    }
  | { readonly _tag: "stale" }

type ProjectSessionDependencies = {
  readonly availableActivityIds: readonly ProjectWorkspaceActivityId[]
  readonly loadWorkspace: (
    projectId: ReviewProjectId,
  ) => Promise<Option.Option<ProjectWorkspaceState>>
  readonly openProject: (
    localPath: string,
    selectedRepository: Option.Option<HostedRepositoryLocator>,
  ) => Promise<ProjectOpenResult>
  readonly resolveLocalReview: (
    localPath: string,
    branchName: Option.Option<string>,
  ) => Promise<LocalReviewTarget>
  readonly resolveLastCommit: (localPath: string) => Promise<LocalReviewTarget>
  readonly resolveRepositoryComparison: (
    command: OpenRepositoryComparisonCommand,
  ) => Promise<ResolvedRepositoryComparison>
  readonly saveWorkspace: (
    input: ProjectWorkspaceStateInput,
  ) => Promise<void | ProjectWorkspaceState>
}

/** Owns renderer project opening, restoration, continuation, and ordered workspace persistence. */
export class ProjectSession {
  private restoreRequest = 0
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(private readonly dependencies: ProjectSessionDependencies) {}

  /** Invalidates any restoration whose asynchronous load has not completed. */
  cancelRestore(): void {
    this.restoreRequest += 1
  }

  /** Returns the immediate project projection shown while persisted state is restored. */
  initial(repo: Repo): ProjectSessionProjection {
    return projectProjection(repo, "review", PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID, null, null)
  }

  /** Restores valid persisted state and rejects completion after a newer navigation request. */
  async restore(repo: Repo): Promise<ProjectSessionRestoreResult> {
    const request = this.restoreRequest + 1
    this.restoreRequest = request
    try {
      const persisted = Option.getOrNull(await this.dependencies.loadWorkspace(repo.id))
      if (request !== this.restoreRequest) return { _tag: "stale" }
      const restored = resolveProjectWorkspaceState(
        repo,
        persisted,
        this.dependencies.availableActivityIds,
      )
      const projection = projectProjection(
        repo,
        restored.activeSurface,
        restored.activeActivity,
        restored.selectedReview,
        restored.notice,
      )
      return {
        _tag: "restored",
        projection,
        persistence: restored.notice === null ? null : this.persist(projection),
      }
    } catch (error) {
      if (request !== this.restoreRequest) return { _tag: "stale" }
      throw error
    }
  }

  /** Opens a checkout or returns the remote-selection continuation required to finish opening it. */
  async open(
    localPath: string,
    intent: ProjectOpenIntent,
    selectedRepository?: HostedRepositoryLocator,
  ): Promise<ProjectSessionOpenResult> {
    this.cancelRestore()
    const result = await this.dependencies.openProject(
      localPath,
      Option.fromNullishOr(selectedRepository),
    )
    return Match.valueTags(result, {
      remoteSelectionRequired: (selection) => ({
        _tag: "remoteSelectionRequired" as const,
        pending: { intent, selection },
      }),
      opened: (opened) => this.completeOpen(opened.repo, intent),
    })
  }

  /** Resolves and persists a repository-comparison command as a project projection. */
  async openRepositoryComparison(
    command: OpenRepositoryComparisonCommand,
  ): Promise<OpenedProjectSession> {
    this.cancelRestore()
    const comparison = await this.dependencies.resolveRepositoryComparison(command)
    const selectedReview: SelectedReviewTarget =
      comparison.target.kind === "local"
        ? { kind: "localDiff", target: comparison.target }
        : { kind: "repositoryComparison", target: comparison.target }
    const projection = projectProjection(
      comparison.repo,
      "review",
      PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
      selectedReview,
      null,
    )
    return {
      _tag: "opened",
      projection,
      persistence: this.persist(projection),
      reviewType: comparison.target.kind === "local" ? "local_diff" : null,
    }
  }

  /** Serializes one workspace projection after all previously requested writes. */
  persist(projection: ProjectSessionProjection): Promise<void> {
    const input = ProjectWorkspaceStateInputSchema.make({
      projectId: projection.repo.id,
      activeSurface: projection.activeSurface,
      activeActivity: projection.activeActivity,
      selectedReviewTarget: selectedReviewTargetForPersistence(projection.selectedReview),
    })
    const requested = this.saveQueue.then(async () => {
      await this.dependencies.saveWorkspace(input)
      return undefined
    })
    this.saveQueue = requested.catch(() => undefined)
    return requested
  }

  /** Invalidates restoration and creates a projection for a UI-owned workspace transition. */
  project(
    repo: Repo,
    activeSurface: ProjectWorkspaceSurface,
    activeActivity: ProjectWorkspaceActivityId,
    selectedReview: SelectedReviewTarget | null,
    notice: string | null = null,
  ): ProjectSessionProjection {
    this.cancelRestore()
    return projectProjection(repo, activeSurface, activeActivity, selectedReview, notice)
  }

  private async completeOpen(repo: Repo, intent: ProjectOpenIntent): Promise<OpenedProjectSession> {
    let projection: ProjectSessionProjection
    let reviewType: OpenedProjectSession["reviewType"] = null
    if (intent.kind === "workingTree") {
      if (repo.localPath === null) throw new Error("The opened project has no local checkout.")
      projection = projectProjection(
        repo,
        "review",
        PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
        { kind: "localDiff", target: workingTreeReviewTarget(repo.localPath) },
        null,
      )
      reviewType = "local_diff"
    } else if (intent.kind === "branchDiff") {
      if (repo.localPath === null) throw new Error("The opened project has no local checkout.")
      const target = await this.dependencies.resolveLocalReview(
        repo.localPath,
        Option.fromNullishOr(intent.branchName),
      )
      projection = projectProjection(
        repo,
        "review",
        PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
        { kind: "localDiff", target },
        null,
      )
      reviewType = "local_diff"
    } else if (intent.kind === "lastCommit") {
      if (repo.localPath === null) throw new Error("The opened project has no local checkout.")
      const target = await this.dependencies.resolveLastCommit(repo.localPath)
      projection = projectProjection(
        repo,
        "review",
        PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
        { kind: "localDiff", target },
        null,
      )
      reviewType = "local_diff"
    } else if (intent.kind === "pullRequest") {
      if (repo.hostedLocator === null) {
        throw new Error("The opened project has no recognized hosted repository.")
      }
      projection = projectProjection(
        repo,
        "review",
        PROJECT_WORKSPACE_FILES_ACTIVITY_ID,
        {
          kind: "hosted",
          review: makeHostedReviewLocator(
            repo.hostedLocator.providerId,
            repo.hostedLocator.namespace,
            repo.hostedLocator.name,
            intent.number,
          ),
        },
        null,
      )
      reviewType = "pull_request"
    } else {
      projection = projectProjection(
        repo,
        "review",
        PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
        null,
        null,
      )
    }
    return {
      _tag: "opened",
      projection,
      persistence: this.persist(projection),
      reviewType,
    }
  }
}

const projectProjection = (
  repo: Repo,
  activeSurface: ProjectWorkspaceSurface,
  activeActivity: ProjectWorkspaceActivityId,
  selectedReview: SelectedReviewTarget | null,
  notice: string | null,
): ProjectSessionProjection => ({ repo, activeSurface, activeActivity, selectedReview, notice })
