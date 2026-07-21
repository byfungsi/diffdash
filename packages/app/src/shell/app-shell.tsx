/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import { AISettings } from "@diffdash/domain/ai-settings"
import { type AppState, DEFAULT_APP_STATE } from "@diffdash/domain/app-state"
import {
  type GitProviderDescriptor,
  GitProviderId,
  type HostedRepository,
  type HostedReviewSummary,
  makeHostedReviewLocator,
  sameHostedReview,
} from "@diffdash/domain/git-provider"
import {
  type LocalReviewTarget,
  localReviewTargetKey,
  workingTreeReviewTarget,
} from "@diffdash/domain/local-review"
import type { Repo, RepositorySearchScope } from "@diffdash/domain/repository"
import { Repo as Repository } from "@diffdash/domain/repository"
import { EMPTY_AGENT_PROVIDER_CATALOG } from "@diffdash/protocol/agent-providers"
import type { AppUpdateState } from "@diffdash/protocol/app-update"
import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import { type AppPrerequisites, EMPTY_APP_PREREQUISITES } from "@diffdash/protocol/prerequisites"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { useDeferredValue, useEffect, useEffectEvent, useRef, useState } from "react"
import { repoPrCountsAtom, reviewRequestsAtom } from "@/home/atoms"
import { HomeScreen, type RecentReviewEntry } from "@/home/home-screen"
import { diagnosticsAtom } from "@/onboarding/atoms"
import { OnboardingScreen } from "@/onboarding/onboarding-screen"
import {
  isBookmarkedPullRequestRepo,
  providersAtom,
  remoteRepositorySearchAtom,
  remoteSearchAtomKey,
  repositoriesAtom,
  repositorySearchAtom,
  scopedLocalSearchQuery,
  searchScopesAtom,
} from "@/repositories/atoms"
import { RepositoryScreen } from "@/repositories/repository-screen"
import { useRepositoryMutations } from "@/repositories/use-repository-mutations"
import {
  pullRequestAtomKey,
  pullRequestsAtom,
  refreshPullRequestsAtom,
  repoKey,
} from "@/review/atoms"
import type { RepositoryLinkState } from "@/review/review-detail-view"
import { ReviewScreen } from "@/review/review-screen"
import {
  type HostedReviewTarget,
  type LocalDiffReviewTarget,
  type SelectedReviewTarget,
} from "@/review/review-subject"
import { useReviewSelection } from "@/review/use-review-selection"
import { useReviewSourceOperations } from "@/review/use-review-source-operations"
import { agentRouteAvailable } from "@/settings/agent-selection"
import { type ResolvedTheme, resolveThemePreference } from "@/settings/theme"
import { useSettingsMutation } from "@/settings/use-settings-mutation"
import { captureAnalytics } from "@/shared/analytics"
import { formatError } from "@/shared/errors"
import { formatTimestamp } from "@/shared/timestamp"
import { Button } from "@/shared/ui/button"
import { EmptyState } from "@/shared/ui/empty-state"
import { UpdateBanner } from "@/shared/ui/update-banner"
import { agentProviderCatalogAtom } from "@/walkthrough/atoms"
import { CommandPaletteDialog, type CommandPaletteItem } from "./command-palette"

type Screen = "home" | "repo" | "review"

type AppDiagnostics = AppPrerequisites

type AppNavigationRoute = {
  readonly screen: Screen
  readonly selectedRepo: Repo | null
  readonly selectedReview: SelectedReviewTarget | null
}

const MOUSE_BUTTON_BACK = 3
const MOUSE_BUTTON_FORWARD = 4

const sameNavigationRoute = (left: AppNavigationRoute, right: AppNavigationRoute) =>
  left.screen === right.screen &&
  left.selectedRepo?.id === right.selectedRepo?.id &&
  sameSelectedReviewTarget(left.selectedReview, right.selectedReview)

const sameSelectedReviewTarget = (
  left: SelectedReviewTarget | null,
  right: SelectedReviewTarget | null,
) => {
  if (left === null || right === null) return left === right
  if (left.kind === "localDiff")
    return (
      right.kind === "localDiff" &&
      localReviewTargetKey(left.target) === localReviewTargetKey(right.target)
    )
  return right.kind === "hosted" && sameHostedReview(left.review, right.review)
}

/** Application shell coordinating navigation and feature composition. */
export function AppShell() {
  const [screen, setScreen] = useState<Screen>("home")
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)
  const [selectedReview, setSelectedReview] = useState<SelectedReviewTarget | null>(null)
  const navigationHistoryRef = useRef<readonly AppNavigationRoute[]>([
    { screen: "home", selectedRepo: null, selectedReview: null },
  ])
  const commandDrainRef = useRef<Promise<void>>(Promise.resolve())
  const navigationIndexRef = useRef(0)
  const handledMouseNavigationButtonRef = useRef<number | null>(null)
  const [query, setQuery] = useState("")
  const [selectedSearchScope, setSelectedSearchScope] = useState<string | null>(null)
  const [selectedProviderId, setSelectedProviderId] = useState<GitProviderId | null>(null)
  const [actionStatus, setActionStatus] = useState("Search a repo or open a bookmark.")
  const [cliNavigationError, setCliNavigationError] = useState<string | null>(null)
  const [setupActionStatus, setSetupActionStatus] = useState<string | null>(null)
  const [appState, setAppState] = useState<AppState | null>(null)
  const settingsMutation = useSettingsMutation()
  const aiSettings = settingsMutation.settings
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveThemePreference(aiSettings.appearance),
  )
  const [recentReviews, setRecentReviews] = useState<readonly RecentReviewEntry[]>([])
  const [goToPaletteOpen, setGoToPaletteOpen] = useState(false)
  const [updateState, setUpdateState] = useState<AppUpdateState | null>(null)
  const [debouncedRemoteSearchQuery, setDebouncedRemoteSearchQuery] = useState("")
  const deferredSearchQuery = useDeferredValue(query.trim())
  const localSearchQuery = scopedLocalSearchQuery(deferredSearchQuery, selectedSearchScope)

  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.diffDash.updates.onStateChanged((state) => {
      if (!cancelled) setUpdateState(state)
    })
    void window.diffDash.updates
      .getState()
      .then((state) => {
        if (!cancelled) setUpdateState(state)
        return undefined
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

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
    selectedRepo === null
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
  const selectedRepoProvider =
    selectedRepo === null
      ? null
      : (availableProviders.find((provider) => provider.id === selectedRepo.provider) ?? null)
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

  const localResultsResult = useAtomValue(localSearchAtom)
  const remoteResultsResult = useAtomValue(remoteSearchAtom)
  const reviewRequestsResult = useAtomValue(reviewRequestsAtom)
  const repoPrCountsResult = useAtomValue(repoPrCountsAtom)
  const pullRequestsResult = useAtomValue(selectedRepoPullRequestsAtom)
  const refreshPullRequests = useAtomSet(refreshPullRequestsAtom)
  const refreshRepositories = useAtomRefresh(repositoriesAtom)
  const refreshProviders = useAtomRefresh(providersAtom)
  const refreshLocalSearch = useAtomRefresh(localSearchAtom)
  const refreshRemoteSearch = useAtomRefresh(remoteSearchAtom)
  const refreshDiagnostics = useAtomRefresh(diagnosticsAtom)
  const refreshAgentProviderCatalog = useAtomRefresh(agentProviderCatalogAtom)
  const refreshSearchScopes = useAtomRefresh(selectedProviderSearchScopesAtom)
  const refreshReviewRequests = useAtomRefresh(reviewRequestsAtom)
  const refreshRepoPrCounts = useAtomRefresh(repoPrCountsAtom)
  const refreshPullRequestsForRepo = (key: string) => {
    refreshPullRequests(key)
  }
  const refreshSelectedPullRequests = useAtomRefresh(selectedRepoPullRequestsAtom)
  const repositoryMutations = useRepositoryMutations({
    repositories: refreshRepositories,
    localSearch: refreshLocalSearch,
    remoteSearch: refreshRemoteSearch,
    counts: refreshRepoPrCounts,
    selectedReviews: refreshSelectedPullRequests,
  })

  const repos = resultValue(repositoriesResult, [] as readonly Repo[])
  const bookmarksStatus = Result.isFailure(repositoriesResult)
    ? resultErrorMessage(repositoriesResult, "Could not load bookmarked repositories")
    : null
  const providers = availableProviders
  const bookmarkedRepos = repos.filter(isBookmarkedPullRequestRepo)
  const hasQuery = query.trim().length > 0
  const localResults = hasQuery ? resultValue(localResultsResult, [] as readonly Repo[]) : []
  const remoteResults =
    hasQuery && query.trim() === debouncedRemoteSearchQuery
      ? resultValue(remoteResultsResult, [] as readonly HostedRepository[])
      : []
  const reviewRequests = resultValue(reviewRequestsResult, [] as readonly HostedReviewSummary[])
  const repoPrCounts = resultValue(repoPrCountsResult, {} as Record<string, number>)
  const diagnostics = resultValue(diagnosticsResult, EMPTY_APP_PREREQUISITES as AppDiagnostics)
  const agentProviderCatalog = resultValue(agentProviderCatalogResult, EMPTY_AGENT_PROVIDER_CATALOG)
  const reviewSelection = useReviewSelection(selectedReview, providers)
  const reviewSourceOperations = useReviewSourceOperations(reviewSelection)
  const isLoadingDiagnostics = Result.isWaiting(diagnosticsResult)
  const pullRequests = resultValue(pullRequestsResult, [] as readonly HostedReviewSummary[])
  const reviewRepositoryLinkState: RepositoryLinkState =
    selectedReview?.kind !== "hosted"
      ? "not-applicable"
      : Result.isWaiting(repositoriesResult) || Result.isFailure(repositoriesResult)
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
  const bookmarkedRepoKeys = new Set(
    bookmarkedRepos.map((repo) => repoKey(repo.provider, repo.owner, repo.name)),
  )
  const uniqueRemoteResults = remoteResults.filter(
    (repo) =>
      !bookmarkedRepoKeys.has(
        repoKey(repo.locator.providerId, repo.locator.namespace, repo.locator.name),
      ),
  )
  const reviewRequestsStatus = Result.isFailure(reviewRequestsResult)
    ? resultErrorMessage(reviewRequestsResult, "Could not load review requests")
    : Result.isWaiting(reviewRequestsResult)
      ? "Loading review requests..."
      : reviewRequests.length === 0
        ? "No active review requests found."
        : `${reviewRequests.length} review request${reviewRequests.length === 1 ? "" : "s"} need attention.`
  const selectedRepoStatus =
    selectedRepo === null
      ? `Select a repo to preview its first 3 open ${selectedProvider?.terminology.reviewPlural ?? "reviews"}.`
      : Result.isFailure(pullRequestsResult)
        ? resultErrorMessage(pullRequestsResult, "Could not load pull requests")
        : Result.isWaiting(pullRequestsResult)
          ? `Loading open ${providerReviewLabel(selectedRepoProvider, 2)} for ${selectedRepo.owner}/${selectedRepo.name}...`
          : `${pullRequests.length} open ${providerReviewLabel(selectedRepoProvider, pullRequests.length)} in ${selectedRepo.owner}/${selectedRepo.name}`
  const isSearching =
    hasQuery &&
    (query.trim() !== debouncedRemoteSearchQuery ||
      query.trim() !== deferredSearchQuery ||
      Result.isWaiting(searchScopesResult) ||
      Result.isWaiting(localResultsResult) ||
      Result.isWaiting(remoteResultsResult))
  const searchError = Result.isFailure(searchScopesResult)
    ? resultErrorMessage(searchScopesResult, "Could not load repository owners")
    : Result.isFailure(remoteResultsResult)
      ? resultErrorMessage(
          remoteResultsResult,
          `Could not search ${selectedProvider?.displayName ?? "hosted"} repositories`,
        )
      : null
  const isLoadingPullRequests = selectedRepo !== null && Result.isWaiting(pullRequestsResult)
  const isLoadingReviewRequests = Result.isWaiting(reviewRequestsResult)

  const applyNavigationRoute = (route: AppNavigationRoute) => {
    setSelectedRepo(route.selectedRepo)
    setSelectedReview(route.selectedReview)
    setScreen(route.screen)
  }

  const navigateTo = (route: AppNavigationRoute) => {
    const currentHistory = navigationHistoryRef.current
    const currentRoute = currentHistory[navigationIndexRef.current]
    if (currentRoute !== undefined && sameNavigationRoute(currentRoute, route)) {
      applyNavigationRoute(route)
      return
    }

    const nextHistory = [...currentHistory.slice(0, navigationIndexRef.current + 1), route]
    navigationHistoryRef.current = nextHistory
    navigationIndexRef.current = nextHistory.length - 1
    applyNavigationRoute(route)
  }

  const navigateHistory = (delta: -1 | 1) => {
    const nextIndex = navigationIndexRef.current + delta
    const nextRoute = navigationHistoryRef.current[nextIndex]
    if (nextRoute === undefined) return

    navigationIndexRef.current = nextIndex
    applyNavigationRoute(nextRoute)
  }

  const navigateBack = () => {
    const currentRoute = navigationHistoryRef.current[navigationIndexRef.current]
    if (navigationIndexRef.current > 0 && currentRoute !== undefined) {
      navigateHistory(-1)
      return
    }

    if (screen === "review") {
      navigateTo({
        screen: selectedRepo === null ? "home" : "repo",
        selectedRepo,
        selectedReview: null,
      })
      return
    }

    if (screen === "repo") {
      navigateTo({ screen: "home", selectedRepo: null, selectedReview: null })
    }
  }

  useEffect(() => {
    refreshRepositories()
    refreshProviders()
    refreshDiagnostics()
    refreshAgentProviderCatalog()
    refreshSearchScopes()
    refreshReviewRequests()
    refreshRepoPrCounts()
  }, [
    refreshDiagnostics,
    refreshAgentProviderCatalog,
    refreshRepoPrCounts,
    refreshRepositories,
    refreshProviders,
    refreshReviewRequests,
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
    window.diffDash.appState
      .get()
      .then((state) => {
        if (!cancelled) setAppState(state)
        return undefined
      })
      .catch(() => {
        if (!cancelled) setAppState(DEFAULT_APP_STATE)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (appState?.onboardingCompleted !== true) return
    void window.diffDash.analytics.start().catch(() => undefined)
  }, [appState?.onboardingCompleted])

  useEffect(() => {
    const applyTheme = () => {
      const nextResolvedTheme = resolveThemePreference(aiSettings.appearance)
      setResolvedTheme(nextResolvedTheme)
      document.documentElement.classList.toggle("dark", nextResolvedTheme === "dark")
      document.documentElement.style.colorScheme = nextResolvedTheme
    }

    applyTheme()
    if (aiSettings.appearance !== "system") return undefined

    const media = window.matchMedia("(prefers-color-scheme: dark)")
    media.addEventListener("change", applyTheme)
    return () => media.removeEventListener("change", applyTheme)
  }, [aiSettings.appearance])

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
      navigateHistory(event.button === MOUSE_BUTTON_BACK ? -1 : 1)
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
  })

  useEffect(() => {
    const openGoToPalette = (event: KeyboardEvent) => {
      if (!isModKey(event) || event.shiftKey || event.key.toLowerCase() !== "k") return
      if (screen === "review") return

      event.preventDefault()
      setGoToPaletteOpen(true)
    }

    window.addEventListener("keydown", openGoToPalette)
    return () => window.removeEventListener("keydown", openGoToPalette)
  }, [screen])

  const bookmarkRemote = async (repo: HostedRepository) => {
    const label = hostedRepositoryLabel(repo)
    setActionStatus(`Bookmarking ${label}...`)
    try {
      const bookmarked = await repositoryMutations.favorite(repo)
      setActionStatus(`Bookmarked ${label}`)
      captureAnalytics({ event: "repository_bookmarked" })
      selectRepository(bookmarked, "home")
    } catch (error) {
      setActionStatus(formatError(error, "Could not bookmark repository"))
    }
  }

  const openRemoteRepository = (repo: HostedRepository) => {
    const now = new Date().toISOString()
    selectRepository(
      Repository.make({
        createdAt: now,
        id: repoKey(repo.locator.providerId, repo.locator.namespace, repo.locator.name),
        isFavorite: false,
        lastOpenedAt: null,
        lastSyncedAt: null,
        localPath: null,
        name: repo.locator.name,
        owner: repo.locator.namespace,
        provider: repo.locator.providerId,
        remoteUrl: repo.url,
        updatedAt: repo.updatedAt ?? now,
      }),
      "repo",
    )
  }

  const unbookmarkRepo = async (repo: Repo) => {
    try {
      await repositoryMutations.remove(repo)
      if (selectedRepo?.id === repo.id) {
        setSelectedRepo(null)
      }
      setActionStatus(`Removed bookmark for ${repo.owner}/${repo.name}`)
    } catch (error) {
      setActionStatus(formatError(error, "Could not update bookmark"))
    }
  }

  const selectRepository = (repo: Repo, nextScreen: Screen = "home") => {
    navigateTo({ screen: nextScreen, selectedRepo: repo, selectedReview: null })
    setActionStatus(`Loading open PRs for ${repo.owner}/${repo.name}...`)
    refreshPullRequestsForRepo(repoKey(repo.provider, repo.owner, repo.name))
  }

  const rememberRecentReview = (entry: Omit<RecentReviewEntry, "lastReviewedAt">) => {
    const lastReviewedAt = new Date().toISOString()
    setRecentReviews((reviews) =>
      [{ ...entry, lastReviewedAt }, ...reviews.filter((review) => review.key !== entry.key)].slice(
        0,
        6,
      ),
    )
  }

  const openReview = (pullRequest: HostedReviewSummary, sourceRepo: Repo | null = selectedRepo) => {
    const review: HostedReviewTarget = {
      kind: "hosted",
      review: pullRequest.locator,
    }
    navigateTo({ screen: "review", selectedRepo: sourceRepo, selectedReview: review })
    captureAnalytics({ event: "review_opened", reviewType: "pull_request" })
    setActionStatus(`Opening review #${pullRequest.locator.number}...`)
    rememberRecentReview({
      key: pullRequestReviewKey(review),
      repoName: pullRequest.locator.repository.name,
      repoOwner: pullRequest.locator.repository.namespace,
      sourceRepoId: sourceRepo?.id ?? null,
      target: review,
      title: pullRequest.title,
    })
  }

  const openReviewRequest = (pullRequest: HostedReviewSummary) => {
    openReview(pullRequest, null)
  }

  const openRecentReview = (entry: RecentReviewEntry) => {
    const sourceRepo = repos.find((repo) => repo.id === entry.sourceRepoId) ?? null
    navigateTo({ screen: "review", selectedRepo: sourceRepo, selectedReview: entry.target })
    setActionStatus(`Opening review #${entry.target.review.number}...`)
    rememberRecentReview({
      key: entry.key,
      repoName: entry.repoName,
      repoOwner: entry.repoOwner,
      sourceRepoId: entry.sourceRepoId,
      target: entry.target,
      title: entry.title,
    })
  }

  const openLocalReview = (target: LocalReviewTarget) => {
    const review: LocalDiffReviewTarget = { kind: "localDiff", target }
    navigateTo({ screen: "review", selectedRepo: null, selectedReview: review })
    captureAnalytics({ event: "review_opened", reviewType: "local_diff" })
    setActionStatus("Opening local changes...")
  }

  const openPullRequestNumber = (repo: Repo, number: number) => {
    const review: HostedReviewTarget = {
      kind: "hosted",
      review: makeHostedReviewLocator(repo.provider, repo.owner, repo.name, number),
    }
    navigateTo({ screen: "review", selectedRepo: repo, selectedReview: review })
    captureAnalytics({ event: "review_opened", reviewType: "pull_request" })
    setActionStatus(`Opening PR #${number}...`)
  }

  const installRepositoryLink = async (localPath: string) => {
    setCliNavigationError(null)
    setActionStatus("Linking local repository...")
    try {
      const linked = await repositoryMutations.install(localPath)
      setActionStatus(`Linked ${linked.owner}/${linked.name} to ${linked.localPath ?? localPath}.`)
      captureAnalytics({ event: "repository_linked" })
      selectRepository(linked, "repo")
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
    if (command["_tag"] === "openWorkingTree") {
      openLocalReview(workingTreeReviewTarget(command.localPath))
      return
    }
    if (command["_tag"] === "linkRepository") {
      await installRepositoryLink(command.localPath)
      return
    }
    if (command["_tag"] === "openBranchDiff") {
      setActionStatus(
        command.branchName === null
          ? "Resolving the default comparison branch..."
          : `Fetching comparison branch ${command.branchName}...`,
      )
      try {
        const target = await window.diffDash.localReviews.resolveBranch(
          command.localPath,
          command.branchName,
        )
        openLocalReview(target)
      } catch (error) {
        const message = formatError(error, "Could not resolve comparison branch")
        setActionStatus(message)
        setCliNavigationError(message)
      }
      return
    }

    setActionStatus("Opening repository pull requests...")
    try {
      const repo = await repositoryMutations.install(command.localPath)
      captureAnalytics({ event: "repository_linked" })
      if (command.number === null) selectRepository(repo, "repo")
      else openPullRequestNumber(repo, command.number)
    } catch (error) {
      const message = formatError(error, "Could not open repository pull requests")
      setActionStatus(message)
      setCliNavigationError(message)
    }
  }
  const handleCliNavigationCommandEvent = useEffectEvent(handleCliNavigationCommand)

  const linkSelectedReviewRepository = async () => {
    if (selectedReview?.kind !== "hosted") return false
    const localPath = await window.diffDash.repositories.selectLocalFolder()
    if (localPath === null) return false

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

  useEffect(() => {
    const drainCommands = () => {
      commandDrainRef.current = commandDrainRef.current
        .catch(() => undefined)
        .then(async () => {
          const commands = await window.diffDash.navigation.drainCommands()
          await commands.reduce<Promise<void>>(
            (previous, command) => previous.then(() => handleCliNavigationCommandEvent(command)),
            Promise.resolve(),
          )
          return undefined
        })
      return commandDrainRef.current
    }
    const unsubscribe = window.diffDash.navigation.onCommandsAvailable(() => {
      void drainCommands().catch(() => undefined)
    })
    void drainCommands().catch(() => undefined)

    return () => {
      unsubscribe()
    }
  }, [])

  const updateAISettings = (settings: AISettings) => {
    void settingsMutation.update(settings).catch(() => undefined)
  }

  const recheckPrerequisites = () => {
    setSetupActionStatus("Rechecking setup...")
    refreshDiagnostics()
  }

  const openSetupDocs = (url: string) => {
    void window.diffDash.openExternalUrl(url).catch((error) => {
      setSetupActionStatus(formatError(error, "Could not open setup documentation"))
    })
  }

  const installDiffDashCli = async () => {
    setSetupActionStatus("Installing diffdash in PATH...")
    try {
      const result = await window.diffDash.installDiffDashCli()
      setSetupActionStatus(
        result.pathSetupCommand === null
          ? `Installed diffdash at ${result.path}`
          : `Installed diffdash at ${result.path}. Add it to this shell with: ${result.pathSetupCommand}`,
      )
      refreshDiagnostics()
    } catch (error) {
      setSetupActionStatus(formatError(error, "Could not install diffdash in PATH"))
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
      const savedState = await window.diffDash.appState.update(nextState)
      setAppState(savedState)
      if (telemetryEnabled) {
        await window.diffDash.analytics.start()
        await window.diffDash.analytics.capture({ event: "onboarding_completed" })
      }
    } catch (error) {
      setSetupActionStatus(formatError(error, "Could not save onboarding state"))
    }
  }

  const showReviewShell = appState?.onboardingCompleted === true && screen === "review"

  return (
    <main
      className={`bg-background text-foreground h-full ${showReviewShell ? "overflow-hidden" : "overflow-auto"}`}
    >
      <span className="sr-only" aria-live="polite">
        {actionStatus}
      </span>
      {updateState === null ? null : (
        <UpdateBanner
          state={updateState}
          onCheck={() => void window.diffDash.updates.check().catch(() => undefined)}
          onDownload={() => {
            captureAnalytics({ event: "update_download_started" })
            void window.diffDash.updates.download().catch(() => undefined)
          }}
          onRestart={() => {
            captureAnalytics({ event: "update_install_started" })
            void window.diffDash.updates.restartAndInstall().catch(() => undefined)
          }}
        />
      )}
      {cliNavigationError === null ? null : (
        <div
          role="alert"
          className="bg-destructive text-destructive-foreground fixed top-3 left-1/2 z-50 flex max-w-xl -translate-x-1/2 items-center gap-3 rounded-lg px-4 py-3 text-sm shadow-lg"
        >
          <span className="min-w-0 flex-1">{cliNavigationError}</span>
          <Button size="sm" variant="secondary" onClick={() => setCliNavigationError(null)}>
            Dismiss
          </Button>
        </div>
      )}
      {appState === null ? (
        <section className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-8 py-10">
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
      ) : screen === "review" ? (
        <ReviewScreen
          detailEnvironment={{
            aiAgentAvailable:
              agentRouteAvailable(
                agentProviderCatalog,
                aiSettings.routes.walkthrough,
                "walkthrough",
              ) || Result.isWaiting(agentProviderCatalogResult),
            aiSettings,
            repositoryLinkState: reviewRepositoryLinkState,
            theme: resolvedTheme,
            onAISettingsChange: updateAISettings,
            onLinkRepository: linkSelectedReviewRepository,
          }}
          selection={reviewSelection}
          sourceOperations={reviewSourceOperations}
          onBack={navigateBack}
        />
      ) : screen === "repo" && selectedRepo ? (
        <RepositoryScreen
          isLoading={isLoadingPullRequests}
          pullRequests={pullRequests}
          repo={selectedRepo}
          status={selectedRepoStatus}
          onBack={navigateBack}
          onOpenReview={(pullRequest) => void openReview(pullRequest)}
        />
      ) : (
        <HomeScreen
          activeProviderId={activeProviderId}
          bookmarkedRepos={bookmarkedRepos}
          bookmarksStatus={bookmarksStatus}
          diagnostics={diagnostics}
          hasQuery={hasQuery}
          isLoadingDiagnostics={isLoadingDiagnostics}
          isLoadingPullRequests={isLoadingPullRequests}
          isLoadingReviewRequests={isLoadingReviewRequests}
          isSearching={isSearching}
          localResults={localResults}
          providers={providers}
          pullRequests={pullRequests}
          query={query}
          recentReviews={recentReviews}
          remoteResults={uniqueRemoteResults}
          repoPrCounts={repoPrCounts}
          reviewRequests={reviewRequests}
          reviewRequestsStatus={reviewRequestsStatus}
          searchError={searchError}
          searchScopes={searchScopes}
          selectedProvider={selectedProvider}
          selectedRepo={selectedRepo}
          selectedRepoStatus={selectedRepoStatus}
          selectedSearchScope={selectedSearchScope}
          setupStatus={setupActionStatus}
          onBookmark={(repo) => void bookmarkRemote(repo)}
          onInstallDiffDashCli={() => void installDiffDashCli()}
          onRetryBookmarks={refreshRepositories}
          onOpenDocs={openSetupDocs}
          onOpenRecentReview={openRecentReview}
          onOpenReview={openReview}
          onOpenReviewRequest={openReviewRequest}
          onQueryChange={setQuery}
          onRecheck={recheckPrerequisites}
          onSelectProvider={(providerId) => {
            setSelectedProviderId(GitProviderId.make(providerId))
            setSelectedSearchScope(null)
          }}
          onSelectRepo={(repo) => selectRepository(repo, "home")}
          onSelectRemote={openRemoteRepository}
          onSelectScope={(scope) =>
            setSelectedSearchScope((current) => (current === scope ? null : scope))
          }
          onShowAll={() => navigateTo({ screen: "repo", selectedRepo, selectedReview: null })}
          onToggleBookmark={(repo) => void unbookmarkRepo(repo)}
        />
      )}
      <CommandPaletteDialog
        items={goToPaletteItems({
          bookmarkedRepos,
          onOpenRecentReview: openRecentReview,
          onOpenPullRequest: openReview,
          onOpenRepo: (repo) => selectRepository(repo, "home"),
          onOpenReviewRequest: openReviewRequest,
          pullRequests,
          recentReviews,
          reviewRequests,
          selectedRepo,
        })}
        open={goToPaletteOpen}
        placeholder="Search repos and PRs"
        title="Go anywhere"
        onOpenChange={setGoToPaletteOpen}
      />
    </main>
  )
}

const isModKey = (event: KeyboardEvent) => event.metaKey || event.ctrlKey

const pullRequestReviewKey = (target: HostedReviewTarget) =>
  pullRequestAtomKey(
    target.review.repository.providerId,
    target.review.repository.namespace,
    target.review.repository.name,
    target.review.number,
  )

const goToPaletteItems = ({
  bookmarkedRepos,
  onOpenPullRequest,
  onOpenRecentReview,
  onOpenRepo,
  onOpenReviewRequest,
  pullRequests,
  recentReviews,
  reviewRequests,
  selectedRepo,
}: {
  readonly bookmarkedRepos: readonly Repo[]
  readonly onOpenPullRequest: (pullRequest: HostedReviewSummary, sourceRepo?: Repo | null) => void
  readonly onOpenRecentReview: (review: RecentReviewEntry) => void
  readonly onOpenRepo: (repo: Repo) => void
  readonly onOpenReviewRequest: (pullRequest: HostedReviewSummary) => void
  readonly pullRequests: readonly HostedReviewSummary[]
  readonly recentReviews: readonly RecentReviewEntry[]
  readonly reviewRequests: readonly HostedReviewSummary[]
  readonly selectedRepo: Repo | null
}): readonly CommandPaletteItem[] => [
  ...bookmarkedRepos.map((repo) => ({
    id: `repo:${repo.id}`,
    keywords: `${repo.owner} ${repo.name} repository bookmark`,
    subtitle:
      repo.localPath === null ? "Remote bookmarked repository" : "Local bookmarked repository",
    title: `${repo.owner}/${repo.name}`,
    onSelect: () => onOpenRepo(repo),
  })),
  ...reviewRequests.map((pullRequest) => ({
    id: `review-request:${pullRequest.locator.repository.namespace}/${pullRequest.locator.repository.name}#${pullRequest.locator.number}`,
    keywords: `${pullRequest.locator.repository.namespace} ${pullRequest.locator.repository.name} ${pullRequest.title} review request`,
    subtitle: `Review request · ${pullRequest.locator.repository.namespace}/${pullRequest.locator.repository.name}`,
    title: `#${pullRequest.locator.number} ${pullRequest.title}`,
    onSelect: () => onOpenReviewRequest(pullRequest),
  })),
  ...pullRequests.map((pullRequest) => ({
    id: `hosted-review:${pullRequest.locator.repository.namespace}/${pullRequest.locator.repository.name}#${pullRequest.locator.number}`,
    keywords: `${pullRequest.locator.repository.namespace} ${pullRequest.locator.repository.name} ${pullRequest.title} hosted review`,
    subtitle: `Open review · ${pullRequest.locator.repository.namespace}/${pullRequest.locator.repository.name}`,
    title: `#${pullRequest.locator.number} ${pullRequest.title}`,
    onSelect: () => onOpenPullRequest(pullRequest, selectedRepo),
  })),
  ...recentReviews.map((review) => ({
    id: `recent:${review.key}`,
    keywords: `${review.repoOwner} ${review.repoName} ${review.title} recently reviewed`,
    subtitle: `Recently reviewed · ${formatReviewTimestamp(review.lastReviewedAt)}`,
    title: `#${review.target.review.number} ${review.title}`,
    onSelect: () => onOpenRecentReview(review),
  })),
]

const formatReviewTimestamp = (value: string) => formatTimestamp(value, "Unknown date")

const providerReviewLabel = (provider: GitProviderDescriptor | null, count: number) =>
  provider?.terminology.reviewAbbreviation === undefined
    ? count === 1
      ? (provider?.terminology.reviewSingular ?? "review")
      : (provider?.terminology.reviewPlural ?? "reviews")
    : `${provider.terminology.reviewAbbreviation}${count === 1 ? "" : "s"}`

const hostedRepositoryLabel = (repository: HostedRepository) =>
  `${repository.locator.namespace}/${repository.locator.name}`

const resultValue = <A,>(result: Result.Result<A, unknown>, fallback: A) =>
  Result.getOrElse(result, () => fallback)

const resultErrorMessage = (result: Result.Result<unknown, unknown>, fallback: string) =>
  Result.matchWithError(result, {
    onInitial: () => fallback,
    onError: (error) => formatError(error, fallback),
    onDefect: (defect) => formatError(defect, fallback),
    onSuccess: () => fallback,
  })
