/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import { AISettings } from "@diffdash/domain/ai-settings"
import type { ParsedDiffFile } from "@diffdash/domain/diff"
import { filterVisibleDiffFiles, getHiddenDiffFileReason } from "@diffdash/domain/diff-file-filters"
import { projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"
import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { type ReviewThreadAnchor, type ReviewThreadDetails } from "@diffdash/domain/review-thread"
import {
  buildWalkthroughHunkDigest,
  focusFilesForWalkthroughHunks,
} from "@diffdash/domain/walkthrough"
import {
  type AgentProviderCatalog,
  EMPTY_AGENT_PROVIDER_CATALOG,
} from "@diffdash/protocol/agent-providers"
import {
  type ReviewSnapshotSearchAnchor,
  type ReviewSnapshotSearchCursor,
  ReviewSnapshotSearchFileAnchor,
  ReviewSnapshotSearchLineAnchor,
  type ReviewSnapshotSearchMatch,
  ReviewSnapshotSearchRequest,
  ReviewSnapshotSearchResponse,
} from "@diffdash/protocol/review-snapshot"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { Schema } from "effect"
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Cloud,
  Command,
  FolderGit2,
  GitBranch,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react"
import { DropdownMenu } from "radix-ui"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  agentProviderOptions,
  agentUnavailableReason,
  aiProviderLabel,
  aiSettingsWithModel,
  aiSettingsWithProvider,
  modelOptionsForProvider,
  selectedAIModelLabel,
  selectedModelForProvider,
} from "@/settings/agent-selection"
import type { ResolvedTheme } from "@/settings/theme"
import { captureAnalytics } from "@/shared/analytics"
import { formatError } from "@/shared/errors"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { EmptyState } from "@/shared/ui/empty-state"
import { Input } from "@/shared/ui/input"
import { CommandPaletteDialog, type CommandPaletteItem } from "@/shell/command-palette"
import { ReviewThreadIndex, useReviewThreads } from "@/threads/review-threads"
import { agentProviderCatalogAtom } from "@/walkthrough/atoms"
import {
  WalkthroughMainHeader,
  type WalkthroughReviewStep,
  WalkthroughSidebar,
  type WalkthroughState,
  walkthroughReviewSteps,
} from "@/walkthrough/walkthrough-panel"
import { OpenDiffCard } from "./diff-card"
import {
  createDiffsWorker,
  DiffVirtualizer,
  type FileDiffOptions,
  type PostRenderPhase,
  useStableCallback,
  VirtualizedFileDiff,
  VirtualizerContext,
  type WorkerInitializationRenderOptions,
  WorkerPoolContextProvider,
  type WorkerPoolOptions,
} from "./pierre"
import { PullRequestStateBadge } from "./pull-request-state-badge"
import { ReviewFileTree } from "./review-file-tree"
import { ReviewPagePlaceholder } from "./review-page-placeholder"
import type { ReviewSearchOccurrence } from "./review-search"
import { ReviewSearchHighlightManager } from "./review-search-highlights"
import { type ReviewSearchPage, ReviewSearchPageCache } from "./review-search-page-cache"
import { ReviewSearchToolbar } from "./review-search-toolbar"
import type { ReviewSelectionProjection } from "./review-selection"
import type { ReviewSourceOperations } from "./review-source-operations"
import {
  reviewSubjectBaseSha,
  reviewSubjectHeadSha,
  reviewSubjectIdentity,
  reviewSubjectRepositoryLabel,
  reviewSubjectTitle,
  reviewSubjectWalkthroughScope,
  reviewThreadScope,
} from "./review-subject"
import {
  lineAnchorIsInFile,
  type ReviewThreadAnnotation,
  sameReviewThreadLine,
} from "./thread-annotations"
import { useReviewSnapshotPages } from "./use-review-snapshot-pages"
import { diffCardDomId, useViewedFileViewport, type ViewedFileUpdate } from "./viewed-file-viewport"

type ReviewSidebarTab = "tree" | "walkthrough"

type PullRequestApprovalState = "checking" | "unapproved" | "approving" | "approved"

/** Repository-link state consumed by ready review presentation. */
export type RepositoryLinkState = "checking" | "linked" | "unlinked" | "not-applicable"

/** Application-owned dependencies required by the review feature. */
export type ReviewDetailEnvironment = {
  readonly aiAgentAvailable: boolean
  readonly aiSettings: AISettings
  readonly repositoryLinkState: RepositoryLinkState
  readonly theme: ResolvedTheme
  readonly onAISettingsChange: (settings: AISettings) => void
  readonly onLinkRepository: () => Promise<boolean>
}

/** Ready review state assembled by ReviewScreen after source selection succeeds. */
export type ReadyReviewDetailState = {
  readonly selection: Extract<ReviewSelectionProjection, { readonly _tag: "ready" }>
  readonly sourceOperations: ReviewSourceOperations
  readonly expandedFileKeys: ReadonlySet<string>
  readonly viewedFileKeys: ReadonlySet<string>
  readonly selectedPath: string | null
  readonly isReloading: boolean
  readonly status: string
  readonly operationError: string | null
  readonly onReload: () => void
  readonly onSelectPath: (path: string) => void
  readonly onSetViewed: (reviewKey: string, viewed: boolean) => void
  readonly onToggleExpanded: (reviewKey: string) => void
}

const CODING_AGENT_SETUP_MESSAGE =
  "Walkthroughs require an available agent provider. Complete provider setup to enable guided review."

const REVIEW_DIFF_OPTIONS = {
  disableFileHeader: true,
  diffStyle: "split",
  enableGutterUtility: true,
  hunkSeparators: "line-info-basic",
  lineHoverHighlight: "both",
  lineDiffType: "word",
  overflow: "wrap",
  stickyHeader: true,
  theme: {
    dark: "dark-plus",
    light: "github-light",
  },
  themeType: "light",
  unsafeCSS: `
    :host {
      --diffs-bg: var(--diff-canvas);
      --diffs-fg: var(--foreground);
      --diffs-fg-number-override: var(--muted-foreground);
      --diffs-fg-number-addition-override: var(--review-success);
      --diffs-fg-number-deletion-override: var(--review-danger);
      --diffs-bg-context-override: var(--diff-canvas);
      --diffs-bg-context-gutter-override: var(--diff-gutter);
      --diffs-bg-buffer-override: var(--diff-canvas);
      --diffs-bg-separator-override: var(--diff-separator);
      --diffs-bg-addition-override: var(--diff-addition);
      --diffs-bg-addition-number-override: var(--diff-addition-emphasis);
      --diffs-bg-addition-emphasis-override: var(--diff-addition-emphasis);
      --diffs-bg-deletion-override: var(--diff-deletion);
      --diffs-bg-deletion-number-override: var(--diff-deletion-emphasis);
      --diffs-bg-deletion-emphasis-override: var(--diff-deletion-emphasis);
      --diffs-bg-hover-override: var(--diff-hover);
      --diffs-bg-selection-override: var(--diff-selection);
      --diffs-bg-selection-number-override: var(--diff-selection);
      --diffs-gap-block: 0px;
      --diffs-line-height: 20px;
    }

    [data-diff-type="split"][data-overflow="wrap"] {
      --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr);
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

    ::highlight(diffdash-review-search-match) {
      background-color: var(--review-search-match);
      color: inherit;
    }

    ::highlight(diffdash-review-search-active) {
      background-color: var(--review-search-active);
      color: var(--review-search-active-foreground);
    }
  `,
} satisfies FileDiffOptions<ReviewThreadAnnotation>

const REVIEW_DIFF_OPTIONS_BY_THEME = {
  dark: { ...REVIEW_DIFF_OPTIONS, themeType: "dark" },
  light: { ...REVIEW_DIFF_OPTIONS, themeType: "light" },
} satisfies Record<ResolvedTheme, FileDiffOptions<ReviewThreadAnnotation>>

const REVIEW_DIFF_VIRTUALIZER_CONFIG = {
  intersectionObserverMargin: 1_500,
  overscrollSize: 1_000,
} as const

const REVIEW_NAVIGATION_MAX_FRAMES = 600

const REVIEW_DIFF_WORKER_POOL_OPTIONS = {
  poolSize: 1,
  totalASTLRUCacheSize: 20,
  workerFactory: createDiffsWorker,
} satisfies WorkerPoolOptions

const REVIEW_DIFF_HIGHLIGHTER_OPTIONS = {
  lineDiffType: REVIEW_DIFF_OPTIONS.lineDiffType,
  maxLineDiffLength: 1_000,
  theme: REVIEW_DIFF_OPTIONS.theme,
  tokenizeMaxLineLength: 1_000,
} satisfies WorkerInitializationRenderOptions

type ReviewDiffRegistration = {
  readonly generation: number
  readonly host: HTMLElement
  readonly instance: VirtualizedFileDiff<unknown>
  readonly phase: PostRenderPhase
}

/** Source-neutral review detail composition with its coupled ephemeral interaction state. */
export const ReviewDetailView = ({
  environment,
  ready,
  onBack,
}: {
  readonly environment: ReviewDetailEnvironment
  readonly ready: ReadyReviewDetailState
  readonly onBack: () => void
}) => {
  const {
    aiAgentAvailable,
    aiSettings,
    repositoryLinkState,
    theme,
    onAISettingsChange,
    onLinkRepository,
  } = environment
  const {
    selection,
    sourceOperations,
    expandedFileKeys,
    isReloading,
    operationError,
    selectedPath,
    status,
    viewedFileKeys,
    onReload,
    onSelectPath,
    onSetViewed,
    onToggleExpanded,
  } = ready
  const manifest = selection.manifest
  const reviewSubject = selection.subject
  const agentProviderCatalogResult = useAtomValue(agentProviderCatalogAtom)
  const agentProviderCatalog = resultValue(agentProviderCatalogResult, EMPTY_AGENT_PROVIDER_CATALOG)
  const diffScrollContainerRef = useRef<HTMLDivElement>(null)
  const stickyReviewChromeRef = useRef<HTMLDivElement>(null)
  const reviewSearchInputRef = useRef<HTMLInputElement>(null)
  const previousReviewSearchFocusRef = useRef<HTMLElement | null>(null)
  const activeReviewSearchOccurrenceRef = useRef<ReviewSearchOccurrence | null>(null)
  const reviewSearchAnchorRef = useRef<ReviewSnapshotSearchAnchor | null>(null)
  const lastPointerPositionRef = useRef<{
    readonly clientX: number
    readonly clientY: number
  } | null>(null)
  const pendingFileNavigationFrameRef = useRef<number | null>(null)
  const pendingFileNavigationTokenRef = useRef<symbol | null>(null)
  const pendingSearchNavigationFrameRef = useRef<number | null>(null)
  const pendingSearchNavigationIdRef = useRef<string | null>(null)
  const reviewDiffRegistrationsRef = useRef<Map<string, ReviewDiffRegistration>>(new Map())
  const [diffVirtualizer] = useState(() => new DiffVirtualizer(REVIEW_DIFF_VIRTUALIZER_CONFIG))
  const [reviewSearchHighlights] = useState(() => new ReviewSearchHighlightManager())
  const [reviewSearchPageCache] = useState(() => new ReviewSearchPageCache())
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
  const [treeNavigationPath, setTreeNavigationPath] = useState<string | null>(null)
  const [showHiddenFiles, setShowHiddenFiles] = useState(false)
  const [goToPaletteOpen, setGoToPaletteOpen] = useState(false)
  const [actionPaletteOpen, setActionPaletteOpen] = useState(false)
  const [reviewSearchOpen, setReviewSearchOpen] = useState(false)
  const [reviewSearchQuery, setReviewSearchQuery] = useState("")
  const [reviewSearchOccurrences, setReviewSearchOccurrences] = useState<
    readonly ReviewSnapshotSearchMatch[]
  >([])
  const [reviewSearchTotalMatches, setReviewSearchTotalMatches] = useState(0)
  const [activeReviewSearchIndex, setActiveReviewSearchIndex] = useState(0)
  const [fileOpenStatus, setFileOpenStatus] = useState<string | null>(null)
  const [approvalState, setApprovalState] = useState<PullRequestApprovalState>("checking")
  const [expandedLineAnchor, setExpandedLineAnchor] = useState<ReviewThreadAnchor | null>(null)
  const [repositoryBannerDismissed, setRepositoryBannerDismissed] = useState(false)
  const [repositoryLinking, setRepositoryLinking] = useState(false)
  const [repositoryLinkError, setRepositoryLinkError] = useState<string | null>(null)
  const reviewSearchRequestRef = useRef(0)
  const reviewSearchNavigationRef = useRef(0)
  const reviewSearchTargetIndexRef = useRef(0)
  const activeReviewSearchIndexRef = useRef(0)
  const {
    files: snapshotFiles,
    loadingFileIds,
    loadFiles: loadSnapshotFiles,
    tooLargeFileIds,
  } = useReviewSnapshotPages(manifest, sourceOperations.refresh)
  const setDiffScrollContainer = useStableCallback<(node: HTMLDivElement | null) => void>(
    (node) => {
      diffScrollContainerRef.current = node
      if (node === null) {
        diffVirtualizer.cleanUp()
        return
      }

      const content = node.firstElementChild
      diffVirtualizer.setup(node, content instanceof HTMLElement ? content : undefined)
    },
  )
  useEffect(
    () => () => {
      if (pendingFileNavigationFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingFileNavigationFrameRef.current)
      }
      if (pendingSearchNavigationFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingSearchNavigationFrameRef.current)
      }
      reviewDiffRegistrationsRef.current.clear()
    },
    [],
  )
  useEffect(() => () => reviewSearchHighlights.dispose(), [reviewSearchHighlights])
  const reviewBaseSha = reviewSubjectBaseSha(reviewSubject)
  const reviewHeadSha = reviewSubjectHeadSha(reviewSubject)
  const reviewIdentity = reviewSubjectIdentity(reviewSubject)
  const reviewThreads = useReviewThreads(reviewThreadScope(reviewSubject))
  const changedFiles = manifest.files
  const loadedFilesById = new Map(snapshotFiles.map((file) => [file.fileId, file]))
  const loadedChangedFiles = changedFiles.flatMap((file) => {
    const loaded = loadedFilesById.get(file.fileId)
    return loaded === undefined ? [] : [loaded]
  })
  const normalizedReviewSearchIndex =
    reviewSearchTotalMatches === 0
      ? 0
      : Math.min(activeReviewSearchIndex, reviewSearchTotalMatches - 1)
  const cachedActiveReviewSearchMatch = reviewSearchPageCache.find(normalizedReviewSearchIndex)
  const activeReviewSearchOccurrence = reviewSearchOpen
    ? (cachedActiveReviewSearchMatch?.match ?? null)
    : null
  activeReviewSearchIndexRef.current = normalizedReviewSearchIndex
  activeReviewSearchOccurrenceRef.current = activeReviewSearchOccurrence
  const hiddenFileCount = changedFiles.filter(
    (file) => getHiddenDiffFileReason(file) !== null,
  ).length
  const visibleBaseFiles = filterVisibleDiffFiles(changedFiles, showHiddenFiles)
  const normalizedFileFilter = fileFilter.trim().toLowerCase()
  const filteredChangedFiles =
    normalizedFileFilter.length === 0
      ? visibleBaseFiles
      : visibleBaseFiles.filter((file) => matchesReviewFileFilter(file, normalizedFileFilter))
  const selectedVisiblePath =
    selectedPath !== null && visibleBaseFiles.some((file) => file.path === selectedPath)
      ? selectedPath
      : (visibleBaseFiles[0]?.path ?? null)
  const selectedTreePath =
    treeNavigationPath !== null &&
    filteredChangedFiles.some((file) => file.path === treeNavigationPath)
      ? treeNavigationPath
      : null
  const totalAdditions = changedFiles.reduce((total, file) => total + file.additions, 0)
  const totalDeletions = changedFiles.reduce((total, file) => total + file.deletions, 0)
  const activeStoredWalkthrough =
    walkthroughState.status === "ready" ? walkthroughState.stored : null
  const activeWalkthrough =
    activeStoredWalkthrough === null ? null : activeStoredWalkthrough.walkthrough
  const walkthroughScope = reviewSubjectWalkthroughScope(reviewSubject, activeStoredWalkthrough)
  const walkthroughHunkDigest = buildWalkthroughHunkDigest(loadedChangedFiles, walkthroughScope)
  const activeWalkthroughSteps =
    activeWalkthrough === null ? [] : walkthroughReviewSteps(activeWalkthrough)
  const activeWalkthroughStep = activeWalkthroughSteps[activeWalkthroughStepIndex] ?? null
  const activeStepFiles =
    activeWalkthroughStep === null
      ? []
      : focusFilesForWalkthroughHunks(
          loadedChangedFiles,
          activeWalkthroughStep.hunkIds,
          walkthroughScope,
        )
  const activeWalkthroughInventory =
    activeWalkthroughStep === null
      ? []
      : changedFiles.filter((file) =>
          activeWalkthroughStep.hunkIds.some((hunkId) => hunkId.startsWith(`${file.path}:`)),
        )
  const visibleChangedFiles =
    sidebarTab === "walkthrough" && activeWalkthroughStep !== null
      ? activeWalkthroughInventory
      : filteredChangedFiles
  const activeSearchReviewKey = activeReviewSearchOccurrence?.reviewKey ?? null
  const renderedChangedFiles =
    activeSearchReviewKey === null ||
    visibleChangedFiles.some((file) => file.reviewKey === activeSearchReviewKey)
      ? visibleChangedFiles
      : (() => {
          const visibleReviewKeys = new Set(visibleChangedFiles.map((file) => file.reviewKey))
          return changedFiles.filter(
            (file) =>
              file.reviewKey === activeSearchReviewKey || visibleReviewKeys.has(file.reviewKey),
          )
        })()
  const indexedThreadDetails = reviewThreads.details
  const activeStepComplete =
    activeWalkthroughStep !== null &&
    activeStepFiles.length > 0 &&
    activeStepFiles.every((file) => viewedFileKeys.has(file.reviewKey))
  const reviewDiffOptions = reviewDiffOptionsForTheme(theme)
  const {
    handleDiffRendered: handleViewedDiffRendered,
    setFileViewed: setViewedPreservingViewport,
    setFilesViewed: setViewedFilesPreservingViewport,
  } = useViewedFileViewport({
    containerRef: diffScrollContainerRef,
    expandedFileKeys,
    onSetViewed,
    scopeKey: `${reviewIdentity}\u0000${reviewBaseSha ?? ""}\u0000${reviewHeadSha ?? ""}`,
    stickyChromeRef: stickyReviewChromeRef,
    viewedFileKeys,
    visibleFiles: visibleChangedFiles,
  })
  useEffect(() => {
    const initialFileIds = manifest.files.slice(0, 3).map((file) => file.fileId)
    void loadSnapshotFiles(initialFileIds)
  }, [loadSnapshotFiles, manifest.files, manifest.snapshotId])
  useEffect(() => {
    if (selectedPath === null) return
    const file = manifest.files.find((candidate) => candidate.path === selectedPath)
    if (file !== undefined) void loadSnapshotFiles([file.fileId])
  }, [loadSnapshotFiles, manifest.files, selectedPath])
  useEffect(() => {
    if (activeWalkthrough === null) return
    const hunkIds = walkthroughReviewSteps(activeWalkthrough).flatMap((step) => step.hunkIds)
    const fileIds = manifest.files
      .filter((file) => hunkIds.some((hunkId) => hunkId.startsWith(`${file.path}:`)))
      .map((file) => file.fileId)
    void loadSnapshotFiles(fileIds)
  }, [activeWalkthrough, loadSnapshotFiles, manifest.files])
  const requestReviewSearchPage = useStableCallback(
    async (
      cursor: ReviewSnapshotSearchCursor | null,
      startIndex: number,
      requestId: number,
      clearOnFailure = false,
    ): Promise<ReviewSearchPage | null> => {
      const cached = reviewSearchPageCache.get(cursor)
      if (cached !== null) return cached
      try {
        const response = Schema.decodeUnknownSync(ReviewSnapshotSearchResponse)(
          await window.diffDash.reviewSnapshots.search(
            ReviewSnapshotSearchRequest.make({
              snapshotId: manifest.snapshotId,
              query: reviewSearchQuery,
              cursor,
              limit: 200,
              anchor: reviewSearchAnchorRef.current,
            }),
          ),
        )
        if (requestId !== reviewSearchRequestRef.current) return null
        if (response["_tag"] === "expired") {
          reviewSearchRequestRef.current += 1
          reviewSearchPageCache.clear()
          setReviewSearchOccurrences([])
          setReviewSearchTotalMatches(0)
          reviewSearchNavigationRef.current += 1
          reviewSearchTargetIndexRef.current = 0
          activeReviewSearchIndexRef.current = 0
          setActiveReviewSearchIndex(0)
          onReload()
          return null
        }
        const activeCursor = reviewSearchPageCache.find(activeReviewSearchIndexRef.current)?.page
          .cursor
        const pinnedCursors = new Set<ReviewSnapshotSearchCursor | null>([cursor])
        if (activeCursor !== undefined) pinnedCursors.add(activeCursor)
        const page = { cursor, response, startIndex }
        if (!reviewSearchPageCache.put(page, pinnedCursors)) return null
        setReviewSearchOccurrences(reviewSearchPageCache.matches())
        setReviewSearchTotalMatches(response.totalMatches)
        return page
      } catch {
        if (requestId === reviewSearchRequestRef.current && clearOnFailure) {
          reviewSearchPageCache.clear()
          setReviewSearchOccurrences([])
          setReviewSearchTotalMatches(0)
        }
        return null
      }
    },
  )
  const activateReviewSearchIndex = useStableCallback(
    async (targetIndex: number, requestId: number, navigationId: number) => {
      const cached = reviewSearchPageCache.find(targetIndex)
      if (cached !== null) {
        reviewSearchPageCache.get(cached.page.cursor)
        if (
          requestId === reviewSearchRequestRef.current &&
          navigationId === reviewSearchNavigationRef.current
        ) {
          activeReviewSearchIndexRef.current = targetIndex
          setActiveReviewSearchIndex(targetIndex)
          return true
        }
        return false
      }

      let cursor: ReviewSnapshotSearchCursor | null = null
      let startIndex = 0
      while (requestId === reviewSearchRequestRef.current) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Opaque cursors require replaying pages in order after eviction.
        const page = await requestReviewSearchPage(cursor, startIndex, requestId)
        if (page === null) return false
        const pageEnd = page.startIndex + page.response.matches.length
        if (targetIndex >= page.startIndex && targetIndex < pageEnd) {
          if (navigationId !== reviewSearchNavigationRef.current) return false
          activeReviewSearchIndexRef.current = targetIndex
          setActiveReviewSearchIndex(targetIndex)
          return true
        }
        if (page.response.nextCursor === null || page.response.matches.length === 0) return false
        startIndex = pageEnd
        cursor = page.response.nextCursor
      }
      return false
    },
  )
  useEffect(() => {
    const requestId = reviewSearchRequestRef.current + 1
    reviewSearchRequestRef.current = requestId
    reviewSearchNavigationRef.current += 1
    reviewSearchTargetIndexRef.current = 0
    activeReviewSearchIndexRef.current = 0
    setActiveReviewSearchIndex(0)
    reviewSearchPageCache.clear()
    setReviewSearchOccurrences([])
    setReviewSearchTotalMatches(0)
    if (!reviewSearchOpen || reviewSearchQuery.length === 0) {
      return
    }
    void requestReviewSearchPage(null, 0, requestId, true)
  }, [
    manifest,
    requestReviewSearchPage,
    reviewSearchOpen,
    reviewSearchPageCache,
    reviewSearchQuery,
  ])
  const moveReviewSearch = useStableCallback((direction: -1 | 1) => {
    if (reviewSearchTotalMatches === 0) return
    const current = reviewSearchTargetIndexRef.current % reviewSearchTotalMatches
    const targetIndex = (current + direction + reviewSearchTotalMatches) % reviewSearchTotalMatches
    const requestId = reviewSearchRequestRef.current
    const navigationId = reviewSearchNavigationRef.current + 1
    reviewSearchNavigationRef.current = navigationId
    reviewSearchTargetIndexRef.current = targetIndex
    void activateReviewSearchIndex(targetIndex, requestId, navigationId).then((activated) => {
      if (!activated && navigationId === reviewSearchNavigationRef.current) {
        reviewSearchTargetIndexRef.current = activeReviewSearchIndexRef.current
      }
      return undefined
    })
  })
  const updateReviewSearchQuery = useStableCallback((query: string) => {
    if (query.length === 0) {
      reviewSearchAnchorRef.current = captureReviewSearchAnchor(
        diffScrollContainerRef.current,
        stickyReviewChromeRef.current,
        lastPointerPositionRef.current,
        reviewDiffRegistrationsRef.current,
        changedFiles,
        loadedChangedFiles,
      )
    }
    setReviewSearchQuery(query)
    reviewSearchTargetIndexRef.current = 0
    activeReviewSearchIndexRef.current = 0
    setActiveReviewSearchIndex(0)
  })
  const focusReviewSearch = useStableCallback(() => {
    window.requestAnimationFrame(() => {
      reviewSearchInputRef.current?.focus()
      reviewSearchInputRef.current?.select()
    })
  })
  const openReviewSearch = useStableCallback(() => {
    if (!reviewSearchOpen && document.activeElement instanceof HTMLElement) {
      previousReviewSearchFocusRef.current = document.activeElement
    }
    reviewSearchAnchorRef.current = captureReviewSearchAnchor(
      diffScrollContainerRef.current,
      stickyReviewChromeRef.current,
      lastPointerPositionRef.current,
      reviewDiffRegistrationsRef.current,
      changedFiles,
      loadedChangedFiles,
    )
    setGoToPaletteOpen(false)
    setActionPaletteOpen(false)
    setReviewSearchOpen(true)
    focusReviewSearch()
  })
  const closeReviewSearch = useStableCallback(() => {
    setReviewSearchOpen(false)
    pendingSearchNavigationIdRef.current = null
    if (pendingSearchNavigationFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingSearchNavigationFrameRef.current)
      pendingSearchNavigationFrameRef.current = null
    }
    const previousFocus = previousReviewSearchFocusRef.current
    previousReviewSearchFocusRef.current = null
    window.requestAnimationFrame(() => {
      if (previousFocus?.isConnected === true) previousFocus.focus()
    })
  })
  const requestReviewDiffReconciliation = useStableCallback((reviewKey: string) => {
    const registration = reviewDiffRegistrationsRef.current.get(reviewKey)
    if (
      registration === undefined ||
      registration.phase === "unmount" ||
      !registration.host.isConnected
    ) {
      return null
    }

    registration.instance.syncVirtualizedTop()
    diffVirtualizer.markDOMDirty()
    diffVirtualizer.requestHeightReconcile(registration.instance)
    registration.instance.rerender()
    return registration.generation
  })
  const finishFileNavigation = useStableCallback((token: symbol, path: string) => {
    if (pendingFileNavigationTokenRef.current !== token) return
    pendingFileNavigationTokenRef.current = null
    setTreeNavigationPath((current) => (current === path ? null : current))
  })
  const cancelFileNavigation = useStableCallback(() => {
    pendingFileNavigationTokenRef.current = null
    if (pendingFileNavigationFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingFileNavigationFrameRef.current)
      pendingFileNavigationFrameRef.current = null
    }
    setTreeNavigationPath(null)
  })
  const scheduleFileNavigation = useStableCallback((path: string, reviewKey: string) => {
    const token = Symbol(reviewKey)
    pendingFileNavigationTokenRef.current = token
    if (pendingFileNavigationFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingFileNavigationFrameRef.current)
    }

    let attempts = 0
    let reconciliationPasses = 0
    let requestedGeneration: number | null = null
    let readyFrames = 0
    const navigate = () => {
      pendingFileNavigationFrameRef.current = null
      if (pendingFileNavigationTokenRef.current !== token) return

      const container = diffScrollContainerRef.current
      const card = document.getElementById(diffCardDomId(reviewKey))
      if (container !== null && card !== null) {
        const stickyHeight = stickyReviewChromeRef.current?.offsetHeight ?? 0
        const cardReady =
          isDiffCardVisible(container, card, stickyHeight) && isDiffCardRendered(card)
        if (!cardReady) {
          diffVirtualizer.markDOMDirty()
          alignDiffCardInPane(container, card, stickyHeight)
          readyFrames = 0
        } else if (card.querySelector("[data-diff-card-body]") === null) {
          finishFileNavigation(token, path)
          return
        } else if (requestedGeneration !== null) {
          const registration = reviewDiffRegistrationsRef.current.get(reviewKey)
          if (
            registration !== undefined &&
            registration.phase !== "unmount" &&
            registration.generation > requestedGeneration
          ) {
            reconciliationPasses += 1
            requestedGeneration = null
            alignDiffCardInPane(container, card, stickyHeight)
          }
        } else if (reconciliationPasses < 2) {
          requestedGeneration = requestReviewDiffReconciliation(reviewKey)
        } else {
          readyFrames += 1
          if (readyFrames >= 2) {
            finishFileNavigation(token, path)
            return
          }
        }
      }

      attempts += 1
      if (attempts < REVIEW_NAVIGATION_MAX_FRAMES) {
        pendingFileNavigationFrameRef.current = window.requestAnimationFrame(navigate)
      } else {
        finishFileNavigation(token, path)
      }
    }

    pendingFileNavigationFrameRef.current = window.requestAnimationFrame(navigate)
  })
  const scheduleSearchNavigation = useStableCallback((occurrence: ReviewSearchOccurrence) => {
    pendingSearchNavigationIdRef.current = occurrence.id
    if (pendingSearchNavigationFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingSearchNavigationFrameRef.current)
    }

    let attempts = 0
    let reconciliationPasses = 0
    let requestedGeneration: number | null = null
    const navigate = () => {
      pendingSearchNavigationFrameRef.current = null
      if (activeReviewSearchOccurrenceRef.current?.id !== occurrence.id) return

      const container = diffScrollContainerRef.current
      const target = reviewSearchHighlights.getScrollTarget(occurrence)
      if (container === null || target === null || !target.host.isConnected) {
        const card = document.getElementById(diffCardDomId(occurrence.reviewKey))
        if (container !== null && card !== null) {
          diffVirtualizer.markDOMDirty()
          alignDiffCardInPane(container, card, stickyReviewChromeRef.current?.offsetHeight ?? 0)
        }
        attempts += 1
        if (attempts < REVIEW_NAVIGATION_MAX_FRAMES) {
          pendingSearchNavigationFrameRef.current = window.requestAnimationFrame(navigate)
        }
        return
      }

      if (requestedGeneration !== null) {
        const registration = reviewDiffRegistrationsRef.current.get(occurrence.reviewKey)
        if (
          registration === undefined ||
          registration.phase === "unmount" ||
          registration.generation <= requestedGeneration
        ) {
          attempts += 1
          if (attempts < REVIEW_NAVIGATION_MAX_FRAMES) {
            pendingSearchNavigationFrameRef.current = window.requestAnimationFrame(navigate)
          }
          return
        }
        reconciliationPasses += 1
        requestedGeneration = null
      }

      if (reconciliationPasses === 0) {
        requestedGeneration = requestReviewDiffReconciliation(occurrence.reviewKey)
        attempts += 1
        if (attempts < REVIEW_NAVIGATION_MAX_FRAMES) {
          pendingSearchNavigationFrameRef.current = window.requestAnimationFrame(navigate)
        }
        return
      }

      const stickyHeight = stickyReviewChromeRef.current?.offsetHeight ?? 0
      const viewportHeight = Math.max(1, container.clientHeight - stickyHeight)
      const targetOffset =
        diffVirtualizer.getOffsetInScrollContainer(target.host) + target.top - stickyHeight
      const estimatedScrollTop = targetOffset - (viewportHeight - target.height) / 2
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
      container.scrollTop = Math.min(Math.max(0, estimatedScrollTop), maxScrollTop)
      container.dispatchEvent(new Event("scroll"))

      const matchRect = reviewSearchHighlights.getActiveMatchRect()
      const matchElement = reviewSearchHighlights.getActiveMatchElement()
      if (matchRect === null || matchElement === null) {
        attempts += 1
        if (attempts < REVIEW_NAVIGATION_MAX_FRAMES) {
          pendingSearchNavigationFrameRef.current = window.requestAnimationFrame(navigate)
        }
        return
      }

      if (reconciliationPasses < 2) {
        requestedGeneration = requestReviewDiffReconciliation(occurrence.reviewKey)
        attempts += 1
        if (attempts < REVIEW_NAVIGATION_MAX_FRAMES) {
          pendingSearchNavigationFrameRef.current = window.requestAnimationFrame(navigate)
        }
        return
      }

      const containerRect = container.getBoundingClientRect()
      const visibleTop = containerRect.top + stickyHeight
      const visibleCenter = visibleTop + (containerRect.bottom - visibleTop) / 2
      const matchElementRect = matchElement.getBoundingClientRect()
      const matchElementCenter = matchElementRect.top + matchElementRect.height / 2
      const refinedScrollTop = container.scrollTop + matchElementCenter - visibleCenter
      const refinedMaxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
      container.scrollTop = Math.min(Math.max(0, refinedScrollTop), refinedMaxScrollTop)
      container.dispatchEvent(new Event("scroll"))
      const visibleMatchRect = reviewSearchHighlights.getActiveMatchRect()
      const visibleContainerRect = container.getBoundingClientRect()
      if (
        visibleMatchRect === null ||
        visibleMatchRect.bottom <= visibleContainerRect.top + stickyHeight ||
        visibleMatchRect.top >= visibleContainerRect.bottom
      ) {
        attempts += 1
        if (attempts < REVIEW_NAVIGATION_MAX_FRAMES) {
          pendingSearchNavigationFrameRef.current = window.requestAnimationFrame(navigate)
        }
        return
      }
      pendingSearchNavigationIdRef.current = null
    }

    pendingSearchNavigationFrameRef.current = window.requestAnimationFrame(navigate)
  })
  useLayoutEffect(() => {
    reviewSearchHighlights.setSearch(
      reviewSearchOpen ? reviewSearchOccurrences : [],
      activeReviewSearchOccurrence?.id ?? null,
    )
  }, [
    activeReviewSearchOccurrence?.id,
    reviewSearchHighlights,
    reviewSearchOccurrences,
    reviewSearchOpen,
  ])
  useEffect(() => {
    if (activeReviewSearchOccurrence !== null) {
      void loadSnapshotFiles([activeReviewSearchOccurrence.fileId]).then(() => {
        scheduleSearchNavigation(activeReviewSearchOccurrence)
        return undefined
      })
    }
  }, [activeReviewSearchOccurrence, loadSnapshotFiles, scheduleSearchNavigation])
  const handleDiffRendered = useStableCallback<
    (reviewKey: string, node: HTMLElement, instance: object, phase: PostRenderPhase) => void
  >((reviewKey, node, instance, phase) => {
    if (instance instanceof VirtualizedFileDiff) {
      const previous = reviewDiffRegistrationsRef.current.get(reviewKey)
      reviewDiffRegistrationsRef.current.set(reviewKey, {
        generation:
          previous?.host === node && previous.instance === instance ? previous.generation + 1 : 1,
        host: node,
        instance,
        phase,
      })
      if (phase === "unmount") {
        queueMicrotask(() => {
          const current = reviewDiffRegistrationsRef.current.get(reviewKey)
          if (current?.host === node && !node.isConnected) {
            reviewDiffRegistrationsRef.current.delete(reviewKey)
          }
        })
      }
    }
    reviewSearchHighlights.handlePostRender(reviewKey, node, instance, phase)
    handleViewedDiffRendered(reviewKey, phase)
  })
  useEffect(() => {
    pendingFileNavigationTokenRef.current = null
    lastPointerPositionRef.current = null
    reviewDiffRegistrationsRef.current.clear()
    if (pendingFileNavigationFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingFileNavigationFrameRef.current)
      pendingFileNavigationFrameRef.current = null
    }
    setTreeNavigationPath(null)
    setSidebarTab("tree")
    setWalkthroughState({ status: "idle" })
    setActiveWalkthroughStepIndex(0)
    setVisitedWalkthroughStepIndexes(new Set())
    setCollapsedWalkthroughFileKeys(new Set())
    setShowHiddenFiles(false)
    setGoToPaletteOpen(false)
    setActionPaletteOpen(false)
    setReviewSearchOpen(false)
    reviewSearchAnchorRef.current = null
    setReviewSearchQuery("")
    reviewSearchPageCache.clear()
    setReviewSearchOccurrences([])
    setReviewSearchTotalMatches(0)
    reviewSearchNavigationRef.current += 1
    reviewSearchTargetIndexRef.current = 0
    activeReviewSearchIndexRef.current = 0
    setActiveReviewSearchIndex(0)
    setExpandedLineAnchor(null)
    setRepositoryBannerDismissed(false)
    setRepositoryLinking(false)
    setRepositoryLinkError(null)
    setApprovalState("checking")
  }, [reviewIdentity, reviewBaseSha, reviewHeadSha, reviewSearchPageCache])

  useEffect(() => {
    if (sourceOperations.decision._tag === "unsupported") {
      setApprovalState("unapproved")
      return undefined
    }

    const decisionOperations = sourceOperations.decision
    let cancelled = false
    setApprovalState("checking")
    decisionOperations
      .get()
      .then((decision) => {
        if (!cancelled) setApprovalState(decision === "approved" ? "approved" : "unapproved")
        return undefined
      })
      .catch(() => {
        if (!cancelled) setApprovalState("unapproved")
      })

    return () => {
      cancelled = true
    }
  }, [sourceOperations.decision])

  useEffect(() => {
    const handleReviewShortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (
        pendingFileNavigationTokenRef.current !== null &&
        isViewportScrollKey(key) &&
        !isEditableTarget(event.target)
      ) {
        cancelFileNavigation()
      }
      if (isModKey(event) && key === "f") {
        event.preventDefault()
        event.stopPropagation()
        openReviewSearch()
        return
      }

      if (reviewSearchOpen && isModKey(event) && key === "g") {
        event.preventDefault()
        event.stopPropagation()
        moveReviewSearch(event.shiftKey ? -1 : 1)
        return
      }

      if (reviewSearchOpen && key === "escape") {
        event.preventDefault()
        event.stopPropagation()
        closeReviewSearch()
        return
      }

      if (isModKey(event) && key === "k") {
        event.preventDefault()
        event.stopPropagation()
        if (event.shiftKey) {
          setActionPaletteOpen(true)
        } else {
          setGoToPaletteOpen(true)
        }
        return
      }

      if (
        key !== "v" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        goToPaletteOpen ||
        actionPaletteOpen ||
        isEditableTarget(event.target)
      ) {
        return
      }

      const viewportPath = reviewViewportPath(
        diffScrollContainerRef.current,
        stickyReviewChromeRef.current,
      )
      const file =
        visibleChangedFiles.find((changedFile) => changedFile.path === viewportPath) ??
        visibleChangedFiles.find((changedFile) => changedFile.path === selectedVisiblePath) ??
        null
      if (file === null) return

      event.preventDefault()
      const nextViewed = !viewedFileKeys.has(file.reviewKey)
      setViewedPreservingViewport(file.reviewKey, nextViewed)
      setFileOpenStatus(
        `${nextViewed ? "Marked" : "Unmarked"} ${file.path} as viewed with shortcut v.`,
      )
    }

    window.addEventListener("keydown", handleReviewShortcut, true)
    return () => window.removeEventListener("keydown", handleReviewShortcut, true)
  }, [
    actionPaletteOpen,
    cancelFileNavigation,
    closeReviewSearch,
    goToPaletteOpen,
    moveReviewSearch,
    openReviewSearch,
    reviewSearchOpen,
    selectedVisiblePath,
    setViewedPreservingViewport,
    viewedFileKeys,
    visibleChangedFiles,
  ])

  const loadWalkthrough = async (regenerate: boolean) => {
    if (!regenerate && reviewBaseSha !== null && reviewHeadSha !== null) {
      setWalkthroughState({ status: "loading", message: "Loading cached walkthrough" })
      try {
        const cached = await sourceOperations.getWalkthrough()

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
      const stored = await sourceOperations.generateWalkthrough(regenerate)
      if (regenerate) {
        const storedWalkthroughScope = reviewSubjectWalkthroughScope(reviewSubject, stored)
        const resetViewedFiles = new Map<string, ViewedFileUpdate>(
          changedFiles.map((file) => [
            file.reviewKey,
            { reviewKey: file.reviewKey, viewed: false },
          ]),
        )
        walkthroughReviewSteps(stored.walkthrough).forEach((step) => {
          focusFilesForWalkthroughHunks(
            loadedChangedFiles,
            step.hunkIds,
            storedWalkthroughScope,
          ).forEach((file) => {
            resetViewedFiles.set(file.reviewKey, { reviewKey: file.reviewKey, viewed: false })
          })
        })
        setViewedFilesPreservingViewport([...resetViewedFiles.values()])
      }
      setActiveWalkthroughStepIndex(0)
      setVisitedWalkthroughStepIndexes(new Set([0]))
      setCollapsedWalkthroughFileKeys(new Set())
      setWalkthroughState({ status: "ready", stored })
      captureAnalytics({
        event: "walkthrough_generated",
        reviewType: reviewSubject.kind === "hosted" ? "pull_request" : "local_diff",
        regenerated: regenerate,
        provider: aiSettings.routes.walkthrough,
      })
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

    setViewedFilesPreservingViewport(
      focusFilesForWalkthroughHunks(
        loadedChangedFiles,
        activeWalkthroughStep.hunkIds,
        walkthroughScope,
      ).map((file) => ({ reviewKey: file.reviewKey, viewed: true })),
    )
  }
  const markAllFilesViewed = () => {
    setViewedFilesPreservingViewport(
      changedFiles.map((file) => ({ reviewKey: file.reviewKey, viewed: true })),
    )
    setFileOpenStatus(
      `Marked ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} as viewed.`,
    )
  }
  const revealHiddenFiles = () => {
    setShowHiddenFiles(true)
    setFileOpenStatus(`Revealed ${hiddenFileCount} hidden file${hiddenFileCount === 1 ? "" : "s"}.`)
  }
  const selectReviewFile = (file: ReviewSnapshotFileInventory) => {
    setFileFilter("")
    if (getHiddenDiffFileReason(file) !== null) setShowHiddenFiles(true)
    selectPathAndScroll(file.path, file.reviewKey)
  }
  const selectWalkthroughStepAndFocus = (index: number) => {
    selectSidebarTab("walkthrough")
    selectWalkthroughStep(index)
    const step = activeWalkthroughSteps[index]
    const file =
      step === undefined
        ? null
        : focusFilesForWalkthroughHunks(loadedChangedFiles, step.hunkIds, walkthroughScope)[0]
    if (file !== undefined && file !== null) selectWalkthroughFile(index, file)
  }
  const toggleExpandedLine = (anchor: ReviewThreadAnchor) => {
    setExpandedLineAnchor((current) => (sameReviewThreadLine(current, anchor) ? null : anchor))
  }
  const reviewGoToItems = reviewGoToPaletteItems({
    files: changedFiles,
    mode: sidebarTab,
    onSelectFile: selectReviewFile,
    onSelectWalkthroughStep: selectWalkthroughStepAndFocus,
    steps: activeWalkthroughSteps,
  })
  const reviewActionItems = reviewActionPaletteItems({
    aiAgentAvailable,
    changedFiles,
    hiddenFileCount,
    isReloading,
    onMarkAllViewed: markAllFilesViewed,
    onApprove: () => void approvePullRequest(),
    onRegenerateWalkthrough: () => void loadWalkthrough(true),
    onReload,
    onRevealHidden: revealHiddenFiles,
    approvalState: sourceOperations.decision._tag === "unsupported" ? null : approvalState,
    showHiddenFiles,
    walkthroughLoading: walkthroughState.status === "loading",
  })
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
  const selectWalkthroughFile = (stepIndex: number, file: ParsedDiffFile) => {
    selectWalkthroughStep(stepIndex)
    setFileFilter("")
    if (getHiddenDiffFileReason(file) !== null) setShowHiddenFiles(true)
    selectPathAndScroll(file.path, file.reviewKey)
  }
  const selectPathAndScroll = (path: string, reviewKey?: string) => {
    setTreeNavigationPath(path)
    onSelectPath(path)
    const file = changedFiles.find((changedFile) => changedFile.path === path)
    if (file !== undefined) scheduleFileNavigation(path, reviewKey ?? file.reviewKey)
  }
  const selectIndexedThread = (details: ReviewThreadDetails) => {
    const anchor = details.thread.currentAnchor ?? details.thread.originalAnchor
    setExpandedLineAnchor(anchor)
    setFileFilter("")
    const file = changedFiles.find(
      (candidate) => candidate.fileId === anchor.fileId || candidate.path === anchor.filePath,
    )
    if (file === undefined) return
    if (getHiddenDiffFileReason(file) !== null) setShowHiddenFiles(true)
    const walkthroughStepIndex = activeWalkthroughSteps.findIndex((step) =>
      focusFilesForWalkthroughHunks(loadedChangedFiles, step.hunkIds, walkthroughScope).some(
        (candidate) => lineAnchorIsInFile(anchor, candidate),
      ),
    )
    if (walkthroughStepIndex >= 0) {
      const walkthroughFile = focusFilesForWalkthroughHunks(
        loadedChangedFiles,
        activeWalkthroughSteps[walkthroughStepIndex]?.hunkIds ?? [],
        walkthroughScope,
      ).find((candidate) => lineAnchorIsInFile(anchor, candidate))
      if (walkthroughFile !== undefined) {
        selectSidebarTab("walkthrough")
        selectWalkthroughStep(walkthroughStepIndex)
        selectPathAndScroll(walkthroughFile.path, walkthroughFile.reviewKey)
        return
      }
    }
    selectPathAndScroll(file.path, file.reviewKey)
  }
  const openRepositoryFile = async (path: string) => {
    setFileOpenStatus(`Opening ${path}...`)
    try {
      await sourceOperations.openFile(path)
      setFileOpenStatus(null)
    } catch (error) {
      setFileOpenStatus(formatError(error, "Could not open file"))
    }
  }
  const approvePullRequest = async () => {
    if (sourceOperations.decision._tag === "unsupported" || reviewSubject.kind !== "hosted") return
    if (approvalState === "approved" || approvalState === "approving") return

    const pullRequest = reviewSubject.hostedReview.summary
    setApprovalState("approving")
    setFileOpenStatus(`Approving review #${pullRequest.locator.number}...`)
    try {
      await sourceOperations.decision.approve()
      setApprovalState("approved")
      captureAnalytics({ event: "pull_request_approved" })
      setFileOpenStatus(`Approved review #${pullRequest.locator.number}.`)
    } catch (error) {
      setApprovalState("unapproved")
      setFileOpenStatus(formatError(error, "Could not approve pull request"))
    }
  }
  const linkRepository = async () => {
    if (repositoryLinking) return
    setRepositoryLinking(true)
    setRepositoryLinkError(null)
    try {
      const linked = await onLinkRepository()
      if (linked) setRepositoryBannerDismissed(true)
    } catch (error) {
      setRepositoryLinkError(formatError(error, "Could not link repository"))
    } finally {
      setRepositoryLinking(false)
    }
  }
  const showRepositoryLinkBanner =
    reviewSubject.kind === "hosted" &&
    repositoryLinkState === "unlinked" &&
    !repositoryBannerDismissed

  const reviewContent = (
    <>
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
            <WalkthroughSettingsMenu
              catalog={agentProviderCatalog}
              settings={aiSettings}
              onChange={onAISettingsChange}
            />
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
              <>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <div className="text-caption text-review-sidebar-muted min-w-0 truncate">
                    {aiProviderLabel(aiSettings.routes.walkthrough, agentProviderCatalog)} /{" "}
                    {selectedAIModelLabel(aiSettings, agentProviderCatalog)}
                  </div>
                </div>
                {agentUnavailableReason(
                  aiSettings.routes.walkthrough,
                  agentProviderCatalog,
                  "walkthrough",
                ) === null ? null : (
                  <p className="text-caption text-review-sidebar-muted leading-4">
                    {agentUnavailableReason(
                      aiSettings.routes.walkthrough,
                      agentProviderCatalog,
                      "walkthrough",
                    )}
                  </p>
                )}
              </>
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
                changedFiles={loadedChangedFiles}
                hunkDigest={walkthroughHunkDigest}
                scope={walkthroughScope}
                state={walkthroughState}
                visitedStepIndexes={visitedWalkthroughStepIndexes}
                viewedFileKeys={viewedFileKeys}
                onRegenerate={() => void loadWalkthrough(true)}
                onRetry={() => void loadWalkthrough(false)}
                onSelectFile={selectWalkthroughFile}
                onSelectStep={selectWalkthroughStep}
              />
            ) : (
              <ReviewFileTree
                files={filteredChangedFiles}
                selectedPath={selectedTreePath}
                onSelectPath={selectPathAndScroll}
              />
            )}
          </div>

          <div className="border-review-sidebar-divider bg-review-sidebar-control text-review-sidebar-muted flex items-center justify-between gap-2 border-t px-3 py-2 text-xs">
            <span>
              {hiddenFileCount > 0 && !showHiddenFiles ? `${hiddenFileCount} hidden` : "Total"}
            </span>
            <span>
              <span className="text-review-success">+{totalAdditions}</span>{" "}
              <span className="text-review-danger">-{totalDeletions}</span>
            </span>
          </div>
        </aside>

        <div
          ref={setDiffScrollContainer}
          data-review-diff-scroll-container
          style={{ overflowAnchor: "none" }}
          className="h-full min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
          onPointerDown={cancelFileNavigation}
          onPointerMove={(event) => {
            lastPointerPositionRef.current = { clientX: event.clientX, clientY: event.clientY }
          }}
          onPointerLeave={() => {
            lastPointerPositionRef.current = null
          }}
          onTouchStart={cancelFileNavigation}
          onWheel={cancelFileNavigation}
        >
          <div className="min-h-full">
            <div
              ref={stickyReviewChromeRef}
              data-review-sticky-chrome
              className="bg-background/95 sticky top-0 z-10 backdrop-blur"
            >
              <div className="border-b px-5 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div
                    role={operationError === null ? undefined : "alert"}
                    className="text-muted-foreground min-w-0 truncate text-xs"
                  >
                    {operationError ?? fileOpenStatus ?? status}
                  </div>
                  <div className="flex items-center gap-2">
                    <ReviewActionsMenu items={reviewActionItems} />
                  </div>
                </div>
              </div>
              {reviewSearchOpen ? (
                <ReviewSearchToolbar
                  activeIndex={normalizedReviewSearchIndex}
                  inputRef={reviewSearchInputRef}
                  matchCount={reviewSearchTotalMatches}
                  query={reviewSearchQuery}
                  onClose={closeReviewSearch}
                  onNext={() => moveReviewSearch(1)}
                  onPrevious={() => moveReviewSearch(-1)}
                  onQueryChange={updateReviewSearchQuery}
                />
              ) : null}
              {showRepositoryLinkBanner ? (
                <section
                  aria-label="Local repository not linked"
                  className="bg-accent/70 border-b px-5 py-3"
                >
                  <div className="mx-auto flex max-w-review-diff items-start gap-3">
                    <div className="bg-background text-primary mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border shadow-xs">
                      <FolderGit2 className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold">
                        Link a checkout for isolated agent review
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-xs leading-5">
                        DiffDash creates a private worktree at the exact PR revision. Your branch
                        and local changes are never switched or cleaned.
                      </p>
                      {repositoryLinkError === null ? null : (
                        <p role="alert" className="text-destructive mt-1 text-xs">
                          {repositoryLinkError}
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={repositoryLinking}
                      onClick={() => void linkRepository()}
                    >
                      {repositoryLinking ? <Loader2 className="size-3.5 animate-spin" /> : null}
                      {repositoryLinking ? "Linking" : "Link folder"}
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Dismiss local repository banner"
                      onClick={() => setRepositoryBannerDismissed(true)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                </section>
              ) : null}
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
                        : Math.min(
                            activeWalkthroughStepIndex + 1,
                            activeWalkthroughSteps.length - 1,
                          ),
                    )
                  }
                  onRetry={() => void loadWalkthrough(false)}
                />
              ) : null}
              <section
                id="review-thread-summary"
                className="bg-card scroll-mt-14 rounded-2xl border p-4 shadow-xs"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  {reviewSubject.kind === "hosted" ? (
                    <>
                      <Badge variant="outline" className="text-caption">
                        #{reviewSubject.hostedReview.summary.locator.number}
                      </Badge>
                      <PullRequestStateBadge
                        className="text-caption"
                        isDraft={reviewSubject.hostedReview.summary.draft}
                        state={reviewSubject.hostedReview.summary.state}
                      />
                      <Badge variant="secondary" className="text-caption">
                        @{reviewSubject.hostedReview.summary.author.username}
                      </Badge>
                      {sidebarTab === "walkthrough" ? (
                        <Badge
                          variant="outline"
                          className="text-caption"
                          title="Walkthrough generated from PR metadata and diff only."
                        >
                          <Cloud className="size-3" />
                          Diff-only
                        </Badge>
                      ) : null}
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
                      {reviewSubject.localReview.comparison["_tag"] === "branch" ? (
                        <Badge variant="outline" className="text-caption">
                          vs {reviewSubject.localReview.comparison.branchName}
                        </Badge>
                      ) : null}
                    </>
                  )}
                </div>
                <h1 className="mt-3 text-2xl font-semibold tracking-tight">
                  {reviewSubjectTitle(reviewSubject)}
                </h1>
                <div className="text-muted-foreground mt-2 grid gap-2 text-xs md:grid-cols-4">
                  <Metric label="Files" value={String(manifest.files.length)} />
                  {reviewSubject.kind === "hosted" ? (
                    <>
                      <Metric
                        label="Commits"
                        value={String(reviewSubject.hostedReview.commits.length)}
                      />
                      <Metric
                        label="Head"
                        value={shortSha(reviewSubject.hostedReview.summary.head.revision)}
                      />
                      <Metric
                        label="Base"
                        value={shortSha(reviewSubject.hostedReview.summary.base.revision)}
                      />
                    </>
                  ) : (
                    <>
                      <Metric label="Repo" value={reviewSubject.localReview.repoName} />
                      <Metric label="Diff" value={shortSha(reviewSubject.localReview.headSha)} />
                      <Metric label="Base" value={shortSha(reviewSubject.localReview.baseSha)} />
                    </>
                  )}
                </div>
                {reviewThreads.loading ? (
                  <div className="text-muted-foreground mt-3 border-t pt-3 text-caption">
                    Loading line comments...
                  </div>
                ) : null}
              </section>

              <ReviewThreadIndex
                items={indexedThreadDetails}
                loading={reviewThreads.loading}
                error={reviewThreads.error}
                onReload={reviewThreads.reload}
                onSelect={selectIndexedThread}
              />
              {normalizedFileFilter.length === 0 && renderedChangedFiles.length === 0 ? (
                <EmptyState>No changed files found.</EmptyState>
              ) : null}
              {normalizedFileFilter.length > 0 && renderedChangedFiles.length === 0 ? (
                <EmptyState>No files match this filter.</EmptyState>
              ) : null}
              {renderedChangedFiles.map((file) => {
                const parsedFile = loadedFilesById.get(file.fileId)
                return parsedFile === undefined ? (
                  <ReviewPagePlaceholder
                    key={file.reviewKey}
                    file={file}
                    loading={loadingFileIds.has(file.fileId)}
                    tooLarge={tooLargeFileIds.has(file.fileId)}
                    onVisible={() => void loadSnapshotFiles([file.fileId])}
                  />
                ) : (
                  <OpenDiffCard
                    key={file.reviewKey}
                    diffOptions={reviewDiffOptions}
                    expanded={
                      sidebarTab === "walkthrough" && activeWalkthroughStep !== null
                        ? !collapsedWalkthroughFileKeys.has(file.reviewKey)
                        : expandedFileKeys.has(file.reviewKey)
                    }
                    expandedLineAnchor={expandedLineAnchor}
                    file={parsedFile}
                    forceExpanded={
                      activeSearchReviewKey === file.reviewKey ||
                      (sidebarTab === "walkthrough" &&
                        activeWalkthroughStep !== null &&
                        !collapsedWalkthroughFileKeys.has(file.reviewKey))
                    }
                    reviewThreads={reviewThreads}
                    selected={
                      activeSearchReviewKey === file.reviewKey || selectedVisiblePath === file.path
                    }
                    viewed={viewedFileKeys.has(file.reviewKey)}
                    onDiffRendered={(node, instance, phase) =>
                      handleDiffRendered(file.reviewKey, node, instance, phase)
                    }
                    onOpenFile={() => void openRepositoryFile(file.path)}
                    onSelect={() => selectPathAndScroll(file.path, file.reviewKey)}
                    onSetViewed={(viewed) => setViewedPreservingViewport(file.reviewKey, viewed)}
                    onToggleLine={toggleExpandedLine}
                    onToggleExpanded={() => toggleVisibleDiffCard(file.reviewKey)}
                  />
                )
              })}
            </main>
          </div>
        </div>
      </section>
      <CommandPaletteDialog
        items={reviewGoToItems}
        open={goToPaletteOpen}
        placeholder={sidebarTab === "walkthrough" ? "Search walkthrough sections" : "Search files"}
        title="Go anywhere"
        onOpenChange={setGoToPaletteOpen}
      />
      <CommandPaletteDialog
        items={reviewActionItems}
        open={actionPaletteOpen}
        placeholder="Search review actions"
        title="Review actions"
        onOpenChange={setActionPaletteOpen}
      />
    </>
  )

  return (
    <WorkerPoolContextProvider
      highlighterOptions={REVIEW_DIFF_HIGHLIGHTER_OPTIONS}
      poolOptions={REVIEW_DIFF_WORKER_POOL_OPTIONS}
    >
      <VirtualizerContext.Provider value={diffVirtualizer}>
        {reviewContent}
      </VirtualizerContext.Provider>
    </WorkerPoolContextProvider>
  )
}

const approvalButtonLabel = (state: PullRequestApprovalState) => {
  if (state === "approved") return "Approved"
  if (state === "approving") return "Approving..."
  if (state === "checking") return "Checking..."
  return "Approve"
}

/** Anchored context menu for review actions; the keyboard palette shares the same item model. */
const ReviewActionsMenu = ({ items }: { readonly items: readonly CommandPaletteItem[] }) => {
  const [open, setOpen] = useState(false)

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={(event) => {
            if (event.detail === 0) setOpen((value) => !value)
          }}
        >
          <Command className="size-3" />
          Actions
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="Review actions"
          align="end"
          sideOffset={8}
          className="bg-popover text-popover-foreground z-30 w-72 overflow-hidden rounded-xl border p-1 shadow-lg"
        >
          {items.map((item) => {
            const Icon = reviewActionIcon(item.id)
            return (
              <DropdownMenu.Item
                key={item.id}
                asChild
                disabled={item.disabled ?? false}
                onSelect={item.onSelect}
              >
                <button
                  type="button"
                  disabled={item.disabled}
                  className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Icon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block font-medium">{item.title}</span>
                    <span className="text-muted-foreground mt-0.5 block truncate text-caption">
                      {item.subtitle}
                    </span>
                  </span>
                </button>
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

const reviewActionIcon = (id: string) => {
  if (id === "action:reload-diff") return RefreshCw
  if (id === "action:regenerate-walkthrough") return Sparkles
  if (id === "action:approve-pull-request") return Check
  if (id === "action:mark-all-viewed") return Check
  return Search
}

const WalkthroughSettingsMenu = ({
  catalog,
  settings,
  onChange,
}: {
  readonly catalog: AgentProviderCatalog
  readonly settings: AISettings
  readonly onChange: (settings: AISettings) => void
}) => {
  const [open, setOpen] = useState(false)
  const walkthroughRoute = settings.routes.walkthrough
  const walkthroughProviders = agentProviderOptions(
    catalog,
    settings,
    walkthroughRoute,
    "walkthrough",
  )
  const walkthroughModel = selectedModelForProvider(
    settings,
    walkthroughRoute,
    catalog,
    "walkthrough",
  )
  const reviewThreadRoute = settings.routes.reviewThread
  const walkthroughModels = modelOptionsForProvider(
    settings,
    walkthroughRoute,
    catalog,
    "walkthrough",
  )
  const reviewThreadProviders = agentProviderOptions(
    catalog,
    settings,
    reviewThreadRoute,
    "review-thread",
  )

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Agent settings"
          className="text-review-sidebar-muted hover:bg-review-sidebar-control-hover hover:text-review-sidebar-fg"
          onClick={(event) => {
            if (event.detail === 0) setOpen((value) => !value)
          }}
        >
          <Settings2 className="size-3" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="Agent settings"
          align="end"
          sideOffset={8}
          className="bg-review-sidebar border-review-sidebar-divider text-review-sidebar-fg z-30 w-72 space-y-3 rounded-xl border p-2 text-xs shadow-lg"
        >
          <DropdownMenu.RadioGroup
            className="space-y-1"
            value={walkthroughRoute}
            onValueChange={(provider) =>
              onChange(aiSettingsWithProvider(settings, "walkthrough", provider, catalog))
            }
          >
            <DropdownMenu.Label className="text-caption text-review-sidebar-muted px-2 font-semibold tracking-wide uppercase">
              Walkthrough agent
            </DropdownMenu.Label>
            {walkthroughProviders.map((option) => (
              <WalkthroughSettingsMenuItem
                key={option.provider}
                value={option.provider}
                label={option.label}
                detail={option.reason}
                disabled={option.disabled}
                selected={walkthroughRoute === option.provider}
              />
            ))}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.RadioGroup
            className="border-review-sidebar-divider space-y-1 border-t pt-2"
            value={walkthroughModel}
            onValueChange={(model) => onChange(aiSettingsWithModel(settings, "walkthrough", model))}
          >
            <DropdownMenu.Label className="text-caption text-review-sidebar-muted px-2 font-semibold tracking-wide uppercase">
              Walkthrough model
            </DropdownMenu.Label>
            {walkthroughModels.map((option) => (
              <WalkthroughSettingsMenuItem
                key={option.model}
                value={option.model}
                label={option.label}
                selected={walkthroughModel === option.model}
              />
            ))}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.RadioGroup
            className="border-review-sidebar-divider space-y-1 border-t pt-2"
            value={reviewThreadRoute}
            onValueChange={(provider) =>
              onChange(aiSettingsWithProvider(settings, "review-thread", provider, catalog))
            }
          >
            <DropdownMenu.Label className="text-caption text-review-sidebar-muted px-2 font-semibold tracking-wide uppercase">
              Review comment agent
            </DropdownMenu.Label>
            {reviewThreadProviders.map((option) => (
              <WalkthroughSettingsMenuItem
                key={option.provider}
                value={option.provider}
                label={option.label}
                detail={option.reason}
                disabled={option.disabled}
                selected={reviewThreadRoute === option.provider}
              />
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

const WalkthroughSettingsMenuItem = ({
  detail,
  disabled = false,
  label,
  selected,
  value,
}: {
  readonly detail?: string | null
  readonly disabled?: boolean
  readonly label: string
  readonly selected: boolean
  readonly value: string
}) => (
  <DropdownMenu.RadioItem
    asChild
    value={value}
    disabled={disabled}
    onSelect={(event) => event.preventDefault()}
  >
    <button
      type="button"
      disabled={disabled}
      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
        selected
          ? "bg-review-sidebar-control-active text-review-sidebar-fg"
          : "text-review-sidebar-muted hover:bg-review-sidebar-control-hover hover:text-review-sidebar-fg"
      }`}
    >
      <span className="min-w-0">
        <span className="block truncate">{label}</span>
        {detail === undefined || detail === null ? null : (
          <span className="text-caption block text-pretty opacity-75">{detail}</span>
        )}
      </span>
      {selected ? <Check className="size-3" /> : null}
    </button>
  </DropdownMenu.RadioItem>
)

const Metric = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <div className="bg-background rounded-lg border p-2">
    <div className="text-muted-foreground text-caption">{label}</div>
    <div className="mt-0.5 truncate font-mono text-xs">{value}</div>
  </div>
)

const matchesReviewFileFilter = (
  file: Pick<ReviewSnapshotFileInventory, "path" | "oldPath">,
  normalizedFilter: string,
) =>
  file.path.toLowerCase().includes(normalizedFilter) ||
  (file.oldPath?.toLowerCase().includes(normalizedFilter) ?? false)

const reviewDiffOptionsForTheme = (theme: ResolvedTheme): FileDiffOptions<ReviewThreadAnnotation> =>
  REVIEW_DIFF_OPTIONS_BY_THEME[theme]

const isModKey = (event: KeyboardEvent) => event.metaKey || event.ctrlKey

const isViewportScrollKey = (key: string) =>
  key === "arrowdown" ||
  key === "arrowup" ||
  key === "end" ||
  key === "home" ||
  key === "pagedown" ||
  key === "pageup" ||
  key === " "

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tagName = target.tagName.toLowerCase()
  return tagName === "input" || tagName === "textarea" || tagName === "select"
}

const reviewGoToPaletteItems = ({
  files,
  mode,
  onSelectFile,
  onSelectWalkthroughStep,
  steps,
}: {
  readonly files: readonly ReviewSnapshotFileInventory[]
  readonly mode: ReviewSidebarTab
  readonly onSelectFile: (file: ReviewSnapshotFileInventory) => void
  readonly onSelectWalkthroughStep: (index: number) => void
  readonly steps: readonly WalkthroughReviewStep[]
}): readonly CommandPaletteItem[] =>
  mode === "tree"
    ? files.map((file) => ({
        id: `file:${file.reviewKey}`,
        keywords: `${file.path} ${file.oldPath ?? ""} file diff`,
        subtitle: `File · +${file.additions} -${file.deletions}`,
        title: file.path,
        onSelect: () => onSelectFile(file),
      }))
    : steps.map((step, index) => ({
        id: `walkthrough:${index}:${step.id}`,
        keywords: `${step.title} ${step.summary} ${step.chapterTitle ?? ""} walkthrough section`,
        subtitle: `${step.chapterTitle ?? "Walkthrough"} · ${step.risk}`,
        title: `${step.chapterTitle ?? "Walkthrough"} > ${step.title}`,
        onSelect: () => onSelectWalkthroughStep(index),
      }))

const reviewActionPaletteItems = ({
  aiAgentAvailable,
  approvalState,
  changedFiles,
  hiddenFileCount,
  isReloading,
  onMarkAllViewed,
  onApprove,
  onRegenerateWalkthrough,
  onReload,
  onRevealHidden,
  showHiddenFiles,
  walkthroughLoading,
}: {
  readonly aiAgentAvailable: boolean
  readonly approvalState: PullRequestApprovalState | null
  readonly changedFiles: readonly ReviewSnapshotFileInventory[]
  readonly hiddenFileCount: number
  readonly isReloading: boolean
  readonly onMarkAllViewed: () => void
  readonly onApprove: () => void
  readonly onRegenerateWalkthrough: () => void
  readonly onReload: () => void
  readonly onRevealHidden: () => void
  readonly showHiddenFiles: boolean
  readonly walkthroughLoading: boolean
}): readonly CommandPaletteItem[] => [
  {
    disabled: isReloading,
    id: "action:reload-diff",
    keywords: "reload refresh pr local diff",
    subtitle: isReloading ? "Reload already running" : "Refetch review detail and diff",
    title: "Reload diff",
    onSelect: onReload,
  },
  ...(approvalState === null
    ? []
    : [
        {
          disabled: approvalState !== "unapproved",
          id: "action:approve-pull-request",
          keywords: "approve pull request review",
          subtitle:
            approvalState === "unapproved"
              ? "Approve this pull request"
              : approvalButtonLabel(approvalState),
          title: approvalButtonLabel(approvalState),
          onSelect: onApprove,
        },
      ]),
  {
    disabled: !aiAgentAvailable || walkthroughLoading,
    id: "action:regenerate-walkthrough",
    keywords: "regenerate walkthrough ai",
    subtitle: aiAgentAvailable ? "Generate a fresh walkthrough" : CODING_AGENT_SETUP_MESSAGE,
    title: "Regenerate walkthrough",
    onSelect: onRegenerateWalkthrough,
  },
  {
    disabled: changedFiles.length === 0,
    id: "action:mark-all-viewed",
    keywords: "mark all viewed complete",
    subtitle: `Mark ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} as viewed`,
    title: "Mark all viewed",
    onSelect: onMarkAllViewed,
  },
  ...(hiddenFileCount > 0
    ? [
        {
          disabled: showHiddenFiles,
          id: "action:reveal-hidden",
          keywords: "reveal hidden noisy generated lockfile vendored binary files",
          subtitle: showHiddenFiles
            ? "Hidden files are already visible"
            : `Show ${hiddenFileCount} hidden file${hiddenFileCount === 1 ? "" : "s"}`,
          title: "Reveal hidden files",
          onSelect: onRevealHidden,
        },
      ]
    : []),
]

const alignDiffCardInPane = (
  container: HTMLElement,
  target: HTMLElement,
  stickyHeaderOffset = 56,
) => {
  const containerRect = container.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const rawScrollTop = container.scrollTop + targetRect.top - containerRect.top - stickyHeaderOffset
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
  const scrollTop = Math.min(Math.max(0, rawScrollTop), maxScrollTop)

  container.scrollTop = scrollTop
  container.dispatchEvent(new Event("scroll"))
}

const isDiffCardVisible = (container: HTMLElement, card: HTMLElement, stickyHeaderOffset = 56) => {
  const containerRect = container.getBoundingClientRect()
  const cardRect = card.getBoundingClientRect()
  return (
    cardRect.bottom > containerRect.top + stickyHeaderOffset && cardRect.top < containerRect.bottom
  )
}

const reviewViewportPath = (container: HTMLElement | null, stickyChrome: HTMLElement | null) => {
  return reviewViewportCard(container, stickyChrome)?.dataset.diffCardPath ?? null
}

const reviewViewportCard = (container: HTMLElement | null, stickyChrome: HTMLElement | null) => {
  if (container === null) return null
  const containerRect = container.getBoundingClientRect()
  const visibleTop = containerRect.top + (stickyChrome?.offsetHeight ?? 0)
  const cards = container.querySelectorAll<HTMLElement>("[data-diff-card-path]")
  for (const card of cards) {
    const rect = card.getBoundingClientRect()
    if (rect.bottom > visibleTop && rect.top < containerRect.bottom) return card
  }
  return null
}

const captureReviewSearchAnchor = (
  container: HTMLElement | null,
  stickyChrome: HTMLElement | null,
  pointerPosition: { readonly clientX: number; readonly clientY: number } | null,
  registrations: ReadonlyMap<string, ReviewDiffRegistration>,
  inventory: readonly ReviewSnapshotFileInventory[],
  loadedFiles: readonly ParsedDiffFile[],
): ReviewSnapshotSearchAnchor | null => {
  const containerRect = container?.getBoundingClientRect()
  const visibleTop =
    containerRect === undefined ? 0 : containerRect.top + (stickyChrome?.offsetHeight ?? 0)
  const pointerCard =
    container !== null &&
    containerRect !== undefined &&
    pointerPosition !== null &&
    pointerPosition.clientX >= containerRect.left &&
    pointerPosition.clientX <= containerRect.right &&
    pointerPosition.clientY >= visibleTop &&
    pointerPosition.clientY <= containerRect.bottom
      ? (document
          .elementFromPoint(pointerPosition.clientX, pointerPosition.clientY)
          ?.closest<HTMLElement>("[data-diff-card-path]") ?? null)
      : null
  const card =
    pointerCard !== null &&
    container?.contains(pointerCard) === true &&
    isDiffCardVisible(container, pointerCard, stickyChrome?.offsetHeight ?? 0)
      ? pointerCard
      : reviewViewportCard(container, stickyChrome)
  const path = card?.dataset.diffCardPath
  if (container === null || card === null || path === undefined) return null
  const inventoryFile = inventory.find((file) => file.path === path)
  if (inventoryFile === undefined) return null
  const loadedFile = loadedFiles.find((file) => file.fileId === inventoryFile.fileId)
  if (loadedFile === undefined) {
    return ReviewSnapshotSearchFileAnchor.make({ fileId: inventoryFile.fileId })
  }

  const registration = registrations.get(inventoryFile.reviewKey)
  if (registration !== undefined && registration.phase !== "unmount") {
    const localViewportTop = Math.max(0, visibleTop - registration.host.getBoundingClientRect().top)
    const anchor = registration.instance.getNumericScrollAnchor(localViewportTop)
    if (anchor === undefined) {
      return ReviewSnapshotSearchFileAnchor.make({ fileId: inventoryFile.fileId })
    }
    const side = anchor.side === "deletions" ? "old" : "new"
    for (const hunk of loadedFile.hunks) {
      const line = projectDiffHunkLines(hunk).find(
        (candidate) =>
          (side === "old" ? candidate.oldLineNumber : candidate.newLineNumber) ===
          anchor.lineNumber,
      )
      if (line !== undefined) {
        return ReviewSnapshotSearchLineAnchor.make({
          fileId: inventoryFile.fileId,
          hunkId: hunk.id,
          hunkLineIndex: line.index,
        })
      }
    }
  }
  return ReviewSnapshotSearchFileAnchor.make({ fileId: inventoryFile.fileId })
}

const isDiffCardRendered = (card: HTMLElement) => {
  const body = card.querySelector<HTMLElement>("[data-diff-card-body]")
  if (body === null) return true
  const host = body.querySelector("diffs-container")
  return (
    body.getAttribute("aria-busy") === "false" &&
    (host?.shadowRoot?.querySelector("[data-line]") ?? null) !== null
  )
}

const resultValue = <A,>(result: Result.Result<A, unknown>, fallback: A) =>
  Result.getOrElse(result, () => fallback)

const shortSha = (sha: string | null) => (sha ? sha.slice(0, 8) : "unknown")
