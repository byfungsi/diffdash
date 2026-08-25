/* oxlint-disable eslint/no-underscore-dangle -- Protocol unions use Effect-compatible _tag discriminants. */
import {
  makeHostedReviewLocator,
  type HostedRepositoryLocator,
} from "@diffdash/domain/git-provider"
import { workingTreeReviewTarget, type LocalReviewTarget } from "@diffdash/domain/local-review"
import {
  ProjectOpenResult,
  ProjectRemoteSelectionRequired,
  ProjectWorkspaceActivityAvailability,
  ProjectWorkspaceActivityId,
  ProjectWorkspaceActivityResolution,
  ProjectWorkspaceActivitySelection,
  ProjectWorkspaceNavigationContributionId,
  ProjectWorkspaceNavigationEnvelope,
  ProjectWorkspaceNavigationLocation,
  ProjectWorkspaceState,
  ProjectWorkspaceStateInput,
  ProjectWorkspaceSurface,
  resolveProjectWorkspaceActivity,
} from "@diffdash/domain/project-workspace"
import { ProjectWorkspaceStateInput as ProjectWorkspaceStateInputSchema } from "@diffdash/domain/project-workspace"
import type { Repo } from "@diffdash/domain/repository"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import type { OpenRepositoryComparisonCommand } from "@diffdash/protocol/cli-navigation"
import type { ResolvedRepositoryComparison } from "@diffdash/protocol/review-snapshot"
import type { AnalyticsEvent } from "@diffdash/protocol/analytics"
import { Data, Match, Option, Schema } from "effect"

import {
  ProjectWorkspaceStateResolution,
  resolveProjectWorkspaceState,
  type ProjectWorkspaceNavigationAvailability,
} from "@/project-workspace/workspace-state"
import type { SelectedReviewTarget } from "@/review/review-subject"
import { PROJECT_WORKSPACE_FILES_ACTIVITY_ID } from "./review-identities"
import {
  decodeReviewNavigationState,
  encodeReviewNavigationState,
  REVIEW_NAVIGATION_ID,
} from "./review-navigation"
import type { ProjectNavigationResult } from "../extension-registry"
import type { ProjectWorkspacePersistenceGeneration } from "../project-workspace-persistence"

type ProjectSessionPersistenceProjection = Omit<
  ProjectNavigationResult,
  "registrationToken" | "activityRegistrationToken"
>

/** User intent retained while a local checkout requires hosted-remote disambiguation. */
type ProjectOpenIntent = Data.TaggedEnum<{
  reviews: {}
  workingTree: {}
  pullRequest: { readonly number: number }
  branchDiff: { readonly branchName: Option.Option<string> }
  lastCommit: {}
}>

const ProjectOpenIntent = Data.taggedEnum<ProjectOpenIntent>()

/** React-independent project state produced by session orchestration. */
export class ProjectSessionProjection extends Data.Class<{
  readonly repo: Repo
  readonly activeSurface: ProjectWorkspaceSurface
  readonly activeActivity: ProjectWorkspaceActivityId
  readonly selectedReviewOption: Option.Option<SelectedReviewTarget>
  readonly contributionId: ProjectWorkspaceNavigationContributionId
  readonly navigationLocation: ProjectWorkspaceNavigationLocation
  readonly notice: Option.Option<string>
}> {
  /** Selected review adapted for the existing renderer state API. */
  get selectedReview(): SelectedReviewTarget | null {
    return Option.getOrNull(this.selectedReviewOption)
  }

  /** Durable workspace input corresponding to this semantic project projection. */
  get workspaceStateInput(): ProjectWorkspaceStateInput {
    return Schema.decodeSync(ProjectWorkspaceStateInputSchema)({
      projectId: this.repo.id,
      activeSurface: this.activeSurface,
      activeActivity: this.activeActivity,
      navigation: ProjectWorkspaceNavigationEnvelope.make({
        contributionId: this.contributionId,
        location: this.navigationLocation,
      }),
    })
  }

  /** Opaque Review-owned history state corresponding to this project projection. */
  get state(): ProjectWorkspaceNavigationLocation {
    return this.navigationLocation
  }

  /** Extension-neutral persisted workspace value applied by the shell. */
  get workspaceState(): ProjectWorkspaceStateInput {
    return this.workspaceStateInput
  }
}

/** Continuation retained when opening a checkout requires remote selection. */
export type PendingProjectRemoteSelection = {
  readonly selection: ProjectRemoteSelectionRequired
  readonly resume: (repository: HostedRepositoryLocator) => Promise<ProjectSessionOpenResult>
}

/** Result of opening a local checkout through the project session. */
export type ProjectSessionOpenResult = Data.TaggedEnum<{
  opened: {
    readonly projection: ProjectSessionProjection
    readonly analyticsEvent: Option.Option<AnalyticsEvent>
    readonly requiresPersistence: true
  }
  remoteSelectionRequired: { readonly pending: PendingProjectRemoteSelection }
  unavailable: {}
}>

/** Constructors and exhaustive matching for project-opening results. */
export const ProjectSessionOpenResult = Data.taggedEnum<ProjectSessionOpenResult>()

type OpenedProjectSession = Extract<ProjectSessionOpenResult, { readonly _tag: "opened" }>
type UnavailableProjectSession = Extract<ProjectSessionOpenResult, { readonly _tag: "unavailable" }>

/** Result of restoring persisted state, including explicit stale-completion rejection. */
export type ProjectSessionRestoreResult = Data.TaggedEnum<{
  restored: {
    readonly projection: ProjectSessionProjection
    readonly requiresPersistence: boolean
  }
  stale: {}
  unavailable: {}
}>

/** Constructors and exhaustive matching for project-restoration results. */
export const ProjectSessionRestoreResult = Data.taggedEnum<ProjectSessionRestoreResult>()

type ProjectSessionDependencies = {
  readonly availableActivities: () => readonly ProjectWorkspaceActivityAvailability[]
  readonly availableNavigation: () => readonly ProjectWorkspaceNavigationAvailability[]
  readonly defaultActivity: (
    surface: ProjectWorkspaceSurface,
  ) => Option.Option<ProjectWorkspaceActivityId>
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
  readonly persistence: ProjectWorkspacePersistenceGeneration
}

/** Owns renderer project opening, restoration, continuation, and generation-scoped persistence. */
export class ProjectSession {
  private restoreRequest = 0

  constructor(private readonly dependencies: ProjectSessionDependencies) {}

  /** Invalidates pending work and releases state retained by this owner generation. */
  dispose(): void {
    this.cancelRestore()
    this.dependencies.persistence.dispose()
  }

  /** Invalidates any restoration whose asynchronous load has not completed. */
  cancelRestore(): void {
    this.restoreRequest += 1
  }

  /** Returns the immediate project projection shown while persisted state is restored. */
  initial(repo: Repo): Option.Option<ProjectSessionProjection> {
    return Option.map(this.dependencies.defaultActivity("review"), (activity) =>
      projectProjection(repo, "review", activity, Option.none(), Option.none()),
    )
  }

  /** Restores valid persisted state and rejects completion after a newer navigation request. */
  async restore(repo: Repo): Promise<ProjectSessionRestoreResult> {
    const request = this.restoreRequest + 1
    this.restoreRequest = request
    try {
      const persisted = Option.getOrNull(await this.dependencies.loadWorkspace(repo.id))
      if (request !== this.restoreRequest) return ProjectSessionRestoreResult.stale()
      const restored = resolveProjectWorkspaceState(
        repo,
        persisted,
        this.dependencies.availableActivities(),
        this.dependencies.availableNavigation(),
      )
      return ProjectWorkspaceStateResolution.match(restored, {
        unresolved: () => ProjectSessionRestoreResult.unavailable(),
        resolved: (state) => {
          const selectedReview =
            state.navigationContributionId === REVIEW_NAVIGATION_ID
              ? decodeReviewNavigationState(state.navigationLocation).selectedReview
              : Option.none<SelectedReviewTarget>()
          const projection = new ProjectSessionProjection({
            repo,
            activeSurface: state.activeSurface,
            activeActivity: state.activeActivity,
            selectedReviewOption: selectedReview,
            contributionId: state.navigationContributionId,
            navigationLocation: state.navigationLocation,
            notice: state.notice,
          })
          return ProjectSessionRestoreResult.restored({
            projection,
            requiresPersistence: Option.isSome(projection.notice),
          })
        },
      })
    } catch (error) {
      if (request !== this.restoreRequest) return ProjectSessionRestoreResult.stale()
      throw error
    }
  }

  /** Opens a checkout or returns the remote-selection continuation required to finish opening it. */
  private async open(
    localPath: string,
    intent: ProjectOpenIntent,
    selectedRepository: Option.Option<HostedRepositoryLocator>,
  ): Promise<ProjectSessionOpenResult> {
    this.cancelRestore()
    const result = await this.dependencies.openProject(localPath, selectedRepository)
    return ProjectOpenResult.match(result, {
      remoteSelectionRequired: (selection) =>
        ProjectSessionOpenResult.remoteSelectionRequired({
          pending: {
            selection,
            resume: (repository) => this.open(localPath, intent, Option.some(repository)),
          },
        }),
      opened: (opened) => this.completeOpen(opened.repo, intent),
    })
  }

  /** Opens a project at its Review overview. */
  openProject(localPath: string): Promise<ProjectSessionOpenResult> {
    return this.open(localPath, ProjectOpenIntent.reviews(), Option.none())
  }

  /** Opens a project's working-tree review. */
  openWorkingTree(localPath: string): Promise<ProjectSessionOpenResult> {
    return this.open(localPath, ProjectOpenIntent.workingTree(), Option.none())
  }

  /** Opens a project's branch comparison. */
  openBranchDiff(localPath: string, branchName: string | null): Promise<ProjectSessionOpenResult> {
    return this.open(
      localPath,
      ProjectOpenIntent.branchDiff({ branchName: Option.fromNullishOr(branchName) }),
      Option.none(),
    )
  }

  /** Opens a project's latest commit. */
  openLastCommit(localPath: string): Promise<ProjectSessionOpenResult> {
    return this.open(localPath, ProjectOpenIntent.lastCommit(), Option.none())
  }

  /** Opens a hosted pull request, or its project overview when no number was supplied. */
  openPullRequest(localPath: string, number: number | null): Promise<ProjectSessionOpenResult> {
    return Option.match(Option.fromNullishOr(number), {
      onNone: () => this.openProject(localPath),
      onSome: (pullRequestNumber) =>
        this.open(
          localPath,
          ProjectOpenIntent.pullRequest({ number: pullRequestNumber }),
          Option.none(),
        ),
    })
  }

  /** Resolves and persists a repository-comparison command as a project projection. */
  async openRepositoryComparison(
    command: OpenRepositoryComparisonCommand,
  ): Promise<OpenedProjectSession | UnavailableProjectSession> {
    this.cancelRestore()
    const comparison = await this.dependencies.resolveRepositoryComparison(command)
    const activity = this.reviewSelectionActivity()
    if (Option.isNone(activity)) return ProjectSessionOpenResult.unavailable()
    const selectedReview = Match.value(comparison.target).pipe(
      Match.when(
        { kind: "local" },
        (target): SelectedReviewTarget => ({ kind: "localDiff", target }),
      ),
      Match.when(
        { kind: "repositoryComparison" },
        (target): SelectedReviewTarget => ({ kind: "repositoryComparison", target }),
      ),
      Match.exhaustive,
    )
    const projection = projectProjection(
      comparison.repo,
      "review",
      activity.value,
      Option.some(selectedReview),
      Option.none(),
    )
    const reviewType = Match.value(comparison.target).pipe(
      Match.when({ kind: "local" }, () => "local_diff" as const),
      Match.when({ kind: "repositoryComparison" }, () => "repository_comparison" as const),
      Match.exhaustive,
    )
    return ProjectSessionOpenResult.opened({
      projection,
      analyticsEvent: Option.some({
        event: "review_opened",
        reviewType,
      }),
      requiresPersistence: true,
    })
  }

  /** Queues one workspace projection while this owner generation remains current. */
  persist(
    projection: ProjectSessionPersistenceProjection,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const resolution = resolveProjectWorkspaceActivity(
      ProjectWorkspaceActivitySelection.make({
        activeSurface: projection.activeSurface,
        activeActivity: projection.activeActivity,
      }),
      this.dependencies.availableActivities(),
    )
    const resolvedSelection = ProjectWorkspaceActivityResolution.match(resolution, {
      available: ({ selection }) => Option.some(selection),
      repaired: ({ selection }) => Option.some(selection),
      unresolved: () => Option.none<ProjectWorkspaceActivitySelection>(),
    })
    if (Option.isNone(resolvedSelection)) return Promise.resolve(false)
    const contribution = this.dependencies
      .availableNavigation()
      .find(
        (candidate) =>
          candidate.id === projection.contributionId &&
          candidate.surface === resolvedSelection.value.activeSurface &&
          candidate.isValidState(projection.state),
      )
    if (contribution === undefined) return Promise.resolve(false)
    const input = Schema.decodeSync(ProjectWorkspaceStateInputSchema)({
      projectId: projection.repo.id,
      activeSurface: resolvedSelection.value.activeSurface,
      activeActivity: resolvedSelection.value.activeActivity,
      navigation: {
        contributionId: contribution.id,
        location: projection.state,
      },
    })
    return this.dependencies.persistence.save(input, isCurrent)
  }

  /** Invalidates restoration and creates a projection for a UI-owned workspace transition. */
  project(
    repo: Repo,
    activeSurface: ProjectWorkspaceSurface,
    activeActivity: ProjectWorkspaceActivityId,
    selectedReview: Option.Option<SelectedReviewTarget>,
    notice: Option.Option<string>,
  ): ProjectSessionProjection {
    this.cancelRestore()
    return projectProjection(repo, activeSurface, activeActivity, selectedReview, notice)
  }

  private async completeOpen(
    repo: Repo,
    intent: ProjectOpenIntent,
  ): Promise<OpenedProjectSession | UnavailableProjectSession> {
    const activity = ProjectOpenIntent.$match(intent, {
      reviews: () => this.dependencies.defaultActivity("review"),
      workingTree: () => this.reviewSelectionActivity(),
      branchDiff: () => this.reviewSelectionActivity(),
      lastCommit: () => this.reviewSelectionActivity(),
      pullRequest: () => this.reviewSelectionActivity(),
    })
    if (Option.isNone(activity)) return ProjectSessionOpenResult.unavailable()
    const opened = await ProjectOpenIntent.$match(intent, {
      reviews: async () =>
        Option.some({
          projection: projectProjection(
            repo,
            "review",
            activity.value,
            Option.none(),
            Option.none(),
          ),
          reviewType: Option.none<"pull_request" | "local_diff">(),
        }),
      workingTree: async () =>
        Option.map(Option.fromNullishOr(repo.localPath), (localPath) => ({
          projection: projectProjection(
            repo,
            "review",
            activity.value,
            Option.some({ kind: "localDiff", target: workingTreeReviewTarget(localPath) }),
            Option.none(),
          ),
          reviewType: Option.some("local_diff" as const),
        })),
      branchDiff: async ({ branchName }) => {
        return Option.match(Option.fromNullishOr(repo.localPath), {
          onNone: () => Promise.resolve(Option.none()),
          onSome: async (localPath) => {
            const target = await this.dependencies.resolveLocalReview(localPath, branchName)
            return Option.some({
              projection: projectProjection(
                repo,
                "review",
                activity.value,
                Option.some({ kind: "localDiff", target }),
                Option.none(),
              ),
              reviewType: Option.some("local_diff" as const),
            })
          },
        })
      },
      lastCommit: async () =>
        Option.match(Option.fromNullishOr(repo.localPath), {
          onNone: () => Promise.resolve(Option.none()),
          onSome: async (localPath) => {
            const target = await this.dependencies.resolveLastCommit(localPath)
            return Option.some({
              projection: projectProjection(
                repo,
                "review",
                activity.value,
                Option.some({ kind: "localDiff", target }),
                Option.none(),
              ),
              reviewType: Option.some("local_diff" as const),
            })
          },
        }),
      pullRequest: async ({ number }) =>
        Option.map(Option.fromNullishOr(repo.hostedLocator), (repository) => ({
          projection: projectProjection(
            repo,
            "review",
            activity.value,
            Option.some({
              kind: "hosted",
              review: makeHostedReviewLocator(
                repository.providerId,
                repository.namespace,
                repository.name,
                number,
              ),
            }),
            Option.none(),
          ),
          reviewType: Option.some("pull_request" as const),
        })),
    })
    if (Option.isNone(opened)) return ProjectSessionOpenResult.unavailable()
    const { projection, reviewType } = opened.value
    return ProjectSessionOpenResult.opened({
      projection,
      analyticsEvent: Option.map(
        reviewType,
        (reviewType): AnalyticsEvent => ({ event: "review_opened", reviewType }),
      ),
      requiresPersistence: true,
    })
  }

  private reviewSelectionActivity(): Option.Option<ProjectWorkspaceActivityId> {
    return Option.fromNullishOr(
      this.dependencies
        .availableActivities()
        .find((activity) => activity.id === PROJECT_WORKSPACE_FILES_ACTIVITY_ID),
    ).pipe(Option.map(({ id }) => id))
  }
}

const projectProjection = (
  repo: Repo,
  activeSurface: ProjectWorkspaceSurface,
  activeActivity: ProjectWorkspaceActivityId,
  selectedReviewOption: Option.Option<SelectedReviewTarget>,
  notice: Option.Option<string>,
): ProjectSessionProjection =>
  new ProjectSessionProjection({
    repo,
    activeSurface,
    activeActivity,
    selectedReviewOption,
    contributionId: REVIEW_NAVIGATION_ID,
    navigationLocation: encodeReviewNavigationState({ selectedReview: selectedReviewOption }),
    notice,
  })
