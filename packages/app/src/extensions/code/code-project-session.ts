import type { HostedRepositoryLocator } from "@diffdash/domain/git-provider"
import {
  ProjectOpenResult,
  type ProjectRemoteSelectionRequired,
  ProjectWorkspaceActivityResolution,
  ProjectWorkspaceActivitySelection,
  ProjectWorkspaceNavigationEnvelope,
  ProjectWorkspaceState,
  ProjectWorkspaceStateInput,
  resolveProjectWorkspaceActivity,
  type ProjectWorkspaceActivityAvailability,
  type ProjectWorkspaceActivityId,
} from "@diffdash/domain/project-workspace"
import type { Repo } from "@diffdash/domain/repository"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import { Data, Option, Schema } from "effect"

import type { ProjectNavigationResult } from "../extension-registry"
import type { ProjectWorkspacePersistenceGeneration } from "../project-workspace-persistence"

/** React-independent Code destination before a provider binds registration generations. */
export type CodeProjectSessionProjection = Omit<
  ProjectNavigationResult,
  "registrationToken" | "activityRegistrationToken"
>
import {
  ProjectWorkspaceStateResolution,
  resolveProjectWorkspaceState,
  type ProjectWorkspaceNavigationAvailability,
} from "@/project-workspace/workspace-state"
import { CODE_NAVIGATION_ID, createDefaultCodeNavigationState } from "./code-navigation"

/** Result of opening a checkout through the Code-owned project session. */
export type CodeProjectSessionOpenResult = Data.TaggedEnum<{
  opened: {
    readonly projection: CodeProjectSessionProjection
    readonly requiresPersistence: true
  }
  remoteSelectionRequired: {
    readonly selection: ProjectRemoteSelectionRequired
    readonly resume: (repository: HostedRepositoryLocator) => Promise<CodeProjectSessionOpenResult>
  }
  unavailable: {}
}>

/** Constructors and exhaustive matching for Code project-opening results. */
export const CodeProjectSessionOpenResult = Data.taggedEnum<CodeProjectSessionOpenResult>()

/** Result of restoring persisted state through the Code-owned project session. */
export type CodeProjectSessionRestoreResult = Data.TaggedEnum<{
  restored: {
    readonly projection: CodeProjectSessionProjection
    readonly requiresPersistence: boolean
  }
  stale: {}
  unavailable: {}
}>

/** Constructors and exhaustive matching for Code project-restoration results. */
export const CodeProjectSessionRestoreResult = Data.taggedEnum<CodeProjectSessionRestoreResult>()

interface CodeProjectSessionDependencies {
  readonly availableActivities: () => readonly ProjectWorkspaceActivityAvailability[]
  readonly availableNavigation: () => readonly ProjectWorkspaceNavigationAvailability[]
  readonly loadWorkspace: (
    projectId: ReviewProjectId,
  ) => Promise<Option.Option<ProjectWorkspaceState>>
  readonly openProject: (
    localPath: string,
    selectedRepository: Option.Option<HostedRepositoryLocator>,
  ) => Promise<ProjectOpenResult>
  readonly persistence: ProjectWorkspacePersistenceGeneration
}

/** Owns Code-only project opening, restoration, and generation-scoped persistence. */
export class CodeProjectSession {
  private restoreRequest = 0

  constructor(private readonly dependencies: CodeProjectSessionDependencies) {}

  /** Invalidates pending restoration retained by this owner generation. */
  dispose(): void {
    this.cancelRestore()
    this.dependencies.persistence.dispose()
  }

  /** Invalidates any restoration whose asynchronous load has not completed. */
  cancelRestore(): void {
    this.restoreRequest += 1
  }

  /** Returns the immediate default Code destination for a project. */
  initial(repo: Repo): Option.Option<CodeProjectSessionProjection> {
    return Option.map(this.codeActivity(), (activeActivity) =>
      codeProjectProjection(repo, activeActivity, Option.none()),
    )
  }

  /** Returns a default Code destination carrying a shell-provided notice. */
  defaultProject(
    repo: Repo,
    notice: Option.Option<string>,
  ): Option.Option<CodeProjectSessionProjection> {
    return Option.map(this.codeActivity(), (activeActivity) =>
      codeProjectProjection(repo, activeActivity, notice),
    )
  }

  /** Opens a checkout or returns the remote-selection continuation needed to finish opening it. */
  openProject(localPath: string): Promise<CodeProjectSessionOpenResult> {
    return this.open(localPath, Option.none())
  }

  /** Restores persisted activity state against current registrations and repairs it to Code. */
  async restore(repo: Repo): Promise<CodeProjectSessionRestoreResult> {
    const request = this.restoreRequest + 1
    this.restoreRequest = request
    try {
      const persisted = Option.getOrNull(await this.dependencies.loadWorkspace(repo.id))
      if (request !== this.restoreRequest) return CodeProjectSessionRestoreResult.stale()
      const restored = resolveProjectWorkspaceState(
        repo,
        persisted,
        this.dependencies.availableActivities(),
        this.dependencies.availableNavigation(),
      )
      return ProjectWorkspaceStateResolution.match(restored, {
        unresolved: () => CodeProjectSessionRestoreResult.unavailable(),
        resolved: (state) => {
          const codeActivity = this.codeActivity()
          if (Option.isNone(codeActivity)) return CodeProjectSessionRestoreResult.unavailable()
          const projection = codeProjectProjection(
            repo,
            state.activeSurface === "code" ? state.activeActivity : codeActivity.value,
            state.notice,
            state.activeSurface === "code" ? state.navigationLocation : undefined,
          )
          const needsPersistence = state.activeSurface !== "code" || Option.isSome(state.notice)
          return CodeProjectSessionRestoreResult.restored({
            projection,
            requiresPersistence: needsPersistence,
          })
        },
      })
    } catch (error) {
      if (request !== this.restoreRequest) return CodeProjectSessionRestoreResult.stale()
      throw error
    }
  }

  /** Queues a Code workspace projection while this owner generation remains current. */
  persist(projection: CodeProjectSessionProjection, isCurrent: () => boolean): Promise<boolean> {
    const selection = this.codeSelection(projection)
    if (Option.isNone(selection)) return Promise.resolve(false)
    const contribution = this.dependencies
      .availableNavigation()
      .find(
        (candidate) =>
          candidate.id === projection.contributionId &&
          candidate.surface === "code" &&
          candidate.isValidState(projection.state),
      )
    if (contribution === undefined) return Promise.resolve(false)
    const input = Schema.decodeSync(ProjectWorkspaceStateInput)({
      projectId: projection.repo.id,
      activeSurface: "code",
      activeActivity: selection.value.activeActivity,
      navigation: ProjectWorkspaceNavigationEnvelope.make({
        contributionId: contribution.id,
        location: projection.state,
      }),
    })
    return this.dependencies.persistence.save(input, isCurrent)
  }

  private async open(
    localPath: string,
    selectedRepository: Option.Option<HostedRepositoryLocator>,
  ): Promise<CodeProjectSessionOpenResult> {
    this.cancelRestore()
    const result = await this.dependencies.openProject(localPath, selectedRepository)
    return ProjectOpenResult.match(result, {
      remoteSelectionRequired: (selection) =>
        CodeProjectSessionOpenResult.remoteSelectionRequired({
          selection,
          resume: (repository) => this.open(localPath, Option.some(repository)),
        }),
      opened: ({ repo }) => {
        const projection = this.initial(repo)
        return Option.match(projection, {
          onNone: () => CodeProjectSessionOpenResult.unavailable(),
          onSome: (openedProjection) =>
            CodeProjectSessionOpenResult.opened({
              projection: openedProjection,
              requiresPersistence: true,
            }),
        })
      },
    })
  }

  private codeActivity(): Option.Option<ProjectWorkspaceActivityId> {
    const activities = this.dependencies.availableActivities()
    return Option.fromNullishOr(
      activities.find((activity) => activity.defaultForSurfaces.includes("code")) ??
        activities.find((activity) => activity.supportedSurfaces.includes("code")),
    ).pipe(Option.map(({ id }) => id))
  }

  private codeSelection(
    projection: CodeProjectSessionProjection,
  ): Option.Option<ProjectWorkspaceActivitySelection> {
    const resolution = resolveProjectWorkspaceActivity(
      ProjectWorkspaceActivitySelection.make({
        activeSurface: "code",
        activeActivity: projection.activeActivity,
      }),
      this.dependencies.availableActivities(),
    )
    return ProjectWorkspaceActivityResolution.match(resolution, {
      available: ({ selection }) => Option.some(selection),
      repaired: ({ selection }) =>
        selection.activeSurface === "code"
          ? Option.some(selection)
          : Option.map(this.codeActivity(), (activeActivity) =>
              ProjectWorkspaceActivitySelection.make({ activeSurface: "code", activeActivity }),
            ),
      unresolved: () => Option.none(),
    })
  }
}

const codeProjectProjection = (
  repo: Repo,
  activeActivity: ProjectWorkspaceActivityId,
  notice: Option.Option<string>,
  state = createDefaultCodeNavigationState(repo.id),
): CodeProjectSessionProjection => ({
  repo,
  contributionId: CODE_NAVIGATION_ID,
  activeSurface: "code",
  activeActivity,
  state,
  notice,
})
