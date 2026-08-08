/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import { AISettings } from "@diffdash/domain/ai-settings"
import type { AppState } from "@diffdash/domain/app-state"
import {
  type GitProviderDescriptor,
  GitProviderId,
  type HostedRepository,
  type HostedReviewSummary,
  type HostedRepositoryLocator,
  makeHostedReviewLocator,
} from "@diffdash/domain/git-provider"
import { workingTreeReviewTarget } from "@diffdash/domain/local-review"
import {
  type ProjectRemoteSelectionRequired,
  type ProjectWorkspaceRibbon,
  ProjectWorkspaceStateInput,
} from "@diffdash/domain/project-workspace"
import {
  RendererLayoutSettings,
  ReviewContextPaneWidth,
  ReviewPaneSettings,
  ReviewThreadDetailPaneWidth,
} from "@diffdash/domain/renderer-layout-settings"
import type { Repo, RepositorySearchScope } from "@diffdash/domain/repository"
import { EMPTY_AGENT_PROVIDER_CATALOG } from "@diffdash/protocol/agent-providers"
import type { AppUpdateState } from "@diffdash/protocol/app-update"
import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import { type AppPrerequisites, EMPTY_APP_PREREQUISITES } from "@diffdash/protocol/prerequisites"
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import { useDeferredValue, useEffect, useRef, useState } from "react"
import { HomeScreen } from "@/home/home-screen"
import { diagnosticsAtom } from "@/onboarding/atoms"
import { OnboardingScreen } from "@/onboarding/onboarding-screen"
import {
  useDesktopRuntime,
  useProjectWorkspace,
  useRendererPreferences,
  useRendererStream,
  useRepositories,
  runRendererPromise,
} from "@/platform/renderer-runtime"
import {
  providersAtom,
  remoteRepositorySearchAtom,
  remoteSearchAtomKey,
  repositoriesAtom,
  repositorySearchAtom,
  scopedLocalSearchQuery,
  searchScopesAtom,
} from "@/repositories/atoms"
import { useRepositoryMutations } from "@/repositories/use-repository-mutations"
import { ProjectRemoteChooser } from "@/project-workspace/project-remote-chooser"
import { ReviewsPane } from "@/project-workspace/reviews-pane"
import { ProjectReviewsOverview } from "@/project-workspace/project-reviews-overview"
import {
  projectHostedReviewsLifecycle,
  projectLocalReviewsLifecycle,
} from "@/project-workspace/reviews-lifecycle"
import {
  enqueueProjectWorkspaceSave,
  projectIdForRepo,
  resolveProjectWorkspaceState,
  selectedReviewTargetForPersistence,
} from "@/project-workspace/workspace-state"
import {
  hostedReviewManifestAtom,
  localReviewManifestAtom,
  repositoryComparisonManifestAtom,
  pullRequestsAtom,
  refreshPullRequestsAtom,
  repoKey,
  serializeLocalReviewAtomKey,
} from "@/review/atoms"
import type { RepositoryLinkState } from "@/review/review-detail-view"
import { ReviewScreen } from "@/review/review-screen"
import { type HostedReviewTarget, type SelectedReviewTarget } from "@/review/review-subject"
import { reviewSelectionSourceKeys } from "@/review/review-selection"
import { useReviewSelection } from "@/review/use-review-selection"
import { useReviewSourceOperations } from "@/review/use-review-source-operations"
import { agentRouteAvailable } from "@/settings/agent-selection"
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
import { UpdateBanner } from "@/shared/ui/update-banner"
import { agentProviderCatalogAtom } from "@/walkthrough/atoms"
import { CommandPaletteDialog, type CommandPaletteItem } from "./command-palette"
import { KeyboardShortcutReference } from "./keyboard-shortcut-reference"
import { WorkbenchContextActionsProvider } from "./workbench-context-actions"
import { WorkbenchTitlebar } from "./workbench-titlebar"

type Screen = "home" | "project"

type AppDiagnostics = AppPrerequisites

type ProjectOpenIntent =
  | { readonly kind: "reviews" }
  | { readonly kind: "workingTree" }
  | { readonly kind: "pullRequest"; readonly number: number }
  | { readonly kind: "branchDiff"; readonly branchName: string | null }

type PendingRemoteSelection = {
  readonly intent: ProjectOpenIntent
  readonly selection: ProjectRemoteSelectionRequired
}

const MOUSE_BUTTON_BACK = 3

/** Application shell coordinating navigation and feature composition. */
export function AppShell() {
  const captureAnalytics = useCaptureAnalytics()
  const desktop = useDesktopRuntime()
  const preferences = useRendererPreferences()
  const projectWorkspace = useProjectWorkspace()
  const repositories = useRepositories()
  const [screen, setScreen] = useState<Screen>("home")
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)
  const [selectedReview, setSelectedReview] = useState<SelectedReviewTarget | null>(null)
  const [activeRibbon, setActiveRibbon] = useState<ProjectWorkspaceRibbon>("reviews")
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null)
  const [pendingRemoteSelection, setPendingRemoteSelection] =
    useState<PendingRemoteSelection | null>(null)
  const [reviewSidebarExpanded, setReviewSidebarExpanded] = useState(true)
  const [reviewQuickNavigationRequest, setReviewQuickNavigationRequest] = useState(0)
  const [contextActionsHost, setContextActionsHost] = useState<HTMLDivElement | null>(null)
  const workspaceSaveRef = useRef<Promise<void>>(Promise.resolve())
  const projectRestoreRequestRef = useRef(0)
  const handledMouseNavigationButtonRef = useRef<number | null>(null)
  const [query, setQuery] = useState("")
  const [selectedSearchScope, setSelectedSearchScope] = useState<string | null>(null)
  const [selectedProviderId, setSelectedProviderId] = useState<GitProviderId | null>(null)
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
  const [debouncedRemoteSearchQuery, setDebouncedRemoteSearchQuery] = useState("")
  const deferredSearchQuery = useDeferredValue(query.trim())
  const localSearchQuery = scopedLocalSearchQuery(deferredSearchQuery, selectedSearchScope)

  useRendererStream(desktop.updates.states, setUpdateState, (error) =>
    setActionStatus(formatError(error, "Could not monitor application updates")),
  )

  useEffect(() => {
    const trimmedQuery = query.trim()
    if (trimmedQuery.length === 0) {
      setDebouncedRemoteSearchQuery("")
      return undefined
    }

    const timer = window.setTimeout(() => setDebouncedRemoteSearchQuery(trimmedQuery), 300)
    return () => window.clearTimeout(timer)
  }, [query])

  const selectedRepoKey =
    selectedRepo === null || selectedRepo.provider === "local"
      ? ""
      : repoKey(selectedRepo.provider, selectedRepo.owner, selectedRepo.name)
  const repositoriesResult = useAtomValue(repositoriesAtom)
  const providersResult = useAtomValue(providersAtom)
  const availableProviders = resultValue(providersResult, [] as readonly GitProviderDescriptor[])
  const activeProviderId = selectedProviderId ?? availableProviders[0]?.id ?? null
  const selectedProvider =
    availableProviders.find((provider) => provider.id === activeProviderId) ??
    availableProviders[0] ??
    null
  const diagnosticsResult = useAtomValue(diagnosticsAtom)
  const agentProviderCatalogResult = useAtomValue(agentProviderCatalogAtom)
  const selectedProviderSearchScopesAtom = searchScopesAtom(
    selectedProvider?.capabilities.searchScopes === true ? (activeProviderId ?? "") : "",
  )
  const searchScopesResult = useAtomValue(selectedProviderSearchScopesAtom)
  const searchScopes = resultValue(searchScopesResult, [] as readonly RepositorySearchScope[])
  const remoteSearchOwners =
    selectedProvider?.capabilities.repositorySearch !== true
      ? []
      : selectedSearchScope === null
        ? searchScopes.map((scope) => scope.login)
        : [selectedSearchScope]
  const remoteSearchKey =
    activeProviderId === null
      ? ""
      : remoteSearchAtomKey(activeProviderId, debouncedRemoteSearchQuery, remoteSearchOwners)
  const localSearchAtom = repositorySearchAtom(localSearchQuery)
  const remoteSearchAtom = remoteRepositorySearchAtom(remoteSearchKey)
  const selectedRepoPullRequestsAtom = pullRequestsAtom(selectedRepoKey)
  const selectedWorkingTreeKey =
    selectedRepo?.localPath === null || selectedRepo?.localPath === undefined
      ? ""
      : serializeLocalReviewAtomKey(workingTreeReviewTarget(selectedRepo.localPath))
  const selectedWorkingTreeAtom = localReviewManifestAtom(selectedWorkingTreeKey)

  const localResultsResult = useAtomValue(localSearchAtom)
  const remoteResultsResult = useAtomValue(remoteSearchAtom)
  const pullRequestsResult = useAtomValue(selectedRepoPullRequestsAtom)
  const workingTreeResult = useAtomValue(selectedWorkingTreeAtom)
  const refreshPullRequests = useAtomSet(refreshPullRequestsAtom)
  const refreshRepositories = useAtomRefresh(repositoriesAtom)
  const refreshProviders = useAtomRefresh(providersAtom)
  const refreshLocalSearch = useAtomRefresh(localSearchAtom)
  const refreshRemoteSearch = useAtomRefresh(remoteSearchAtom)
  const refreshDiagnostics = useAtomRefresh(diagnosticsAtom)
  const refreshAgentProviderCatalog = useAtomRefresh(agentProviderCatalogAtom)
  const refreshSearchScopes = useAtomRefresh(selectedProviderSearchScopesAtom)
  const refreshPullRequestsForRepo = (key: string) => {
    refreshPullRequests(key)
  }
  const refreshSelectedPullRequests = useAtomRefresh(selectedRepoPullRequestsAtom)
  const refreshSelectedWorkingTree = useAtomRefresh(selectedWorkingTreeAtom)
  const repositoryMutations = useRepositoryMutations({
    repositories: refreshRepositories,
    localSearch: refreshLocalSearch,
    remoteSearch: refreshRemoteSearch,
    selectedReviews: refreshSelectedPullRequests,
  })

  const repos = resultValue(repositoriesResult, [] as readonly Repo[])
  const projectsStatus = AsyncResult.isFailure(repositoriesResult)
    ? resultErrorMessage(repositoriesResult, "Could not load projects")
    : null
  const providers = availableProviders
  const hasQuery = query.trim().length > 0
  const localResults = hasQuery ? resultValue(localResultsResult, [] as readonly Repo[]) : []
  const remoteResults =
    hasQuery && query.trim() === debouncedRemoteSearchQuery
      ? resultValue(remoteResultsResult, [] as readonly HostedRepository[])
      : []
  const diagnostics = resultValue(diagnosticsResult, EMPTY_APP_PREREQUISITES as AppDiagnostics)
  const agentProviderCatalog = resultValue(agentProviderCatalogResult, EMPTY_AGENT_PROVIDER_CATALOG)
  const reviewSelection = useReviewSelection(selectedReview, providers)
  const reviewSourceOperations = useReviewSourceOperations(reviewSelection)
  const selectedReviewSourceKeys = reviewSelectionSourceKeys(selectedReview)
  const refreshSelectedHostedReview = useAtomRefresh(
    hostedReviewManifestAtom(selectedReviewSourceKeys.hosted),
  )
  const refreshSelectedLocalReview = useAtomRefresh(
    localReviewManifestAtom(selectedReviewSourceKeys.local),
  )
  const refreshSelectedRepositoryComparison = useAtomRefresh(
    repositoryComparisonManifestAtom(selectedReviewSourceKeys.comparison),
  )
  const isLoadingDiagnostics = AsyncResult.isWaiting(diagnosticsResult)
  const pullRequests = resultValue(pullRequestsResult, [] as readonly HostedReviewSummary[])
  const reviewRepositoryLinkState: RepositoryLinkState =
    selectedReview?.kind !== "hosted"
      ? "not-applicable"
      : AsyncResult.isWaiting(repositoriesResult) || AsyncResult.isFailure(repositoriesResult)
        ? "checking"
        : repos.some(
              (candidate) =>
                candidate.provider === selectedReview.review.repository.providerId &&
                candidate.localPath !== null &&
                repoKey(candidate.provider, candidate.owner, candidate.name) ===
                  repoKey(
                    selectedReview.review.repository.providerId,
                    selectedReview.review.repository.namespace,
                    selectedReview.review.repository.name,
                  ),
            )
          ? "linked"
          : "unlinked"
  const knownHostedRepoKeys = new Set(
    repos
      .filter((repo) => repo.provider !== "local")
      .map((repo) => repoKey(repo.provider, repo.owner, repo.name)),
  )
  const uniqueRemoteResults = remoteResults.filter(
    (repo) =>
      !knownHostedRepoKeys.has(
        repoKey(repo.locator.providerId, repo.locator.namespace, repo.locator.name),
      ),
  )
  const isSearching =
    hasQuery &&
    (query.trim() !== debouncedRemoteSearchQuery ||
      query.trim() !== deferredSearchQuery ||
      AsyncResult.isWaiting(searchScopesResult) ||
      AsyncResult.isWaiting(localResultsResult) ||
      AsyncResult.isWaiting(remoteResultsResult))
  const searchError = AsyncResult.isFailure(searchScopesResult)
    ? resultErrorMessage(searchScopesResult, "Could not load repository owners")
    : AsyncResult.isFailure(remoteResultsResult)
      ? resultErrorMessage(
          remoteResultsResult,
          `Could not search ${selectedProvider?.displayName ?? "hosted"} repositories`,
        )
      : null
  const navigateBack = () => {
    if (screen === "home") return
    projectRestoreRequestRef.current += 1
    setScreen("home")
    setSelectedRepo(null)
    setSelectedReview(null)
    setActiveRibbon("reviews")
    setWorkspaceNotice(null)
  }

  useEffect(() => {
    refreshRepositories()
    refreshProviders()
    refreshDiagnostics()
    refreshAgentProviderCatalog()
    refreshSearchScopes()
  }, [
    refreshDiagnostics,
    refreshAgentProviderCatalog,
    refreshRepositories,
    refreshProviders,
    refreshSearchScopes,
  ])

  useEffect(() => {
    if (
      providers.length === 0 ||
      (selectedProviderId !== null &&
        providers.some((provider) => provider.id === selectedProviderId))
    )
      return
    const firstProvider = providers[0]
    if (firstProvider !== undefined) {
      setSelectedProviderId(firstProvider.id)
      setSelectedSearchScope(null)
    }
  }, [providers, selectedProviderId])

  useEffect(() => {
    let cancelled = false
    runRendererPromise(preferences.loadAppState())
      .then((state) => {
        if (!cancelled) setAppState(state)
        return undefined
      })
      .catch((error: unknown) => {
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
      if (event.button !== MOUSE_BUTTON_BACK) return

      event.preventDefault()
      event.stopPropagation()
      handledMouseNavigationButtonRef.current = event.button
      navigateBack()
    }
    const suppressHandledAuxClick = (event: MouseEvent) => {
      if (event.button !== MOUSE_BUTTON_BACK) return

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
  })

  useEffect(() => {
    const openShortcutReference = (event: KeyboardEvent) => {
      if (!isModKey(event) || event.altKey || event.key !== "/") return

      event.preventDefault()
      event.stopPropagation()
      setShortcutReferenceOpen(true)
    }

    window.addEventListener("keydown", openShortcutReference, true)
    return () => window.removeEventListener("keydown", openShortcutReference, true)
  }, [])

  useEffect(() => {
    const openGoToPalette = (event: KeyboardEvent) => {
      if (!isModKey(event) || event.shiftKey || event.key.toLowerCase() !== "k") return
      if (screen === "project") return

      event.preventDefault()
      setGoToPaletteOpen(true)
    }

    window.addEventListener("keydown", openGoToPalette)
    return () => window.removeEventListener("keydown", openGoToPalette)
  }, [screen])

  const persistWorkspace = (
    repo: Repo,
    ribbon: ProjectWorkspaceRibbon,
    selection: SelectedReviewTarget | null,
  ) => {
    const input = ProjectWorkspaceStateInput.make({
      projectId: projectIdForRepo(repo),
      activeRibbon: ribbon,
      selectedReviewTarget: selectedReviewTargetForPersistence(selection),
    })
    workspaceSaveRef.current = enqueueProjectWorkspaceSave(
      workspaceSaveRef.current,
      input,
      (nextInput) => runRendererPromise(preferences.saveWorkspace(nextInput)),
      (error) => {
        setWorkspaceNotice(formatError(error, "Could not save project workspace"))
      },
    )
  }

  const showProject = (
    repo: Repo,
    ribbon: ProjectWorkspaceRibbon,
    selection: SelectedReviewTarget | null,
    notice: string | null,
    persist: boolean,
  ) => {
    setSelectedRepo(repo)
    setSelectedReview(selection)
    setActiveRibbon(ribbon)
    setWorkspaceNotice(notice)
    setReviewSidebarExpanded(true)
    setScreen("project")
    setActionStatus(`Opened project ${repo.owner}/${repo.name}.`)
    if (repo.provider !== "local") {
      refreshPullRequestsForRepo(repoKey(repo.provider, repo.owner, repo.name))
    }
    if (persist) persistWorkspace(repo, ribbon, selection)
  }

  const restoreProject = async (repo: Repo) => {
    const request = projectRestoreRequestRef.current + 1
    projectRestoreRequestRef.current = request
    showProject(repo, "reviews", null, null, false)
    setActionStatus(`Restoring ${repo.owner}/${repo.name}...`)
    try {
      const persisted = Option.getOrNull(
        await runRendererPromise(preferences.loadWorkspace(projectIdForRepo(repo))),
      )
      if (projectRestoreRequestRef.current !== request) return
      const restored = resolveProjectWorkspaceState(repo, persisted)
      showProject(
        repo,
        restored.activeRibbon,
        restored.selectedReview,
        restored.notice,
        restored.notice !== null,
      )
    } catch (error) {
      if (projectRestoreRequestRef.current !== request) return
      showProject(
        repo,
        "reviews",
        null,
        formatError(error, "Saved workspace state could not be restored"),
        false,
      )
    }
  }

  const updateProjectRibbon = (ribbon: ProjectWorkspaceRibbon) => {
    setActiveRibbon(ribbon)
    if (selectedRepo !== null) persistWorkspace(selectedRepo, ribbon, selectedReview)
  }

  const selectProjectReview = (selection: SelectedReviewTarget) => {
    setSelectedReview(selection)
    setActiveRibbon("files")
    setReviewSidebarExpanded(true)
    setWorkspaceNotice(null)
    if (selectedRepo !== null) persistWorkspace(selectedRepo, "files", selection)
    captureAnalytics({
      event: "review_opened",
      reviewType:
        selection.kind === "hosted"
          ? "pull_request"
          : selection.kind === "localDiff"
            ? "local_diff"
            : "repository_comparison",
    })
  }

  const completeOpenedProject = async (repo: Repo, intent: ProjectOpenIntent) => {
    if (intent.kind === "workingTree") {
      if (repo.localPath === null) throw new Error("The opened project has no local checkout.")
      const target = workingTreeReviewTarget(repo.localPath)
      showProject(repo, "files", { kind: "localDiff", target }, null, true)
      captureAnalytics({ event: "review_opened", reviewType: "local_diff" })
      return
    }
    if (intent.kind === "branchDiff") {
      if (repo.localPath === null) throw new Error("The opened project has no local checkout.")
      const localPath = repo.localPath
      const target = await runRendererPromise(
        projectWorkspace.resolveLocalReview(localPath, Option.fromNullishOr(intent.branchName)),
      )
      showProject(repo, "files", { kind: "localDiff", target }, null, true)
      captureAnalytics({ event: "review_opened", reviewType: "local_diff" })
      return
    }
    if (intent.kind === "pullRequest") {
      if (repo.provider === "local") {
        throw new Error("The opened project has no recognized hosted repository.")
      }
      const review: HostedReviewTarget = {
        kind: "hosted",
        review: makeHostedReviewLocator(repo.provider, repo.owner, repo.name, intent.number),
      }
      showProject(repo, "files", review, null, true)
      captureAnalytics({ event: "review_opened", reviewType: "pull_request" })
      return
    }
    showProject(repo, "reviews", null, null, true)
  }

  const openProjectPath = async (
    localPath: string,
    intent: ProjectOpenIntent,
    selectedRepository?: HostedRepositoryLocator,
  ) => {
    setActionStatus("Opening project...")
    try {
      const result = await runRendererPromise(
        repositories.openProject(localPath, Option.fromNullishOr(selectedRepository)),
      )
      if (result._tag === "remoteSelectionRequired") {
        setPendingRemoteSelection({ intent, selection: result })
        return
      }
      setPendingRemoteSelection(null)
      refreshRepositories()
      await completeOpenedProject(result.repo, intent)
    } catch (error) {
      const fallback =
        intent.kind === "branchDiff"
          ? "Could not resolve comparison branch"
          : intent.kind === "pullRequest"
            ? "Could not open repository pull requests"
            : "Could not open project"
      const message = formatError(error, fallback)
      setActionStatus(message)
      setCliNavigationError(message)
    }
  }

  const chooseProjectFolder = async () => {
    setCliNavigationError(null)
    const localPath = await runRendererPromise(repositories.selectLocalFolder())
    if (Option.isSome(localPath)) await openProjectPath(localPath.value, { kind: "reviews" })
  }

  const pinRemote = async (repo: HostedRepository) => {
    const label = hostedRepositoryLabel(repo)
    try {
      await repositoryMutations.favorite(repo)
      setActionStatus(`Pinned ${label}.`)
      captureAnalytics({ event: "repository_bookmarked" })
    } catch (error) {
      setActionStatus(formatError(error, "Could not pin project"))
    }
  }

  const openRemoteRepository = async (repo: HostedRepository) => {
    try {
      const saved = await repositoryMutations.rememberRemote(repo)
      await restoreProject(saved)
    } catch (error) {
      setActionStatus(formatError(error, "Could not open hosted project"))
    }
  }

  const setRepositoryFavorite = async (repo: Repo, isFavorite: boolean) => {
    try {
      await repositoryMutations.setFavorite(repo, isFavorite)
      setActionStatus(`${isFavorite ? "Pinned" : "Unpinned"} ${repo.owner}/${repo.name}.`)
    } catch (error) {
      setActionStatus(formatError(error, "Could not update project pin"))
    }
  }

  const forgetRepository = async (repo: Repo) => {
    try {
      await repositoryMutations.forget(projectIdForRepo(repo))
      setActionStatus(`Forgot ${repo.owner}/${repo.name} from Home. Review artifacts were kept.`)
    } catch (error) {
      setActionStatus(formatError(error, "Could not forget project"))
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
    setCliNavigationError(null)
    setActionStatus("Linking local repository...")
    try {
      const linked = await repositoryMutations.install(localPath)
      setActionStatus(`Linked ${linked.owner}/${linked.name} to ${linked.localPath ?? localPath}.`)
      captureAnalytics({ event: "repository_linked" })
      showProject(linked, "reviews", null, null, true)
    } catch (error) {
      const message = formatError(error, "Could not link local repository")
      setActionStatus(message)
      setCliNavigationError(message)
    }
  }
  const handleCliNavigationCommand = async (command: CliNavigationCommand) => {
    if (command["_tag"] === "error") {
      setActionStatus(command.message)
      setCliNavigationError(command.message)
      return
    }
    setCliNavigationError(null)
    if (command["_tag"] === "openProject") {
      await openProjectPath(command.localPath, { kind: "reviews" })
      return
    }
    if (command["_tag"] === "openWorkingTree") {
      await openProjectPath(command.localPath, { kind: "workingTree" })
      return
    }
    if (command["_tag"] === "linkRepository") {
      await installRepositoryLink(command.localPath)
      return
    }
    if (command["_tag"] === "repairRepositoryIdentities") {
      await repairRepositoryIdentities()
      return
    }
    if (command["_tag"] === "openBranchDiff") {
      await openProjectPath(command.localPath, {
        kind: "branchDiff",
        branchName: command.branchName,
      })
      return
    }
    if (command["_tag"] === "openRepositoryComparison") {
      setActionStatus("Resolving repository comparison...")
      try {
        const comparison = await runRendererPromise(
          projectWorkspace.resolveRepositoryComparison(command),
        )
        const selection = { kind: "repositoryComparison", target: comparison.target } as const
        showProject(comparison.repo, "files", selection, null, false)
        await runRendererPromise(
          preferences.saveWorkspace(
            ProjectWorkspaceStateInput.make({
              projectId: projectIdForRepo(comparison.repo),
              activeRibbon: "files",
              selectedReviewTarget: selectedReviewTargetForPersistence(selection),
            }),
          ),
        )
        captureAnalytics({ event: "review_opened", reviewType: "repository_comparison" })
      } catch (error) {
        const message = formatError(error, "Could not open repository comparison")
        setActionStatus(message)
        setCliNavigationError(message)
      }
      return
    }
    await openProjectPath(
      command.localPath,
      command.number === null
        ? { kind: "reviews" }
        : { kind: "pullRequest", number: command.number },
    )
  }
  const linkSelectedReviewRepository = async () => {
    if (selectedReview?.kind !== "hosted") return false
    const localPathOption = await runRendererPromise(repositories.selectLocalFolder())
    if (Option.isNone(localPathOption)) return false
    const localPath = localPathOption.value

    const linked = await repositoryMutations.link({
      repository: selectedReview.review.repository,
      localPath,
    })
    if (
      selectedRepo !== null &&
      repoKey(selectedRepo.provider, selectedRepo.owner, selectedRepo.name) ===
        repoKey(linked.provider, linked.owner, linked.name)
    ) {
      setSelectedRepo(linked)
    }
    setActionStatus(`Linked ${linked.owner}/${linked.name} to ${linked.localPath ?? localPath}.`)
    captureAnalytics({ event: "repository_linked" })
    return true
  }

  useRendererStream(desktop.navigation.commands, handleCliNavigationCommand, (error) =>
    setCliNavigationError(formatError(error, "Could not receive CLI navigation commands")),
  )

  const updateAISettings = (settings: AISettings) => {
    void settingsMutation.update(settings).catch(() => undefined)
  }
  const updateReviewContextWidth = (width: number) => {
    void settingsMutation
      .update((current) =>
        AISettings.make({
          ...current,
          layout: RendererLayoutSettings.make({
            review: ReviewPaneSettings.make({
              ...current.layout.review,
              contextWidth: ReviewContextPaneWidth.make(width),
            }),
          }),
        }),
      )
      .catch(() => undefined)
  }
  const updateReviewThreadDetailWidth = (width: number) => {
    void settingsMutation
      .update((current) =>
        AISettings.make({
          ...current,
          layout: RendererLayoutSettings.make({
            review: ReviewPaneSettings.make({
              ...current.layout.review,
              threadDetailWidth: ReviewThreadDetailPaneWidth.make(width),
            }),
          }),
        }),
      )
      .catch(() => undefined)
  }

  const recheckPrerequisites = () => {
    setSetupActionStatus("Rechecking setup...")
    refreshDiagnostics()
  }

  const openSetupDocs = (url: string) => {
    void runRendererPromise(desktop.openExternalUrl(url)).catch((error) => {
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

  const showProjectShell = appState?.onboardingCompleted === true && screen === "project"
  const reviewWorkbenchReady =
    showProjectShell && reviewSelection._tag === "ready" && reviewSourceOperations._tag === "ready"
  const commandLabel = workbenchCommandLabel(selectedRepo, selectedReview, reviewSelection)
  const canNavigateBack = appState?.onboardingCompleted === true && screen !== "home"
  const openQuickNavigation = () => {
    if (reviewWorkbenchReady) {
      setReviewQuickNavigationRequest((request) => request + 1)
      return
    }
    setGoToPaletteOpen(true)
  }

  return (
    <WorkbenchContextActionsProvider host={contextActionsHost}>
      <div
        data-workbench-shell
        className="bg-shell-bevel text-foreground flex h-full min-h-0 flex-col"
      >
        <WorkbenchTitlebar
          canNavigateBack={canNavigateBack}
          commandLabel={commandLabel}
          commandNavigationDisabled={appState?.onboardingCompleted !== true}
          showSidebarToggle={showProjectShell}
          sidebarExpanded={reviewSidebarExpanded}
          onContextActionsHostChange={setContextActionsHost}
          onNavigateBack={navigateBack}
          onOpenKeyboardShortcuts={() => setShortcutReferenceOpen(true)}
          onOpenQuickNavigation={openQuickNavigation}
          onToggleSidebar={() => setReviewSidebarExpanded((expanded) => !expanded)}
        />
        <span className="sr-only" aria-live="polite">
          {actionStatus}
        </span>
        {updateState === null ? null : (
          <UpdateBanner
            state={updateState}
            onCheck={() => void runRendererPromise(desktop.updates.check()).catch(() => undefined)}
            onDownload={() => {
              captureAnalytics({ event: "update_download_started" })
              void runRendererPromise(desktop.updates.download()).catch(() => undefined)
            }}
            onRestart={() => {
              captureAnalytics({ event: "update_install_started" })
              void runRendererPromise(desktop.updates.restartAndInstall()).catch(() => undefined)
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
        {showProjectShell && reviewWorkbenchReady && workspaceNotice !== null ? (
          <output className="bg-popover text-popover-foreground fixed top-[calc(var(--shell-titlebar-height)+0.75rem)] right-4 z-40 flex max-w-md items-center gap-3 rounded-lg border px-4 py-3 text-xs shadow-lg">
            <span className="min-w-0 flex-1">{workspaceNotice}</span>
            <Button size="xs" variant="ghost" onClick={() => setWorkspaceNotice(null)}>
              Dismiss
            </Button>
          </output>
        ) : null}
        <div data-workbench-viewport className="workbench-viewport min-h-0 min-w-0 flex-1">
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
              {appStateLoadError !== null ? (
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
              ) : appState === null ? (
                <section className="mx-auto flex min-h-full max-w-3xl flex-col justify-center px-8 py-10">
                  <EmptyState>Loading DiffDash...</EmptyState>
                </section>
              ) : !appState.onboardingCompleted ? (
                <OnboardingScreen
                  diagnostics={diagnostics}
                  isLoadingDiagnostics={isLoadingDiagnostics}
                  status={setupActionStatus}
                  onComplete={(telemetryEnabled) => void completeOnboarding(telemetryEnabled)}
                  onInstallDiffDashCli={() => void installDiffDashCli()}
                  onOpenDocs={openSetupDocs}
                  onRecheck={recheckPrerequisites}
                />
              ) : screen === "project" && selectedRepo !== null ? (
                <ReviewScreen
                  activeRibbon={activeRibbon}
                  detailEnvironment={{
                    aiAgentAvailable:
                      agentRouteAvailable(
                        agentProviderCatalog,
                        aiSettings.routes.walkthrough,
                        "walkthrough",
                      ) || AsyncResult.isWaiting(agentProviderCatalogResult),
                    aiSettings,
                    quickNavigationRequest: reviewQuickNavigationRequest,
                    repositoryLinkState: reviewRepositoryLinkState,
                    sidebarExpanded: reviewSidebarExpanded,
                    sidebarWidth: aiSettings.layout.review.contextWidth,
                    threadDetailWidth: aiSettings.layout.review.threadDetailWidth,
                    colorScheme: THEME_DEFINITIONS[resolvedTheme].colorScheme,
                    onAISettingsChange: updateAISettings,
                    onLinkRepository: linkSelectedReviewRepository,
                    onSidebarExpandedChange: setReviewSidebarExpanded,
                    onSidebarWidthChange: updateReviewContextWidth,
                    onThreadDetailWidthChange: updateReviewThreadDetailWidth,
                  }}
                  reviewsContext={
                    <ReviewsPane
                      hosted={projectHostedReviewsLifecycle(selectedRepo, pullRequestsResult)}
                      local={projectLocalReviewsLifecycle(selectedRepo, workingTreeResult)}
                      repo={selectedRepo}
                      onRefreshHosted={refreshSelectedPullRequests}
                      onRefreshLocal={refreshSelectedWorkingTree}
                      onSelect={selectProjectReview}
                    />
                  }
                  reviewsMain={
                    <ProjectReviewsOverview
                      hosted={projectHostedReviewsLifecycle(selectedRepo, pullRequestsResult)}
                      local={projectLocalReviewsLifecycle(selectedRepo, workingTreeResult)}
                      repo={selectedRepo}
                      onRefreshHosted={refreshSelectedPullRequests}
                      onRefreshLocal={refreshSelectedWorkingTree}
                      onSelect={selectProjectReview}
                    />
                  }
                  selection={reviewSelection}
                  sourceOperations={reviewSourceOperations}
                  workspaceNotice={workspaceNotice}
                  onActiveRibbonChange={updateProjectRibbon}
                  onRetrySelection={() => {
                    refreshSelectedHostedReview()
                    refreshSelectedLocalReview()
                    refreshSelectedRepositoryComparison()
                  }}
                />
              ) : (
                <HomeScreen
                  activeProviderId={activeProviderId}
                  diagnostics={diagnostics}
                  hasQuery={hasQuery}
                  isLoadingDiagnostics={isLoadingDiagnostics}
                  isSearching={isSearching}
                  localResults={localResults}
                  projects={repos}
                  projectsStatus={projectsStatus}
                  providers={providers}
                  query={query}
                  remoteResults={uniqueRemoteResults}
                  searchError={searchError}
                  searchScopes={searchScopes}
                  selectedProvider={selectedProvider}
                  selectedSearchScope={selectedSearchScope}
                  setupStatus={setupActionStatus}
                  onForget={(repo) => void forgetRepository(repo)}
                  onInstallDiffDashCli={() => void installDiffDashCli()}
                  onOpenDocs={openSetupDocs}
                  onOpenProject={() => void chooseProjectFolder()}
                  onOpenRepo={(repo) => void restoreProject(repo)}
                  onPinRemote={(repo) => void pinRemote(repo)}
                  onQueryChange={setQuery}
                  onRecheck={recheckPrerequisites}
                  onRetryProjects={refreshRepositories}
                  onSelectProvider={(providerId) => {
                    setSelectedProviderId(GitProviderId.make(providerId))
                    setSelectedSearchScope(null)
                  }}
                  onSelectRemote={(repo) => void openRemoteRepository(repo)}
                  onSelectScope={(scope) =>
                    setSelectedSearchScope((current) => (current === scope ? null : scope))
                  }
                  onSetFavorite={(repo, isFavorite) => void setRepositoryFavorite(repo, isFavorite)}
                />
              )}
            </main>
          </div>
          <div aria-hidden="true" data-workbench-global-rail />
        </div>
        <CommandPaletteDialog
          items={goToPaletteItems({
            projects: repos,
            onOpenPullRequest: (pullRequest) =>
              selectProjectReview({ kind: "hosted", review: pullRequest.locator }),
            onOpenRepo: (repo) => void restoreProject(repo),
            pullRequests,
          })}
          open={goToPaletteOpen}
          placeholder="Search projects and reviews"
          title="Go anywhere"
          onOpenChange={setGoToPaletteOpen}
        />
        <KeyboardShortcutReference
          open={shortcutReferenceOpen}
          onOpenChange={setShortcutReferenceOpen}
        />
        {pendingRemoteSelection === null ? null : (
          <ProjectRemoteChooser
            selection={pendingRemoteSelection.selection}
            onCancel={() => setPendingRemoteSelection(null)}
            onSelect={(candidate) =>
              void openProjectPath(
                pendingRemoteSelection.selection.rootPath,
                pendingRemoteSelection.intent,
                candidate.repository,
              )
            }
          />
        )}
      </div>
    </WorkbenchContextActionsProvider>
  )
}

const workbenchCommandLabel = (
  selectedRepo: Repo | null,
  selectedReview: SelectedReviewTarget | null,
  selection: ReturnType<typeof useReviewSelection>,
) => {
  if (selection._tag === "ready") return selection.repositoryLabel
  if (selectedRepo !== null) return `${selectedRepo.owner}/${selectedRepo.name}`
  if (selectedReview?.kind === "hosted") {
    return `${selectedReview.review.repository.namespace}/${selectedReview.review.repository.name}`
  }
  if (selectedReview?.kind === "localDiff") return selectedReview.target.rootPath
  if (selectedReview?.kind === "repositoryComparison") {
    return `${selectedReview.target.repository.namespace}/${selectedReview.target.repository.name}`
  }
  return "DiffDash"
}

const isModKey = (event: KeyboardEvent) => event.metaKey || event.ctrlKey

const goToPaletteItems = ({
  projects,
  onOpenPullRequest,
  onOpenRepo,
  pullRequests,
}: {
  readonly projects: readonly Repo[]
  readonly onOpenPullRequest: (pullRequest: HostedReviewSummary) => void
  readonly onOpenRepo: (repo: Repo) => void
  readonly pullRequests: readonly HostedReviewSummary[]
}): readonly CommandPaletteItem[] => [
  ...projects.map((repo) => ({
    id: `repo:${repo.id}`,
    keywords: `${repo.owner} ${repo.name} project repository`,
    subtitle:
      repo.provider === "local"
        ? "Local-only project"
        : repo.localPath === null
          ? "Hosted project"
          : "Hosted project with local checkout",
    title: `${repo.owner}/${repo.name}`,
    onSelect: () => onOpenRepo(repo),
  })),
  ...pullRequests.map((pullRequest) => ({
    id: `hosted-review:${pullRequest.locator.repository.namespace}/${pullRequest.locator.repository.name}#${pullRequest.locator.number}`,
    keywords: `${pullRequest.locator.repository.namespace} ${pullRequest.locator.repository.name} ${pullRequest.title} hosted review`,
    subtitle: `Open review · ${pullRequest.locator.repository.namespace}/${pullRequest.locator.repository.name}`,
    title: `#${pullRequest.locator.number} ${pullRequest.title}`,
    onSelect: () => onOpenPullRequest(pullRequest),
  })),
]

const hostedRepositoryLabel = (repository: HostedRepository) =>
  `${repository.locator.namespace}/${repository.locator.name}`

const resultValue = <A,>(result: AsyncResult.AsyncResult<A, unknown>, fallback: A) =>
  AsyncResult.getOrElse(result, () => fallback)

const resultErrorMessage = (result: AsyncResult.AsyncResult<unknown, unknown>, fallback: string) =>
  AsyncResult.matchWithError(result, {
    onInitial: () => fallback,
    onError: (error) => formatError(error, fallback),
    onDefect: (defect) => formatError(defect, fallback),
    onSuccess: () => fallback,
  })
