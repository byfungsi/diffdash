import type { HostedReviewSummary } from "@diffdash/domain/git-provider"
import { useAtomValue } from "@effect/atom-react"
import { Match, Option } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import { Fragment, useEffect, useRef, useState } from "react"

import {
  useProjectWorkspace,
  useRendererPreferences,
  useRepositories,
  runRendererPromise,
} from "@/platform/renderer-runtime"
import {
  ProjectOpeningCommandClaim,
  ProjectOpeningResult,
  ProjectRestoreResult,
  useProjectOpeningRuntimeRegistration,
} from "../project-opening-runtime"
import type {
  ProjectOpeningCommandPaletteProps,
  ProjectOpeningResult as ProjectOpeningResultType,
  ProjectOpeningRuntime,
} from "../project-opening-runtime"
import {
  useTrustedExtensionRegistry,
  useTrustedExtensionRegistryController,
} from "../extension-registry-context"
import type { ProjectNavigationResult, ProjectOpeningProviderProps } from "../extension-registry"
import {
  ProjectSession,
  ProjectSessionOpenResult,
  ProjectSessionRestoreResult,
} from "./review-project-session"
import type { ProjectSessionProjection } from "./review-project-session"
import { reviewCommandPaletteItems } from "./review-command-palette"
import { useCaptureAnalytics } from "@/shared/analytics"
import { pullRequestsAtom, repoKey } from "@/review/atoms"
import { useProjectWorkspacePersistenceCoordinator } from "../project-workspace-persistence"

const EMPTY_HOSTED_REVIEWS: readonly HostedReviewSummary[] = []

/** Composes Review-owned project opening and persistence behind the generic shell contract. */
export const ReviewProjectOpeningProvider = ({
  active,
  children,
  registrationToken,
}: ProjectOpeningProviderProps) => (
  <>
    {active ? (
      <ActiveReviewProjectOpeningProvider
        key={registrationToken.reactKey}
        registrationToken={registrationToken}
      />
    ) : null}
    <Fragment key="project-opening-content">{children}</Fragment>
  </>
)

const ActiveReviewProjectOpeningProvider = ({
  registrationToken,
}: Pick<ProjectOpeningProviderProps, "registrationToken">) => {
  const captureAnalytics = useCaptureAnalytics()
  const preferences = useRendererPreferences()
  const persistenceCoordinator = useProjectWorkspacePersistenceCoordinator()
  const projectWorkspace = useProjectWorkspace()
  const repositories = useRepositories()
  const registry = useTrustedExtensionRegistryController()
  const { projectActivities, projectNavigation } = useTrustedExtensionRegistry()
  const projectActivitiesRef = useRef(projectActivities)
  projectActivitiesRef.current = projectActivities
  const projectNavigationRef = useRef(projectNavigation)
  projectNavigationRef.current = projectNavigation
  const [session] = useState(
    () =>
      new ProjectSession({
        availableActivities: () =>
          projectActivitiesRef.current.map((activity) => ({
            id: activity.id,
            supportedSurfaces: activity.supportedSurfaces,
            defaultForSurfaces: activity.defaultForSurfaces ?? [],
          })),
        availableNavigation: () => projectNavigationRef.current,
        defaultActivity: (surface) => {
          const activities = projectActivitiesRef.current
          const navigation = projectNavigationRef.current
          const surfaceAvailable = (candidate: typeof surface) =>
            navigation.some((contribution) => contribution.surface === candidate)
          const activity = surfaceAvailable(surface)
            ? activities.find((candidate) => candidate.defaultForSurfaces?.includes(surface))
            : undefined
          const fallback =
            activity ??
            activities.find((candidate) => candidate.defaultForSurfaces?.some(surfaceAvailable)) ??
            activities.find((candidate) => candidate.supportedSurfaces.some(surfaceAvailable))
          return Option.fromNullishOr(fallback?.id)
        },
        loadWorkspace: (projectId) => runRendererPromise(preferences.loadWorkspace(projectId)),
        openProject: (localPath, selectedRepository) =>
          runRendererPromise(repositories.openProject(localPath, selectedRepository)),
        resolveLocalReview: (localPath, branchName) =>
          runRendererPromise(projectWorkspace.resolveLocalReview(localPath, branchName)),
        resolveLastCommit: (localPath) =>
          runRendererPromise(projectWorkspace.resolveLastCommit(localPath)),
        resolveRepositoryComparison: (command) =>
          runRendererPromise(projectWorkspace.resolveRepositoryComparison(command)),
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
    projection: ProjectSessionProjection,
  ): Option.Option<ProjectNavigationResult> => {
    const snapshot = registry.snapshot()
    if (
      !snapshot.projectOpeningProviders.some(
        (provider) => provider.ownerRegistrationToken === registrationToken,
      )
    ) {
      return Option.none()
    }
    const activity = snapshot.projectActivities.find(
      (candidate) => candidate.id === projection.activeActivity,
    )
    if (activity === undefined) return Option.none()
    const activeSurface = activity.supportedSurfaces.includes(projection.activeSurface)
      ? projection.activeSurface
      : (activity.defaultForSurfaces?.[0] ?? activity.supportedSurfaces[0])
    if (activeSurface === undefined) return Option.none()
    const contribution = snapshot.projectNavigation.find(
      (candidate) =>
        candidate.id === projection.contributionId &&
        candidate.surface === activeSurface &&
        candidate.isValidState(projection.state),
    )
    const fallbackContribution =
      contribution ??
      snapshot.projectNavigation.find((candidate) => candidate.surface === activeSurface)
    if (fallbackContribution === undefined) return Option.none()
    return Option.some({
      repo: projection.repo,
      contributionId: fallbackContribution.id,
      registrationToken: fallbackContribution.ownerRegistrationToken,
      activeSurface,
      activeActivity: projection.activeActivity,
      activityRegistrationToken: activity.ownerRegistrationToken,
      state:
        contribution !== undefined
          ? projection.state
          : fallbackContribution.createDefaultState(projection.repo),
      notice: projection.notice,
    })
  }
  const isCurrentProjection = (projection: ProjectNavigationResult): boolean => {
    const snapshot = registry.snapshot()
    return (
      snapshot.projectOpeningProviders.some(
        (provider) => provider.ownerRegistrationToken === registrationToken,
      ) &&
      snapshot.projectNavigation.some(
        (contribution) =>
          contribution.id === projection.contributionId &&
          contribution.ownerRegistrationToken === projection.registrationToken &&
          contribution.surface === projection.activeSurface &&
          contribution.isValidState(projection.state),
      ) &&
      snapshot.projectActivities.some(
        (activity) =>
          activity.id === projection.activeActivity &&
          activity.ownerRegistrationToken === projection.activityRegistrationToken &&
          activity.supportedSurfaces.includes(projection.activeSurface),
      )
    )
  }
  const adaptOpenResult = (
    result: Awaited<ReturnType<ProjectSession["openProject"]>>,
  ): ProjectOpeningResultType =>
    ProjectSessionOpenResult.$match(result, {
      unavailable: () => ProjectOpeningResult.unavailable(),
      opened: (opened) => {
        const projection = adaptProjection(opened.projection)
        if (Option.isNone(projection)) return ProjectOpeningResult.unavailable()
        Option.match(opened.analyticsEvent, {
          onNone: () => undefined,
          onSome: captureAnalytics,
        })
        return ProjectOpeningResult.opened({
          projection: projection.value,
          persistence: async () => {
            if (!opened.requiresPersistence) return
            await session.persist(opened.projection, () => isCurrentProjection(projection.value))
          },
        })
      },
      remoteSelectionRequired: ({ pending }) =>
        ProjectOpeningResult.remoteSelectionRequired({
          pending: {
            selection: pending.selection,
            resume: async (repository) => adaptOpenResult(await pending.resume(repository)),
          },
        }),
    })
  const adaptOpenRequest = async (
    request: Promise<Awaited<ReturnType<ProjectSession["openProject"]>>>,
  ): Promise<ProjectOpeningResultType> => adaptOpenResult(await request)
  const adaptRestoreResult = async (
    request: ReturnType<ProjectSession["restore"]>,
  ): Promise<ProjectRestoreResult> =>
    ProjectSessionRestoreResult.$match(await request, {
      stale: () => ProjectRestoreResult.stale(),
      unavailable: () => ProjectRestoreResult.unavailable(),
      restored: (restored) =>
        Option.match(adaptProjection(restored.projection), {
          onNone: () => ProjectRestoreResult.unavailable(),
          onSome: (projection) =>
            ProjectRestoreResult.restored({
              persistence: restored.requiresPersistence
                ? Option.some(async () => {
                    await session.persist(restored.projection, () =>
                      isCurrentProjection(projection),
                    )
                  })
                : Option.none(),
              projection,
            }),
        }),
    })
  const CommandPaletteItems = ({ apply, render, repo }: ProjectOpeningCommandPaletteProps) => {
    const selectedRepoKey =
      repo?.hostedLocator === null || repo?.hostedLocator === undefined
        ? ""
        : repoKey(
            repo.hostedLocator.providerId,
            repo.hostedLocator.namespace,
            repo.hostedLocator.name,
          )
    const pullRequests = AsyncResult.getOrElse(
      useAtomValue(pullRequestsAtom(selectedRepoKey)),
      () => EMPTY_HOSTED_REVIEWS,
    )
    return render(
      reviewCommandPaletteItems({
        apply: (projection) => Option.map(adaptProjection(projection), apply),
        projectSession: session,
        pullRequests,
        repo: Option.fromNullishOr(repo),
      }),
    )
  }
  const [runtime] = useState<ProjectOpeningRuntime>(() => ({
    cancelRestore: () => session.cancelRestore(),
    initial: (repo) => Option.flatMap(session.initial(repo), adaptProjection),
    defaultProject: (repo, notice) =>
      Option.flatMap(session.initial(repo), (projection) =>
        adaptProjection(
          session.project(
            repo,
            projection.activeSurface,
            projection.activeActivity,
            Option.none(),
            notice,
          ),
        ),
      ),
    restore: (repo) => adaptRestoreResult(session.restore(repo)),
    persist: async (projection) => {
      return session.persist(projection, () => isCurrentProjection(projection))
    },
    persistLocation: async (location) => {
      return session.persist(location, () => isCurrentProjection(location))
    },
    openProject: (localPath) => adaptOpenRequest(session.openProject(localPath)),
    claimCommand: (command) =>
      Match.valueTags(command, {
        error: () => ProjectOpeningCommandClaim.unhandled(),
        linkRepository: () => ProjectOpeningCommandClaim.unhandled(),
        repairRepositoryIdentities: () => ProjectOpeningCommandClaim.unhandled(),
        openProject: ({ localPath }) =>
          ProjectOpeningCommandClaim.handled({
            request: adaptOpenRequest(session.openProject(localPath)),
            failureMessage: "Could not open project",
          }),
        openWorkingTree: ({ localPath }) =>
          ProjectOpeningCommandClaim.handled({
            request: adaptOpenRequest(session.openWorkingTree(localPath)),
            failureMessage: "Could not open project",
          }),
        openBranchDiff: ({ localPath, branchName }) =>
          ProjectOpeningCommandClaim.handled({
            request: adaptOpenRequest(session.openBranchDiff(localPath, branchName)),
            failureMessage: "Could not resolve comparison branch",
          }),
        openLastCommit: ({ localPath }) =>
          ProjectOpeningCommandClaim.handled({
            request: adaptOpenRequest(session.openLastCommit(localPath)),
            failureMessage: "Could not open project",
          }),
        openRepositoryComparison: (comparison) =>
          ProjectOpeningCommandClaim.handled({
            request: adaptOpenRequest(session.openRepositoryComparison(comparison)),
            failureMessage: "Could not open repository comparison",
          }),
        openPullRequest: ({ localPath, number }) =>
          ProjectOpeningCommandClaim.handled({
            request: adaptOpenRequest(session.openPullRequest(localPath, number)),
            failureMessage: "Could not open repository pull requests",
          }),
      }),
    CommandPaletteItems,
  }))
  useProjectOpeningRuntimeRegistration(runtime, registrationToken)
  return null
}
