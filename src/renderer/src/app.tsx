import type { FileDiffOptions, VirtualFileMetrics } from "@pierre/diffs"
import { PatchDiff } from "@pierre/diffs/react"
import { preparePresortedFileTreeInput } from "@pierre/trees"
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react"
import { Atom, Result, useAtomRefresh, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { Effect, Schema } from "effect"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  FolderGit2,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Laptop,
  Loader2,
  Search,
  Sparkles,
  Star,
  Settings2,
  UserRound,
} from "lucide-react"
import { useDeferredValue, useEffect, useRef, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Surface } from "@/components/ui/surface"
import { DEFAULT_APP_STATE, type AppState } from "../../shared/app-state"
import {
  AI_PROVIDER_OPTIONS,
  AIProviderModels,
  AISettings,
  AUTO_MODEL_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  DEFAULT_AI_SETTINGS,
  OPENCODE_MODEL_OPTIONS,
  modelOptionsForProvider,
  selectedModelForProvider,
  type AIProvider,
  type AutoModel,
  type ClaudeModel,
  type CodexModel,
  type OpenCodeModel,
} from "../../shared/ai-settings"
import { parseUnifiedDiff } from "../../shared/diff-parser"
import { buildReviewFileTreeInput } from "../../shared/file-tree-adapter"
import { Repo } from "../../shared/domain"
import { EMPTY_APP_PREREQUISITES, type AppPrerequisites } from "../../shared/prerequisites"
import type {
  LocalReviewDetail,
  ParsedDiff,
  ParsedDiffFile,
  PullRequestDetail,
  PullRequestSummary,
  RepositorySearchResult,
  RepositorySearchScope,
} from "../../shared/domain"
import {
  buildWalkthroughHunkDigest,
  flattenWalkthroughStops,
  focusFilesForWalkthroughHunks,
  summarizeWalkthroughHunksByPath,
  walkthroughLocalDiffScope,
  walkthroughPullRequestScope,
  type StoredWalkthrough,
  type Walkthrough,
  type WalkthroughHunkDigest,
  type WalkthroughRisk,
} from "../../shared/walkthrough"

type Screen = "home" | "repo" | "review"

type ReviewSidebarTab = "tree" | "walkthrough"

type AppDiagnostics = AppPrerequisites

type WalkthroughState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly message: string }
  | { readonly status: "ready"; readonly stored: StoredWalkthrough }
  | { readonly status: "error"; readonly message: string }

type PullRequestApprovalState = "checking" | "unapproved" | "approving" | "approved"

type SelectedReviewTarget =
  | {
      readonly kind: "pullRequest"
      readonly number: number
      readonly repoName: string
      readonly repoOwner: string
    }
  | {
      readonly kind: "localDiff"
      readonly rootPath: string
    }

type ReviewSubject =
  | {
      readonly kind: "pullRequest"
      readonly pullRequest: PullRequestDetail
    }
  | {
      readonly kind: "localDiff"
      readonly localReview: LocalReviewDetail
    }

type PullRequestReviewTarget = Extract<SelectedReviewTarget, { readonly kind: "pullRequest" }>

type LocalDiffReviewTarget = Extract<SelectedReviewTarget, { readonly kind: "localDiff" }>

type AppNavigationRoute = {
  readonly screen: Screen
  readonly selectedRepo: Repo | null
  readonly selectedReview: SelectedReviewTarget | null
}

const MOUSE_BUTTON_BACK = 3
const MOUSE_BUTTON_FORWARD = 4
const GH_CLI_DOCS_URL = "https://cli.github.com/"
const GH_AUTH_DOCS_URL = "https://cli.github.com/manual/gh_auth_login"
const CODING_AGENT_SETUP_MESSAGE =
  "Walkthroughs require Codex, Claude, or OpenCode. Install one of them to enable guided review."

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
    return right.kind === "localDiff" && left.rootPath === right.rootPath
  if (right.kind !== "pullRequest") return false
  return (
    left.repoOwner === right.repoOwner &&
    left.repoName === right.repoName &&
    left.number === right.number
  )
}

class RendererApiError extends Schema.TaggedError<RendererApiError>()("RendererApiError", {
  error: Schema.Defect,
  message: Schema.String,
}) {}

const REVIEW_DIFF_OPTIONS = {
  disableFileHeader: true,
  disableVirtualizationBuffers: true,
  diffStyle: "split",
  hunkSeparators: "line-info-basic",
  lineDiffType: "word",
  overflow: "wrap",
  stickyHeader: true,
  themeType: "light",
  unsafeCSS: `
    :host {
      --diffs-gap-block: 0px;
      --diffs-line-height: 20px;
    }

    [data-code],
    [data-diff-type="split"][data-overflow="wrap"] {
      padding-block: 0 !important;
      padding-top: 0 !important;
      padding-bottom: 0 !important;
    }

    [data-line],
    [data-content],
    [data-gutter],
    [data-column-number] {
      line-height: 20px !important;
      min-height: 20px !important;
    }

    pre {
      margin-block: 0 !important;
      margin-top: 0 !important;
      margin-bottom: 0 !important;
      padding-top: 0 !important;
      padding-bottom: 0 !important;
    }
  `,
} satisfies FileDiffOptions<undefined>

const REVIEW_DIFF_METRICS = {
  diffHeaderHeight: 0,
  hunkLineCount: 50,
  lineHeight: 20,
  paddingBottom: 0,
  paddingTop: 0,
  spacing: 0,
} satisfies VirtualFileMetrics

const REVIEW_FILE_TREE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-input-bg-override: transparent;
    --trees-border-color-override: var(--review-tree-indent);
    --trees-fg-override: var(--review-sidebar-fg);
    --trees-fg-muted-override: var(--review-sidebar-muted);
    --trees-selected-bg-override: var(--review-tree-selected);
  }

  [data-file-tree-id],
  [data-type="root"],
  [data-type="tree"],
  [data-type="viewport"],
  [data-type="scroll-container"],
  [data-type="sticky-overlay"] {
    background: transparent !important;
  }

  [data-type="item"] {
    background: transparent;
    --truncate-marker-opacity: 0%;
    --truncate-middle-marker-opacity: 0%;
    --truncate-fade-marker-color: transparent;
  }

  [data-type="item"]:hover {
    background: var(--review-sidebar-control-hover);
  }

  [data-type="item"] [data-truncate-marker],
  [data-type="item"] [data-truncate-marker]::before,
  [data-type="item"] [data-truncate-marker]::after,
  [data-type="item"] [data-truncate-fade] {
    background: transparent !important;
    background-color: transparent !important;
    background-image: none !important;
    box-shadow: none !important;
  }

  [data-type="item"][data-item-selected] {
    background: var(--review-tree-selected) !important;
    box-shadow: none !important;
    outline: 1px solid var(--review-tree-selected-border);
    outline-offset: -1px;
  }
`

const repositoriesAtom = Atom.make(
  fetchEffect(() => window.diffDash.repositories.list()),
  {
    initialValue: [] as readonly Repo[],
  },
).pipe(Atom.keepAlive)

const isBookmarkedPullRequestRepo = (repo: Repo) => repo.provider !== "local" && repo.isFavorite

const repositorySearchAtom = Atom.family((query: string) =>
  Atom.make(
    query.length === 0
      ? Effect.succeed([] as readonly Repo[])
      : fetchEffect(() => window.diffDash.repositories.list(query)).pipe(
          Effect.map((repos) => repos.filter(isBookmarkedPullRequestRepo)),
        ),
    { initialValue: [] as readonly Repo[] },
  ),
)

const remoteRepositorySearchAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.gen(function* () {
      const { query, scope } = parseRemoteSearchAtomKey(key)
      if (query.length === 0) return [] as readonly RepositorySearchResult[]

      const scopedQuery = scopedRemoteSearchQuery(query, scope)
      const scopedResults = yield* fetchEffect(() =>
        window.diffDash.gitProvider.searchRepositories(scopedQuery),
      )

      if (scope === null || scopedResults.length > 0) return scopedResults

      const fallbackResults = yield* fetchEffect(() =>
        window.diffDash.gitProvider.searchRepositories(query),
      )
      return filterRemoteResultsByScope(fallbackResults, scope)
    }),
    { initialValue: [] as readonly RepositorySearchResult[] },
  ),
)

const searchScopesAtom = Atom.make(
  fetchEffect(() => window.diffDash.gitProvider.listSearchScopes()),
  { initialValue: [] as readonly RepositorySearchScope[] },
).pipe(Atom.keepAlive)

const diagnosticsAtom = Atom.make(
  fetchEffect(() => window.diffDash.diagnostics()),
  {
    initialValue: EMPTY_APP_PREREQUISITES as AppDiagnostics,
  },
).pipe(Atom.keepAlive)

const scopedLocalSearchQuery = (query: string, scope: string | null) =>
  scope === null ? query : `${scope}/${query}`

const scopedRemoteSearchQuery = (query: string, scope: string | null) =>
  scope === null ? query : `owner:${scope} ${query}`

const remoteSearchAtomKey = (query: string, scope: string | null) => `${scope ?? ""}\u0000${query}`

const parseRemoteSearchAtomKey = (key: string) => {
  const [scope = "", query = ""] = key.split("\u0000", 2)
  return {
    query,
    scope: scope.length === 0 ? null : scope,
  }
}

const filterRemoteResultsByScope = (results: readonly RepositorySearchResult[], scope: string) => {
  const normalizedScope = scope.toLowerCase()
  return results.filter((repo) => repo.owner.toLowerCase() === normalizedScope)
}

const reviewRequestsAtom = Atom.make(
  fetchEffect(() => window.diffDash.gitProvider.listReviewRequests()),
  {
    initialValue: [] as readonly PullRequestSummary[],
  },
).pipe(Atom.keepAlive)

const pullRequestsAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.gen(function* () {
      const parsedKey = parseRepoAtomKey(key)
      if (parsedKey === null) return [] as readonly PullRequestSummary[]
      return yield* fetchEffect(() =>
        window.diffDash.gitProvider.listPullRequests(parsedKey.owner, parsedKey.name),
      )
    }),
    { initialValue: [] as readonly PullRequestSummary[] },
  ),
)

const repoPrCountsAtom = Atom.make(
  Effect.fnUntraced(function* (get: Atom.Context) {
    const repos = yield* get.result(repositoriesAtom)
    const entries = yield* Effect.all(
      repos.filter(isBookmarkedPullRequestRepo).map((repo) =>
        get.result(pullRequestsAtom(repoKey(repo.owner, repo.name))).pipe(
          Effect.map((pullRequests) => [repo.id, pullRequests.length] as const),
          Effect.catchAll(() => Effect.succeed(null)),
        ),
      ),
    )
    return Object.fromEntries(entries.filter(isNonNull)) as Record<string, number>
  }),
  { initialValue: {} as Record<string, number> },
).pipe(Atom.keepAlive)

const pullRequestDetailAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.gen(function* () {
      const parsedKey = parsePullRequestAtomKey(key)
      if (parsedKey === null) return null
      return yield* fetchEffect(() =>
        window.diffDash.gitProvider.getPullRequestDetail(
          parsedKey.owner,
          parsedKey.name,
          parsedKey.number,
        ),
      )
    }),
    { initialValue: null as PullRequestDetail | null },
  ),
)

const pullRequestDiffAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.gen(function* () {
      const parsedKey = parsePullRequestAtomKey(key)
      if (parsedKey === null) return null
      const diff = yield* fetchEffect(() =>
        window.diffDash.gitProvider.getPullRequestDiff(
          parsedKey.owner,
          parsedKey.name,
          parsedKey.number,
        ),
      )
      return parseUnifiedDiff(diff.diff)
    }),
    { initialValue: null as ParsedDiff | null },
  ),
)

const localReviewDetailAtom = Atom.family((rootPath: string) =>
  Atom.make(
    rootPath.length === 0
      ? Effect.succeed(null as LocalReviewDetail | null)
      : fetchEffect(() => window.diffDash.localReviews.getDetail(rootPath)),
    { initialValue: null as LocalReviewDetail | null },
  ),
)

const localReviewDiffAtom = Atom.family((rootPath: string) =>
  Atom.make(
    Effect.gen(function* () {
      if (rootPath.length === 0) return null
      const diff = yield* fetchEffect(() => window.diffDash.localReviews.getDiff(rootPath))
      return parseUnifiedDiff(diff.diff)
    }),
    { initialValue: null as ParsedDiff | null },
  ),
)

const bookmarkRemoteAtom = Atom.fn(
  Effect.fnUntraced(function* (repo: RepositorySearchResult) {
    return yield* fetchEffect(() => window.diffDash.repositories.favoriteRemote(repo))
  }),
)

const unbookmarkRepoAtom = Atom.fn(
  Effect.fnUntraced(function* (repo: Repo) {
    return yield* fetchEffect(() => window.diffDash.repositories.setFavorite(repo.id, false))
  }),
)

const refreshPullRequestsAtom = Atom.fnSync((key: string, get) => {
  get.refresh(pullRequestsAtom(key))
  get.refresh(repoPrCountsAtom)
})

/** Repo-first Home and early Review workspace shell. */
export function App() {
  const [screen, setScreen] = useState<Screen>("home")
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)
  const [selectedReview, setSelectedReview] = useState<SelectedReviewTarget | null>(null)
  const [selectedReviewPath, setSelectedReviewPath] = useState<string | null>(null)
  const [diffRenderPass, setDiffRenderPass] = useState(0)
  const [expandedFileKeys, setExpandedFileKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [viewedFileKeys, setViewedFileKeys] = useState<ReadonlySet<string>>(() => new Set())
  const navigationHistoryRef = useRef<readonly AppNavigationRoute[]>([
    { screen: "home", selectedRepo: null, selectedReview: null },
  ])
  const navigationIndexRef = useRef(0)
  const handledMouseNavigationButtonRef = useRef<number | null>(null)
  const [query, setQuery] = useState("")
  const [selectedSearchScope, setSelectedSearchScope] = useState<string | null>(null)
  const [actionStatus, setActionStatus] = useState("Search a repo or open a bookmark.")
  const [setupActionStatus, setSetupActionStatus] = useState<string | null>(null)
  const [appState, setAppState] = useState<AppState | null>(null)
  const [aiSettings, setAISettings] = useState<AISettings>(DEFAULT_AI_SETTINGS)
  const deferredSearchQuery = useDeferredValue(query.trim())
  const localSearchQuery = scopedLocalSearchQuery(deferredSearchQuery, selectedSearchScope)
  const remoteSearchKey = remoteSearchAtomKey(deferredSearchQuery, selectedSearchScope)

  const selectedRepoKey =
    selectedRepo === null ? "" : repoKey(selectedRepo.owner, selectedRepo.name)
  const selectedPullRequestReviewKey =
    selectedReview === null || selectedReview.kind !== "pullRequest"
      ? ""
      : pullRequestAtomKey(selectedReview.repoOwner, selectedReview.repoName, selectedReview.number)
  const selectedLocalReviewKey =
    selectedReview === null || selectedReview.kind !== "localDiff" ? "" : selectedReview.rootPath
  const localSearchAtom = repositorySearchAtom(localSearchQuery)
  const remoteSearchAtom = remoteRepositorySearchAtom(remoteSearchKey)
  const selectedRepoPullRequestsAtom = pullRequestsAtom(selectedRepoKey)
  const selectedPullRequestDetailAtom = pullRequestDetailAtom(selectedPullRequestReviewKey)
  const selectedPullRequestDiffAtom = pullRequestDiffAtom(selectedPullRequestReviewKey)
  const selectedLocalReviewDetailAtom = localReviewDetailAtom(selectedLocalReviewKey)
  const selectedLocalReviewDiffAtom = localReviewDiffAtom(selectedLocalReviewKey)

  const repositoriesResult = useAtomValue(repositoriesAtom)
  const diagnosticsResult = useAtomValue(diagnosticsAtom)
  const searchScopesResult = useAtomValue(searchScopesAtom)
  const localResultsResult = useAtomValue(localSearchAtom)
  const remoteResultsResult = useAtomValue(remoteSearchAtom)
  const reviewRequestsResult = useAtomValue(reviewRequestsAtom)
  const repoPrCountsResult = useAtomValue(repoPrCountsAtom)
  const pullRequestsResult = useAtomValue(selectedRepoPullRequestsAtom)
  const selectedPullRequestResult = useAtomValue(selectedPullRequestDetailAtom)
  const selectedPullRequestDiffResult = useAtomValue(selectedPullRequestDiffAtom)
  const selectedLocalReviewResult = useAtomValue(selectedLocalReviewDetailAtom)
  const selectedLocalDiffResult = useAtomValue(selectedLocalReviewDiffAtom)
  const bookmarkRemoteRepo = useAtomSet(bookmarkRemoteAtom, { mode: "promise" })
  const unbookmarkFavoriteRepo = useAtomSet(unbookmarkRepoAtom, { mode: "promise" })
  const refreshPullRequestsForRepo = useAtomSet(refreshPullRequestsAtom)
  const refreshRepositories = useAtomRefresh(repositoriesAtom)
  const refreshLocalSearch = useAtomRefresh(localSearchAtom)
  const refreshRemoteSearch = useAtomRefresh(remoteSearchAtom)
  const refreshDiagnostics = useAtomRefresh(diagnosticsAtom)
  const refreshSearchScopes = useAtomRefresh(searchScopesAtom)
  const refreshReviewRequests = useAtomRefresh(reviewRequestsAtom)
  const refreshRepoPrCounts = useAtomRefresh(repoPrCountsAtom)
  const refreshSelectedPullRequests = useAtomRefresh(selectedRepoPullRequestsAtom)

  const repos = resultValue(repositoriesResult, [] as readonly Repo[])
  const searchScopes = resultValue(searchScopesResult, [] as readonly RepositorySearchScope[])
  const bookmarkedRepos = repos.filter(isBookmarkedPullRequestRepo)
  const hasQuery = query.trim().length > 0
  const localResults = hasQuery ? resultValue(localResultsResult, [] as readonly Repo[]) : []
  const remoteResults = hasQuery
    ? resultValue(remoteResultsResult, [] as readonly RepositorySearchResult[])
    : []
  const reviewRequests = resultValue(reviewRequestsResult, [] as readonly PullRequestSummary[])
  const repoPrCounts = resultValue(repoPrCountsResult, {} as Record<string, number>)
  const diagnostics = resultValue(diagnosticsResult, EMPTY_APP_PREREQUISITES as AppDiagnostics)
  const isLoadingDiagnostics = Result.isWaiting(diagnosticsResult)
  const pullRequests = resultValue(pullRequestsResult, [] as readonly PullRequestSummary[])
  const selectedPullRequest = resultValue(selectedPullRequestResult, null)
  const selectedPullRequestDiff = resultValue(selectedPullRequestDiffResult, null)
  const selectedLocalReview = resultValue(selectedLocalReviewResult, null)
  const selectedLocalDiff = resultValue(selectedLocalDiffResult, null)
  const selectedReviewSubject = reviewSubjectFromSelection(
    selectedReview,
    selectedPullRequest,
    selectedLocalReview,
  )
  const selectedDiff =
    selectedReview?.kind === "localDiff" ? selectedLocalDiff : selectedPullRequestDiff
  const selectedReviewKind = selectedReview?.kind ?? null
  const bookmarkedRepoKeys = new Set(bookmarkedRepos.map((repo) => repoKey(repo.owner, repo.name)))
  const uniqueRemoteResults = remoteResults.filter(
    (repo) => !bookmarkedRepoKeys.has(repoKey(repo.owner, repo.name)),
  )
  const previewPullRequests = pullRequests.slice(0, 3)
  const reviewRequestsStatus = Result.isFailure(reviewRequestsResult)
    ? resultErrorMessage(reviewRequestsResult, "Could not load review requests")
    : Result.isWaiting(reviewRequestsResult)
      ? "Loading review requests..."
      : reviewRequests.length === 0
        ? "No active review requests found."
        : `${reviewRequests.length} review request${reviewRequests.length === 1 ? "" : "s"} need attention.`
  const selectedRepoStatus =
    selectedRepo === null
      ? "Select a repo to preview its first 3 open PRs."
      : Result.isFailure(pullRequestsResult)
        ? resultErrorMessage(pullRequestsResult, "Could not load pull requests")
        : Result.isWaiting(pullRequestsResult)
          ? `Loading open PRs for ${selectedRepo.owner}/${selectedRepo.name}...`
          : `${pullRequests.length} open PR${pullRequests.length === 1 ? "" : "s"} in ${selectedRepo.owner}/${selectedRepo.name}`
  const reviewStatus =
    selectedReview === null
      ? actionStatus
      : selectedReview.kind === "localDiff"
        ? Result.isFailure(selectedLocalReviewResult) || Result.isFailure(selectedLocalDiffResult)
          ? resultErrorMessage(
              Result.isFailure(selectedLocalReviewResult)
                ? selectedLocalReviewResult
                : selectedLocalDiffResult,
              "Could not open local changes",
            )
          : selectedLocalReview === null
            ? "Opening local changes..."
            : Result.isWaiting(selectedLocalDiffResult)
              ? "Loading local diff..."
              : selectedDiff?.files.length === 0
                ? `No local changes in ${selectedLocalReview.repoName}`
                : `Opened local changes in ${selectedLocalReview.repoName}`
        : Result.isFailure(selectedPullRequestResult) ||
            Result.isFailure(selectedPullRequestDiffResult)
          ? resultErrorMessage(
              Result.isFailure(selectedPullRequestResult)
                ? selectedPullRequestResult
                : selectedPullRequestDiffResult,
              "Could not open pull request",
            )
          : selectedPullRequest === null
            ? `Opening PR #${selectedReview.number}...`
            : Result.isWaiting(selectedPullRequestDiffResult)
              ? `Loading diff for PR #${selectedPullRequest.number}...`
              : `Opened PR #${selectedPullRequest.number}: ${selectedPullRequest.title}`
  const isSearching =
    hasQuery &&
    (query.trim() !== deferredSearchQuery ||
      Result.isWaiting(localResultsResult) ||
      Result.isWaiting(remoteResultsResult))
  const isLoadingPullRequests = selectedRepo !== null && Result.isWaiting(pullRequestsResult)
  const isLoadingReview =
    selectedReview?.kind === "localDiff"
      ? Result.isWaiting(selectedLocalReviewResult) || Result.isWaiting(selectedLocalDiffResult)
      : Result.isWaiting(selectedPullRequestResult) ||
        Result.isWaiting(selectedPullRequestDiffResult)
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
    refreshDiagnostics()
    refreshSearchScopes()
    refreshReviewRequests()
    refreshRepoPrCounts()
  }, [
    refreshDiagnostics,
    refreshRepoPrCounts,
    refreshRepositories,
    refreshReviewRequests,
    refreshSearchScopes,
  ])

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
    let cancelled = false
    window.diffDash.settings
      .get()
      .then((settings) => {
        if (!cancelled) setAISettings(settings)
        return undefined
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [])

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
    if (screen !== "review" || selectedDiff === null) return
    setSelectedReviewPath((path) => {
      if (path !== null && selectedDiff.files.some((file) => file.path === path)) return path
      return selectedDiff.files[0]?.path ?? null
    })
  }, [screen, selectedDiff])

  useEffect(() => {
    if (screen !== "review" || selectedDiff === null) return
    setExpandedFileKeys(new Set(selectedDiff.files.map((file) => file.reviewKey)))
  }, [screen, selectedDiff])

  useEffect(() => {
    if (screen !== "review" || selectedDiff === null) return
    setDiffRenderPass(0)
    const remountTimer = window.setTimeout(() => setDiffRenderPass(1), 250)
    return () => window.clearTimeout(remountTimer)
  }, [screen, selectedDiff])

  useEffect(() => {
    if (screen !== "review" || selectedReviewKind === null || selectedDiff === null) {
      return
    }

    let cancelled = false
    const viewedFiles =
      selectedReviewKind === "pullRequest"
        ? selectedPullRequest?.headRefOid === null || selectedPullRequest === null
          ? Promise.resolve([] as readonly string[])
          : window.diffDash.viewedFiles.list(
              selectedPullRequest.repoOwner,
              selectedPullRequest.repoName,
              selectedPullRequest.number,
              selectedPullRequest.headRefOid,
            )
        : selectedLocalReview === null
          ? Promise.resolve([] as readonly string[])
          : window.diffDash.viewedFiles.listLocal(
              selectedLocalReview.rootPath,
              selectedLocalReview.headSha,
            )

    viewedFiles
      .then((reviewKeys) => {
        if (!cancelled) setViewedFileKeys(new Set(reviewKeys))
        return undefined
      })
      .catch(() => {
        if (!cancelled) setViewedFileKeys(new Set())
      })

    return () => {
      cancelled = true
    }
  }, [screen, selectedReviewKind, selectedPullRequest, selectedLocalReview, selectedDiff])

  const setFileViewed = (reviewKey: string, viewed: boolean) => {
    setViewedFileKeys((keys) => {
      const nextKeys = new Set(keys)
      if (viewed) {
        nextKeys.add(reviewKey)
      } else {
        nextKeys.delete(reviewKey)
      }
      return nextKeys
    })
    setExpandedFileKeys((keys) => {
      const nextKeys = new Set(keys)
      if (viewed) {
        nextKeys.delete(reviewKey)
      } else {
        nextKeys.add(reviewKey)
      }
      return nextKeys
    })
    const changedFile = selectedDiff?.files.find(
      (file) => file.reviewKey === reviewKey || reviewKey.startsWith(`${file.reviewKey}:`),
    )
    if (selectedReviewSubject?.kind === "pullRequest" && changedFile !== undefined) {
      if (selectedReviewSubject.pullRequest.headRefOid === null) return
      void window.diffDash.viewedFiles.set(
        selectedReviewSubject.pullRequest.repoOwner,
        selectedReviewSubject.pullRequest.repoName,
        selectedReviewSubject.pullRequest.number,
        selectedReviewSubject.pullRequest.headRefOid,
        reviewKey,
        changedFile.path,
        viewed,
      )
      return
    }

    if (selectedReviewSubject?.kind === "localDiff" && changedFile !== undefined) {
      void window.diffDash.viewedFiles.setLocal(
        selectedReviewSubject.localReview.rootPath,
        selectedReviewSubject.localReview.headSha,
        reviewKey,
        changedFile.path,
        viewed,
      )
    }
  }

  const toggleExpandedFile = (reviewKey: string) => {
    setExpandedFileKeys((keys) => {
      const nextKeys = new Set(keys)
      if (nextKeys.has(reviewKey)) {
        nextKeys.delete(reviewKey)
      } else {
        nextKeys.add(reviewKey)
      }
      return nextKeys
    })
  }

  const bookmarkRemote = async (repo: RepositorySearchResult) => {
    setActionStatus(`Bookmarking ${repo.nameWithOwner}...`)
    try {
      const bookmarked = await bookmarkRemoteRepo(repo)
      refreshRepositories()
      refreshLocalSearch()
      refreshRemoteSearch()
      refreshRepoPrCounts()
      setActionStatus(`Bookmarked ${repo.nameWithOwner}`)
      selectRepository(bookmarked, "home")
    } catch (error) {
      setActionStatus(formatError(error, "Could not bookmark repository"))
    }
  }

  const openRemoteRepository = (repo: RepositorySearchResult) => {
    const now = new Date().toISOString()
    selectRepository(
      Repo.make({
        createdAt: now,
        id: repoKey(repo.owner, repo.name),
        isFavorite: false,
        lastOpenedAt: null,
        lastSyncedAt: null,
        localPath: null,
        name: repo.name,
        owner: repo.owner,
        provider: "github",
        remoteUrl: repo.url,
        updatedAt: repo.updatedAt ?? now,
      }),
      "repo",
    )
  }

  const unbookmarkRepo = async (repo: Repo) => {
    try {
      await unbookmarkFavoriteRepo(repo)
      refreshRepositories()
      refreshRepoPrCounts()
      refreshSelectedPullRequests()
      if (selectedRepo?.id === repo.id) {
        setSelectedRepo(null)
      }
      setActionStatus(`Removed bookmark for ${repo.owner}/${repo.name}`)
    } catch (error) {
      setActionStatus(formatError(error, "Could not update bookmark"))
    }
  }

  const selectRepository = (repo: Repo, nextScreen: Screen = "home") => {
    setSelectedReviewPath(null)
    setExpandedFileKeys(new Set())
    setViewedFileKeys(new Set())
    navigateTo({ screen: nextScreen, selectedRepo: repo, selectedReview: null })
    setActionStatus(`Loading open PRs for ${repo.owner}/${repo.name}...`)
    refreshPullRequestsForRepo(repoKey(repo.owner, repo.name))
  }

  const openReview = (pullRequest: PullRequestSummary, sourceRepo: Repo | null = selectedRepo) => {
    const review: PullRequestReviewTarget = {
      kind: "pullRequest",
      number: pullRequest.number,
      repoName: pullRequest.repoName,
      repoOwner: pullRequest.repoOwner,
    }
    setSelectedReviewPath(null)
    setExpandedFileKeys(new Set())
    setViewedFileKeys(new Set())
    navigateTo({ screen: "review", selectedRepo: sourceRepo, selectedReview: review })
    setActionStatus(`Opening PR #${pullRequest.number}...`)
  }

  const openReviewRequest = (pullRequest: PullRequestSummary) => {
    openReview(pullRequest, null)
  }

  const openLocalReview = (rootPath: string) => {
    const review: LocalDiffReviewTarget = { kind: "localDiff", rootPath }
    setSelectedReviewPath(null)
    setExpandedFileKeys(new Set())
    setViewedFileKeys(new Set())
    navigateTo({ screen: "review", selectedRepo: null, selectedReview: review })
    setActionStatus("Opening local changes...")
  }

  useEffect(() => {
    let cancelled = false
    window.diffDash.navigation
      .getPendingLocalReview()
      .then((rootPath) => {
        if (!cancelled && rootPath !== null) openLocalReview(rootPath)
        return undefined
      })
      .catch(() => undefined)

    const unsubscribe = window.diffDash.navigation.onOpenLocalReview((rootPath) => {
      openLocalReview(rootPath)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const updateAISettings = (settings: AISettings) => {
    const previousSettings = aiSettings
    setAISettings(settings)
    void window.diffDash.settings
      .update(settings)
      .then((savedSettings) => {
        setAISettings(savedSettings)
        setActionStatus("Saved walkthrough AI settings.")
        return undefined
      })
      .catch((error) => {
        setAISettings(previousSettings)
        setActionStatus(formatError(error, "Could not save walkthrough AI settings"))
      })
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
      setSetupActionStatus(`Installed diffdash at ${result.path}`)
      refreshDiagnostics()
    } catch (error) {
      setSetupActionStatus(formatError(error, "Could not install diffdash in PATH"))
    }
  }

  const completeOnboarding = async () => {
    const nextState: AppState = { onboardingCompleted: true }
    setAppState(nextState)
    try {
      const savedState = await window.diffDash.appState.update(nextState)
      setAppState(savedState)
    } catch (error) {
      setSetupActionStatus(formatError(error, "Could not save onboarding state"))
    }
  }

  const showReviewShell = appState?.onboardingCompleted === true && screen === "review"

  return (
    <main
      className={`bg-background text-foreground h-full ${showReviewShell ? "overflow-hidden" : "overflow-auto"}`}
    >
      {appState === null ? (
        <section className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-8 py-10">
          <EmptyState>Loading DiffDash...</EmptyState>
        </section>
      ) : !appState.onboardingCompleted ? (
        <OnboardingScreen
          diagnostics={diagnostics}
          isLoadingDiagnostics={isLoadingDiagnostics}
          status={setupActionStatus}
          onComplete={() => void completeOnboarding()}
          onInstallDiffDashCli={() => void installDiffDashCli()}
          onOpenDocs={openSetupDocs}
          onRecheck={recheckPrerequisites}
        />
      ) : screen === "review" ? (
        selectedReviewSubject ? (
          <ReviewScreen
            aiAgentAvailable={diagnostics.codingAgentInstalled || isLoadingDiagnostics}
            aiSettings={aiSettings}
            parsedDiff={selectedDiff}
            reviewSubject={selectedReviewSubject}
            diffRenderPass={diffRenderPass}
            expandedFileKeys={expandedFileKeys}
            selectedPath={selectedReviewPath}
            status={reviewStatus}
            viewedFileKeys={viewedFileKeys}
            onBack={navigateBack}
            onAISettingsChange={updateAISettings}
            onSelectPath={setSelectedReviewPath}
            onSetViewed={setFileViewed}
            onToggleExpanded={toggleExpandedFile}
          />
        ) : (
          <section className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-8 py-10">
            <Button
              variant="ghost"
              className="mb-4 w-fit"
              onClick={() =>
                navigateTo({ screen: "home", selectedRepo: null, selectedReview: null })
              }
            >
              <ArrowLeft className="size-4" />
              Home
            </Button>
            <EmptyState>{reviewStatus}</EmptyState>
          </section>
        )
      ) : screen === "repo" && selectedRepo ? (
        <RepoScreen
          isLoading={isLoadingPullRequests || isLoadingReview}
          pullRequests={pullRequests}
          repo={selectedRepo}
          status={selectedRepoStatus}
          onBack={navigateBack}
          onOpenReview={(pullRequest) => void openReview(pullRequest)}
        />
      ) : (
        <section className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-7 text-sm">
          <header className="space-y-3 pt-3">
            <Badge variant="secondary" className="text-caption w-fit gap-1.5">
              <Sparkles className="size-3" />
              Repo-first review workspace
            </Badge>
            <div className="space-y-2">
              <h1 className="max-w-3xl text-4xl font-semibold tracking-tight">DiffDash</h1>
              <p className="text-muted-foreground max-w-3xl text-sm">
                Find a repo, open a PR, and jump into focused review without leaving the desktop.
              </p>
            </div>
          </header>

          {!isLoadingDiagnostics && missingPrerequisiteRows(diagnostics).length > 0 ? (
            <SetupBanner
              diagnostics={diagnostics}
              status={setupActionStatus}
              onInstallDiffDashCli={() => void installDiffDashCli()}
              onOpenDocs={openSetupDocs}
              onRecheck={recheckPrerequisites}
            />
          ) : null}

          <div className="relative z-20">
            <div className="relative h-10">
              <div className="relative h-10">
                <Surface
                  active={hasQuery}
                  variant="floatingSearch"
                  className="absolute inset-x-0 top-0 z-30"
                >
                  <div className="relative h-10">
                    <Search className="text-muted-foreground absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      className="h-10 border-0 bg-transparent pr-9 pl-9 text-sm shadow-none focus-visible:border-0 focus-visible:bg-transparent focus-visible:ring-0"
                      placeholder="Search bookmarked and accessible repositories"
                    />
                    {isSearching ? (
                      <Loader2 className="text-muted-foreground absolute top-1/2 right-3 size-3.5 -translate-y-1/2 animate-spin" />
                    ) : null}
                  </div>
                  {hasQuery ? (
                    <SearchResults
                      localResults={localResults}
                      remoteResults={uniqueRemoteResults}
                      scopes={searchScopes}
                      selectedScope={selectedSearchScope}
                      onBookmark={(repo) => void bookmarkRemote(repo)}
                      onSelectLocal={(repo) => void selectRepository(repo, "home")}
                      onSelectRemote={openRemoteRepository}
                      onSelectScope={(scope) =>
                        setSelectedSearchScope((selectedScope) =>
                          selectedScope === scope ? null : scope,
                        )
                      }
                    />
                  ) : null}
                </Surface>
              </div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Bookmarked Repos</CardTitle>
                  <CardDescription>Starred repos stay here for fast PR review.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 md:grid-cols-2">
                  {bookmarkedRepos.length === 0 ? (
                    <EmptyState className="md:col-span-2">
                      Search for a repository to create your first bookmark.
                    </EmptyState>
                  ) : (
                    bookmarkedRepos.map((repo) => (
                      <RepoCard
                        key={repo.id}
                        prCount={repoPrCounts[repo.id]}
                        repo={repo}
                        loading={selectedRepo?.id === repo.id && isLoadingPullRequests}
                        selected={selectedRepo?.id === repo.id}
                        onSelect={() => void selectRepository(repo, "home")}
                        onToggleBookmark={() => void unbookmarkRepo(repo)}
                      />
                    ))
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Recent Review Requests</CardTitle>
                  <CardDescription>{reviewRequestsStatus}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {isLoadingReviewRequests ? (
                    <EmptyState>Loading review requests...</EmptyState>
                  ) : null}
                  {!isLoadingReviewRequests && reviewRequests.length === 0 ? (
                    <EmptyState>{reviewRequestsStatus}</EmptyState>
                  ) : null}
                  {reviewRequests.map((pullRequest) => (
                    <ReviewRequestRow
                      key={`${pullRequest.repoOwner}/${pullRequest.repoName}#${pullRequest.number}`}
                      pullRequest={pullRequest}
                      onOpen={() => void openReviewRequest(pullRequest)}
                    />
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Recently Reviewed</CardTitle>
                  <CardDescription>Your latest review sessions will appear here.</CardDescription>
                </CardHeader>
                <CardContent>
                  <EmptyState>
                    Review history appears once viewed-file state is wired into Review.
                  </EmptyState>
                </CardContent>
              </Card>
            </div>

            <Card className="h-fit">
              <CardHeader>
                <CardTitle>
                  {selectedRepo ? `${selectedRepo.owner}/${selectedRepo.name}` : "PR Preview"}
                </CardTitle>
                <CardDescription>
                  {selectedRepo
                    ? selectedRepoStatus
                    : "Select a repo to preview its first 3 open PRs."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {isLoadingPullRequests ? (
                  <EmptyState>Loading open PRs...</EmptyState>
                ) : selectedRepo === null ? (
                  <EmptyState>No repo selected.</EmptyState>
                ) : pullRequests.length === 0 ? (
                  <EmptyState>No open PRs found for this repo.</EmptyState>
                ) : (
                  <>
                    {previewPullRequests.map((pullRequest) => (
                      <PullRequestRow
                        key={pullRequest.number}
                        pullRequest={pullRequest}
                        onOpen={() => void openReview(pullRequest)}
                      />
                    ))}
                    {pullRequests.length > 3 ? (
                      <Button
                        variant="outline"
                        className="w-full rounded-xl"
                        onClick={() =>
                          navigateTo({ screen: "repo", selectedRepo, selectedReview: null })
                        }
                      >
                        Show {pullRequests.length - 3} more
                        <ArrowRight className="size-3.5" />
                      </Button>
                    ) : null}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </section>
      )}
    </main>
  )
}

const SearchResults = ({
  localResults,
  remoteResults,
  scopes,
  selectedScope,
  onBookmark,
  onSelectLocal,
  onSelectRemote,
  onSelectScope,
}: {
  readonly localResults: readonly Repo[]
  readonly remoteResults: readonly RepositorySearchResult[]
  readonly scopes: readonly RepositorySearchScope[]
  readonly selectedScope: string | null
  readonly onBookmark: (repo: RepositorySearchResult) => void
  readonly onSelectLocal: (repo: Repo) => void
  readonly onSelectRemote: (repo: RepositorySearchResult) => void
  readonly onSelectScope: (scope: string) => void
}) => {
  const hasResults = localResults.length > 0 || remoteResults.length > 0

  return (
    <div className="bg-search-surface max-h-search-results overflow-y-auto p-3 pt-0">
      <div className="flex flex-wrap gap-1.5">
        {scopes.map((scope) => {
          const isSelected = selectedScope === scope.login

          return (
            <button
              key={`${scope.kind}:${scope.login}`}
              type="button"
              aria-pressed={isSelected}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                isSelected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-muted text-muted-foreground hover:border-ring/30 hover:bg-secondary"
              }`}
              onClick={() => onSelectScope(scope.login)}
            >
              {scope.login}
            </button>
          )
        })}
      </div>
      <div className="mt-4 space-y-1.5">
        {!hasResults ? (
          <EmptyState className="p-4 text-xs">No matching repos found.</EmptyState>
        ) : null}
        {localResults.map((repo) => (
          <div
            key={repo.id}
            className="bg-search-surface hover:border-foreground/30 grid gap-2 rounded-xl border p-2 transition md:grid-cols-[1fr_auto]"
          >
            <button
              type="button"
              className="flex items-center gap-2 text-left"
              onClick={() => onSelectLocal(repo)}
            >
              <RepoSourceIcon localPath={repo.localPath} />
              <div>
                <div className="text-sm font-medium">
                  {repo.owner}/{repo.name}
                </div>
                <div className="text-muted-foreground text-xs">Bookmarked repo</div>
              </div>
            </button>
            <Badge variant="secondary" className="text-caption self-center">
              <Star className="size-3 fill-current" />
              Bookmarked
            </Badge>
          </div>
        ))}
        {remoteResults.map((repo) => (
          <div
            key={repo.nameWithOwner}
            className="bg-search-surface hover:border-foreground/30 grid gap-2 rounded-xl border p-2 transition md:grid-cols-[1fr_auto]"
          >
            <button
              type="button"
              className="flex items-center gap-2 text-left"
              onClick={() => onSelectRemote(repo)}
            >
              <Cloud className="text-muted-foreground size-3.5" />
              <div>
                <div className="text-sm font-medium">{repo.nameWithOwner}</div>
                <div className="text-muted-foreground line-clamp-1 text-xs">
                  {repo.description ?? "Accessible repository"}
                </div>
              </div>
            </button>
            <Button
              size="sm"
              variant="secondary"
              className="self-center rounded-lg"
              onClick={() => onBookmark(repo)}
            >
              <Star className="size-3.5" />
              Bookmark
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

const RepoCard = ({
  loading,
  prCount,
  repo,
  selected,
  onSelect,
  onToggleBookmark,
}: {
  readonly loading: boolean
  readonly prCount: number | undefined
  readonly repo: Repo
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onToggleBookmark: () => void
}) => (
  <div
    className={`bg-background overflow-hidden rounded-xl border transition ${selected ? "border-primary ring-primary/15 ring-2" : ""}`}
  >
    <div className="grid grid-cols-[1fr_auto] items-stretch">
      <button
        type="button"
        className="flex min-w-0 items-center gap-2 p-3 text-left"
        onClick={onSelect}
      >
        {loading ? (
          <Loader2 className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
        ) : (
          <RepoSourceIcon localPath={repo.localPath} />
        )}
        <div className="min-w-0 space-y-0.5">
          <div className="truncate text-sm font-medium">
            {repo.owner}/{repo.name}
          </div>
          <div className="text-muted-foreground text-xs">
            {loading
              ? "Loading PRs..."
              : prCount === undefined
                ? "Checking PRs..."
                : `${prCount} open PR${prCount === 1 ? "" : "s"}`}
          </div>
        </div>
      </button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Remove bookmark for ${repo.owner}/${repo.name}`}
        className="m-2 self-start"
        onClick={onToggleBookmark}
      >
        <Star className="size-3.5 fill-current text-amber-500" />
      </Button>
    </div>
  </div>
)

const RepoScreen = ({
  isLoading,
  pullRequests,
  repo,
  status,
  onBack,
  onOpenReview,
}: {
  readonly isLoading: boolean
  readonly pullRequests: readonly PullRequestSummary[]
  readonly repo: Repo
  readonly status: string
  readonly onBack: () => void
  readonly onOpenReview: (pullRequest: PullRequestSummary) => void
}) => (
  <section className="mx-auto flex max-w-5xl flex-col gap-6 px-8 py-10">
    <Button variant="ghost" className="w-fit" onClick={onBack}>
      <ArrowLeft className="size-4" />
      Home
    </Button>
    <Card>
      <CardHeader>
        <CardTitle>
          {repo.owner}/{repo.name}
        </CardTitle>
        <CardDescription>{status}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? <EmptyState>Loading PRs...</EmptyState> : null}
        {!isLoading && pullRequests.length === 0 ? (
          <EmptyState>No open PRs found.</EmptyState>
        ) : null}
        {pullRequests.map((pullRequest) => (
          <PullRequestRow
            key={pullRequest.number}
            pullRequest={pullRequest}
            onOpen={() => onOpenReview(pullRequest)}
          />
        ))}
      </CardContent>
    </Card>
  </section>
)

const ReviewScreen = ({
  aiAgentAvailable,
  aiSettings,
  parsedDiff,
  reviewSubject,
  diffRenderPass,
  expandedFileKeys,
  selectedPath,
  status,
  viewedFileKeys,
  onBack,
  onAISettingsChange,
  onSelectPath,
  onSetViewed,
  onToggleExpanded,
}: {
  readonly aiAgentAvailable: boolean
  readonly aiSettings: AISettings
  readonly parsedDiff: ParsedDiff | null
  readonly reviewSubject: ReviewSubject
  readonly diffRenderPass: number
  readonly expandedFileKeys: ReadonlySet<string>
  readonly selectedPath: string | null
  readonly status: string
  readonly viewedFileKeys: ReadonlySet<string>
  readonly onBack: () => void
  readonly onAISettingsChange: (settings: AISettings) => void
  readonly onSelectPath: (path: string) => void
  readonly onSetViewed: (reviewKey: string, viewed: boolean) => void
  readonly onToggleExpanded: (reviewKey: string) => void
}) => (
  <PullRequestDetailView
    aiAgentAvailable={aiAgentAvailable}
    aiSettings={aiSettings}
    parsedDiff={parsedDiff}
    reviewSubject={reviewSubject}
    diffRenderPass={diffRenderPass}
    expandedFileKeys={expandedFileKeys}
    selectedPath={selectedPath}
    status={status}
    viewedFileKeys={viewedFileKeys}
    onBack={onBack}
    onAISettingsChange={onAISettingsChange}
    onSelectPath={onSelectPath}
    onSetViewed={onSetViewed}
    onToggleExpanded={onToggleExpanded}
  />
)

const PullRequestStateBadge = ({
  isDraft,
  state,
  className = "",
}: {
  readonly isDraft: boolean
  readonly state: string
  readonly className?: string
}) => {
  if (isDraft) {
    return (
      <Badge variant="ghost" className={`${className} bg-pr-draft text-white`}>
        <GitPullRequestDraft />
        Draft
      </Badge>
    )
  }

  const normalizedState = state.toUpperCase()
  if (normalizedState === "OPEN") {
    return (
      <Badge variant="ghost" className={`${className} bg-pr-open text-white`}>
        <GitPullRequest />
        Open
      </Badge>
    )
  }
  if (normalizedState === "MERGED") {
    return (
      <Badge variant="ghost" className={`${className} bg-pr-merged text-white`}>
        <GitMerge />
        Merged
      </Badge>
    )
  }
  if (normalizedState === "CLOSED") {
    return (
      <Badge variant="ghost" className={`${className} bg-pr-closed text-white`}>
        <GitPullRequestClosed />
        Closed
      </Badge>
    )
  }

  return (
    <Badge variant="outline" className={className}>
      {state}
    </Badge>
  )
}

const PullRequestRow = ({
  pullRequest,
  onOpen,
}: {
  readonly pullRequest: PullRequestSummary
  readonly onOpen: () => void
}) => (
  <button
    type="button"
    aria-label={`Open PR #${pullRequest.number}: ${pullRequest.title}`}
    className="bg-background hover:border-foreground/30 w-full space-y-3 rounded-2xl border p-4 text-left transition"
    onClick={onOpen}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-1">
        <div className="text-sm font-semibold">#{pullRequest.number}</div>
        <div className="line-clamp-2 font-medium">{pullRequest.title}</div>
      </div>
      <PullRequestStateBadge isDraft={pullRequest.isDraft} state={pullRequest.state} />
    </div>
    <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
      <span className="inline-flex items-center gap-1">
        <UserRound className="size-3" />
        {pullRequest.author.login}
      </span>
      <span className="inline-flex items-center gap-1">
        <GitBranch className="size-3" />
        {pullRequest.headRefName} into {pullRequest.baseRefName}
      </span>
    </div>
  </button>
)

const ReviewRequestRow = ({
  pullRequest,
  onOpen,
}: {
  readonly pullRequest: PullRequestSummary
  readonly onOpen: () => void
}) => (
  <button
    type="button"
    aria-label={`Open requested review #${pullRequest.number}: ${pullRequest.title}`}
    className="bg-background hover:border-foreground/30 w-full space-y-3 rounded-2xl border p-4 text-left transition"
    onClick={onOpen}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="text-muted-foreground truncate text-xs font-medium">
          {pullRequest.repoOwner}/{pullRequest.repoName} #{pullRequest.number}
        </div>
        <div className="line-clamp-2 font-medium">{pullRequest.title}</div>
      </div>
      <PullRequestStateBadge isDraft={pullRequest.isDraft} state={pullRequest.state} />
    </div>
    <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
      <span className="inline-flex items-center gap-1">
        <UserRound className="size-3" />
        {pullRequest.author.login}
      </span>
      <span className="inline-flex items-center gap-1">
        <GitBranch className="size-3" />
        {pullRequest.headRefName} into {pullRequest.baseRefName}
      </span>
      <span>{pullRequest.updatedAt === null ? "Recently updated" : pullRequest.updatedAt}</span>
    </div>
  </button>
)

const EmptyState = ({
  children,
  className = "",
}: {
  readonly children: string
  readonly className?: string
}) => (
  <div
    className={`text-muted-foreground rounded-2xl border border-dashed p-8 text-center text-sm ${className}`}
  >
    {children}
  </div>
)

type SetupRequirementKey = "gh-cli" | "gh-auth" | "coding-agent" | "diffdash-cli"

type SetupRequirement = {
  readonly key: SetupRequirementKey
  readonly title: string
  readonly description: string
  readonly detail: string
  readonly done: boolean
}

const OnboardingScreen = ({
  diagnostics,
  isLoadingDiagnostics,
  status,
  onComplete,
  onInstallDiffDashCli,
  onOpenDocs,
  onRecheck,
}: {
  readonly diagnostics: AppDiagnostics
  readonly isLoadingDiagnostics: boolean
  readonly status: string | null
  readonly onComplete: () => void
  readonly onInstallDiffDashCli: () => void
  readonly onOpenDocs: (url: string) => void
  readonly onRecheck: () => void
}) => {
  const rows = prerequisiteRows(diagnostics)
  const completedCount = rows.filter((row) => row.done).length

  return (
    <section className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-10 text-sm">
      <div className="mb-6 space-y-3">
        <Badge variant="secondary" className="text-caption w-fit gap-1.5">
          <Sparkles className="size-3" />
          First-run setup
        </Badge>
        <div className="space-y-2">
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight">Set up DiffDash</h1>
          <p className="text-muted-foreground max-w-3xl text-sm leading-6">
            DiffDash needs GitHub CLI auth for repositories, one coding agent for walkthroughs, and
            the diffdash terminal command for local review shortcuts.
          </p>
        </div>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle>Setup checklist</CardTitle>
          <CardDescription>
            {isLoadingDiagnostics
              ? "Checking your local setup..."
              : `${completedCount} of ${rows.length} requirements ready.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 pt-0">
          {rows.map((row) => (
            <PrerequisiteRow
              key={row.key}
              requirement={row}
              isChecking={isLoadingDiagnostics}
              onInstallDiffDashCli={onInstallDiffDashCli}
              onOpenDocs={onOpenDocs}
            />
          ))}
        </CardContent>
      </Card>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-muted-foreground text-xs">
          {status ?? "You can continue now and finish setup later from Home."}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onRecheck} disabled={isLoadingDiagnostics}>
            {isLoadingDiagnostics ? <Loader2 className="size-3 animate-spin" /> : null}
            Recheck
          </Button>
          <Button onClick={onComplete}>Continue to DiffDash</Button>
        </div>
      </div>
    </section>
  )
}

const SetupBanner = ({
  diagnostics,
  status,
  onInstallDiffDashCli,
  onOpenDocs,
  onRecheck,
}: {
  readonly diagnostics: AppDiagnostics
  readonly status: string | null
  readonly onInstallDiffDashCli: () => void
  readonly onOpenDocs: (url: string) => void
  readonly onRecheck: () => void
}) => {
  const missingRows = missingPrerequisiteRows(diagnostics)

  return (
    <Card className="border-primary/20 bg-primary/5 py-4 shadow-xs">
      <CardContent className="grid gap-4 px-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div className="space-y-3">
          <div>
            <div className="font-semibold">Finish setup</div>
            <p className="text-muted-foreground mt-1 text-xs leading-5">
              Complete these items to unlock the full DiffDash workflow.
            </p>
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {missingRows.map((row) => (
              <PrerequisiteRow
                key={row.key}
                requirement={row}
                compact
                onInstallDiffDashCli={onInstallDiffDashCli}
                onOpenDocs={onOpenDocs}
              />
            ))}
          </div>
          {status !== null ? <div className="text-muted-foreground text-xs">{status}</div> : null}
        </div>
        <Button variant="outline" onClick={onRecheck}>
          Recheck
        </Button>
      </CardContent>
    </Card>
  )
}

const PrerequisiteRow = ({
  compact = false,
  isChecking = false,
  requirement,
  onInstallDiffDashCli,
  onOpenDocs,
}: {
  readonly compact?: boolean
  readonly isChecking?: boolean
  readonly requirement: SetupRequirement
  readonly onInstallDiffDashCli: () => void
  readonly onOpenDocs: (url: string) => void
}) => (
  <div
    className={`bg-background grid gap-3 rounded-2xl border p-3 ${compact ? "md:grid-cols-[1fr_auto]" : "md:grid-cols-[1fr_auto] md:items-center"}`}
  >
    <div className="flex min-w-0 gap-3">
      <span
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
          requirement.done
            ? "border-review-success bg-review-success/10 text-review-success"
            : "border-primary/30 bg-primary/10 text-primary"
        }`}
      >
        {isChecking ? (
          <Loader2 className="size-3 animate-spin" />
        ) : requirement.done ? (
          <Check className="size-3" />
        ) : (
          "!"
        )}
      </span>
      <div className="min-w-0">
        <div className="font-medium">{requirement.title}</div>
        <p className="text-muted-foreground mt-1 text-xs leading-5">{requirement.description}</p>
        <div className="text-caption text-muted-foreground mt-1">{requirement.detail}</div>
      </div>
    </div>
    <PrerequisiteAction
      requirement={requirement}
      onInstallDiffDashCli={onInstallDiffDashCli}
      onOpenDocs={onOpenDocs}
    />
  </div>
)

const PrerequisiteAction = ({
  requirement,
  onInstallDiffDashCli,
  onOpenDocs,
}: {
  readonly requirement: SetupRequirement
  readonly onInstallDiffDashCli: () => void
  readonly onOpenDocs: (url: string) => void
}) => {
  if (requirement.done) {
    return (
      <Badge variant="secondary" className="self-start">
        Ready
      </Badge>
    )
  }

  if (requirement.key === "gh-cli") {
    return (
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onOpenDocs(GH_CLI_DOCS_URL)}
      >
        GitHub CLI docs
      </Button>
    )
  }

  if (requirement.key === "gh-auth") {
    return (
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onOpenDocs(GH_AUTH_DOCS_URL)}
      >
        Auth docs
      </Button>
    )
  }

  if (requirement.key === "diffdash-cli") {
    return (
      <Button size="sm" className="self-start" onClick={onInstallDiffDashCli}>
        Install in PATH
      </Button>
    )
  }

  return null
}

const prerequisiteRows = (diagnostics: AppDiagnostics): readonly SetupRequirement[] => [
  {
    key: "gh-cli",
    title: "GitHub CLI installed",
    description: "DiffDash uses gh to search repositories, load PRs, and submit reviews.",
    detail: diagnostics.ghInstalled ? "gh is available in PATH." : "gh was not found in PATH.",
    done: diagnostics.ghInstalled,
  },
  {
    key: "gh-auth",
    title: "GitHub CLI authenticated",
    description: "Sign in with gh so DiffDash can access repositories and review requests.",
    detail: diagnostics.ghAuthenticated
      ? "GitHub CLI auth is ready."
      : "Run gh auth login or follow the auth docs.",
    done: diagnostics.ghAuthenticated,
  },
  {
    key: "coding-agent",
    title: "Coding agent installed",
    description: CODING_AGENT_SETUP_MESSAGE,
    detail: installedCodingAgentDetail(diagnostics.installedCodingAgents),
    done: diagnostics.codingAgentInstalled,
  },
  {
    key: "diffdash-cli",
    title: "DiffDash CLI installed in PATH",
    description: "Install the diffdash command so you can open local reviews from any terminal.",
    detail: diagnostics.diffDashCliPath ?? "diffdash was not found in PATH.",
    done: diagnostics.diffDashCliInstalled,
  },
]

const missingPrerequisiteRows = (diagnostics: AppDiagnostics) =>
  prerequisiteRows(diagnostics).filter((row) => !row.done)

const installedCodingAgentDetail = (agents: readonly string[]) => {
  if (agents.length === 0) return "No supported coding agent was found in PATH."
  return `Detected ${agents.map(codingAgentLabel).join(", ")}.`
}

const codingAgentLabel = (agent: string) => {
  if (agent === "codex") return "Codex"
  if (agent === "claude") return "Claude"
  if (agent === "opencode") return "OpenCode"
  return agent
}

const PullRequestDetailView = ({
  aiAgentAvailable,
  aiSettings,
  parsedDiff,
  reviewSubject,
  diffRenderPass,
  expandedFileKeys,
  selectedPath,
  status,
  viewedFileKeys,
  onBack,
  onAISettingsChange,
  onSelectPath,
  onSetViewed,
  onToggleExpanded,
}: {
  readonly aiAgentAvailable: boolean
  readonly aiSettings: AISettings
  readonly parsedDiff: ParsedDiff | null
  readonly reviewSubject: ReviewSubject
  readonly diffRenderPass: number
  readonly expandedFileKeys: ReadonlySet<string>
  readonly selectedPath: string | null
  readonly status: string
  readonly viewedFileKeys: ReadonlySet<string>
  readonly onBack: () => void
  readonly onAISettingsChange: (settings: AISettings) => void
  readonly onSelectPath: (path: string) => void
  readonly onSetViewed: (reviewKey: string, viewed: boolean) => void
  readonly onToggleExpanded: (reviewKey: string) => void
}) => {
  const diffScrollContainerRef = useRef<HTMLDivElement>(null)
  const lastPointerPositionRef = useRef<{
    readonly clientX: number
    readonly clientY: number
  } | null>(null)
  const [fileFilter, setFileFilter] = useState("")
  const [sidebarTab, setSidebarTab] = useState<ReviewSidebarTab>("tree")
  const [walkthroughState, setWalkthroughState] = useState<WalkthroughState>({ status: "idle" })
  const [activeWalkthroughStepIndex, setActiveWalkthroughStepIndex] = useState(0)
  const [visitedWalkthroughStepIndexes, setVisitedWalkthroughStepIndexes] = useState<
    ReadonlySet<number>
  >(() => new Set())
  const [collapsedWalkthroughFileKeys, setCollapsedWalkthroughFileKeys] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  const [fileOpenStatus, setFileOpenStatus] = useState<string | null>(null)
  const [approvalState, setApprovalState] = useState<PullRequestApprovalState>("checking")
  const reviewFiles = reviewSubjectFiles(reviewSubject)
  const reviewBaseSha = reviewSubjectBaseSha(reviewSubject)
  const reviewHeadSha = reviewSubjectHeadSha(reviewSubject)
  const reviewIdentity = reviewSubjectIdentity(reviewSubject)
  const approvalPullRequest =
    reviewSubject.kind === "pullRequest" ? reviewSubject.pullRequest : null
  const changedFiles = parsedDiff?.files ?? []
  const normalizedFileFilter = fileFilter.trim().toLowerCase()
  const filteredChangedFiles =
    normalizedFileFilter.length === 0
      ? changedFiles
      : changedFiles.filter((file) => matchesReviewFileFilter(file, normalizedFileFilter))
  const selectedVisiblePath =
    selectedPath !== null && changedFiles.some((file) => file.path === selectedPath)
      ? selectedPath
      : (changedFiles[0]?.path ?? null)
  const activeVisiblePath =
    activeFilePath !== null && changedFiles.some((file) => file.path === activeFilePath)
      ? activeFilePath
      : selectedVisiblePath
  const fallbackFiles = reviewFiles
  const filteredFallbackFiles =
    normalizedFileFilter.length === 0
      ? fallbackFiles
      : fallbackFiles.filter((file) => file.path.toLowerCase().includes(normalizedFileFilter))
  const selectedTreePath =
    activeVisiblePath !== null &&
    filteredChangedFiles.some((file) => file.path === activeVisiblePath)
      ? activeVisiblePath
      : null
  const totalAdditions = changedFiles.reduce((total, file) => total + file.additions, 0)
  const totalDeletions = changedFiles.reduce((total, file) => total + file.deletions, 0)
  const activeStoredWalkthrough =
    walkthroughState.status === "ready" ? walkthroughState.stored : null
  const activeWalkthrough =
    activeStoredWalkthrough === null ? null : activeStoredWalkthrough.walkthrough
  const walkthroughScope = reviewSubjectWalkthroughScope(reviewSubject, activeStoredWalkthrough)
  const walkthroughHunkDigest = buildWalkthroughHunkDigest(changedFiles, walkthroughScope)
  const activeWalkthroughSteps =
    activeWalkthrough === null ? [] : walkthroughReviewSteps(activeWalkthrough)
  const activeWalkthroughStep = activeWalkthroughSteps[activeWalkthroughStepIndex] ?? null
  const activeStepFiles =
    activeWalkthroughStep === null
      ? []
      : focusFilesForWalkthroughHunks(changedFiles, activeWalkthroughStep.hunkIds, walkthroughScope)
  const activeWalkthroughFiles =
    activeWalkthroughStep === null
      ? []
      : focusFilesForWalkthroughHunks(
          filteredChangedFiles,
          activeWalkthroughStep.hunkIds,
          walkthroughScope,
        )
  const visibleChangedFiles =
    sidebarTab === "walkthrough" && activeWalkthroughStep !== null
      ? activeWalkthroughFiles
      : filteredChangedFiles
  const activeStepComplete =
    activeWalkthroughStep !== null &&
    activeStepFiles.length > 0 &&
    activeStepFiles.every((file) => viewedFileKeys.has(file.reviewKey))
  useEffect(() => {
    setSidebarTab("tree")
    setWalkthroughState({ status: "idle" })
    setActiveWalkthroughStepIndex(0)
    setVisitedWalkthroughStepIndexes(new Set())
    setCollapsedWalkthroughFileKeys(new Set())
    setApprovalState("checking")
  }, [reviewIdentity, reviewBaseSha, reviewHeadSha])

  useEffect(() => {
    if (approvalPullRequest === null) {
      setApprovalState("unapproved")
      return undefined
    }

    let cancelled = false
    setApprovalState("checking")
    window.diffDash.gitProvider
      .hasApprovedPullRequest(
        approvalPullRequest.repoOwner,
        approvalPullRequest.repoName,
        approvalPullRequest.number,
      )
      .then((approved) => {
        if (!cancelled) setApprovalState(approved ? "approved" : "unapproved")
        return undefined
      })
      .catch(() => {
        if (!cancelled) setApprovalState("unapproved")
      })

    return () => {
      cancelled = true
    }
  }, [approvalPullRequest])

  const loadWalkthrough = async (regenerate: boolean) => {
    if (!regenerate && reviewBaseSha !== null && reviewHeadSha !== null) {
      setWalkthroughState({ status: "loading", message: "Loading cached walkthrough" })
      try {
        const cached =
          reviewSubject.kind === "pullRequest"
            ? await window.diffDash.walkthroughs.get(
                reviewSubject.pullRequest.repoOwner,
                reviewSubject.pullRequest.repoName,
                reviewSubject.pullRequest.number,
                reviewBaseSha,
                reviewHeadSha,
              )
            : await window.diffDash.localWalkthroughs.get(
                reviewSubject.localReview.rootPath,
                reviewBaseSha,
                reviewHeadSha,
              )

        if (cached !== null) {
          setActiveWalkthroughStepIndex(0)
          setVisitedWalkthroughStepIndexes(new Set([0]))
          setCollapsedWalkthroughFileKeys(new Set())
          setWalkthroughState({ status: "ready", stored: cached })
          return
        }
      } catch {
        // Fall through to generation; the main-process generator performs the same cache check.
      }
    }

    if (!aiAgentAvailable) {
      setWalkthroughState({
        status: "error",
        message:
          "Walkthrough generation is disabled because the configured AI agent is unavailable.",
      })
      return
    }

    setWalkthroughState({
      status: "loading",
      message: regenerate ? "Regenerating walkthrough" : "Generating walkthrough",
    })
    try {
      const stored =
        reviewSubject.kind === "pullRequest"
          ? regenerate
            ? await window.diffDash.walkthroughs.regenerate(
                reviewSubject.pullRequest.repoOwner,
                reviewSubject.pullRequest.repoName,
                reviewSubject.pullRequest.number,
              )
            : await window.diffDash.walkthroughs.generate(
                reviewSubject.pullRequest.repoOwner,
                reviewSubject.pullRequest.repoName,
                reviewSubject.pullRequest.number,
              )
          : regenerate
            ? await window.diffDash.localWalkthroughs.regenerate(reviewSubject.localReview.rootPath)
            : await window.diffDash.localWalkthroughs.generate(reviewSubject.localReview.rootPath)
      if (regenerate) {
        const storedWalkthroughScope = reviewSubjectWalkthroughScope(reviewSubject, stored)
        changedFiles.forEach((file) => onSetViewed(file.reviewKey, false))
        walkthroughReviewSteps(stored.walkthrough).forEach((step) => {
          focusFilesForWalkthroughHunks(changedFiles, step.hunkIds, storedWalkthroughScope).forEach(
            (file) => {
              onSetViewed(file.reviewKey, false)
            },
          )
        })
      }
      setActiveWalkthroughStepIndex(0)
      setVisitedWalkthroughStepIndexes(new Set([0]))
      setCollapsedWalkthroughFileKeys(new Set())
      setWalkthroughState({ status: "ready", stored })
    } catch (error) {
      setWalkthroughState({ status: "error", message: formatError(error, "Walkthrough failed") })
    }
  }

  const selectSidebarTab = (tab: ReviewSidebarTab) => {
    if (tab === "walkthrough" && !aiAgentAvailable) return
    setSidebarTab(tab)
    if (tab === "walkthrough" && walkthroughState.status === "idle") {
      void loadWalkthrough(false)
    }
  }

  const markActiveWalkthroughStepComplete = () => {
    if (activeWalkthroughStep === null) return

    focusFilesForWalkthroughHunks(
      changedFiles,
      activeWalkthroughStep.hunkIds,
      walkthroughScope,
    ).forEach((file) => {
      onSetViewed(file.reviewKey, true)
    })
  }
  const toggleVisibleDiffCard = (reviewKey: string) => {
    if (sidebarTab !== "walkthrough" || activeWalkthroughStep === null) {
      onToggleExpanded(reviewKey)
      return
    }

    setCollapsedWalkthroughFileKeys((keys) => {
      const nextKeys = new Set(keys)
      if (nextKeys.has(reviewKey)) {
        nextKeys.delete(reviewKey)
      } else {
        nextKeys.add(reviewKey)
      }
      return nextKeys
    })
  }
  const selectWalkthroughStep = (index: number) => {
    setVisitedWalkthroughStepIndexes((indexes) =>
      new Set(indexes).add(activeWalkthroughStepIndex).add(index),
    )
    setActiveWalkthroughStepIndex(index)
  }
  const selectPathAndScroll = (path: string, reviewKey?: string) => {
    setActiveFilePath(path)
    onSelectPath(path)
    window.requestAnimationFrame(() => {
      const container = diffScrollContainerRef.current
      const file = changedFiles.find((changedFile) => changedFile.path === path)
      if (container === null || file === undefined) return

      const card = document.getElementById(diffCardDomId(reviewKey ?? file.reviewKey))
      if (card !== null) {
        scrollIntoDiffPane(container, card)
      }
    })
  }
  const openRepositoryFile = async (path: string) => {
    setFileOpenStatus(`Opening ${path}...`)
    try {
      if (reviewSubject.kind === "pullRequest") {
        await window.diffDash.openRepositoryFile(
          reviewSubject.pullRequest.repoOwner,
          reviewSubject.pullRequest.repoName,
          path,
          reviewSubject.pullRequest.headRefName,
          reviewSubject.pullRequest.headRefOid,
        )
      } else {
        await window.diffDash.openLocalRepositoryFile(reviewSubject.localReview.rootPath, path)
      }
      setFileOpenStatus(null)
    } catch (error) {
      setFileOpenStatus(formatError(error, "Could not open file"))
    }
  }
  const approvePullRequest = async () => {
    if (reviewSubject.kind !== "pullRequest") return
    if (approvalState === "approved" || approvalState === "approving") return

    const pullRequest = reviewSubject.pullRequest
    setApprovalState("approving")
    setFileOpenStatus(`Approving PR #${pullRequest.number}...`)
    try {
      await window.diffDash.gitProvider.approvePullRequest(
        pullRequest.repoOwner,
        pullRequest.repoName,
        pullRequest.number,
      )
      setApprovalState("approved")
      setFileOpenStatus(`Approved PR #${pullRequest.number}.`)
    } catch (error) {
      setApprovalState("unapproved")
      setFileOpenStatus(formatError(error, "Could not approve pull request"))
    }
  }
  const setActiveFileFromPoint = (clientX: number, clientY: number) => {
    const path = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-diff-card-path]")?.dataset.diffCardPath
    if (path !== undefined && path !== activeFilePath) {
      setActiveFilePath(path)
    }
  }
  const syncActiveFileFromPointer = () => {
    const position = lastPointerPositionRef.current
    if (position === null) return

    window.requestAnimationFrame(() => setActiveFileFromPoint(position.clientX, position.clientY))
  }

  return (
    <section className="bg-background flex h-full min-h-0 overflow-hidden text-sm">
      <aside className="bg-review-sidebar text-review-sidebar-fg border-review-sidebar-border flex h-full min-h-0 w-review-sidebar shrink-0 flex-col border-r">
        <div className="border-review-sidebar-divider flex h-12 items-center gap-2 border-b pt-review-title-top-offset pr-3 pl-review-title-inset">
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0"
            aria-label="Back"
            onClick={onBack}
          >
            <ArrowLeft className="size-3" />
          </Button>
          <div
            className="text-review-sidebar-fg min-w-0 flex-1 truncate font-mono text-xs"
            title={reviewSubjectRepositoryLabel(reviewSubject)}
          >
            {reviewSubjectRepositoryLabel(reviewSubject)}
          </div>
        </div>

        <div className="border-review-sidebar-divider space-y-2 border-b p-3">
          <Input
            value={fileFilter}
            onChange={(event) => setFileFilter(event.currentTarget.value)}
            className="border-review-sidebar-divider bg-review-sidebar-control text-review-sidebar-fg placeholder:text-review-sidebar-muted h-8 text-xs"
            placeholder="Filter files"
          />
          <div className="bg-review-sidebar-control grid grid-cols-2 rounded-xl p-0.5 text-xs">
            <button
              type="button"
              className={`rounded-lg py-1.5 font-medium ${sidebarTab === "tree" ? "bg-review-sidebar-control-active text-review-sidebar-fg" : "text-review-sidebar-muted"}`}
              onClick={() => selectSidebarTab("tree")}
            >
              Tree
            </button>
            <button
              type="button"
              disabled={!aiAgentAvailable}
              title={aiAgentAvailable ? undefined : CODING_AGENT_SETUP_MESSAGE}
              className={`rounded-lg py-1.5 font-medium disabled:cursor-not-allowed disabled:opacity-45 ${sidebarTab === "walkthrough" ? "bg-review-sidebar-control-active text-review-sidebar-fg" : "text-review-sidebar-muted"}`}
              onClick={() => selectSidebarTab("walkthrough")}
            >
              Walkthrough
            </button>
          </div>
          {!aiAgentAvailable ? (
            <p className="text-caption text-review-sidebar-muted leading-4">
              {CODING_AGENT_SETUP_MESSAGE}
            </p>
          ) : null}
          {sidebarTab === "walkthrough" ? (
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="text-caption text-review-sidebar-muted min-w-0 truncate">
                {aiProviderLabel(aiSettings.provider)} / {selectedAIModelLabel(aiSettings)}
              </div>
              <WalkthroughSettingsMenu settings={aiSettings} onChange={onAISettingsChange} />
            </div>
          ) : null}
        </div>

        <div
          className={`min-h-0 flex-1 overscroll-contain py-2 pr-1 ${
            sidebarTab === "walkthrough" ? "overflow-y-auto" : "overflow-hidden"
          }`}
        >
          {sidebarTab === "walkthrough" ? (
            <WalkthroughSidebar
              activeStepIndex={activeWalkthroughStepIndex}
              changedFiles={changedFiles}
              hunkDigest={walkthroughHunkDigest}
              scope={walkthroughScope}
              state={walkthroughState}
              visitedStepIndexes={visitedWalkthroughStepIndexes}
              viewedFileKeys={viewedFileKeys}
              onRegenerate={() => void loadWalkthrough(true)}
              onRetry={() => void loadWalkthrough(false)}
              onSelectStep={selectWalkthroughStep}
            />
          ) : parsedDiff === null ? (
            <FallbackFileTree
              files={filteredFallbackFiles}
              selectedPath={selectedPath}
              onSelectPath={selectPathAndScroll}
            />
          ) : (
            <ReviewFileTree
              files={filteredChangedFiles}
              selectedPath={selectedTreePath}
              onSelectPath={selectPathAndScroll}
            />
          )}
        </div>

        <div className="border-review-sidebar-divider bg-review-sidebar-control text-review-sidebar-muted flex items-center justify-between border-t px-3 py-2 text-xs">
          <span>Total</span>
          <span>
            <span className="text-review-success">+{totalAdditions}</span>{" "}
            <span className="text-review-danger">-{totalDeletions}</span>
          </span>
        </div>
      </aside>

      <div
        ref={diffScrollContainerRef}
        className="h-full min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
        onPointerMove={(event) => {
          lastPointerPositionRef.current = {
            clientX: event.clientX,
            clientY: event.clientY,
          }
          setActiveFileFromPoint(event.clientX, event.clientY)
        }}
        onScroll={syncActiveFileFromPointer}
      >
        <div className="bg-background/95 sticky top-0 z-10 border-b px-5 py-2 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <div className="text-muted-foreground min-w-0 truncate text-xs">
              {fileOpenStatus ?? status}
            </div>
            <div className="flex items-center gap-2">
              {sidebarTab === "walkthrough" && walkthroughState.status === "ready" ? (
                <Button size="sm" variant="outline" onClick={() => void loadWalkthrough(true)}>
                  Regenerate
                </Button>
              ) : null}
              {reviewSubject.kind === "pullRequest" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={approvalState !== "unapproved"}
                  className={
                    approvalState === "approved"
                      ? "border-review-success bg-review-success/10 text-review-success hover:bg-review-success/15 hover:text-review-success disabled:opacity-100"
                      : undefined
                  }
                  onClick={() => void approvePullRequest()}
                >
                  <Check className="size-3" />
                  {approvalButtonLabel(approvalState)}
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        <main className="mx-auto max-w-review-diff space-y-4 px-5 py-4">
          {sidebarTab === "walkthrough" ? (
            <WalkthroughMainHeader
              activeStepComplete={activeStepComplete}
              step={activeWalkthroughStep}
              state={walkthroughState}
              onMarkComplete={markActiveWalkthroughStepComplete}
              onNextStep={() =>
                selectWalkthroughStep(
                  activeWalkthrough === null
                    ? activeWalkthroughStepIndex
                    : Math.min(activeWalkthroughStepIndex + 1, activeWalkthroughSteps.length - 1),
                )
              }
              onRetry={() => void loadWalkthrough(false)}
            />
          ) : null}
          <section className="bg-card rounded-2xl border p-4 shadow-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              {reviewSubject.kind === "pullRequest" ? (
                <>
                  <Badge variant="outline" className="text-caption">
                    #{reviewSubject.pullRequest.number}
                  </Badge>
                  <PullRequestStateBadge
                    className="text-caption"
                    isDraft={reviewSubject.pullRequest.isDraft}
                    state={reviewSubject.pullRequest.state}
                  />
                  <Badge variant="secondary" className="text-caption">
                    @{reviewSubject.pullRequest.author.login}
                  </Badge>
                </>
              ) : (
                <>
                  <Badge variant="outline" className="text-caption">
                    Local
                  </Badge>
                  {reviewSubject.localReview.branchName === null ? null : (
                    <Badge variant="secondary" className="text-caption">
                      <GitBranch className="size-3" />
                      {reviewSubject.localReview.branchName}
                    </Badge>
                  )}
                </>
              )}
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight">
              {reviewSubjectTitle(reviewSubject)}
            </h1>
            <div className="text-muted-foreground mt-2 grid gap-2 text-xs md:grid-cols-4">
              <Metric
                label="Files"
                value={String(parsedDiff?.files.length ?? fallbackFiles.length)}
              />
              {reviewSubject.kind === "pullRequest" ? (
                <>
                  <Metric
                    label="Commits"
                    value={String(reviewSubject.pullRequest.commits.length)}
                  />
                  <Metric label="Head" value={shortSha(reviewSubject.pullRequest.headRefOid)} />
                  <Metric label="Base" value={shortSha(reviewSubject.pullRequest.baseRefOid)} />
                </>
              ) : (
                <>
                  <Metric label="Repo" value={reviewSubject.localReview.repoName} />
                  <Metric label="Diff" value={shortSha(reviewSubject.localReview.headSha)} />
                  <Metric label="Base" value={shortSha(reviewSubject.localReview.baseSha)} />
                </>
              )}
            </div>
          </section>

          {parsedDiff === null ? <EmptyState>Loading diff...</EmptyState> : null}
          {parsedDiff !== null &&
          normalizedFileFilter.length === 0 &&
          visibleChangedFiles.length === 0 ? (
            <EmptyState>No changed files found.</EmptyState>
          ) : null}
          {parsedDiff !== null &&
          normalizedFileFilter.length > 0 &&
          visibleChangedFiles.length === 0 ? (
            <EmptyState>No files match this filter.</EmptyState>
          ) : null}
          {visibleChangedFiles.map((file) => (
            <OpenDiffCard
              key={file.reviewKey}
              diffRenderPass={diffRenderPass}
              expanded={
                sidebarTab === "walkthrough" && activeWalkthroughStep !== null
                  ? !collapsedWalkthroughFileKeys.has(file.reviewKey)
                  : expandedFileKeys.has(file.reviewKey)
              }
              file={file}
              selected={selectedVisiblePath === file.path || activeFilePath === file.path}
              viewed={viewedFileKeys.has(file.reviewKey)}
              onOpenFile={() => void openRepositoryFile(file.path)}
              onSelect={() => selectPathAndScroll(file.path, file.reviewKey)}
              onSetViewed={(viewed) => onSetViewed(file.reviewKey, viewed)}
              onToggleExpanded={() => toggleVisibleDiffCard(file.reviewKey)}
            />
          ))}
        </main>
      </div>
    </section>
  )
}

const WalkthroughSidebar = ({
  activeStepIndex,
  changedFiles,
  hunkDigest,
  scope,
  state,
  visitedStepIndexes,
  viewedFileKeys,
  onRegenerate,
  onRetry,
  onSelectStep,
}: {
  readonly activeStepIndex: number
  readonly changedFiles: readonly ParsedDiffFile[]
  readonly hunkDigest: readonly WalkthroughHunkDigest[]
  readonly scope: string
  readonly state: WalkthroughState
  readonly visitedStepIndexes: ReadonlySet<number>
  readonly viewedFileKeys: ReadonlySet<string>
  readonly onRegenerate: () => void
  readonly onRetry: () => void
  readonly onSelectStep: (index: number) => void
}) => {
  if (state.status === "loading") {
    return (
      <BrailleLoadingText
        className="text-review-sidebar-muted px-3 py-2 text-xs"
        text={state.message}
      />
    )
  }

  if (state.status === "error") {
    return <WalkthroughErrorNotice message={state.message} variant="sidebar" onRetry={onRetry} />
  }

  if (state.status !== "ready") {
    return <SidebarMessage title="Walkthrough" message="Preparing walkthrough generation..." />
  }

  const steps = walkthroughReviewSteps(state.stored.walkthrough)

  return (
    <div className="space-y-4 px-3 py-2 text-xs">
      <div className="space-y-1.5">
        <div className="text-review-sidebar-fg font-semibold tracking-wide uppercase">
          Review focus
        </div>
        <p className="text-review-sidebar-muted leading-5">{state.stored.walkthrough.summary}</p>
      </div>

      <div className="border-review-sidebar-divider border-t pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-review-sidebar-fg font-semibold tracking-wide uppercase">Scope</div>
          <button
            type="button"
            className="text-review-sidebar-muted hover:text-review-sidebar-fg text-caption font-medium"
            onClick={onRegenerate}
          >
            Regenerate
          </button>
        </div>
        <div className="space-y-4">
          {groupWalkthroughSteps(steps).map((group) => {
            const SectionIcon = walkthroughSectionIcon(group.title)

            return (
              <section key={group.title} className="space-y-2">
                <div className="text-review-sidebar-fg flex items-center gap-2 px-1 font-semibold tracking-wide uppercase">
                  <SectionIcon className="text-review-sidebar-muted size-3.5" />
                  <span>{group.title}</span>
                </div>
                <ol className="relative space-y-1 pl-4 before:absolute before:top-[10px] before:bottom-2 before:left-[6px] before:w-px before:bg-review-sidebar-divider">
                  {group.steps.map(({ index, step }) => {
                    const files = focusFilesForWalkthroughHunks(changedFiles, step.hunkIds, scope)
                    const fileSummaries = summarizeWalkthroughHunksByPath(hunkDigest, step.hunkIds)
                    const complete =
                      files.length > 0 && files.every((file) => viewedFileKeys.has(file.reviewKey))
                    const visited = visitedStepIndexes.has(index) || complete
                    const additions = fileSummaries.reduce(
                      (total, file) => total + file.additions,
                      0,
                    )
                    const deletions = fileSummaries.reduce(
                      (total, file) => total + file.deletions,
                      0,
                    )
                    const selected = activeStepIndex === index

                    return (
                      <li key={step.id} className="relative">
                        <span
                          className={`absolute top-[10px] -left-[17px] z-10 flex size-3.5 items-center justify-center rounded-full border text-[9px] ${
                            visited
                              ? "border-review-success bg-review-success text-white"
                              : selected
                                ? "border-primary bg-white text-primary shadow-[0_0_0_3px_var(--color-review-sidebar)]"
                                : "border-primary/70 bg-white text-primary"
                          }`}
                        >
                          {visited ? <Check className="size-2.5" /> : null}
                        </span>
                        <button
                          type="button"
                          className={`w-full rounded-xl border px-2.5 py-2 text-left transition ${
                            selected
                              ? "border-primary bg-review-tree-selected text-review-sidebar-emphasis"
                              : "border-transparent text-review-sidebar-fg hover:bg-review-sidebar-control-hover"
                          }`}
                          onClick={() => onSelectStep(index)}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold">
                              {index + 1} {step.title}
                            </span>
                            <span className="text-caption text-review-sidebar-muted">
                              {complete ? "Done" : `${files.length} files`}
                            </span>
                          </div>
                          <div className="text-review-sidebar-muted mt-1 space-y-0.5">
                            {fileSummaries.slice(0, 4).map((file) => (
                              <div
                                key={file.path}
                                className="flex items-center justify-between gap-2"
                              >
                                <span className="truncate font-mono" title={file.path}>
                                  {fileNameFromPath(file.path)}
                                </span>
                                <span className="shrink-0">
                                  <span className="text-review-success">+{file.additions}</span>{" "}
                                  <span className="text-review-danger">-{file.deletions}</span>
                                </span>
                              </div>
                            ))}
                            {fileSummaries.length > 4 ? (
                              <div>{fileSummaries.length - 4} more files</div>
                            ) : null}
                          </div>
                          <div className="text-caption mt-1 text-right">
                            <span className="text-review-success">+{additions}</span>{" "}
                            <span className="text-review-danger">-{deletions}</span>
                          </div>
                        </button>
                      </li>
                    )
                  })}
                </ol>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const approvalButtonLabel = (state: PullRequestApprovalState) => {
  if (state === "approved") return "Approved"
  if (state === "approving") return "Approving..."
  if (state === "checking") return "Checking..."
  return "Approve"
}

const WalkthroughSettingsMenu = ({
  settings,
  onChange,
}: {
  readonly settings: AISettings
  readonly onChange: (settings: AISettings) => void
}) => {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const selectedModel = selectedModelForProvider(settings, settings.provider)
  const modelOptions = modelOptionsForProvider(settings.provider)

  useEffect(() => {
    if (!open) return undefined

    const closeFromOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      setOpen(false)
    }
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }

    window.addEventListener("pointerdown", closeFromOutsidePointer)
    window.addEventListener("keydown", closeFromEscape)
    return () => {
      window.removeEventListener("pointerdown", closeFromOutsidePointer)
      window.removeEventListener("keydown", closeFromEscape)
    }
  }, [open])

  return (
    <div ref={menuRef} className="relative shrink-0">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Walkthrough settings"
        aria-haspopup="menu"
        aria-expanded={open}
        className="text-review-sidebar-muted hover:bg-review-sidebar-control-hover hover:text-review-sidebar-fg"
        onClick={() => setOpen((value) => !value)}
      >
        <Settings2 className="size-3" />
      </Button>
      {open ? (
        <div
          role="menu"
          className="bg-review-sidebar border-review-sidebar-divider text-review-sidebar-fg absolute top-full right-0 z-30 mt-2 w-64 space-y-3 rounded-xl border p-2 text-xs shadow-lg"
        >
          <div className="space-y-1">
            <div className="text-caption text-review-sidebar-muted px-2 font-semibold tracking-wide uppercase">
              Agent
            </div>
            {AI_PROVIDER_OPTIONS.map((option) => (
              <WalkthroughSettingsMenuItem
                key={option.provider}
                label={option.label}
                selected={settings.provider === option.provider}
                onSelect={() => onChange(aiSettingsWithProvider(settings, option.provider))}
              />
            ))}
          </div>

          <div className="border-review-sidebar-divider space-y-1 border-t pt-2">
            <div className="text-caption text-review-sidebar-muted px-2 font-semibold tracking-wide uppercase">
              Model
            </div>
            {modelOptions.map((option) => (
              <WalkthroughSettingsMenuItem
                key={option.model}
                label={option.label}
                selected={selectedModel === option.model}
                onSelect={() => onChange(aiSettingsWithModel(settings, option.model))}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

const WalkthroughSettingsMenuItem = ({
  label,
  selected,
  onSelect,
}: {
  readonly label: string
  readonly selected: boolean
  readonly onSelect: () => void
}) => (
  <button
    type="button"
    role="menuitemradio"
    aria-checked={selected}
    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition ${
      selected
        ? "bg-review-sidebar-control-active text-review-sidebar-fg"
        : "text-review-sidebar-muted hover:bg-review-sidebar-control-hover hover:text-review-sidebar-fg"
    }`}
    onClick={onSelect}
  >
    <span className="truncate">{label}</span>
    {selected ? <Check className="size-3" /> : null}
  </button>
)

const aiSettingsWithProvider = (settings: AISettings, provider: AIProvider) =>
  AISettings.make({ provider, models: aiProviderModelsFromSettings(settings) })

const aiSettingsWithModel = (
  settings: AISettings,
  model: AutoModel | CodexModel | ClaudeModel | OpenCodeModel,
) => {
  if (settings.provider === "auto" && isAutoModel(model)) {
    return AISettings.make({
      provider: settings.provider,
      models: AIProviderModels.make({
        auto: model,
        codex: settings.models.codex,
        claude: settings.models.claude,
        opencode: settings.models.opencode,
      }),
    })
  }

  if (settings.provider === "claude" && isClaudeModel(model)) {
    return AISettings.make({
      provider: settings.provider,
      models: AIProviderModels.make({
        auto: settings.models.auto,
        codex: settings.models.codex,
        claude: model,
        opencode: settings.models.opencode,
      }),
    })
  }

  if (settings.provider === "opencode" && isOpenCodeModel(model)) {
    return AISettings.make({
      provider: settings.provider,
      models: AIProviderModels.make({
        auto: settings.models.auto,
        codex: settings.models.codex,
        claude: settings.models.claude,
        opencode: model,
      }),
    })
  }

  if (isCodexModel(model)) {
    return AISettings.make({
      provider: settings.provider,
      models: AIProviderModels.make({
        auto: settings.models.auto,
        codex: model,
        claude: settings.models.claude,
        opencode: settings.models.opencode,
      }),
    })
  }

  return settings
}

const aiProviderLabel = (provider: AIProvider) =>
  AI_PROVIDER_OPTIONS.find((option) => option.provider === provider)?.label ?? provider

const aiProviderModelsFromSettings = (settings: AISettings) =>
  AIProviderModels.make({
    auto: settings.models.auto,
    codex: settings.models.codex,
    claude: settings.models.claude,
    opencode: settings.models.opencode,
  })

const selectedAIModelLabel = (settings: AISettings) => {
  const selectedModel = selectedModelForProvider(settings, settings.provider)
  return (
    modelOptionsForProvider(settings.provider).find((option) => option.model === selectedModel)
      ?.label ?? selectedModel
  )
}

const isAutoModel = (
  model: AutoModel | CodexModel | ClaudeModel | OpenCodeModel,
): model is AutoModel => AUTO_MODEL_OPTIONS.some((option) => option.model === model)

const isCodexModel = (
  model: AutoModel | CodexModel | ClaudeModel | OpenCodeModel,
): model is CodexModel => CODEX_MODEL_OPTIONS.some((option) => option.model === model)

const isClaudeModel = (
  model: AutoModel | CodexModel | ClaudeModel | OpenCodeModel,
): model is ClaudeModel => CLAUDE_MODEL_OPTIONS.some((option) => option.model === model)

const isOpenCodeModel = (
  model: AutoModel | CodexModel | ClaudeModel | OpenCodeModel,
): model is OpenCodeModel => OPENCODE_MODEL_OPTIONS.some((option) => option.model === model)

const SidebarMessage = ({
  action,
  message,
  title,
  onAction,
}: {
  readonly action?: string
  readonly message: string
  readonly title: string
  readonly onAction?: () => void
}) => (
  <div className="space-y-3 px-3 py-2 text-xs">
    <div className="border-review-sidebar-divider rounded-xl border p-3">
      <div className="text-review-sidebar-fg font-semibold">{title}</div>
      <div className="text-review-sidebar-muted mt-1 leading-5">{message}</div>
      {action === undefined || onAction === undefined ? null : (
        <Button size="sm" variant="secondary" className="mt-3 h-8 rounded-lg" onClick={onAction}>
          {action}
        </Button>
      )}
    </div>
  </div>
)

const BrailleLoadingText = ({
  className = "",
  text,
}: {
  readonly className?: string
  readonly text: string
}) => {
  const [frameIndex, setFrameIndex] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => {
      setFrameIndex((index) => (index + 1) % BRAILLE_LOADING_FRAMES.length)
    }, 80)

    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      <span aria-hidden="true" className="font-mono text-sm leading-none">
        {BRAILLE_LOADING_FRAMES[frameIndex]}
      </span>
      <span>{text}</span>
    </div>
  )
}

const WalkthroughErrorNotice = ({
  message,
  variant,
  onRetry,
}: {
  readonly message: string
  readonly variant: "main" | "sidebar"
  readonly onRetry: () => void
}) => {
  const copyError = () => {
    void navigator.clipboard.writeText(message).catch(() => undefined)
  }
  const containerClassName =
    variant === "sidebar"
      ? "space-y-2 px-3 py-2 text-xs"
      : "bg-card rounded-2xl border p-4 text-sm shadow-xs"
  const titleClassName =
    variant === "sidebar" ? "text-review-sidebar-fg font-semibold" : "font-semibold"
  const messageClassName =
    variant === "sidebar"
      ? "text-review-sidebar-muted min-w-0 flex-1 truncate"
      : "text-muted-foreground min-w-0 flex-1 truncate"

  return (
    <section className={containerClassName}>
      <div className={titleClassName}>Walkthrough unavailable</div>
      <div className="flex min-w-0 items-center gap-2">
        <div className={messageClassName} title={message}>
          {message}
        </div>
        <Button size="sm" variant="secondary" className="h-8 shrink-0 rounded-lg" onClick={onRetry}>
          Retry
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-foreground hover:text-foreground h-8 shrink-0 gap-1 rounded-lg"
          onClick={copyError}
        >
          <Copy className="size-3" />
          Copy error
        </Button>
      </div>
    </section>
  )
}

const WalkthroughMainHeader = ({
  activeStepComplete,
  step,
  state,
  onMarkComplete,
  onNextStep,
  onRetry,
}: {
  readonly activeStepComplete: boolean
  readonly step: WalkthroughReviewStep | null
  readonly state: WalkthroughState
  readonly onMarkComplete: () => void
  readonly onNextStep: () => void
  readonly onRetry: () => void
}) => {
  if (state.status === "loading") {
    return <BrailleLoadingText className="text-muted-foreground text-sm" text={state.message} />
  }

  if (state.status === "error") {
    return <WalkthroughErrorNotice message={state.message} variant="main" onRetry={onRetry} />
  }

  if (state.status !== "ready" || step === null) return null

  return (
    <section className="bg-card border-l-primary rounded-2xl border border-l-4 p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <RiskBadge risk={step.risk} />
          <h2 className="text-2xl font-semibold tracking-tight">{step.title}</h2>
          <p className="text-muted-foreground max-w-3xl leading-6">{step.summary}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onMarkComplete}
            disabled={activeStepComplete}
          >
            {activeStepComplete ? "Complete" : "Mark complete"}
          </Button>
          <Button size="sm" variant="secondary" onClick={onNextStep}>
            Next step
          </Button>
        </div>
      </div>
    </section>
  )
}

const RiskBadge = ({ risk }: { readonly risk: WalkthroughRisk }) => {
  const className =
    risk === "critical"
      ? "bg-red-950/10 text-red-700 border-red-700/30"
      : risk === "review"
        ? "bg-amber-950/10 text-amber-700 border-amber-700/30"
        : "bg-slate-950/10 text-slate-700 border-slate-700/30"

  return (
    <Badge variant="outline" className={`text-caption uppercase tracking-[0.18em] ${className}`}>
      {risk.toUpperCase()}
    </Badge>
  )
}

type WalkthroughReviewStep = {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly risk: WalkthroughRisk
  readonly hunkIds: readonly string[]
  readonly chapterTitle: string | null
}

type WalkthroughStepGroup = {
  readonly title: string
  readonly steps: readonly {
    readonly index: number
    readonly step: WalkthroughReviewStep
  }[]
}

const BRAILLE_LOADING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

const WALKTHROUGH_SECTION_ICONS = [GitBranch, GitPullRequest, Sparkles, FolderGit2, Star] as const

const groupWalkthroughSteps = (
  steps: readonly WalkthroughReviewStep[],
): readonly WalkthroughStepGroup[] => {
  const groups: WalkthroughStepGroup[] = []
  const groupIndexes = new Map<string, number>()

  steps.forEach((step, index) => {
    const title = step.chapterTitle ?? "Review"
    const groupIndex = groupIndexes.get(title)
    if (groupIndex === undefined) {
      groupIndexes.set(title, groups.length)
      groups.push({ title, steps: [{ index, step }] })
      return
    }

    const group = groups[groupIndex]
    if (group !== undefined) {
      groups[groupIndex] = { ...group, steps: [...group.steps, { index, step }] }
    }
  })

  return groups
}

const walkthroughSectionIcon = (title: string) => {
  let hash = 0
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) >>> 0
  }

  return WALKTHROUGH_SECTION_ICONS[hash % WALKTHROUGH_SECTION_ICONS.length] ?? Sparkles
}

const walkthroughReviewSteps = (walkthrough: Walkthrough): readonly WalkthroughReviewStep[] => [
  ...flattenWalkthroughStops(walkthrough).map(({ chapter, stop }) => ({
    id: `${chapter.id}:${stop.id}`,
    title: stop.title,
    summary: stop.summary,
    risk: stop.risk,
    hunkIds: stop.hunkIds,
    chapterTitle: chapter.title,
  })),
  ...walkthrough.support.map((item) => ({
    id: `support:${item.id}`,
    title: item.title,
    summary: item.reason,
    risk: "support" as const,
    hunkIds: item.hunkIds,
    chapterTitle: "Support",
  })),
]

const fileNameFromPath = (path: string) => {
  const trimmedPath = path.endsWith("/") ? path.slice(0, -1) : path
  const separatorIndex = trimmedPath.lastIndexOf("/")
  return separatorIndex >= 0 ? trimmedPath.slice(separatorIndex + 1) : trimmedPath
}

const OpenDiffCard = ({
  diffRenderPass,
  expanded,
  file,
  selected,
  viewed,
  onOpenFile,
  onSelect,
  onSetViewed,
  onToggleExpanded,
}: {
  readonly diffRenderPass: number
  readonly expanded: boolean
  readonly file: ParsedDiffFile
  readonly selected: boolean
  readonly viewed: boolean
  readonly onOpenFile: () => void
  readonly onSelect: () => void
  readonly onSetViewed: (viewed: boolean) => void
  readonly onToggleExpanded: () => void
}) => {
  const isExpanded = expanded && !viewed
  const selectedClassName = viewed
    ? "border-review-success/55 bg-review-success/[0.03] ring-1 ring-review-success/25"
    : selected
      ? "border-primary/50 ring-primary/15 ring-2"
      : ""

  if (file.status === "binary" || file.hunks.length === 0) {
    return (
      <section
        id={diffCardDomId(file.reviewKey)}
        data-diff-card-path={file.path}
        className={`bg-card scroll-mt-14 rounded-2xl border shadow-xs ${selectedClassName}`}
      >
        <DiffCardHeader
          expanded={isExpanded}
          file={file}
          viewed={viewed}
          onOpenFile={onOpenFile}
          onSelect={onSelect}
          onSetViewed={onSetViewed}
          onToggleExpanded={onToggleExpanded}
        />
        {isExpanded ? (
          <div className="border-t p-4">
            <EmptyState className="text-left">
              {file.status === "binary"
                ? "Binary file changes are shown in the file summary only."
                : "No renderable hunks were found for this file."}
            </EmptyState>
          </div>
        ) : null}
      </section>
    )
  }

  return (
    <section
      id={diffCardDomId(file.reviewKey)}
      data-diff-card-path={file.path}
      className={`bg-card scroll-mt-14 overflow-hidden rounded-2xl border shadow-xs ${selectedClassName}`}
    >
      <DiffCardHeader
        expanded={isExpanded}
        file={file}
        viewed={viewed}
        onOpenFile={onOpenFile}
        onSelect={onSelect}
        onSetViewed={onSetViewed}
        onToggleExpanded={onToggleExpanded}
      />
      {isExpanded ? (
        <div className="bg-background -mt-px overflow-hidden border-t">
          <PatchDiff
            key={`${file.reviewKey}:${diffRenderPass}`}
            className="block overflow-auto text-xs"
            disableWorkerPool
            metrics={REVIEW_DIFF_METRICS}
            options={REVIEW_DIFF_OPTIONS}
            patch={file.patch}
          />
        </div>
      ) : null}
    </section>
  )
}

const DiffCardHeader = ({
  expanded,
  file,
  viewed,
  onOpenFile,
  onSelect,
  onSetViewed,
  onToggleExpanded,
}: {
  readonly expanded: boolean
  readonly file: ParsedDiffFile
  readonly viewed: boolean
  readonly onOpenFile: () => void
  readonly onSelect: () => void
  readonly onSetViewed: (viewed: boolean) => void
  readonly onToggleExpanded: () => void
}) => {
  const ChevronIcon = expanded ? ChevronDown : ChevronRight

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          size="icon-xs"
          variant="ghost"
          className="hover:bg-accent size-7 shrink-0 rounded-md"
          aria-label={expanded ? "Collapse diff" : "Expand diff"}
          aria-expanded={expanded}
          onClick={onToggleExpanded}
        >
          <ChevronIcon className="size-4" />
        </Button>
        <button type="button" className="min-w-0 text-left" onClick={onSelect}>
          <div className="min-w-0">
            <div
              className={`truncate font-mono text-xs tracking-wide ${viewed ? "text-muted-foreground" : ""}`}
            >
              {file.path}
            </div>
            {file.oldPath === null ? null : (
              <div className="text-muted-foreground text-caption truncate font-mono">
                from {file.oldPath}
              </div>
            )}
          </div>
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="secondary" className="text-caption gap-1">
          <span className="text-review-success">+{file.additions}</span>
          <span className="text-review-danger">-{file.deletions}</span>
        </Badge>
        <Badge variant="secondary" className="text-caption capitalize">
          {file.status}
        </Badge>
        <Button size="sm" variant="outline" onClick={onOpenFile}>
          Open
        </Button>
        <label
          className={`flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors ${
            viewed
              ? "border-review-success/45 bg-review-success/10 text-review-success hover:bg-review-success/15"
              : "hover:bg-accent"
          }`}
        >
          <input
            type="checkbox"
            checked={viewed}
            className="peer sr-only"
            onChange={(event) => onSetViewed(event.currentTarget.checked)}
          />
          <span
            aria-hidden="true"
            className={`flex size-3.5 items-center justify-center rounded-sm border transition-colors ${
              viewed
                ? "border-review-success bg-review-success text-primary-foreground"
                : "border-muted-foreground/50 bg-background"
            }`}
          >
            {viewed ? <Check className="size-3" strokeWidth={3} /> : null}
          </span>
          Viewed
        </label>
      </div>
    </div>
  )
}

const ReviewFileTree = ({
  files,
  selectedPath,
  onSelectPath,
}: {
  readonly files: readonly ParsedDiffFile[]
  readonly selectedPath: string | null
  readonly onSelectPath: (path: string) => void
}) => {
  const appliedSelectedPathRef = useRef<string | null>(null)
  const suppressSelectionChangeRef = useRef(false)
  const treeInput = buildReviewFileTreeInput(files, true)
  const preparedInput = preparePresortedFileTreeInput(treeInput.paths)
  const treeInputKey = `${treeInput.paths.join("\u0000")}\u0001${treeInput.gitStatus
    .map((entry) => `${entry.path}\u0000${entry.status}`)
    .join("\u0000")}`
  const appliedTreeInputKeyRef = useRef(treeInputKey)
  const { model } = useFileTree({
    preparedInput,
    gitStatus: treeInput.gitStatus,
    initialExpansion: 20,
    initialSelectedPaths: selectedPath === null ? [] : [selectedPath],
    itemHeight: 26,
    onSelectionChange: (paths) => {
      if (suppressSelectionChangeRef.current) return

      const path = paths[0]
      if (path !== undefined && treeInput.paths.includes(path)) {
        onSelectPath(path)
      }
    },
    search: false,
    stickyFolders: false,
    unsafeCSS: REVIEW_FILE_TREE_CSS,
  })

  useEffect(() => {
    if (appliedTreeInputKeyRef.current === treeInputKey) return

    model.resetPaths({ preparedInput })
    model.setGitStatus(treeInput.gitStatus)
    appliedTreeInputKeyRef.current = treeInputKey
  }, [model, preparedInput, treeInput.gitStatus, treeInputKey])

  useEffect(() => {
    const previousSelectedPath = appliedSelectedPathRef.current
    if (previousSelectedPath !== null && previousSelectedPath !== selectedPath) {
      model.getItem(previousSelectedPath)?.deselect()
    }

    if (selectedPath === null || !treeInput.paths.includes(selectedPath)) {
      appliedSelectedPathRef.current = null
      return
    }

    suppressSelectionChangeRef.current = true
    model.getItem(selectedPath)?.select()
    model.scrollToPath(selectedPath, { focus: false, offset: "nearest" })
    appliedSelectedPathRef.current = selectedPath
    window.setTimeout(() => {
      suppressSelectionChangeRef.current = false
    }, 0)
  }, [model, selectedPath, treeInput.paths])

  return (
    <div className="h-full overflow-hidden bg-transparent">
      <PierreFileTree
        aria-label="Changed files"
        className="text-review-sidebar-fg block h-full bg-transparent text-xs [&_*]:border-review-tree-indent"
        model={model}
        style={{ background: "transparent" }}
      />
    </div>
  )
}

const FallbackFileTree = ({
  files,
  selectedPath,
  onSelectPath,
}: {
  readonly files: PullRequestDetail["files"]
  readonly selectedPath: string | null
  readonly onSelectPath: (path: string) => void
}) => (
  <nav aria-label="Changed files" className="space-y-0.5 text-xs">
    {files.map((file) => (
      <button
        key={file.path}
        type="button"
        className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left ${selectedPath === file.path ? "bg-review-tree-selected text-review-sidebar-emphasis" : "text-review-sidebar-fg hover:bg-review-sidebar-control-hover"}`}
        onClick={() => onSelectPath(file.path)}
      >
        <span className="truncate">{file.path}</span>
        <span className="text-caption text-review-sidebar-muted shrink-0">
          <span className="text-review-success">+{file.additions}</span>{" "}
          <span className="text-review-danger">-{file.deletions}</span>
        </span>
      </button>
    ))}
  </nav>
)

const RepoSourceIcon = ({ localPath }: { readonly localPath: string | null }) =>
  localPath === null ? (
    <Cloud className="text-muted-foreground size-4 shrink-0" />
  ) : (
    <Laptop className="text-muted-foreground size-4 shrink-0" />
  )

const Metric = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <div className="bg-background rounded-lg border p-2">
    <div className="text-muted-foreground text-caption">{label}</div>
    <div className="mt-0.5 truncate font-mono text-xs">{value}</div>
  </div>
)

const reviewSubjectFromSelection = (
  selectedReview: SelectedReviewTarget | null,
  pullRequest: PullRequestDetail | null,
  localReview: LocalReviewDetail | null,
): ReviewSubject | null => {
  if (selectedReview?.kind === "pullRequest" && pullRequest !== null) {
    return { kind: "pullRequest", pullRequest }
  }
  if (selectedReview?.kind === "localDiff" && localReview !== null) {
    return { kind: "localDiff", localReview }
  }
  return null
}

const reviewSubjectFiles = (reviewSubject: ReviewSubject) =>
  reviewSubject.kind === "pullRequest"
    ? reviewSubject.pullRequest.files
    : reviewSubject.localReview.files

const reviewSubjectWalkthroughScope = (
  reviewSubject: ReviewSubject,
  storedWalkthrough: StoredWalkthrough | null = null,
) =>
  reviewSubject.kind === "pullRequest"
    ? walkthroughPullRequestScope(reviewSubject.pullRequest.number)
    : walkthroughLocalDiffScope(storedWalkthrough?.headSha ?? reviewSubject.localReview.headSha)

const reviewSubjectBaseSha = (reviewSubject: ReviewSubject) =>
  reviewSubject.kind === "pullRequest"
    ? reviewSubject.pullRequest.baseRefOid
    : reviewSubject.localReview.baseSha

const reviewSubjectHeadSha = (reviewSubject: ReviewSubject) =>
  reviewSubject.kind === "pullRequest"
    ? reviewSubject.pullRequest.headRefOid
    : reviewSubject.localReview.headSha

const reviewSubjectIdentity = (reviewSubject: ReviewSubject) =>
  reviewSubject.kind === "pullRequest"
    ? `pr:${reviewSubject.pullRequest.repoOwner}/${reviewSubject.pullRequest.repoName}#${reviewSubject.pullRequest.number}`
    : `local:${reviewSubject.localReview.rootPath}`

const reviewSubjectRepositoryLabel = (reviewSubject: ReviewSubject) =>
  reviewSubject.kind === "pullRequest"
    ? `${reviewSubject.pullRequest.repoOwner}/${reviewSubject.pullRequest.repoName}`
    : reviewSubject.localReview.rootPath

const reviewSubjectTitle = (reviewSubject: ReviewSubject) =>
  reviewSubject.kind === "pullRequest"
    ? reviewSubject.pullRequest.title
    : reviewSubject.localReview.title

const repoKey = (owner: string, name: string) => `${owner.toLowerCase()}/${name.toLowerCase()}`

const matchesReviewFileFilter = (file: ParsedDiffFile, normalizedFilter: string) =>
  file.path.toLowerCase().includes(normalizedFilter) ||
  (file.oldPath?.toLowerCase().includes(normalizedFilter) ?? false)

const diffCardDomId = (reviewKey: string) => {
  let hash = 0
  for (let index = 0; index < reviewKey.length; index += 1) {
    hash = (hash * 31 + reviewKey.charCodeAt(index)) >>> 0
  }

  return `diff-card-${hash.toString(36)}`
}

const scrollIntoDiffPane = (container: HTMLElement, target: HTMLElement) => {
  const stickyHeaderOffset = 56
  const containerRect = container.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const rawScrollTop = container.scrollTop + targetRect.top - containerRect.top - stickyHeaderOffset
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
  const scrollTop = Math.min(Math.max(0, rawScrollTop), maxScrollTop)

  container.scrollTo({ behavior: "smooth", top: scrollTop })
}

const pullRequestAtomKey = (owner: string, name: string, number: number) =>
  `${repoKey(owner, name)}#${number}`

function fetchEffect<A>(tryPromise: () => Promise<A>) {
  return Effect.tryPromise({
    try: tryPromise,
    catch: normalizeError,
  })
}

function normalizeError(error: unknown) {
  return RendererApiError.make({
    error,
    message: formatError(error, "Unknown renderer API error"),
  })
}

const isNonNull = <A,>(value: A | null): value is A => value !== null

const parseRepoAtomKey = (key: string) => {
  const separatorIndex = key.indexOf("/")
  if (separatorIndex < 1 || separatorIndex === key.length - 1) return null
  return {
    owner: key.slice(0, separatorIndex),
    name: key.slice(separatorIndex + 1),
  }
}

const parsePullRequestAtomKey = (key: string) => {
  const pullRequestSeparatorIndex = key.lastIndexOf("#")
  if (pullRequestSeparatorIndex < 1 || pullRequestSeparatorIndex === key.length - 1) return null
  const repo = parseRepoAtomKey(key.slice(0, pullRequestSeparatorIndex))
  const number = Number(key.slice(pullRequestSeparatorIndex + 1))
  if (repo === null || !Number.isInteger(number)) return null
  return { ...repo, number }
}

const resultValue = <A,>(result: Result.Result<A, unknown>, fallback: A) =>
  Result.getOrElse(result, () => fallback)

const resultErrorMessage = (result: Result.Result<unknown, unknown>, fallback: string) =>
  Result.matchWithError(result, {
    onInitial: () => fallback,
    onError: (error) => formatError(error, fallback),
    onDefect: (defect) => formatError(defect, fallback),
    onSuccess: () => fallback,
  })

const shortSha = (sha: string | null) => (sha ? sha.slice(0, 8) : "unknown")

const formatError = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.length > 0)
    return cleanErrorMessage(error.message, fallback)
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message
    if (typeof message === "string" && message.length > 0)
      return cleanErrorMessage(message, fallback)
  }
  return fallback
}

const cleanErrorMessage = (message: string, fallback: string) => {
  const missingCommand = /spawn\s+([^\s]+)\s+ENOENT/.exec(message)
  if (missingCommand?.[1]) return `${fallback}: ${missingCommand[1]} was not found.`

  const taggedError = /\)\s+\w+Error:\s+([^{}\n]+)/.exec(message)
  if (taggedError?.[1]) return taggedError[1].trim()

  return message
}
