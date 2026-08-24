/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import { AISettings } from "@diffdash/domain/ai-settings"
import type { AppState } from "@diffdash/domain/app-state"
import type { CodeLineChangeRange } from "@diffdash/domain/code-line-change"
import type { OpenCodeConnectionSelection } from "@diffdash/domain/comment"
import {
  type CodeWorkspaceTarget,
  ProjectHeadCodeWorkspaceTarget,
} from "@diffdash/domain/code-workspace"
import type { DiffFileStatus } from "@diffdash/domain/diff"
import type { LanguageRange } from "@diffdash/domain/language"
import {
  type GitProviderDescriptor,
  GitProviderId,
  type HostedRepository,
  type HostedReviewSummary,
  type HostedRepositoryLocator,
  RepositorySource,
} from "@diffdash/domain/git-provider"
import { workingTreeReviewTarget } from "@diffdash/domain/local-review"
import { type ProjectWorkspaceRibbon } from "@diffdash/domain/project-workspace"
import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  RendererLayoutSettings,
  ReviewContextPaneWidth,
  ReviewPaneSettings,
  ReviewThreadDetailPaneWidth,
} from "@diffdash/domain/renderer-layout-settings"
import {
  RepositoryCheckoutPath,
  RepositoryCheckout,
  type Repo,
  type RepositorySearchScope,
} from "@diffdash/domain/repository"
import { WebUrl } from "@diffdash/domain/web-url"
import { EMPTY_AGENT_PROVIDER_CATALOG } from "@diffdash/protocol/agent-providers"
import type { AppUpdateState } from "@diffdash/protocol/app-update"
import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import { EMPTY_APP_PREREQUISITES } from "@diffdash/protocol/prerequisites"
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Equal, HashMap, Match, Option } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import { useDeferredValue, useEffect, useEffectEvent, useRef, useState } from "react"
import { HomeScreen, hostedRepositoryLabel } from "@/home/home-screen"
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
  searchScopesAtom,
} from "@/repositories/atoms"
import { useRepositoryMutations } from "@/repositories/use-repository-mutations"
import { CodeScreen } from "@/project-workspace/code-screen"
import { ProjectRemoteChooser } from "@/project-workspace/project-remote-chooser"
import { ReviewsPane } from "@/project-workspace/reviews-pane"
import { ProjectReviewsOverview } from "@/project-workspace/project-reviews-overview"
import {
  projectHostedReviewsLifecycle,
  projectLocalReviewsLifecycle,
} from "@/project-workspace/reviews-lifecycle"
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
import type { SelectedReviewTarget } from "@/review/review-subject"
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
import { CommentSubmissionProvider } from "@/comments/comment-submission"
import { formatError } from "@/shared/errors"
import { Button } from "@/shared/ui/button"
import { EmptyState } from "@/shared/ui/empty-state"
import { FloatingPaneWorkspace } from "@/shared/ui/floating-pane"
import { UpdateBanner } from "@/shared/ui/update-banner"
import { agentProviderCatalogAtom } from "@/walkthrough/atoms"
import { CommandPaletteDialog, type CommandPaletteItem } from "./command-palette"
import { AIConnectionMenu } from "./ai-connection-menu"
import { KeyboardShortcutReference } from "./keyboard-shortcut-reference"
import { useKeyboardShortcut } from "./keyboard-shortcuts"
import { WorkbenchContextActionsProvider } from "./workbench-context-actions"
import { WorkbenchTitlebar } from "./workbench-titlebar"
import type { LanguageNavigationDestination } from "@/source-surface/language-navigation-capability"
import {
  canNavigateHistoryBack,
  canNavigateHistoryForward,
  currentNavigationLocation,
  makeNavigationHistory,
  navigateHistoryBack,
  navigateHistoryForward,
  pushNavigationLocation,
  removeNavigationLocations,
  replaceNavigationLocation,
  type NavigationHistory,
} from "./app-navigation-history"

import {
  type PendingProjectRemoteSelection,
  type ProjectOpenIntent,
  type ProjectSessionProjection,
  ProjectSession,
} from "./project-session"

type Screen = "home" | "project"
type ReviewWorkspaceRibbon = Exclude<ProjectWorkspaceRibbon, "code">

type AppNavigationLocation =
  | { readonly kind: "home" }
  | {
      readonly kind: "projectReview"
      readonly activeRibbon: ReviewWorkspaceRibbon
      readonly repo: Repo
      readonly selectedReview: SelectedReviewTarget | null
    }
  | {
      readonly kind: "projectCode"
      readonly fileStatuses: ReadonlyMap<RepositoryRelativePath, DiffFileStatus>
      readonly lineChanges: HashMap.HashMap<RepositoryRelativePath, readonly CodeLineChangeRange[]>
      readonly path: Option.Option<RepositoryRelativePath>
      readonly repo: Repo
      readonly revealRange: Option.Option<LanguageRange>
      readonly selectedReview: SelectedReviewTarget | null
      readonly target: CodeWorkspaceTarget
    }

const MOUSE_BUTTON_BACK = 3
const MOUSE_BUTTON_FORWARD = 4
const EMPTY_PROVIDER_DESCRIPTORS: readonly GitProviderDescriptor[] = []
const EMPTY_REPOSITORY_SEARCH_SCOPES: readonly RepositorySearchScope[] = []
const EMPTY_REPOS: readonly Repo[] = []
const EMPTY_HOSTED_REPOSITORIES: readonly HostedRepository[] = []
const EMPTY_HOSTED_REVIEWS: readonly HostedReviewSummary[] = []

const sameAppNavigationLocation = (
  left: AppNavigationLocation,
  right: AppNavigationLocation,
): boolean => {
  if (left.kind !== right.kind) return false
  if (left.kind === "home" || right.kind === "home") return true
  if (left.repo.id !== right.repo.id || !Equal.equals(left.selectedReview, right.selectedReview)) {
    return false
  }
  if (left.kind === "projectReview" && right.kind === "projectReview") {
    return left.activeRibbon === right.activeRibbon
  }
  if (left.kind === "projectCode" && right.kind === "projectCode") {
    return (
      Equal.equals(left.path, right.path) &&
      Equal.equals(left.target, right.target) &&
      Equal.equals(left.revealRange, right.revealRange)
    )
  }
  return false
}

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
  const [selectedCodePath, setSelectedCodePath] = useState<Option.Option<RepositoryRelativePath>>(
    Option.none,
  )
  const [selectedCodeTarget, setSelectedCodeTarget] = useState<CodeWorkspaceTarget | null>(null)
  const [codeWorkspaceMounted, setCodeWorkspaceMounted] = useState(false)
  const [codeFileStatuses, setCodeFileStatuses] = useState<
    ReadonlyMap<RepositoryRelativePath, DiffFileStatus>
  >(new Map())
  const [codeLineChanges, setCodeLineChanges] = useState<
    HashMap.HashMap<RepositoryRelativePath, readonly CodeLineChangeRange[]>
  >(HashMap.empty())
  const [codeDefinitionNavigation, setCodeDefinitionNavigation] = useState<
    Option.Option<{
      readonly id: number
      readonly path: RepositoryRelativePath
      readonly range: LanguageRange
    }>
  >(Option.none())
  const codeDefinitionNavigationSequence = useRef(0)
  const initialNavigationHistory = makeNavigationHistory<AppNavigationLocation>({ kind: "home" })
  const navigationHistoryRef =
    useRef<NavigationHistory<AppNavigationLocation>>(initialNavigationHistory)
  const [navigationHistory, setNavigationHistory] = useState(initialNavigationHistory)
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null)
  const [pendingRemoteSelection, setPendingRemoteSelection] =
    useState<PendingProjectRemoteSelection | null>(null)
  const [reviewSidebarExpanded, setReviewSidebarExpanded] = useState(true)
  const [reviewQuickNavigationRequest, setReviewQuickNavigationRequest] = useState(0)
  const [contextActionsHost, setContextActionsHost] = useState<HTMLDivElement | null>(null)
  const [projectSession] = useState(
    () =>
      new ProjectSession({
        loadWorkspace: (projectId) => runRendererPromise(preferences.loadWorkspace(projectId)),
        openProject: (localPath, selectedRepository) =>
          runRendererPromise(repositories.openProject(localPath, selectedRepository)),
        resolveLocalReview: (localPath, branchName) =>
          runRendererPromise(projectWorkspace.resolveLocalReview(localPath, branchName)),
        resolveLastCommit: (localPath) =>
          runRendererPromise(projectWorkspace.resolveLastCommit(localPath)),
        resolveRepositoryComparison: (command) =>
          runRendererPromise(projectWorkspace.resolveRepositoryComparison(command)),
        saveWorkspace: (input) => runRendererPromise(preferences.saveWorkspace(input)),
      }),
  )
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
  const [aiConnection, setAIConnection] = useState(Option.none<OpenCodeConnectionSelection>())
  const [updateState, setUpdateState] = useState<AppUpdateState | null>(null)
  const [debouncedRemoteSearchQuery, setDebouncedRemoteSearchQuery] = useState("")
  const deferredSearchQuery = useDeferredValue(query.trim())
  const localSearchQuery =
    selectedSearchScope === null
      ? deferredSearchQuery
      : `${selectedSearchScope}/${deferredSearchQuery}`

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
    selectedRepo?.hostedLocator === null || selectedRepo?.hostedLocator === undefined
      ? ""
      : repoKey(
          selectedRepo.hostedLocator.providerId,
          selectedRepo.hostedLocator.namespace,
          selectedRepo.hostedLocator.name,
        )
  const repositoriesResult = useAtomValue(repositoriesAtom)
  const providersResult = useAtomValue(providersAtom)
  const availableProviders = AsyncResult.getOrElse(
    providersResult,
    () => EMPTY_PROVIDER_DESCRIPTORS,
  )
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
  const searchScopes = AsyncResult.getOrElse(
    searchScopesResult,
    () => EMPTY_REPOSITORY_SEARCH_SCOPES,
  )
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
    activeRibbon !== "reviews" ||
    selectedRepo?.localPath === null ||
    selectedRepo?.localPath === undefined
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

  const repos = AsyncResult.getOrElse(repositoriesResult, () => EMPTY_REPOS)
  const projectsStatus = AsyncResult.isFailure(repositoriesResult)
    ? resultErrorMessage(repositoriesResult, "Could not load projects")
    : null
  const providers = availableProviders
  const hasQuery = query.trim().length > 0
  const localResults = hasQuery ? AsyncResult.getOrElse(localResultsResult, () => EMPTY_REPOS) : []
  const remoteResults =
    hasQuery && query.trim() === debouncedRemoteSearchQuery
      ? AsyncResult.getOrElse(remoteResultsResult, () => EMPTY_HOSTED_REPOSITORIES)
      : []
  const diagnostics = AsyncResult.getOrElse(diagnosticsResult, () => EMPTY_APP_PREREQUISITES)
  const agentProviderCatalog = AsyncResult.getOrElse(
    agentProviderCatalogResult,
    () => EMPTY_AGENT_PROVIDER_CATALOG,
  )
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
  const pullRequests = AsyncResult.getOrElse(pullRequestsResult, () => EMPTY_HOSTED_REVIEWS)
  const reviewRepositoryLinkState: RepositoryLinkState = Option.match(
    Option.fromNullishOr(selectedReview),
    {
      onNone: (): RepositoryLinkState => "not-applicable",
      onSome: (review) =>
        Match.value(review).pipe(
          Match.discriminatorsExhaustive("kind")({
            localDiff: (): RepositoryLinkState => "not-applicable",
            repositoryComparison: (): RepositoryLinkState => "not-applicable",
            hosted: ({ review: hostedReview }): RepositoryLinkState => {
              const linkedSelectedRepo = Option.fromNullishOr(selectedRepo).pipe(
                Option.filter((repo) =>
                  RepositoryCheckout.match(repo.checkout, {
                    RemoteOnly: () => false,
                    LinkedCheckout: () => repo.matchesHosted(hostedReview.repository),
                  }),
                ),
              )
              return Option.match(linkedSelectedRepo, {
                onSome: () => "linked",
                onNone: () => {
                  if (
                    AsyncResult.isWaiting(repositoriesResult) ||
                    AsyncResult.isFailure(repositoriesResult)
                  ) {
                    return "checking"
                  }
                  return repos.some((candidate) =>
                    RepositoryCheckout.match(candidate.checkout, {
                      RemoteOnly: () => false,
                      LinkedCheckout: () => candidate.matchesHosted(hostedReview.repository),
                    }),
                  )
                    ? "linked"
                    : "unlinked"
                },
              })
            },
          }),
        ),
    },
  )
  const knownHostedRepoKeys = new Set(
    repos.flatMap((repo) =>
      repo.hostedLocator === null
        ? []
        : [
            repoKey(
              repo.hostedLocator.providerId,
              repo.hostedLocator.namespace,
              repo.hostedLocator.name,
            ),
          ],
    ),
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
  const applyNavigationLocation = (location: AppNavigationLocation) => {
    if (location.kind === "home") {
      setScreen("home")
      setSelectedRepo(null)
      setSelectedCodeTarget(null)
      setCodeWorkspaceMounted(false)
      setCodeFileStatuses(new Map())
      setCodeLineChanges(HashMap.empty())
      setSelectedReview(null)
      setSelectedCodePath(Option.none())
      setCodeDefinitionNavigation(Option.none())
      setActiveRibbon("reviews")
      setWorkspaceNotice(null)
      setAIConnection(Option.none())
      return
    }

    setAIConnection((current) =>
      Option.filter(current, (connection) => connection.projectId === location.repo.id),
    )
    setScreen("project")
    setSelectedRepo(location.repo)
    setSelectedReview(location.selectedReview)
    if (location.kind === "projectReview") {
      setActiveRibbon(location.activeRibbon)
      setCodeDefinitionNavigation(Option.none())
      if (selectedRepo?.id !== location.repo.id) {
        setSelectedCodeTarget(ProjectHeadCodeWorkspaceTarget.make({ projectId: location.repo.id }))
        setSelectedCodePath(Option.none())
        setCodeFileStatuses(new Map())
        setCodeLineChanges(HashMap.empty())
        setCodeWorkspaceMounted(false)
      }
      return
    }

    setActiveRibbon("code")
    setSelectedCodeTarget(location.target)
    setSelectedCodePath(location.path)
    setCodeFileStatuses(location.fileStatuses)
    setCodeLineChanges(location.lineChanges)
    setCodeWorkspaceMounted(true)
    setCodeDefinitionNavigation(
      Option.flatMap(location.path, (path) =>
        Option.map(location.revealRange, (range) => {
          const id = codeDefinitionNavigationSequence.current + 1
          codeDefinitionNavigationSequence.current = id
          return { id, path, range }
        }),
      ),
    )
  }

  const setHistory = (history: NavigationHistory<AppNavigationLocation>) => {
    navigationHistoryRef.current = history
    setNavigationHistory(history)
  }
  const pushAppNavigationLocation = (location: AppNavigationLocation) => {
    const next = pushNavigationLocation(
      navigationHistoryRef.current,
      location,
      sameAppNavigationLocation,
    )
    setHistory(next)
    applyNavigationLocation(currentNavigationLocation(next))
  }
  const replaceAppNavigationLocation = (location: AppNavigationLocation, apply = true) => {
    const next = replaceNavigationLocation(navigationHistoryRef.current, location)
    setHistory(next)
    if (apply) applyNavigationLocation(location)
  }
  const navigateBack = () => {
    projectSession.cancelRestore()
    const current = navigationHistoryRef.current
    const next = navigateHistoryBack(current)
    if (next === current) return
    setHistory(next)
    const location = currentNavigationLocation(next)
    applyNavigationLocation(location)
  }
  const navigateForward = () => {
    projectSession.cancelRestore()
    const current = navigationHistoryRef.current
    const next = navigateHistoryForward(current)
    if (next === current) return
    setHistory(next)
    const location = currentNavigationLocation(next)
    applyNavigationLocation(location)
  }
  const navigateBackFromEffect = useEffectEvent(navigateBack)
  const navigateForwardFromEffect = useEffectEvent(navigateForward)

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
  useKeyboardShortcut(
    "review.toggleSidebar",
    () => {
      const activeElement = document.activeElement
      if (
        reviewSidebarExpanded &&
        activeElement !== null &&
        activeElement.closest("[data-review-sidebar-collapse-region]") !== null
      ) {
        document.querySelector<HTMLButtonElement>("[data-workbench-sidebar-toggle]")?.focus()
      }
      setReviewSidebarExpanded((expanded) => !expanded)
    },
    {
      enabled: appState?.onboardingCompleted === true && screen === "project",
    },
  )
  useKeyboardShortcut("navigation.goAnywhere", () => setGoToPaletteOpen(true), {
    enabled: screen !== "project",
  })

  const applyProjectProjection = (
    projection: ProjectSessionProjection,
    mode: "push" | "replace" = "push",
  ) => {
    const location: AppNavigationLocation =
      projection.activeRibbon === "code"
        ? {
            kind: "projectCode",
            repo: projection.repo,
            selectedReview: projection.selectedReview,
            target: ProjectHeadCodeWorkspaceTarget.make({ projectId: projection.repo.id }),
            path: Option.none(),
            revealRange: Option.none(),
            fileStatuses: new Map(),
            lineChanges: HashMap.empty(),
          }
        : {
            kind: "projectReview",
            repo: projection.repo,
            selectedReview: projection.selectedReview,
            activeRibbon: projection.activeRibbon,
          }
    if (mode === "replace") replaceAppNavigationLocation(location)
    else pushAppNavigationLocation(location)
    setWorkspaceNotice(projection.notice)
    setReviewSidebarExpanded(true)
    setActionStatus(`Opened project ${projection.repo.displayIdentity}.`)
    if (projection.repo.hostedLocator !== null) {
      refreshPullRequestsForRepo(
        repoKey(
          projection.repo.hostedLocator.providerId,
          projection.repo.hostedLocator.namespace,
          projection.repo.hostedLocator.name,
        ),
      )
    }
  }

  const observeWorkspacePersistence = (persistence: Promise<void>) => {
    void persistence.catch((error) => {
      setWorkspaceNotice(formatError(error, "Could not save project workspace"))
    })
  }

  const restoreProject = async (repo: Repo) => {
    applyProjectProjection(projectSession.initial(repo))
    setActionStatus(`Restoring ${repo.displayIdentity}...`)
    try {
      const restored = await projectSession.restore(repo)
      const restoredProjection = Match.valueTags(restored, {
        stale: () => null,
        restored: (value) => value,
      })
      if (restoredProjection === null) return
      applyProjectProjection(restoredProjection.projection, "replace")
      if (restoredProjection.persistence !== null)
        observeWorkspacePersistence(restoredProjection.persistence)
    } catch (error) {
      applyProjectProjection(
        projectSession.project(
          repo,
          "reviews",
          null,
          formatError(error, "Saved workspace state could not be restored"),
        ),
        "replace",
      )
    }
  }

  const updateProjectRibbon = (ribbon: ProjectWorkspaceRibbon) => {
    projectSession.cancelRestore()
    if (selectedRepo === null) return
    const location: AppNavigationLocation =
      ribbon === "code"
        ? {
            kind: "projectCode",
            repo: selectedRepo,
            selectedReview,
            target: ProjectHeadCodeWorkspaceTarget.make({ projectId: selectedRepo.id }),
            path: Option.none(),
            revealRange: Option.none(),
            fileStatuses: new Map(),
            lineChanges: HashMap.empty(),
          }
        : {
            kind: "projectReview",
            repo: selectedRepo,
            selectedReview,
            activeRibbon: ribbon,
          }
    pushAppNavigationLocation(location)
    if (selectedRepo !== null) {
      observeWorkspacePersistence(
        projectSession.persist(projectSession.project(selectedRepo, ribbon, selectedReview)),
      )
    }
  }

  const openCodeFile = (
    path: RepositoryRelativePath,
    target?: CodeWorkspaceTarget,
    files: readonly ReviewSnapshotFileInventory[] = [],
    lineChanges: HashMap.HashMap<
      RepositoryRelativePath,
      readonly CodeLineChangeRange[]
    > = HashMap.empty(),
  ) => {
    if (selectedRepo === null) return
    const location: AppNavigationLocation = {
      kind: "projectCode",
      repo: selectedRepo,
      selectedReview,
      target: target ?? ProjectHeadCodeWorkspaceTarget.make({ projectId: selectedRepo.id }),
      path: Option.some(path),
      revealRange: Option.none(),
      fileStatuses: new Map(
        files
          .filter((file) => file.status !== "deleted")
          .map((file) => [file.path, file.status] as const),
      ),
      lineChanges,
    }
    pushAppNavigationLocation(location)
    setReviewSidebarExpanded(true)
    observeWorkspacePersistence(
      projectSession.persist(projectSession.project(selectedRepo, "code", selectedReview)),
    )
  }

  const navigateToCodePath = (path: RepositoryRelativePath | null) => {
    const current = currentNavigationLocation(navigationHistoryRef.current)
    if (current.kind !== "projectCode") return
    pushAppNavigationLocation({
      ...current,
      path: Option.fromNullishOr(path),
      revealRange: Option.none(),
    })
  }

  const navigateToDefinition = (destination: LanguageNavigationDestination) => {
    const current = currentNavigationLocation(navigationHistoryRef.current)
    if (current.kind !== "projectCode" || Option.isNone(current.path)) return
    replaceAppNavigationLocation(
      {
        ...current,
        revealRange: Option.some(destination.origin.range),
      },
      false,
    )
    pushAppNavigationLocation({
      ...current,
      path: Option.some(destination.location.target.path),
      revealRange: Option.some(destination.location.targetSelectionRange),
    })
  }

  const selectProjectReview = (selection: SelectedReviewTarget) => {
    projectSession.cancelRestore()
    Match.valueTags(reviewSelection, {
      none: () => undefined,
      loading: () => undefined,
      ready: () => undefined,
      failure: (failure) => {
        const selectedSourceKeys = reviewSelectionSourceKeys(selection)
        Match.value(selection).pipe(
          Match.discriminatorsExhaustive("kind")({
            hosted: () => {
              if (selectedSourceKeys.hosted === failure.sourceKey) refreshSelectedHostedReview()
            },
            localDiff: () => {
              if (selectedSourceKeys.local === failure.sourceKey) refreshSelectedLocalReview()
            },
            repositoryComparison: () => {
              if (selectedSourceKeys.comparison === failure.sourceKey) {
                refreshSelectedRepositoryComparison()
              }
            },
          }),
        )
      },
    })
    if (selectedRepo !== null) {
      pushAppNavigationLocation({
        kind: "projectReview",
        repo: selectedRepo,
        selectedReview: selection,
        activeRibbon: "files",
      })
    }
    setReviewSidebarExpanded(true)
    setWorkspaceNotice(null)
    if (selectedRepo !== null) {
      observeWorkspacePersistence(
        projectSession.persist(projectSession.project(selectedRepo, "files", selection)),
      )
    }
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

  const openProjectPath = async (
    localPath: string,
    intent: ProjectOpenIntent,
    selectedRepository?: HostedRepositoryLocator,
  ) => {
    setActionStatus("Opening project...")
    try {
      const result = await projectSession.open(localPath, intent, selectedRepository)
      const pendingRemoteSelection = Match.valueTags(result, {
        remoteSelectionRequired: (value) => value.pending,
        opened: () => null,
      })
      if (pendingRemoteSelection !== null) {
        setPendingRemoteSelection(pendingRemoteSelection)
        return
      }
      const opened = Match.valueTags(result, {
        remoteSelectionRequired: () => null,
        opened: (value) => value,
      })
      if (opened === null) return
      setPendingRemoteSelection(null)
      refreshRepositories()
      applyProjectProjection(opened.projection)
      observeWorkspacePersistence(opened.persistence)
      if (opened.reviewType !== null) {
        captureAnalytics({ event: "review_opened", reviewType: opened.reviewType })
      }
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
      setActionStatus(`${isFavorite ? "Pinned" : "Unpinned"} ${repo.displayIdentity}.`)
    } catch (error) {
      setActionStatus(formatError(error, "Could not update project pin"))
    }
  }

  const forgetRepository = async (repo: Repo) => {
    try {
      await repositoryMutations.forget(repo.id)
      const shouldRemove = (location: AppNavigationLocation) =>
        location.kind !== "home" && location.repo.id === repo.id
      const nextHistory = navigationHistoryRef.current.entries.every(shouldRemove)
        ? makeNavigationHistory<AppNavigationLocation>({ kind: "home" })
        : removeNavigationLocations(navigationHistoryRef.current, shouldRemove)
      setHistory(nextHistory)
      applyNavigationLocation(currentNavigationLocation(nextHistory))
      setActionStatus(`Forgot ${repo.displayIdentity} from Home. Review artifacts were kept.`)
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
    projectSession.cancelRestore()
    setCliNavigationError(null)
    setActionStatus("Linking local repository...")
    try {
      const linked = await repositoryMutations.install(localPath)
      setActionStatus(`Linked ${linked.displayIdentity} to ${linked.localPath ?? localPath}.`)
      captureAnalytics({ event: "repository_linked" })
      const projection = projectSession.project(linked, "reviews", null)
      applyProjectProjection(projection)
      observeWorkspacePersistence(projectSession.persist(projection))
    } catch (error) {
      const message = formatError(error, "Could not link local repository")
      setActionStatus(message)
      setCliNavigationError(message)
    }
  }
  const handleCliNavigationCommand = async (command: CliNavigationCommand) => {
    await Match.valueTags(command, {
      error: (error) => {
        setActionStatus(error.message)
        setCliNavigationError(error.message)
      },
      openProject: async (openProject) => {
        setCliNavigationError(null)
        await openProjectPath(openProject.localPath, { kind: "reviews" })
      },
      openWorkingTree: async (openWorkingTree) => {
        setCliNavigationError(null)
        await openProjectPath(openWorkingTree.localPath, { kind: "workingTree" })
      },
      linkRepository: async (linkRepository) => {
        setCliNavigationError(null)
        await installRepositoryLink(linkRepository.localPath)
      },
      repairRepositoryIdentities: async () => {
        setCliNavigationError(null)
        await repairRepositoryIdentities()
      },
      openBranchDiff: async (openBranchDiff) => {
        setCliNavigationError(null)
        await openProjectPath(openBranchDiff.localPath, {
          kind: "branchDiff",
          branchName: openBranchDiff.branchName,
        })
      },
      openLastCommit: async (openLastCommit) => {
        setCliNavigationError(null)
        await openProjectPath(openLastCommit.localPath, { kind: "lastCommit" })
      },
      openRepositoryComparison: async (openRepositoryComparison) => {
        setCliNavigationError(null)
        setActionStatus("Resolving repository comparison...")
        try {
          const comparison = await projectSession.openRepositoryComparison(openRepositoryComparison)
          applyProjectProjection(comparison.projection)
          await comparison.persistence
          captureAnalytics({
            event: "review_opened",
            reviewType: comparison.reviewType ?? "repository_comparison",
          })
        } catch (error) {
          const message = formatError(error, "Could not open repository comparison")
          setActionStatus(message)
          setCliNavigationError(message)
        }
      },
      openPullRequest: async (openPullRequest) => {
        setCliNavigationError(null)
        await openProjectPath(
          openPullRequest.localPath,
          openPullRequest.number === null
            ? { kind: "reviews" }
            : { kind: "pullRequest", number: openPullRequest.number },
        )
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
      const entries = navigationHistoryRef.current.entries.map((location) => {
        if (location.kind === "home" || location.repo.id !== projectId) return location
        return RepositorySource.match(linked.source, {
          local: () => location,
          hosted: ({ locator }) =>
            location.repo.matchesHosted(locator) ? { ...location, repo: linked } : location,
        })
      })
      setHistory({ ...navigationHistoryRef.current, entries })
    })
    setActionStatus(`Linked ${linked.displayIdentity} to ${linked.localPath ?? localPath}.`)
    captureAnalytics({ event: "repository_linked" })
    return true
  }
  const linkSelectedReviewRepository = () => {
    return Option.match(Option.fromNullishOr(selectedReview), {
      onNone: () => Promise.resolve(false),
      onSome: (review) =>
        Match.value(review).pipe(
          Match.discriminatorsExhaustive("kind")({
            hosted: ({ review: hostedReview }) => linkHostedRepository(hostedReview.repository),
            localDiff: () => Promise.resolve(false),
            repositoryComparison: () => Promise.resolve(false),
          }),
        ),
    })
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

  const showProjectShell = appState?.onboardingCompleted === true && screen === "project"
  const reviewWorkbenchReady =
    showProjectShell &&
    Match.valueTags(reviewSelection, {
      ready: () =>
        Match.valueTags(reviewSourceOperations, { ready: () => true, unavailable: () => false }),
      loading: () => false,
      failure: () => false,
      none: () => false,
    })
  const commandLabel = workbenchCommandLabel(selectedRepo, selectedReview, reviewSelection)
  const canNavigateBack =
    appState?.onboardingCompleted === true && canNavigateHistoryBack(navigationHistory)
  const canNavigateForward =
    appState?.onboardingCompleted === true && canNavigateHistoryForward(navigationHistory)
  const reviewRibbon = Option.liftPredicate(
    activeRibbon,
    (ribbon): ribbon is ReviewWorkspaceRibbon => ribbon !== "code",
  )
  const openQuickNavigation = () => {
    if (reviewWorkbenchReady) {
      setReviewQuickNavigationRequest((request) => request + 1)
      return
    }
    setGoToPaletteOpen(true)
  }

  return (
    <CommentSubmissionProvider connection={aiConnection}>
      <WorkbenchContextActionsProvider host={contextActionsHost}>
        <div
          data-workbench-shell
          className="bg-shell-bevel text-foreground flex h-full min-h-0 flex-col"
        >
          <WorkbenchTitlebar
            aiConnectionControl={
              <AIConnectionMenu
                directory={Option.fromNullishOr(selectedRepo?.localPath)}
                projectId={Option.fromNullishOr(selectedRepo?.id)}
                selected={aiConnection}
                onChange={setAIConnection}
              />
            }
            canNavigateBack={canNavigateBack}
            canNavigateForward={canNavigateForward}
            commandLabel={commandLabel}
            commandNavigationDisabled={appState?.onboardingCompleted !== true}
            showSidebarToggle={showProjectShell}
            sidebarExpanded={reviewSidebarExpanded}
            onContextActionsHostChange={setContextActionsHost}
            onNavigateBack={navigateBack}
            onNavigateForward={navigateForward}
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
              onCheck={() =>
                void runRendererPromise(desktop.updates.check()).catch(() => undefined)
              }
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
                  <>
                    {codeWorkspaceMounted ? (
                      <CodeScreen
                        key={selectedRepo.id}
                        active={activeRibbon === "code"}
                        codeThemes={aiSettings.codeThemes}
                        colorScheme={THEME_DEFINITIONS[resolvedTheme].colorScheme}
                        contextWidth={aiSettings.layout.review.contextWidth}
                        fileStatuses={codeFileStatuses}
                        historyDefinitionNavigation={codeDefinitionNavigation}
                        lineChanges={codeLineChanges}
                        repo={selectedRepo}
                        selectedPath={Option.getOrNull(selectedCodePath)}
                        sidebarExpanded={reviewSidebarExpanded}
                        target={
                          selectedCodeTarget ??
                          ProjectHeadCodeWorkspaceTarget.make({ projectId: selectedRepo.id })
                        }
                        threadDetailWidth={aiSettings.layout.review.threadDetailWidth}
                        onActiveRibbonChange={updateProjectRibbon}
                        onHistoryDefinitionNavigationHandled={(id) =>
                          setCodeDefinitionNavigation((current) =>
                            Option.filter(current, (navigation) => navigation.id !== id),
                          )
                        }
                        onLinkRepository={linkSelectedProjectRepository}
                        onNavigateToDefinition={navigateToDefinition}
                        onSelectedPathChange={navigateToCodePath}
                        onSidebarExpandedChange={setReviewSidebarExpanded}
                        onSidebarWidthChange={updateReviewContextWidth}
                        onThreadDetailWidthChange={updateReviewThreadDetailWidth}
                      />
                    ) : null}
                    {Option.match(reviewRibbon, {
                      onNone: () => null,
                      onSome: (activeReviewRibbon) => (
                        <ReviewScreen
                          activeRibbon={activeReviewRibbon}
                          detailEnvironment={{
                            aiAgentAvailable:
                              agentRouteAvailable(
                                agentProviderCatalog,
                                aiSettings.selections.walkthrough,
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
                            onOpenCodeFile: openCodeFile,
                            onSidebarExpandedChange: setReviewSidebarExpanded,
                            onSidebarWidthChange: updateReviewContextWidth,
                            onThreadDetailWidthChange: updateReviewThreadDetailWidth,
                          }}
                          reviewsContext={
                            <ReviewsPane
                              hosted={projectHostedReviewsLifecycle(
                                selectedRepo,
                                pullRequestsResult,
                              )}
                              local={projectLocalReviewsLifecycle(selectedRepo, workingTreeResult)}
                              repo={selectedRepo}
                              onRefreshHosted={refreshSelectedPullRequests}
                              onRefreshLocal={refreshSelectedWorkingTree}
                              onLinkRepository={() => void linkSelectedProjectRepository()}
                              onSelect={selectProjectReview}
                            />
                          }
                          reviewsMain={
                            <ProjectReviewsOverview
                              hosted={projectHostedReviewsLifecycle(
                                selectedRepo,
                                pullRequestsResult,
                              )}
                              local={projectLocalReviewsLifecycle(selectedRepo, workingTreeResult)}
                              repo={selectedRepo}
                              onRefreshHosted={refreshSelectedPullRequests}
                              onRefreshLocal={refreshSelectedWorkingTree}
                              onLinkRepository={() => void linkSelectedProjectRepository()}
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
                      ),
                    })}
                  </>
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
                    onSetFavorite={(repo, isFavorite) =>
                      void setRepositoryFavorite(repo, isFavorite)
                    }
                  />
                )}
              </main>
            </div>
            <div aria-hidden="true" data-workbench-global-rail />
          </FloatingPaneWorkspace>
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
    </CommentSubmissionProvider>
  )
}

const workbenchCommandLabel = (
  selectedRepo: Repo | null,
  selectedReview: SelectedReviewTarget | null,
  selection: ReturnType<typeof useReviewSelection>,
) => {
  const reviewLabel = Match.valueTags(selection, {
    ready: ({ review }) => review.repositoryLabel,
    loading: () => null,
    failure: () => null,
    none: () => null,
  })
  if (reviewLabel !== null) return reviewLabel
  if (selectedRepo !== null) return selectedRepo.displayIdentity
  if (selectedReview?.kind === "hosted") {
    return `${selectedReview.review.repository.namespace}/${selectedReview.review.repository.name}`
  }
  if (selectedReview?.kind === "localDiff") return selectedReview.target.rootPath
  if (selectedReview?.kind === "repositoryComparison") {
    return `${selectedReview.target.repository.namespace}/${selectedReview.target.repository.name}`
  }
  return "DiffDash"
}

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
    keywords: `${repo.displayIdentity} project repository`,
    subtitle: Match.valueTags(repo.source, {
      local: () => "Local-only project",
      hosted: () =>
        repo.localPath === null ? "Hosted project" : "Hosted project with local checkout",
    }),
    title: repo.displayIdentity,
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

const resultErrorMessage = <Value, Failure>(
  result: AsyncResult.AsyncResult<Value, Failure>,
  fallback: string,
) =>
  AsyncResult.matchWithError(result, {
    onInitial: () => fallback,
    onError: (error) => formatError(error, fallback),
    onDefect: (defect) => formatError(defect, fallback),
    onSuccess: () => fallback,
  })
