/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import { AISettings } from "@diffdash/domain/ai-settings"
import type { AppState } from "@diffdash/domain/app-state"
import { type HostedRepositoryLocator, RepositorySource } from "@diffdash/domain/git-provider"
import {
  ProjectWorkspaceActivityResolution,
  ProjectWorkspaceActivitySelection,
  type ProjectWorkspaceActivityId,
  type ProjectWorkspaceSurface,
  resolveProjectWorkspaceActivity,
  selectProjectWorkspaceActivity,
} from "@diffdash/domain/project-workspace"
import { RepositoryCheckoutPath, type Repo } from "@diffdash/domain/repository"
import { WebUrl } from "@diffdash/domain/web-url"
import type { AppUpdateState } from "@diffdash/protocol/app-update"
import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import { EMPTY_APP_PREREQUISITES } from "@diffdash/protocol/prerequisites"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { HashSet, Match, Option } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import {
  createElement,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { useTrustedExtensionRegistry } from "@/extensions/extension-registry-context"
import {
  type PendingProjectRemoteSelection,
  type ProjectOpeningResult,
  type ProjectOpeningRuntime,
  useProjectOpeningRuntime,
} from "@/extensions/project-opening-runtime"
import { RegisteredProjectSurface } from "@/extensions/project-surface-host"
import { ProjectSurfaceRuntimeProvider } from "@/extensions/project-surface-runtime"
import { ProjectRepositoryCapabilityProvider } from "@/extensions/project-repository-capability"
import { useProjectNavigationRuntime } from "@/extensions/project-navigation-runtime"
import { RegisteredProjectNavigationProviders } from "@/extensions/project-navigation-runtime"
import type {
  GlobalNavigationEntry,
  OwnedExtensionContribution,
  GlobalNavigationContribution,
  GlobalNavigationHostControls,
  ProjectActivityContribution,
  ProjectNavigationContribution,
  ProjectNavigationEntry,
  ProjectNavigationResult,
} from "@/extensions/extension-registry"
import { makeRequiredGlobalNavigationFallback } from "@/extensions/extension-registry"
import { TrustedProjectProviders } from "@/extensions/trusted-project-providers"
import { TrustedTitlebarActions } from "@/extensions/trusted-titlebar-actions"
import { diagnosticsAtom } from "@/onboarding/atoms"
import { OnboardingScreen } from "@/onboarding/onboarding-screen"
import {
  useDesktopRuntime,
  useRendererPreferences,
  useRendererStream,
  useRepositories,
  runRendererPromise,
} from "@/platform/renderer-runtime"
import { repositoriesAtom } from "@/repositories/atoms"
import { useRepositoryMutations } from "@/repositories/use-repository-mutations"
import { ProjectRemoteChooser } from "@/project-workspace/project-remote-chooser"
import {
  getSystemColorScheme,
  type ResolvedTheme,
  resolveThemePreference,
  THEME_DEFINITIONS,
} from "@/settings/theme"
import { useSettingsMutation } from "@/settings/use-settings-mutation"
import { useCaptureAnalytics } from "@/shared/analytics"
import { formatError } from "@/shared/errors"
import { Button } from "@/shared/ui/button"
import { EmptyState } from "@/shared/ui/empty-state"
import { FloatingPaneWorkspace } from "@/shared/ui/floating-pane"
import { UpdateBanner } from "@/shared/ui/update-banner"
import { CommandPaletteDialog, type CommandPaletteItem } from "./command-palette"
import { KeyboardShortcutReference } from "./keyboard-shortcut-reference"
import { useKeyboardShortcut } from "./keyboard-shortcuts"
import { WorkbenchContextActionsProvider } from "./workbench-context-actions"
import { WorkbenchTitlebar } from "./workbench-titlebar"
import {
  canNavigateHistoryBack,
  canNavigateHistoryForward,
  currentNavigationLocation,
  makeNavigationHistory,
  navigateHistoryBackToAvailable,
  navigateHistoryForwardToAvailable,
  pushNavigationLocation,
  removeNavigationLocations,
  replaceNavigationLocation,
  replaceUnavailableCurrentNavigationLocation,
  type NavigationHistory,
} from "./app-navigation-history"

type Screen = "global" | "project"
type AppNavigationLocation = GlobalNavigationEntry | ProjectNavigationEntry

const matchAppNavigationLocation = <Result,>(
  location: AppNavigationLocation,
  cases: {
    readonly global: (location: GlobalNavigationEntry) => Result
    readonly project: (location: ProjectNavigationEntry) => Result
  },
) =>
  Match.value(location).pipe(
    Match.when({ kind: "global" }, cases.global),
    Match.when({ kind: "project" }, cases.project),
    Match.exhaustive,
  )

const MOUSE_BUTTON_BACK = 3
const MOUSE_BUTTON_FORWARD = 4
const EMPTY_REPOS: readonly Repo[] = []
const sameAppNavigationLocation = (
  left: AppNavigationLocation,
  right: AppNavigationLocation,
  globalContributions: readonly OwnedExtensionContribution<GlobalNavigationContribution>[],
  contributions: readonly OwnedExtensionContribution<ProjectNavigationContribution>[],
  activities: readonly {
    readonly id: ProjectWorkspaceActivityId
    readonly ownerRegistrationToken: ProjectNavigationEntry["activityRegistrationToken"]
    readonly supportedSurfaces: readonly ProjectWorkspaceSurface[]
  }[],
): boolean => {
  return matchAppNavigationLocation(left, {
    global: (leftGlobal) =>
      matchAppNavigationLocation(right, {
        global: (rightGlobal) => {
          if (
            leftGlobal.contributionId !== rightGlobal.contributionId ||
            leftGlobal.registrationToken !== rightGlobal.registrationToken
          )
            return false
          const contribution = globalContributions.find(
            ({ id }) => id === leftGlobal.contributionId,
          )
          if (contribution?.ownerRegistrationToken !== leftGlobal.registrationToken) return false
          return contribution.sameState(leftGlobal.state, rightGlobal.state)
        },
        project: () => false,
      }),
    project: (leftProject) =>
      matchAppNavigationLocation(right, {
        global: () => false,
        project: (rightProject) => {
          if (
            leftProject.contributionId !== rightProject.contributionId ||
            leftProject.registrationToken !== rightProject.registrationToken ||
            leftProject.repo.id !== rightProject.repo.id ||
            leftProject.activityId !== rightProject.activityId ||
            leftProject.activityRegistrationToken !== rightProject.activityRegistrationToken ||
            leftProject.surface !== rightProject.surface
          )
            return false
          const contribution = contributions.find(({ id }) => id === leftProject.contributionId)
          const activity = activities.find(({ id }) => id === leftProject.activityId)
          if (
            contribution?.ownerRegistrationToken !== leftProject.registrationToken ||
            contribution.surface !== leftProject.surface ||
            activity?.ownerRegistrationToken !== leftProject.activityRegistrationToken ||
            !activity.supportedSurfaces.includes(leftProject.surface)
          )
            return false
          return contribution.sameState(leftProject.state, rightProject.state)
        },
      }),
  })
}

const isAppNavigationLocationAvailable = (
  location: AppNavigationLocation,
  globalContributions: readonly OwnedExtensionContribution<GlobalNavigationContribution>[],
  contributions: readonly OwnedExtensionContribution<ProjectNavigationContribution>[],
  activities: readonly {
    readonly id: ProjectWorkspaceActivityId
    readonly supportedSurfaces: readonly ProjectWorkspaceSurface[]
    readonly ownerRegistrationToken: ProjectNavigationEntry["activityRegistrationToken"]
  }[],
): boolean => {
  return matchAppNavigationLocation(location, {
    global: (globalLocation) => {
      const contribution = globalContributions.find(
        ({ id }) => id === globalLocation.contributionId,
      )
      return (
        contribution !== undefined &&
        contribution.ownerRegistrationToken === globalLocation.registrationToken &&
        contribution.isValidState(globalLocation.state)
      )
    },
    project: (projectLocation) => {
      const contribution = contributions.find(({ id }) => id === projectLocation.contributionId)
      const activity = activities.find(({ id }) => id === projectLocation.activityId)
      if (
        contribution === undefined ||
        contribution.ownerRegistrationToken !== projectLocation.registrationToken ||
        contribution.surface !== projectLocation.surface ||
        activity === undefined ||
        activity.ownerRegistrationToken !== projectLocation.activityRegistrationToken ||
        !activity.supportedSurfaces.includes(projectLocation.surface)
      )
        return false
      return contribution.isValidState(projectLocation.state)
    },
  })
}

const effectiveAvailableNavigationLocation = (
  current: AppNavigationLocation,
  globalContributions: readonly OwnedExtensionContribution<GlobalNavigationContribution>[],
  navigationContributions: readonly OwnedExtensionContribution<ProjectNavigationContribution>[],
  activities: readonly OwnedExtensionContribution<ProjectActivityContribution>[],
): AppNavigationLocation => {
  if (
    isAppNavigationLocationAvailable(
      current,
      globalContributions,
      navigationContributions,
      activities,
    )
  ) {
    return current
  }

  return matchAppNavigationLocation(current, {
    global: makeRequiredGlobalNavigationFallback,
    project: (projectLocation) => {
      const currentNavigationOwner = navigationContributions.find(
        (contribution) =>
          contribution.id === projectLocation.contributionId &&
          contribution.ownerRegistrationToken === projectLocation.registrationToken &&
          contribution.surface === projectLocation.surface,
      )
      const repairActivities = activities.filter(
        (activity) =>
          activity.id !== projectLocation.activityId ||
          activity.ownerRegistrationToken === projectLocation.activityRegistrationToken,
      )
      const resolution = resolveProjectWorkspaceActivity(
        ProjectWorkspaceActivitySelection.make({
          activeSurface: projectLocation.surface,
          activeActivity: projectLocation.activityId,
        }),
        repairActivities.map((activity) => ({
          id: activity.id,
          ownerRegistrationToken: activity.ownerRegistrationToken,
          supportedSurfaces: activity.supportedSurfaces,
          defaultForSurfaces: activity.defaultForSurfaces ?? [],
        })),
      )
      const repairedSelection = ProjectWorkspaceActivityResolution.match(resolution, {
        available: ({ selection }) => selection,
        repaired: ({ selection }) => selection,
        unresolved: () => null,
      })
      const repairedActivity =
        repairedSelection === null
          ? undefined
          : activities.find(({ id }) => id === repairedSelection.activeActivity)
      if (
        repairedSelection !== null &&
        repairedSelection.activeSurface === currentNavigationOwner?.surface &&
        repairedActivity !== undefined
      ) {
        return {
          ...projectLocation,
          activityId: repairedActivity.id,
          activityRegistrationToken: repairedActivity.ownerRegistrationToken,
          state: currentNavigationOwner.createDefaultState(projectLocation.repo),
        }
      }

      const fallbackActivity =
        activities.find((activity) => activity.defaultForSurfaces?.length !== 0) ??
        activities.find((activity) => activity.supportedSurfaces.length !== 0)
      const fallbackContribution =
        fallbackActivity === undefined
          ? undefined
          : navigationContributions.find((contribution) =>
              fallbackActivity.supportedSurfaces.includes(contribution.surface),
            )
      if (fallbackActivity === undefined || fallbackContribution === undefined) {
        return makeRequiredGlobalNavigationFallback()
      }
      return {
        kind: "project",
        contributionId: fallbackContribution.id,
        registrationToken: fallbackContribution.ownerRegistrationToken,
        activityId: fallbackActivity.id,
        activityRegistrationToken: fallbackActivity.ownerRegistrationToken,
        surface: fallbackContribution.surface,
        repo: projectLocation.repo,
        state: fallbackContribution.createDefaultState(projectLocation.repo),
      }
    },
  })
}
/** Application shell coordinating navigation and feature composition. */
export function AppShell() {
  const captureAnalytics = useCaptureAnalytics()
  const desktop = useDesktopRuntime()
  const preferences = useRendererPreferences()
  const projectOpening = useProjectOpeningRuntime()
  const projectOpeningRef = useRef(projectOpening)
  projectOpeningRef.current = projectOpening
  const repositories = useRepositories()
  const {
    globalNavigation,
    projectActivities,
    projectNavigation,
    projectProviders,
    projectSurfaces,
    titlebarActions,
  } = useTrustedExtensionRegistry()
  const projectNavigationRuntime = useProjectNavigationRuntime()
  const projectActivitiesRef = useRef(projectActivities)
  projectActivitiesRef.current = projectActivities
  const projectNavigationRef = useRef(projectNavigation)
  projectNavigationRef.current = projectNavigation
  const globalNavigationRef = useRef(globalNavigation)
  globalNavigationRef.current = globalNavigation
  const fallbackNavigationLocation = makeRequiredGlobalNavigationFallback
  const [screen, setScreen] = useState<Screen>("global")
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)
  const [activeSurface, setActiveSurface] = useState<ProjectWorkspaceSurface | null>(null)
  const [activeActivity, setActiveActivity] = useState<Option.Option<ProjectWorkspaceActivityId>>(
    Option.none,
  )
  const initialNavigationHistory = makeNavigationHistory<AppNavigationLocation>(
    fallbackNavigationLocation(),
  )
  const navigationHistoryRef =
    useRef<NavigationHistory<AppNavigationLocation>>(initialNavigationHistory)
  const [navigationHistory, setNavigationHistory] = useState(initialNavigationHistory)
  const [workspaceNotice, setWorkspaceNotice] = useState<Option.Option<string>>(Option.none)
  const [workspaceRestoring, setWorkspaceRestoring] = useState(false)
  const [workspaceRepairPersistenceRequest, setWorkspaceRepairPersistenceRequest] = useState(0)
  const [pendingRemoteSelection, setPendingRemoteSelection] =
    useState<PendingProjectRemoteSelection | null>(null)
  const projectOpenRequestRef = useRef(0)
  const [sidebarExpanded, setSidebarExpanded] = useState(true)
  const [projectQuickNavigationRequest, setProjectQuickNavigationRequest] = useState(0)
  const [visitedSurfaces, setVisitedSurfaces] = useState(HashSet.empty<string>())
  const [contextActionsHost, setContextActionsHost] = useState<HTMLDivElement | null>(null)
  const handledMouseNavigationButtonRef = useRef<number | null>(null)
  const [actionStatus, setActionStatus] = useState("Search a repo or open a bookmark.")
  const [cliNavigationError, setCliNavigationError] = useState<string | null>(null)
  const [setupActionStatus, setSetupActionStatus] = useState<string | null>(null)
  const [isRepairingIdentities, setIsRepairingIdentities] = useState(false)
  const [appState, setAppState] = useState<AppState | null>(null)
  const [appStateLoadAttempt, setAppStateLoadAttempt] = useState(0)
  const [appStateLoadError, setAppStateLoadError] = useState<string | null>(null)
  const settingsMutation = useSettingsMutation()
  const aiSettings = settingsMutation.settings
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveThemePreference(aiSettings.appearance, aiSettings.themes, getSystemColorScheme()),
  )
  const [goToPaletteOpen, setGoToPaletteOpen] = useState(false)
  const [shortcutReferenceOpen, setShortcutReferenceOpen] = useState(false)
  const [updateState, setUpdateState] = useState<AppUpdateState | null>(null)
  useRendererStream(desktop.updates.states, setUpdateState, (error) =>
    setActionStatus(formatError(error, "Could not monitor application updates")),
  )

  const repositoriesResult = useAtomValue(repositoriesAtom)
  const diagnosticsResult = useAtomValue(diagnosticsAtom)
  const refreshRepositories = useAtomRefresh(repositoriesAtom)
  const refreshDiagnostics = useAtomRefresh(diagnosticsAtom)
  const repositoryMutations = useRepositoryMutations({
    repositories: refreshRepositories,
    localSearch: () => undefined,
    remoteSearch: () => undefined,
    selectedReviews: () => undefined,
  })

  const repos = AsyncResult.getOrElse(repositoriesResult, () => EMPTY_REPOS)
  const diagnostics = AsyncResult.getOrElse(diagnosticsResult, () => EMPTY_APP_PREREQUISITES)
  const isLoadingDiagnostics = AsyncResult.isWaiting(diagnosticsResult)
  const applyNavigationLocation = (location: AppNavigationLocation): boolean => {
    return matchAppNavigationLocation(location, {
      global: (globalLocation) => {
        if (
          !isAppNavigationLocationAvailable(
            globalLocation,
            globalNavigationRef.current,
            projectNavigationRef.current,
            projectActivitiesRef.current,
          )
        )
          return false
        setScreen("global")
        setSelectedRepo(null)
        setActiveSurface(null)
        setActiveActivity(Option.none())
        setWorkspaceNotice(Option.none())
        return true
      },
      project: (projectLocation) => {
        if (
          !isAppNavigationLocationAvailable(
            projectLocation,
            globalNavigationRef.current,
            projectNavigationRef.current,
            projectActivitiesRef.current,
          ) ||
          !projectNavigationRuntime.restore(projectLocation)
        )
          return false
        const contribution = projectNavigationRef.current.find(
          ({ id }) => id === projectLocation.contributionId,
        )
        if (contribution === undefined) return false
        setScreen("project")
        setSelectedRepo(projectLocation.repo)
        setActiveSurface(projectLocation.surface)
        setVisitedSurfaces((surfaces) =>
          HashSet.add(
            surfaces,
            `${projectLocation.surface}:${projectLocation.registrationToken.reactKey}`,
          ),
        )
        setActiveActivity(Option.some(projectLocation.activityId))
        return true
      },
    })
  }

  const setHistory = (history: NavigationHistory<AppNavigationLocation>) => {
    navigationHistoryRef.current = history
    setNavigationHistory(history)
  }
  const pushAppNavigationLocation = (location: AppNavigationLocation): boolean => {
    if (!applyNavigationLocation(location)) return false
    const next = pushNavigationLocation(navigationHistoryRef.current, location, (left, right) =>
      sameAppNavigationLocation(
        left,
        right,
        globalNavigationRef.current,
        projectNavigationRef.current,
        projectActivitiesRef.current,
      ),
    )
    setHistory(next)
    return true
  }
  const replaceAppNavigationLocation = (location: AppNavigationLocation, apply = true): boolean => {
    if (apply && !applyNavigationLocation(location)) return false
    const next = replaceNavigationLocation(navigationHistoryRef.current, location)
    setHistory(next)
    return true
  }
  const reconcileRegisteredProjectActivities = useEffectEvent(() => {
    const previousHistory = navigationHistoryRef.current
    const previousCurrent = currentNavigationLocation(previousHistory)
    const isAvailable = (location: AppNavigationLocation) =>
      isAppNavigationLocationAvailable(
        location,
        globalNavigation,
        projectNavigation,
        projectActivities,
      )
    if (isAvailable(previousCurrent)) return
    const replacement = effectiveAvailableNavigationLocation(
      previousCurrent,
      globalNavigation,
      projectNavigation,
      projectActivities,
    )
    const reconciledHistory = replaceUnavailableCurrentNavigationLocation(
      previousHistory,
      isAvailable,
      () => replacement,
    )
    setHistory(reconciledHistory)
    if (screen !== "project" || selectedRepo === null) return
    const current = currentNavigationLocation(reconciledHistory)
    applyNavigationLocation(current)
    matchAppNavigationLocation(current, {
      global: () => undefined,
      project: () => {
        setWorkspaceRepairPersistenceRequest((request) => request + 1)
        setWorkspaceNotice(
          Option.some(
            "The active workspace extension is unavailable. A registered activity was restored instead.",
          ),
        )
      },
    })
  })

  useLayoutEffect(() => {
    reconcileRegisteredProjectActivities()
  }, [globalNavigation, projectActivities, projectNavigation])

  const navigateBack = () => {
    projectOpenRequestRef.current += 1
    setPendingRemoteSelection(null)
    projectOpening?.cancelRestore()
    const current = navigationHistoryRef.current
    const next = navigateHistoryBackToAvailable(current, (location) =>
      isAppNavigationLocationAvailable(
        location,
        globalNavigation,
        projectNavigation,
        projectActivities,
      ),
    )
    if (next === current) return
    const location = currentNavigationLocation(next)
    if (applyNavigationLocation(location)) setHistory(next)
  }
  const navigateForward = () => {
    projectOpenRequestRef.current += 1
    setPendingRemoteSelection(null)
    projectOpening?.cancelRestore()
    const current = navigationHistoryRef.current
    const next = navigateHistoryForwardToAvailable(current, (location) =>
      isAppNavigationLocationAvailable(
        location,
        globalNavigation,
        projectNavigation,
        projectActivities,
      ),
    )
    if (next === current) return
    const location = currentNavigationLocation(next)
    if (applyNavigationLocation(location)) setHistory(next)
  }
  const navigateBackFromEffect = useEffectEvent(navigateBack)
  const navigateForwardFromEffect = useEffectEvent(navigateForward)

  useEffect(() => {
    refreshRepositories()
    refreshDiagnostics()
  }, [refreshDiagnostics, refreshRepositories])

  useEffect(() => {
    let cancelled = false
    runRendererPromise(preferences.loadAppState())
      .then((state) => {
        if (!cancelled) setAppState(state)
        return undefined
      })
      .catch((error) => {
        if (!cancelled) {
          setAppStateLoadError(formatError(error, "Could not load application state"))
        }
      })

    return () => {
      cancelled = true
    }
  }, [appStateLoadAttempt, preferences])

  useEffect(() => {
    if (appState?.onboardingCompleted !== true) return
    void runRendererPromise(desktop.analytics.start()).catch(() => undefined)
  }, [appState?.onboardingCompleted, desktop])

  useEffect(() => {
    const applyTheme = () => {
      const nextResolvedTheme = resolveThemePreference(
        aiSettings.appearance,
        aiSettings.themes,
        getSystemColorScheme(),
      )
      const definition = THEME_DEFINITIONS[nextResolvedTheme]
      setResolvedTheme(nextResolvedTheme)
      document.documentElement.dataset.theme = nextResolvedTheme
      document.documentElement.classList.toggle("dark", definition.colorScheme === "dark")
      document.documentElement.style.colorScheme = definition.colorScheme
    }

    applyTheme()
    if (aiSettings.appearance !== "system") return undefined

    const media = window.matchMedia("(prefers-color-scheme: dark)")
    media.addEventListener("change", applyTheme)
    return () => media.removeEventListener("change", applyTheme)
  }, [aiSettings.appearance, aiSettings.themes])

  useEffect(() => {
    if (settingsMutation.status !== null) setActionStatus(settingsMutation.status)
  }, [settingsMutation.status])

  useEffect(() => {
    if (
      setupActionStatus === "Rechecking setup..." &&
      !isLoadingDiagnostics &&
      diagnostics.checkedAt.length > 0
    ) {
      setSetupActionStatus("Setup status refreshed.")
    }
  }, [diagnostics.checkedAt, isLoadingDiagnostics, setupActionStatus])

  useEffect(() => {
    const navigateFromMouseButton = (event: MouseEvent) => {
      if (event.button !== MOUSE_BUTTON_BACK && event.button !== MOUSE_BUTTON_FORWARD) return

      event.preventDefault()
      event.stopPropagation()
      handledMouseNavigationButtonRef.current = event.button
      if (event.button === MOUSE_BUTTON_BACK) navigateBackFromEffect()
      else navigateForwardFromEffect()
    }
    const suppressHandledAuxClick = (event: MouseEvent) => {
      if (event.button !== MOUSE_BUTTON_BACK && event.button !== MOUSE_BUTTON_FORWARD) return

      event.preventDefault()
      event.stopPropagation()
      if (handledMouseNavigationButtonRef.current === event.button) {
        handledMouseNavigationButtonRef.current = null
      }
    }

    window.addEventListener("mousedown", navigateFromMouseButton, true)
    window.addEventListener("auxclick", suppressHandledAuxClick, true)
    return () => {
      window.removeEventListener("mousedown", navigateFromMouseButton, true)
      window.removeEventListener("auxclick", suppressHandledAuxClick, true)
    }
  }, [])

  useKeyboardShortcut("shortcuts.open", () => setShortcutReferenceOpen(true))
  useKeyboardShortcut("navigation.goAnywhere", () => setGoToPaletteOpen(true), {
    enabled: screen !== "project",
  })

  const applyProjectProjection = (
    projection: ProjectNavigationResult,
    mode: "push" | "replace" = "push",
  ): boolean => {
    const contribution = projectNavigationRef.current.find(
      (candidate) =>
        candidate.id === projection.contributionId &&
        candidate.ownerRegistrationToken === projection.registrationToken &&
        candidate.surface === projection.activeSurface &&
        candidate.isValidState(projection.state),
    )
    const activity = projectActivitiesRef.current.find(
      (candidate) =>
        candidate.id === projection.activeActivity &&
        candidate.ownerRegistrationToken === projection.activityRegistrationToken &&
        candidate.supportedSurfaces.includes(projection.activeSurface),
    )
    if (contribution === undefined || activity === undefined) return false
    const location: AppNavigationLocation = {
      kind: "project",
      contributionId: contribution.id,
      registrationToken: contribution.ownerRegistrationToken,
      activityId: projection.activeActivity,
      activityRegistrationToken: projection.activityRegistrationToken,
      surface: projection.activeSurface,
      repo: projection.repo,
      state: projection.state,
    }
    const applied =
      mode === "replace"
        ? replaceAppNavigationLocation(location)
        : pushAppNavigationLocation(location)
    if (!applied) return false
    setWorkspaceNotice(projection.notice)
    setSidebarExpanded(true)
    setActionStatus(`Opened project ${projection.repo.displayIdentity}.`)
    return true
  }

  const observeWorkspacePersistence = (persistence: Promise<void | boolean>) => {
    void persistence.catch((error) => {
      setWorkspaceNotice(Option.some(formatError(error, "Could not save project workspace")))
    })
  }
  const persistActiveWorkspace = (
    repo: Repo,
    contributionId: ProjectNavigationResult["contributionId"],
    registrationToken: ProjectNavigationResult["registrationToken"],
    surface: ProjectWorkspaceSurface,
    activity: ProjectWorkspaceActivityId,
    activityRegistrationToken: ProjectNavigationResult["activityRegistrationToken"],
    state: ProjectNavigationEntry["state"],
  ) => {
    const contribution = projectNavigationRef.current.find(
      (candidate) =>
        candidate.id === contributionId &&
        candidate.ownerRegistrationToken === registrationToken &&
        candidate.surface === surface &&
        candidate.isValidState(state),
    )
    const registeredActivity = projectActivitiesRef.current.find(
      (candidate) =>
        candidate.id === activity &&
        candidate.ownerRegistrationToken === activityRegistrationToken &&
        candidate.supportedSurfaces.includes(surface),
    )
    if (contribution === undefined || registeredActivity === undefined) return
    if (projectOpening === null) return
    observeWorkspacePersistence(
      projectOpening.persistLocation({
        repo,
        contributionId: contribution.id,
        registrationToken,
        activeSurface: surface,
        activeActivity: activity,
        activityRegistrationToken,
        state,
        notice: Option.none(),
      }),
    )
  }
  const persistRepairedWorkspace = useEffectEvent(() => {
    if (
      screen !== "project" ||
      selectedRepo === null ||
      activeSurface === null ||
      Option.isNone(activeActivity)
    )
      return
    const location = currentNavigationLocation(navigationHistoryRef.current)
    matchAppNavigationLocation(location, {
      global: () => undefined,
      project: (projectLocation) =>
        persistActiveWorkspace(
          selectedRepo,
          projectLocation.contributionId,
          projectLocation.registrationToken,
          activeSurface,
          activeActivity.value,
          projectLocation.activityRegistrationToken,
          projectLocation.state,
        ),
    })
  })
  useEffect(() => {
    if (workspaceRepairPersistenceRequest > 0) persistRepairedWorkspace()
  }, [workspaceRepairPersistenceRequest])

  const restoreProject = async (repo: Repo) => {
    const request = projectOpenRequestRef.current + 1
    projectOpenRequestRef.current = request
    setWorkspaceRestoring(true)
    setPendingRemoteSelection(null)
    const finishRestoration = () => {
      if (projectOpenRequestRef.current === request) setWorkspaceRestoring(false)
    }
    const opening = projectOpeningRef.current
    if (opening === null) {
      finishRestoration()
      setActionStatus("Project opening is unavailable.")
      applyNavigationLocation(fallbackNavigationLocation())
      return
    }
    const initial = opening.initial(repo)
    if (Option.isNone(initial)) {
      finishRestoration()
      applyNavigationLocation(fallbackNavigationLocation())
      return
    }
    if (!applyProjectProjection(initial.value)) {
      finishRestoration()
      return
    }
    setActionStatus(`Restoring ${repo.displayIdentity}...`)
    try {
      const restored = await opening.restore(repo)
      if (projectOpeningRef.current !== opening || projectOpenRequestRef.current !== request) return
      Match.valueTags(restored, {
        stale: () => undefined,
        unavailable: () => applyNavigationLocation(fallbackNavigationLocation()),
        restored: (value) => {
          if (!applyProjectProjection(value.projection, "replace")) return
          Option.map(value.persistence, (persist) => observeWorkspacePersistence(persist()))
        },
      })
    } catch (error) {
      if (projectOpeningRef.current !== opening || projectOpenRequestRef.current !== request) return
      const fallback = opening.defaultProject(
        repo,
        Option.some(formatError(error, "Saved workspace state could not be restored")),
      )
      Option.map(fallback, (projection) => applyProjectProjection(projection, "replace"))
    } finally {
      finishRestoration()
    }
  }

  const updateProjectActivity = (activityId: ProjectWorkspaceActivityId) => {
    projectOpenRequestRef.current += 1
    setWorkspaceRestoring(false)
    setPendingRemoteSelection(null)
    const activity = projectActivities.find((candidate) => candidate.id === activityId)
    if (activity === undefined) return
    projectOpening?.cancelRestore()
    if (selectedRepo === null || activeSurface === null) return
    const selection = selectProjectWorkspaceActivity(
      ProjectWorkspaceActivitySelection.make({
        activeSurface,
        activeActivity: Option.getOrElse(activeActivity, () => activityId),
      }),
      activityId,
      activity.surfacePolicy,
    )
    const currentLocation = currentNavigationLocation(navigationHistoryRef.current)
    const navigationRegistration = projectNavigation.find(
      (contribution) => contribution.surface === selection.activeSurface,
    )
    const activityRegistration = projectActivities.find(
      (candidate) => candidate.id === selection.activeActivity,
    )
    if (navigationRegistration === undefined || activityRegistration === undefined) return
    const currentProjectLocation = matchAppNavigationLocation(currentLocation, {
      global: () => undefined,
      project: (projectLocation) =>
        projectLocation.contributionId === navigationRegistration.id &&
        projectLocation.repo.id === selectedRepo.id
          ? projectLocation
          : undefined,
    })
    let location: AppNavigationLocation
    if (currentProjectLocation !== undefined) {
      location = {
        ...currentProjectLocation,
        activityId: selection.activeActivity,
        activityRegistrationToken: activityRegistration.ownerRegistrationToken,
      }
    } else {
      const previousOwnerLocation = navigationHistoryRef.current.entries.reduceRight<
        ProjectNavigationEntry | undefined
      >(
        (found, entry) =>
          found ??
          matchAppNavigationLocation(entry, {
            global: () => undefined,
            project: (projectEntry) =>
              projectEntry.contributionId === navigationRegistration.id &&
              projectEntry.registrationToken === navigationRegistration.ownerRegistrationToken &&
              projectEntry.repo.id === selectedRepo.id
                ? projectEntry
                : undefined,
          }),
        undefined,
      )
      location = {
        kind: "project",
        contributionId: navigationRegistration.id,
        registrationToken: navigationRegistration.ownerRegistrationToken,
        activityId: selection.activeActivity,
        activityRegistrationToken: activityRegistration.ownerRegistrationToken,
        surface: selection.activeSurface,
        repo: selectedRepo,
        state:
          previousOwnerLocation !== undefined
            ? previousOwnerLocation.state
            : navigationRegistration.createDefaultState(selectedRepo),
      }
    }
    pushAppNavigationLocation(location)
    if (selectedRepo !== null) {
      persistActiveWorkspace(
        selectedRepo,
        navigationRegistration.id,
        navigationRegistration.ownerRegistrationToken,
        selection.activeSurface,
        selection.activeActivity,
        activityRegistration.ownerRegistrationToken,
        location.state,
      )
    }
  }

  const applyProjectOpen = async (
    opening: ProjectOpeningRuntime,
    request: Promise<ProjectOpeningResult>,
    fallback = "Could not open project",
  ) => {
    const generation = projectOpenRequestRef.current + 1
    projectOpenRequestRef.current = generation
    setPendingRemoteSelection(null)
    setActionStatus("Opening project...")
    try {
      const result = await request
      if (projectOpeningRef.current !== opening || projectOpenRequestRef.current !== generation)
        return
      Match.valueTags(result, {
        remoteSelectionRequired: ({ pending }) => setPendingRemoteSelection(pending),
        unavailable: () => applyNavigationLocation(fallbackNavigationLocation()),
        opened: (opened) => {
          setPendingRemoteSelection(null)
          refreshRepositories()
          if (applyProjectProjection(opened.projection))
            observeWorkspacePersistence(opened.persistence())
        },
      })
    } catch (error) {
      if (projectOpeningRef.current !== opening || projectOpenRequestRef.current !== generation)
        return
      const message = formatError(error, fallback)
      setActionStatus(message)
      setCliNavigationError(message)
    }
  }

  const repairRepositoryIdentities = async () => {
    if (isRepairingIdentities) return
    setIsRepairingIdentities(true)
    setActionStatus("Repairing project identities...")
    try {
      const result = await runRendererPromise(repositories.repairIdentities())
      refreshRepositories()
      setActionStatus(
        `Repaired ${result.resolvedCount + result.localAliasCount} project identities; ${result.unresolvedCount} will retry when providers are available.`,
      )
    } catch (error) {
      const message = formatError(error, "Could not repair project identities")
      setActionStatus(message)
      setCliNavigationError(message)
    } finally {
      setIsRepairingIdentities(false)
    }
  }

  const installRepositoryLink = async (localPath: string) => {
    projectOpenRequestRef.current += 1
    setPendingRemoteSelection(null)
    projectOpening?.cancelRestore()
    setCliNavigationError(null)
    setActionStatus("Linking local repository...")
    try {
      const linked = await repositoryMutations.install(localPath)
      setActionStatus(`Linked ${linked.displayIdentity} to ${linked.localPath ?? localPath}.`)
      captureAnalytics({ event: "repository_linked" })
      const opening = projectOpeningRef.current
      if (opening === null) return
      const projection = opening.defaultProject(linked, Option.none())
      if (Option.isNone(projection)) return
      if (applyProjectProjection(projection.value)) {
        observeWorkspacePersistence(opening.persist(projection.value))
      }
    } catch (error) {
      const message = formatError(error, "Could not link local repository")
      setActionStatus(message)
      setCliNavigationError(message)
    }
  }
  const handleCliNavigationCommand = async (command: CliNavigationCommand) => {
    const hostHandled = await Match.value(command).pipe(
      Match.when({ _tag: "error" }, (error) => {
        projectOpenRequestRef.current += 1
        setPendingRemoteSelection(null)
        setActionStatus(error.message)
        setCliNavigationError(error.message)
        return true
      }),
      Match.when({ _tag: "linkRepository" }, async (linkRepository) => {
        setCliNavigationError(null)
        await installRepositoryLink(linkRepository.localPath)
        return true
      }),
      Match.when({ _tag: "repairRepositoryIdentities" }, async () => {
        setCliNavigationError(null)
        await repairRepositoryIdentities()
        return true
      }),
      Match.orElse(() => false),
    )
    if (hostHandled) return
    const opening = projectOpeningRef.current
    if (opening === null) {
      const message = "No project-opening extension is available."
      setActionStatus(message)
      setCliNavigationError(message)
      return
    }
    await Match.valueTags(opening.claimCommand(command), {
      handled: async ({ request, failureMessage }) => {
        setCliNavigationError(null)
        await applyProjectOpen(opening, request, failureMessage)
      },
      unhandled: () => {
        const message = "The active project-opening extension did not handle this command."
        setActionStatus(message)
        setCliNavigationError(message)
      },
    })
  }
  const linkHostedRepository = async (repository: HostedRepositoryLocator) => {
    const linkingProjectId = Option.map(Option.fromNullishOr(selectedRepo), ({ id }) => id)
    const localPathOption = await runRendererPromise(repositories.selectLocalFolder())
    if (Option.isNone(localPathOption)) return false
    const localPath = localPathOption.value

    const linked = await repositoryMutations.link({
      repository,
      localPath: RepositoryCheckoutPath.make(localPath),
    })
    setSelectedRepo((currentRepo) =>
      Option.match(Option.fromNullishOr(currentRepo), {
        onNone: () => null,
        onSome: (current) =>
          Option.match(linkingProjectId, {
            onNone: () => current,
            onSome: (projectId) =>
              RepositorySource.match(linked.source, {
                local: () => current,
                hosted: ({ locator }) =>
                  current.id === projectId && current.matchesHosted(locator) ? linked : current,
              }),
          }),
      }),
    )
    Option.map(linkingProjectId, (projectId) => {
      const entries = navigationHistoryRef.current.entries.map((location) =>
        matchAppNavigationLocation<AppNavigationLocation>(location, {
          global: (globalLocation) => globalLocation,
          project: (projectLocation) => {
            if (projectLocation.repo.id !== projectId) return projectLocation
            return RepositorySource.match(linked.source, {
              local: () => projectLocation,
              hosted: ({ locator }) => {
                if (!projectLocation.repo.matchesHosted(locator)) return projectLocation
                return { ...projectLocation, repo: linked }
              },
            })
          },
        }),
      )
      setHistory({ ...navigationHistoryRef.current, entries })
    })
    setActionStatus(`Linked ${linked.displayIdentity} to ${linked.localPath ?? localPath}.`)
    captureAnalytics({ event: "repository_linked" })
    return true
  }
  const linkSelectedProjectRepository = () =>
    Option.match(Option.fromNullishOr(selectedRepo), {
      onNone: () => Promise.resolve(false),
      onSome: (repo) =>
        RepositorySource.match(repo.source, {
          local: () => Promise.resolve(false),
          hosted: ({ locator }) => linkHostedRepository(locator),
        }),
    })

  useRendererStream(desktop.navigation.commands, handleCliNavigationCommand, (error) =>
    setCliNavigationError(formatError(error, "Could not receive CLI navigation commands")),
  )

  const recheckPrerequisites = () => {
    setSetupActionStatus("Rechecking setup...")
    refreshDiagnostics()
  }

  const openSetupDocs = (url: string) => {
    void runRendererPromise(desktop.openExternalUrl(WebUrl.make(url))).catch((error) => {
      setSetupActionStatus(formatError(error, "Could not open setup documentation"))
    })
  }

  const installDiffDashCli = async () => {
    setSetupActionStatus("Installing the DiffDash CLI...")
    try {
      const result = await runRendererPromise(desktop.installCli())
      setSetupActionStatus(
        result.pathSetupCommand === null
          ? `Installed the DiffDash CLI at ${result.path}`
          : `Installed the DiffDash CLI at ${result.path}. For terminal access, add it to your shell with: ${result.pathSetupCommand}`,
      )
      refreshDiagnostics()
    } catch (error) {
      setSetupActionStatus(formatError(error, "Could not install the DiffDash CLI"))
    }
  }

  const completeOnboarding = async (telemetryEnabled: boolean) => {
    const nextState: AppState = { onboardingCompleted: true }
    try {
      await settingsMutation.update(
        AISettings.make({
          ...aiSettings,
          telemetryEnabled,
        }),
      )
      const savedState = await runRendererPromise(preferences.saveAppState(nextState))
      setAppState(savedState)
      if (telemetryEnabled) {
        await runRendererPromise(desktop.analytics.start())
        await runRendererPromise(desktop.analytics.capture({ event: "onboarding_completed" }))
      }
    } catch (error) {
      setSetupActionStatus(formatError(error, "Could not save onboarding state"))
    }
  }

  const currentHistoryLocation = currentNavigationLocation(navigationHistory)
  const currentHistoryLocationAvailable = isAppNavigationLocationAvailable(
    currentHistoryLocation,
    globalNavigation,
    projectNavigation,
    projectActivities,
  )
  const effectiveNavigationLocation = effectiveAvailableNavigationLocation(
    currentHistoryLocation,
    globalNavigation,
    projectNavigation,
    projectActivities,
  )
  const effectiveProjectLocation = matchAppNavigationLocation(effectiveNavigationLocation, {
    global: () => null,
    project: (location) => location,
  })
  const effectiveSelectedRepo = effectiveProjectLocation?.repo ?? null
  const effectiveActiveSurface = effectiveProjectLocation?.surface ?? null
  const effectiveActiveActivity = effectiveProjectLocation?.activityId ?? null
  const showProjectShell =
    appState?.onboardingCompleted === true && effectiveProjectLocation !== null
  const commandLabel = effectiveSelectedRepo?.displayIdentity ?? "DiffDash"
  const canNavigateBack =
    appState?.onboardingCompleted === true && canNavigateHistoryBack(navigationHistory)
  const canNavigateForward =
    appState?.onboardingCompleted === true && canNavigateHistoryForward(navigationHistory)
  const openQuickNavigation = () => {
    if (showProjectShell) {
      setProjectQuickNavigationRequest((request) => request + 1)
      return
    }
    setGoToPaletteOpen(true)
  }
  const globalNavigationHost: GlobalNavigationHostControls = {
    openProject: restoreProject,
    openProjectDirectory: async (directory) => {
      setCliNavigationError(null)
      const opening = projectOpeningRef.current
      if (opening === null) {
        setActionStatus("Project opening is unavailable.")
        return
      }
      await applyProjectOpen(opening, opening.openProject(directory))
    },
    removeProjectHistory: (projectId) => {
      projectOpenRequestRef.current += 1
      setPendingRemoteSelection(null)
      const shouldRemove = (location: AppNavigationLocation) =>
        matchAppNavigationLocation(location, {
          global: () => false,
          project: (projectLocation) => projectLocation.repo.id === projectId,
        })
      const nextHistory = removeNavigationLocations(
        navigationHistoryRef.current,
        shouldRemove,
        fallbackNavigationLocation(),
      )
      setHistory(nextHistory)
      applyNavigationLocation(currentNavigationLocation(nextHistory))
    },
  }
  const renderActiveGlobalDestination = (): ReactNode => {
    return matchAppNavigationLocation(effectiveNavigationLocation, {
      global: (globalLocation) => {
        const contribution = globalNavigation.find(
          ({ id, ownerRegistrationToken }) =>
            id === globalLocation.contributionId &&
            ownerRegistrationToken === globalLocation.registrationToken,
        )
        if (contribution === undefined || !contribution.isValidState(globalLocation.state)) {
          return null
        }
        return createElement(contribution.component, {
          key: contribution.ownerRegistrationToken.reactKey,
          state: globalLocation.state,
          host: globalNavigationHost,
        })
      },
      project: () => null,
    })
  }
  const renderCommandPalette = (ownerItems: readonly CommandPaletteItem[]): ReactNode => (
    <CommandPaletteDialog
      items={goToPaletteItems({
        projects: repos,
        onOpenRepo: (repo) => void restoreProject(repo),
      }).concat(ownerItems)}
      open={goToPaletteOpen}
      placeholder="Search projects and destinations"
      title="Go anywhere"
      onOpenChange={setGoToPaletteOpen}
    />
  )
  const renderGlobalContent = (): ReactNode => renderActiveGlobalDestination()
  const renderProjectContent = (): ReactNode => {
    if (
      effectiveSelectedRepo === null ||
      effectiveActiveActivity === null ||
      effectiveActiveSurface === null ||
      effectiveProjectLocation === null
    ) {
      return renderGlobalContent()
    }
    return (
      <ProjectRepositoryCapabilityProvider
        value={{
          link: (repository) => {
            if (repository === undefined) return linkSelectedProjectRepository()
            return linkHostedRepository(repository)
          },
        }}
      >
        <ProjectSurfaceRuntimeProvider
          value={{
            repo: effectiveSelectedRepo,
            activeActivity: effectiveActiveActivity,
            activeSurface: effectiveActiveSurface,
            activities: projectActivities,
            colorScheme: THEME_DEFINITIONS[resolvedTheme].colorScheme,
            sidebarExpanded,
            workspaceRestoring,
            workspaceNotice,
            quickNavigationRequest: projectQuickNavigationRequest,
            navigate: (contribution, activityId, state, mode = "push") => {
              projectOpenRequestRef.current += 1
              setWorkspaceRestoring(false)
              setPendingRemoteSelection(null)
              const activity = projectActivitiesRef.current.find(
                (candidate) => candidate.id === activityId,
              )
              if (activity === undefined) return false
              const location: AppNavigationLocation = {
                kind: "project",
                contributionId: contribution.id,
                registrationToken: contribution.ownerRegistrationToken,
                activityId,
                activityRegistrationToken: activity.ownerRegistrationToken,
                surface: contribution.surface,
                repo: effectiveSelectedRepo,
                state,
              }
              if (mode === "replace") return replaceAppNavigationLocation(location)
              return pushAppNavigationLocation(location)
            },
            persistLocation: async (contribution, activity, state) => {
              const currentContribution = projectNavigationRef.current.find(
                (candidate) =>
                  candidate.id === contribution.id &&
                  candidate.surface === contribution.surface &&
                  candidate.ownerRegistrationToken === contribution.ownerRegistrationToken &&
                  candidate.isValidState(state),
              )
              const currentActivity = projectActivitiesRef.current.find(
                (candidate) =>
                  candidate.id === activity.id &&
                  candidate.ownerRegistrationToken === activity.ownerRegistrationToken &&
                  candidate.supportedSurfaces.includes(currentContribution?.surface ?? "review"),
              )
              if (currentContribution === undefined || currentActivity === undefined) return
              await projectOpening?.persistLocation({
                repo: effectiveSelectedRepo,
                contributionId: currentContribution.id,
                registrationToken: currentContribution.ownerRegistrationToken,
                activeSurface: currentContribution.surface,
                activeActivity: activity.id,
                activityRegistrationToken: activity.ownerRegistrationToken,
                state,
                notice: Option.none(),
              })
            },
            selectActivity: updateProjectActivity,
            setSidebarExpanded,
          }}
        >
          {currentHistoryLocationAvailable &&
            projectSurfaces.map((surface) =>
              surface.surface === effectiveActiveSurface ||
              (surface.keepMountedAfterVisit === true &&
                HashSet.has(
                  visitedSurfaces,
                  `${surface.surface}:${surface.ownerRegistrationToken.reactKey}`,
                )) ? (
                <RegisteredProjectSurface
                  key={`${effectiveSelectedRepo.id}:${surface.id}:${surface.ownerRegistrationToken.reactKey}`}
                  contributions={projectSurfaces}
                  surface={surface.surface}
                />
              ) : null,
            )}
        </ProjectSurfaceRuntimeProvider>
      </ProjectRepositoryCapabilityProvider>
    )
  }
  const renderMainContent = (): ReactNode => {
    if (appStateLoadError !== null) {
      return (
        <section className="mx-auto flex min-h-full max-w-3xl flex-col justify-center px-8 py-10">
          <EmptyState>
            <div className="space-y-4" role="alert">
              <div className="space-y-1">
                <h1 className="text-foreground text-base font-semibold">
                  DiffDash could not load application state
                </h1>
                <p>{appStateLoadError}</p>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  setAppState(null)
                  setAppStateLoadError(null)
                  setAppStateLoadAttempt((attempt) => attempt + 1)
                }}
              >
                Retry
              </Button>
            </div>
          </EmptyState>
        </section>
      )
    }
    if (appState === null) {
      return (
        <section className="mx-auto flex min-h-full max-w-3xl flex-col justify-center px-8 py-10">
          <EmptyState>Loading DiffDash...</EmptyState>
        </section>
      )
    }
    if (!appState.onboardingCompleted) {
      return (
        <OnboardingScreen
          diagnostics={diagnostics}
          isLoadingDiagnostics={isLoadingDiagnostics}
          status={setupActionStatus}
          onComplete={(telemetryEnabled) => void completeOnboarding(telemetryEnabled)}
          onInstallDiffDashCli={() => void installDiffDashCli()}
          onOpenDocs={openSetupDocs}
          onRecheck={recheckPrerequisites}
        />
      )
    }
    return effectiveProjectLocation === null ? renderGlobalContent() : renderProjectContent()
  }

  return (
    <RegisteredProjectNavigationProviders>
      <TrustedProjectProviders
        directory={effectiveSelectedRepo?.localPath ?? null}
        projectId={effectiveSelectedRepo?.id ?? null}
        providers={projectProviders}
      >
        <WorkbenchContextActionsProvider host={contextActionsHost}>
          <div
            data-workbench-shell
            className="bg-shell-bevel text-foreground flex h-full min-h-0 flex-col"
          >
            <WorkbenchTitlebar
              titlebarActions={
                <TrustedTitlebarActions
                  actions={titlebarActions}
                  projectId={effectiveSelectedRepo?.id ?? null}
                />
              }
              canNavigateBack={canNavigateBack}
              canNavigateForward={canNavigateForward}
              commandLabel={commandLabel}
              commandNavigationDisabled={appState?.onboardingCompleted !== true}
              showSidebarToggle={showProjectShell}
              sidebarExpanded={sidebarExpanded}
              onContextActionsHostChange={setContextActionsHost}
              onNavigateBack={navigateBack}
              onNavigateForward={navigateForward}
              onOpenKeyboardShortcuts={() => setShortcutReferenceOpen(true)}
              onOpenQuickNavigation={openQuickNavigation}
              onToggleSidebar={() => setSidebarExpanded((expanded) => !expanded)}
            />
            <span className="sr-only" aria-live="polite">
              {actionStatus}
            </span>
            {updateState === null ? null : (
              <UpdateBanner
                state={updateState}
                onCheck={() =>
                  void runRendererPromise(desktop.updates.check()).catch(() => undefined)
                }
                onDownload={() => {
                  captureAnalytics({ event: "update_download_started" })
                  void runRendererPromise(desktop.updates.download()).catch(() => undefined)
                }}
                onRestart={() => {
                  captureAnalytics({ event: "update_install_started" })
                  void runRendererPromise(desktop.updates.restartAndInstall()).catch(
                    () => undefined,
                  )
                }}
              />
            )}
            {cliNavigationError === null ? null : (
              <div
                role="alert"
                className="bg-destructive text-destructive-foreground fixed top-[calc(var(--shell-titlebar-height)+0.75rem)] left-1/2 z-50 flex max-w-xl -translate-x-1/2 items-center gap-3 rounded-lg px-4 py-3 text-sm shadow-lg"
              >
                <span className="min-w-0 flex-1">{cliNavigationError}</span>
                <Button size="sm" variant="secondary" onClick={() => setCliNavigationError(null)}>
                  Dismiss
                </Button>
              </div>
            )}
            {showProjectShell && Option.isSome(workspaceNotice) ? (
              <output className="bg-popover text-popover-foreground fixed top-[calc(var(--shell-titlebar-height)+0.75rem)] right-4 z-40 flex max-w-md items-center gap-3 rounded-lg border px-4 py-3 text-xs shadow-lg">
                <span className="min-w-0 flex-1">{workspaceNotice.value}</span>
                <Button size="xs" variant="ghost" onClick={() => setWorkspaceNotice(Option.none())}>
                  Dismiss
                </Button>
              </output>
            ) : null}
            <FloatingPaneWorkspace
              data-workbench-viewport
              className="workbench-viewport min-h-0 min-w-0 flex-1"
            >
              <div
                data-workbench-frame
                data-workbench-frame-mode={showProjectShell ? "project" : "route"}
                className={`min-h-0 min-w-0 overflow-hidden ${
                  showProjectShell ? "bg-shell-bevel" : "workbench-frame bg-workspace-canvas"
                }`}
              >
                <main
                  data-workbench-content
                  className={`h-full min-h-0 ${showProjectShell ? "overflow-hidden" : "overflow-auto"}`}
                >
                  {renderMainContent()}
                </main>
              </div>
              <div aria-hidden="true" data-workbench-global-rail />
            </FloatingPaneWorkspace>
            {projectOpening === null ? (
              renderCommandPalette([])
            ) : (
              <projectOpening.CommandPaletteItems
                repo={effectiveSelectedRepo}
                apply={(projection) => {
                  projectOpenRequestRef.current += 1
                  setPendingRemoteSelection(null)
                  applyProjectProjection(projection)
                }}
                render={renderCommandPalette}
              />
            )}
            <KeyboardShortcutReference
              open={shortcutReferenceOpen}
              onOpenChange={setShortcutReferenceOpen}
            />
            {pendingRemoteSelection === null ? null : (
              <ProjectRemoteChooser
                selection={pendingRemoteSelection.selection}
                onCancel={() => {
                  projectOpenRequestRef.current += 1
                  setPendingRemoteSelection(null)
                }}
                onSelect={(candidate) =>
                  projectOpening === null
                    ? setPendingRemoteSelection(null)
                    : void applyProjectOpen(
                        projectOpening,
                        pendingRemoteSelection.resume(candidate.repository),
                      )
                }
              />
            )}
          </div>
        </WorkbenchContextActionsProvider>
      </TrustedProjectProviders>
    </RegisteredProjectNavigationProviders>
  )
}

const goToPaletteItems = ({
  projects,
  onOpenRepo,
}: {
  readonly projects: readonly Repo[]
  readonly onOpenRepo: (repo: Repo) => void
}): readonly CommandPaletteItem[] =>
  projects.map((repo) => ({
    id: `repo:${repo.id}`,
    keywords: `${repo.displayIdentity} project repository`,
    subtitle: Match.valueTags(repo.source, {
      local: () => "Local-only project",
      hosted: () =>
        repo.localPath === null ? "Hosted project" : "Hosted project with local checkout",
    }),
    title: repo.displayIdentity,
    onSelect: () => onOpenRepo(repo),
  }))
