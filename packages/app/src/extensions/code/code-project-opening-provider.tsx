import { Fragment, useEffect, useRef, useState } from "react"
import { Option } from "effect"

import {
  runRendererPromise,
  useRendererPreferences,
  useRepositories,
} from "@/platform/renderer-runtime"
import type { ProjectNavigationResult, ProjectOpeningProviderProps } from "../extension-registry"
import {
  useTrustedExtensionRegistry,
  useTrustedExtensionRegistryController,
} from "../extension-registry-context"
import {
  ProjectOpeningCommandClaim,
  ProjectOpeningResult,
  ProjectRestoreResult,
  useProjectOpeningRuntimeRegistration,
  type ProjectOpeningResult as ProjectOpeningResultType,
  type ProjectOpeningRuntime,
} from "../project-opening-runtime"
import {
  CodeProjectSession,
  CodeProjectSessionOpenResult,
  CodeProjectSessionRestoreResult,
  type CodeProjectSessionProjection,
} from "./code-project-session"
import { useProjectWorkspacePersistenceCoordinator } from "../project-workspace-persistence"

/** Composes Code-owned project opening and persistence behind the generic shell contract. */
export const CodeProjectOpeningProvider = ({
  active,
  children,
  registrationToken,
}: ProjectOpeningProviderProps) => (
  <>
    {active ? (
      <ActiveCodeProjectOpeningProvider
        key={registrationToken.reactKey}
        registrationToken={registrationToken}
      />
    ) : null}
    <Fragment key="project-opening-content">{children}</Fragment>
  </>
)

const ActiveCodeProjectOpeningProvider = ({
  registrationToken,
}: Pick<ProjectOpeningProviderProps, "registrationToken">) => {
  const preferences = useRendererPreferences()
  const persistenceCoordinator = useProjectWorkspacePersistenceCoordinator()
  const repositories = useRepositories()
  const registry = useTrustedExtensionRegistryController()
  const { projectActivities, projectNavigation } = useTrustedExtensionRegistry()
  const projectActivitiesRef = useRef(projectActivities)
  projectActivitiesRef.current = projectActivities
  const projectNavigationRef = useRef(projectNavigation)
  projectNavigationRef.current = projectNavigation
  const [session] = useState(
    () =>
      new CodeProjectSession({
        availableActivities: () =>
          projectActivitiesRef.current.map((activity) => ({
            id: activity.id,
            supportedSurfaces: activity.supportedSurfaces,
            defaultForSurfaces: activity.defaultForSurfaces ?? [],
          })),
        availableNavigation: () => projectNavigationRef.current,
        loadWorkspace: (projectId) => runRendererPromise(preferences.loadWorkspace(projectId)),
        openProject: (localPath, selectedRepository) =>
          runRendererPromise(repositories.openProject(localPath, selectedRepository)),
        persistence: persistenceCoordinator.createGeneration(),
      }),
  )
  useEffect(
    () => () => {
      session.dispose()
    },
    [session],
  )
  const adaptProjection = (
    projection: CodeProjectSessionProjection,
  ): Option.Option<ProjectNavigationResult> => {
    const snapshot = registry.snapshot()
    if (
      !snapshot.projectOpeningProviders.some(
        (provider) => provider.ownerRegistrationToken === registrationToken,
      )
    )
      return Option.none()
    const contribution = snapshot.projectNavigation.find(
      (candidate) =>
        candidate.id === projection.contributionId &&
        candidate.surface === projection.activeSurface &&
        candidate.isValidState(projection.state),
    )
    const activity = snapshot.projectActivities.find(
      (candidate) =>
        candidate.id === projection.activeActivity &&
        candidate.supportedSurfaces.includes(projection.activeSurface),
    )
    if (contribution === undefined || activity === undefined) return Option.none()
    return Option.some({
      ...projection,
      registrationToken: contribution.ownerRegistrationToken,
      activityRegistrationToken: activity.ownerRegistrationToken,
    })
  }
  const isCurrentProjection = (projection: ProjectNavigationResult): boolean => {
    const current = adaptProjection(projection)
    return (
      Option.isSome(current) &&
      current.value.registrationToken === projection.registrationToken &&
      current.value.activityRegistrationToken === projection.activityRegistrationToken
    )
  }
  const adaptOpenResult = (result: CodeProjectSessionOpenResult): ProjectOpeningResultType =>
    CodeProjectSessionOpenResult.$match(result, {
      unavailable: () => ProjectOpeningResult.unavailable(),
      opened: ({ projection, requiresPersistence }) =>
        Option.match(adaptProjection(projection), {
          onNone: () => ProjectOpeningResult.unavailable(),
          onSome: (adapted) =>
            ProjectOpeningResult.opened({
              projection: adapted,
              persistence: async () => {
                if (!requiresPersistence) return
                await session.persist(projection, () => isCurrentProjection(adapted))
              },
            }),
        }),
      remoteSelectionRequired: ({ selection, resume }) =>
        ProjectOpeningResult.remoteSelectionRequired({
          pending: {
            selection,
            resume: async (repository) => adaptOpenResult(await resume(repository)),
          },
        }),
    })
  const [runtime] = useState<ProjectOpeningRuntime>(() => ({
    cancelRestore: () => session.cancelRestore(),
    initial: (repo) => Option.flatMap(session.initial(repo), adaptProjection),
    defaultProject: (repo, notice) =>
      Option.flatMap(session.defaultProject(repo, notice), adaptProjection),
    restore: async (repo) =>
      CodeProjectSessionRestoreResult.$match(await session.restore(repo), {
        stale: () => ProjectRestoreResult.stale(),
        unavailable: () => ProjectRestoreResult.unavailable(),
        restored: ({ projection, requiresPersistence }) =>
          Option.match(adaptProjection(projection), {
            onNone: () => ProjectRestoreResult.unavailable(),
            onSome: (adapted) =>
              ProjectRestoreResult.restored({
                projection: adapted,
                persistence: requiresPersistence
                  ? Option.some(async () => {
                      await session.persist(projection, () => isCurrentProjection(adapted))
                    })
                  : Option.none(),
              }),
          }),
      }),
    persist: async (projection) => {
      return session.persist(projection, () => isCurrentProjection(projection))
    },
    persistLocation: async (location) => {
      return session.persist(location, () => isCurrentProjection(location))
    },
    openProject: async (localPath) => adaptOpenResult(await session.openProject(localPath)),
    claimCommand: () => ProjectOpeningCommandClaim.unhandled(),
    CommandPaletteItems: ({ render }) => render([]),
  }))
  useProjectOpeningRuntimeRegistration(runtime, registrationToken)
  return null
}
