/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
/* oxlint-disable jsx-a11y/prefer-tag-over-role -- A focusable ARIA separator is the standard keyboard-resizable splitter pattern. */
import {
  AIProviderId,
  AISettings,
  type CodeThemePreferences,
  DEFAULT_CODE_THEME_PREFERENCES,
  DiffViewMode,
} from "@diffdash/domain/ai-settings"
import { DiffFileVisibility, type ParsedDiffFile } from "@diffdash/domain/diff"
import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import type { ReviewFileId } from "@diffdash/domain/review-identity"
import type { ProjectWorkspaceRibbon } from "@diffdash/domain/project-workspace"
import {
  ReviewLocationV1,
  ReviewNavigationBehavior,
  ReviewNavigationInput,
  ReviewSnapshotAddress,
  ThreadReviewNavigationTarget,
  FileReviewNavigationTarget,
} from "@diffdash/domain/review-navigation"
import type {
  ReviewThreadAnchor,
  ReviewThreadDetails,
  ReviewThreadId,
} from "@diffdash/domain/review-thread"
import {
  buildWalkthroughHunkDigest,
  focusFilesForWalkthroughHunks,
} from "@diffdash/domain/walkthrough"
import {
  type AgentProviderCatalog,
  EMPTY_AGENT_PROVIDER_CATALOG,
} from "@diffdash/protocol/agent-providers"
import { ReviewSnapshotSearchFileAnchor } from "@diffdash/protocol/review-snapshot"
import { RegistryContext, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/unstable/reactivity"
import { Match } from "effect"
import {
  Check,
  Ellipsis,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react"
import { DropdownMenu } from "radix-ui"
import type { ReactNode } from "react"
import { useContext, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react"
import {
  runRendererPromise,
  useDesktopRuntime,
  useReviewContent,
} from "@/platform/renderer-runtime"
import {
  agentProviderOptions,
  agentSelection,
  agentUnavailableReason,
  aiProviderLabel,
  aiSettingsWithModel,
  aiSettingsWithProvider,
  modelOptionsForProvider,
  selectedAIModelLabel,
  selectedModelForProvider,
  selectedProvider,
} from "@/settings/agent-selection"
import type { ColorScheme } from "@/settings/theme"
import { useCaptureAnalytics } from "@/shared/analytics"
import { isHTMLElement } from "@/shared/dom"
import type { TransportError } from "@diffdash/protocol/transport-error"
import { formatError } from "@/shared/errors"
import { Button } from "@/shared/ui/button"
import { EmptyState } from "@/shared/ui/empty-state"
import { Input } from "@/shared/ui/input"
import { CommandPaletteDialog, type CommandPaletteItem } from "@/shell/command-palette"
import { WorkbenchContextActions } from "@/shell/workbench-context-actions"
import { ProjectActivityNavigation } from "@/project-workspace/project-activity-navigation"
import {
  ReviewThreadDetailPane,
  ReviewThreadListPane,
  type ReviewThreadSidebarState,
} from "@/threads/review-thread-sidebar"
import { useReviewThreads } from "@/threads/review-threads"
import { agentProviderCatalogAtom } from "@/walkthrough/atoms"
import { walkthroughErrorPresentation } from "@/walkthrough/walkthrough-error-report"
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
  isVirtualizedFileDiff,
  type FileDiffOptions,
  type PostRenderPhase,
  useStableCallback,
  useWorkerPool,
  VirtualizerContext,
  type WorkerInitializationRenderOptions,
  WorkerPoolContextProvider,
  type WorkerPoolOptions,
} from "./pierre"
import { ReviewFileTree } from "./review-file-tree"
import {
  ReviewNavigatorController,
  reviewNavigationLastOutcomeAtom,
  reviewNavigationPresentationAtom,
  reviewNavigationStatusAtom,
} from "./review-navigation"
import { ReviewNavigationAnchorRegistry, reviewFileAnchorKey } from "./review-navigation-anchors"
import { ReviewPagePlaceholder } from "./review-page-placeholder"
import { ReviewSearchHighlightManager } from "./review-search-highlights"
import { ReviewSearchController } from "./review-search-state"
import { ReviewSearchToolbar } from "./review-search-toolbar"
import type { ReviewSelectionProjection } from "./review-selection"
import type { ReviewSourceOperations } from "./use-review-source-operations"
import type { ReviewActivePane } from "./review-sidebar-layout"
import { ReviewWorkbenchLayout } from "./review-workbench-layout"
import {
  type ReviewDiffRegistration,
  ReviewViewportNavigationBridge,
} from "./review-viewport-navigation"
import { reviewThreadScope, reviewWalkthroughScope } from "./review-subject"
import { type ReviewThreadAnnotation, sameReviewThreadLine } from "./thread-annotations"
import { useReviewSnapshotPages } from "./use-review-snapshot-pages"
import { diffCardDomId, useViewedFileViewport, type ViewedFileUpdate } from "./viewed-file-viewport"

type ReviewSidebarTab = "reviews" | "tree" | "walkthrough" | "threads"

type PullRequestApprovalState = "checking" | "unapproved" | "approving" | "approved"

type ResolvedDiffViewMode = Exclude<DiffViewMode, "auto">

/** Repository-link state consumed by ready review presentation. */
export type RepositoryLinkState = "checking" | "linked" | "unlinked" | "not-applicable"

/** Application-owned dependencies required by the review feature. */
export type ReviewDetailEnvironment = {
  readonly aiAgentAvailable: boolean
  readonly aiSettings: AISettings
  readonly quickNavigationRequest: number
  readonly repositoryLinkState: RepositoryLinkState
  readonly sidebarExpanded: boolean
  readonly sidebarWidth: number
  readonly threadDetailWidth: number
  readonly colorScheme: ColorScheme
  readonly onAISettingsChange: (settings: AISettings) => void
  readonly onLinkRepository: () => Promise<boolean>
  readonly onSidebarExpandedChange: (expanded: boolean) => void
  readonly onSidebarWidthChange: (width: number) => void
  readonly onThreadDetailWidthChange: (width: number) => void
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

const REVIEW_SPLIT_DIFF_MIN_WIDTH = 1_040
const REVIEW_SPLIT_DIFF_RESTORE_MARGIN = 32

const resolveAutoDiffViewMode = (
  width: number,
  current: ResolvedDiffViewMode,
): ResolvedDiffViewMode => {
  if (width < REVIEW_SPLIT_DIFF_MIN_WIDTH) return "unified"
  if (width >= REVIEW_SPLIT_DIFF_MIN_WIDTH + REVIEW_SPLIT_DIFF_RESTORE_MARGIN) return "split"
  return current
}

const REVIEW_DIFF_OPTIONS = {
  disableFileHeader: true,
  diffStyle: "split",
  enableGutterUtility: true,
  hunkSeparators: "line-info-basic",
  lineHoverHighlight: "both",
  lineDiffType: "word",
  overflow: "wrap",
  tokenizeMaxLineLength: 2_000,
  theme: {
    dark: DEFAULT_CODE_THEME_PREFERENCES.dark,
    light: DEFAULT_CODE_THEME_PREFERENCES.light,
  },
  themeType: "light",
  unsafeCSS: `
    :host {
      --diffs-bg: var(--diff-canvas);
      --diffs-addition-color-override: var(--review-success);
      --diffs-deletion-color-override: var(--review-danger);
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

    [data-diff][data-overflow="wrap"] {
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

    [data-indicators="bars"] [data-line-type="change-addition"][data-column-number]::before,
    [data-indicators="bars"] [data-line-type="change-deletion"][data-column-number]::before {
      opacity: 0.55;
    }

    [data-separator="line-info-basic"] {
      box-shadow:
        inset 0 1px 0 var(--diff-separator-border),
        inset 0 -1px 0 var(--diff-separator-border);
    }

    [data-separator="line-info-basic"] [data-separator-content] {
      color: var(--diff-separator-foreground);
      font-weight: 500;
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

const REVIEW_DIFF_VIRTUALIZER_CONFIG = {
  intersectionObserverMargin: 1_500,
  overscrollSize: 1_000,
} as const

const REVIEW_DIFF_WORKER_POOL_OPTIONS = {
  poolSize: 1,
  totalASTLRUCacheSize: 20,
  workerFactory: createDiffsWorker,
} satisfies WorkerPoolOptions

const REVIEW_DIFF_HIGHLIGHTER_OPTIONS = {
  lineDiffType: REVIEW_DIFF_OPTIONS.lineDiffType,
  maxLineDiffLength: 1_000,
  theme: REVIEW_DIFF_OPTIONS.theme,
  tokenizeMaxLineLength: REVIEW_DIFF_OPTIONS.tokenizeMaxLineLength,
} satisfies WorkerInitializationRenderOptions

const reviewDiffHighlighterOptions = (
  codeThemes: CodeThemePreferences,
): WorkerInitializationRenderOptions => ({
  ...REVIEW_DIFF_HIGHLIGHTER_OPTIONS,
  theme: codeThemes,
})

/** Source-neutral review detail composition with its coupled ephemeral interaction state. */
export const ReviewDetailView = ({
  activeRibbon,
  environment,
  ready,
  reviewsContext,
  onActiveRibbonChange,
}: {
  readonly activeRibbon: ProjectWorkspaceRibbon
  readonly environment: ReviewDetailEnvironment
  readonly ready: ReadyReviewDetailState
  readonly reviewsContext: ReactNode
  readonly onActiveRibbonChange: (ribbon: ProjectWorkspaceRibbon) => void
}) => {
  const captureAnalytics = useCaptureAnalytics()
  const desktop = useDesktopRuntime()
  const reviewContentService = useReviewContent()
  const {
    aiAgentAvailable,
    aiSettings,
    quickNavigationRequest,
    repositoryLinkState,
    sidebarExpanded,
    sidebarWidth,
    threadDetailWidth,
    colorScheme,
    onAISettingsChange,
    onLinkRepository,
    onSidebarExpandedChange,
    onSidebarWidthChange,
    onThreadDetailWidthChange,
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
  const review = selection.review
  const manifest = review.manifest
  const reviewSnapshotAddress = ReviewSnapshotAddress.make({
    projectId: manifest.projectId,
    snapshotId: manifest.snapshotId,
  })
  const atomRegistry = useContext(RegistryContext)
  const agentProviderCatalogResult = useAtomValue(agentProviderCatalogAtom)
  const navigationPresentation = useAtomValue(reviewNavigationPresentationAtom)
  const navigationLastOutcome = useAtomValue(reviewNavigationLastOutcomeAtom)
  const navigationStatus = useAtomValue(reviewNavigationStatusAtom)
  const navigationLocked = Match.valueTags(navigationStatus, {
    active: () => true,
    idle: () => false,
  })
  const agentProviderCatalog = AsyncResult.getOrElse(
    agentProviderCatalogResult,
    () => EMPTY_AGENT_PROVIDER_CATALOG,
  )
  const diffScrollContainerRef = useRef<HTMLDivElement>(null)
  const reviewDiffContentRef = useRef<HTMLElement>(null)
  const stickyReviewChromeRef = useRef<HTMLDivElement>(null)
  const reviewSearchInputRef = useRef<HTMLInputElement>(null)
  const reviewSearchManifestRef = useRef(manifest)
  const reviewsActivityButtonRef = useRef<HTMLButtonElement>(null)
  const treeActivityButtonRef = useRef<HTMLButtonElement>(null)
  const walkthroughActivityButtonRef = useRef<HTMLButtonElement>(null)
  const threadsActivityButtonRef = useRef<HTMLButtonElement>(null)
  const threadButtonRefs = useRef<Map<ReviewThreadId, HTMLButtonElement>>(new Map())
  const previousSidebarExpandedRef = useRef(sidebarExpanded)
  const quickNavigationRequestRef = useRef(quickNavigationRequest)
  const previousReviewSearchFocusRef = useRef<HTMLElement | null>(null)
  const lastPointerPositionRef = useRef<{
    readonly clientX: number
    readonly clientY: number
  } | null>(null)
  const reviewDiffRegistrationsRef = useRef<Map<string, ReviewDiffRegistration>>(new Map())
  const reviewDiffRegistrationsByHostRef = useRef(
    new WeakMap<HTMLElement, ReviewDiffRegistration>(),
  )
  const reviewDiffResizeObserverRef = useRef<ResizeObserver | null>(null)
  const [diffVirtualizer] = useState(() => new DiffVirtualizer(REVIEW_DIFF_VIRTUALIZER_CONFIG))
  const [reviewNavigationAnchors] = useState(() => new ReviewNavigationAnchorRegistry())
  const [reviewNavigator] = useState(() => new ReviewNavigatorController(atomRegistry))
  const [reviewSearchController] = useState(() => new ReviewSearchController(atomRegistry))
  const [reviewViewportBridge] = useState(
    () => new ReviewViewportNavigationBridge(reviewNavigationAnchors),
  )
  const [autoDiffViewMode, setAutoDiffViewMode] = useState<ResolvedDiffViewMode>("split")
  const [reviewSearchHighlights] = useState(() => new ReviewSearchHighlightManager())
  const [fileFilter, setFileFilter] = useState("")
  const [navigationSelectedFileId, setNavigationSelectedFileId] = useState<ReviewFileId | null>(
    null,
  )
  const sidebarTab = projectRibbonToSidebarTab(activeRibbon)
  const setSidebarTab = (tab: ReviewSidebarTab) =>
    onActiveRibbonChange(sidebarTabToProjectRibbon(tab))
  const [walkthroughState, setWalkthroughState] = useState<WalkthroughState>({ status: "idle" })
  const [activeWalkthroughStepIndex, setActiveWalkthroughStepIndex] = useState(0)
  const [visitedWalkthroughStepIndexes, setVisitedWalkthroughStepIndexes] = useState<
    ReadonlySet<number>
  >(() => new Set())
  const [collapsedWalkthroughFileKeys, setCollapsedWalkthroughFileKeys] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const [showHiddenFiles, setShowHiddenFiles] = useState(false)
  const [goToPaletteOpen, setGoToPaletteOpen] = useState(false)
  const [actionPaletteOpen, setActionPaletteOpen] = useState(false)
  const reviewSearchToolbar = useAtomValue(reviewSearchController.toolbarAtom)
  const activeReviewSearchMatch = useAtomValue(reviewSearchController.activeMatchAtom)
  const reviewSearchOccurrences = useAtomValue(reviewSearchController.retainedMatchesAtom)
  const [fileOpenStatus, setFileOpenStatus] = useState<string | null>(null)
  const [approvalState, setApprovalState] = useState<PullRequestApprovalState>("checking")
  const [expandedLineAnchor, setExpandedLineAnchor] = useState<ReviewThreadAnchor | null>(null)
  const [threadSidebarState, setThreadSidebarState] = useState<ReviewThreadSidebarState>({
    _tag: "collapsed",
  })
  const [activePane, setActivePane] = useState<ReviewActivePane>("diff")
  const [repositoryBannerDismissed, setRepositoryBannerDismissed] = useState(false)
  const [repositoryLinking, setRepositoryLinking] = useState(false)
  const [repositoryLinkError, setRepositoryLinkError] = useState<string | null>(null)
  const [scrollPastEndHeight, setScrollPastEndHeight] = useState(0)
  const previousFileFilterRef = useRef(fileFilter)
  const reviewSearchOpen = reviewSearchToolbar.open
  const reviewSearchQuery = reviewSearchToolbar.query
  const reviewSearchTotalMatches = reviewSearchToolbar.totalMatches
  const activeReviewSearchIndex = reviewSearchToolbar.activeGlobalIndex
  reviewSearchController.updateRuntime({
    navigator: reviewNavigator,
    onSnapshotExpired: onReload,
    search: (request) => runRendererPromise(reviewContentService.snapshots.search(request)),
  })

  useEffect(() => {
    if (quickNavigationRequestRef.current === quickNavigationRequest) return
    quickNavigationRequestRef.current = quickNavigationRequest
    setGoToPaletteOpen(true)
  }, [quickNavigationRequest])

  useEffect(() => {
    const previouslyExpanded = previousSidebarExpandedRef.current
    previousSidebarExpandedRef.current = sidebarExpanded
    if (previouslyExpanded === sidebarExpanded) return
    if (!sidebarExpanded) {
      setThreadSidebarState({ _tag: "collapsed" })
      setActivePane("diff")
      return
    }
    setActivePane("context")
    if (sidebarTab === "threads") setThreadSidebarState({ _tag: "list" })
  }, [sidebarExpanded, sidebarTab])
  const {
    fileErrors,
    files: snapshotFiles,
    loadingFileIds,
    pageReader: snapshotPageReader,
    setPinnedFileIds: setPinnedSnapshotFileIds,
    snapshotRefresh,
    tooLargeFileIds,
  } = useReviewSnapshotPages(manifest, sourceOperations.refresh)
  const loadSnapshotFiles = snapshotPageReader.loadFiles
  const registerFileNavigationAnchor = useStableCallback(
    (fileId: ReviewFileId, element: HTMLElement, focusElement: HTMLElement) =>
      reviewNavigationAnchors.registerAnchor(reviewFileAnchorKey(fileId), {
        measure: () => element.getBoundingClientRect(),
        focus: () => {
          if (!element.isConnected || !focusElement.isConnected) return false
          focusElement.focus({ preventScroll: true })
          return document.activeElement === focusElement
        },
        ownsFocus: (active) => active === focusElement,
        isConnected: () => element.isConnected,
      }),
  )
  useEffect(() => {
    const releases = manifest.files.map((file) =>
      reviewNavigationAnchors.registerDescriptor({
        anchorKey: reviewFileAnchorKey(file.fileId),
        fileId: file.fileId,
      }),
    )
    return () => {
      for (const release of releases) release()
    }
  }, [manifest.files, manifest.snapshotId, reviewNavigationAnchors])
  const setDiffScrollContainer = useStableCallback<(node: HTMLDivElement | null) => void>(
    (node) => {
      diffScrollContainerRef.current = node
      if (node === null) {
        diffVirtualizer.cleanUp()
        return
      }

      const content = node.firstElementChild
      diffVirtualizer.setup(node, isHTMLElement(content) ? content : undefined)
    },
  )
  useEffect(
    () => () => {
      reviewDiffRegistrationsRef.current.clear()
      reviewDiffRegistrationsByHostRef.current = new WeakMap()
    },
    [],
  )
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (!isHTMLElement(entry.target)) continue
        const registration = reviewDiffRegistrationsByHostRef.current.get(entry.target)
        if (
          registration === undefined ||
          !registration.rendered ||
          !registration.host.isConnected
        ) {
          continue
        }

        diffVirtualizer.requestHeightReconcile(registration.instance)
      }
    })
    reviewDiffResizeObserverRef.current = observer
    for (const registration of reviewDiffRegistrationsRef.current.values()) {
      if (registration.host.isConnected) {
        observer.observe(registration.host)
      }
    }

    return () => {
      observer.disconnect()
      if (reviewDiffResizeObserverRef.current === observer) {
        reviewDiffResizeObserverRef.current = null
      }
    }
  }, [diffVirtualizer])
  useLayoutEffect(() => {
    if (aiSettings.diffViewMode !== "auto") return
    const content = reviewDiffContentRef.current
    if (content === null) return

    const updateMode = (width: number) => {
      setAutoDiffViewMode((current) => resolveAutoDiffViewMode(width, current))
    }
    updateMode(content.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry !== undefined) updateMode(entry.contentRect.width)
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [aiSettings.diffViewMode])
  useEffect(() => () => reviewSearchHighlights.dispose(), [reviewSearchHighlights])
  useEffect(() => {
    if (previousFileFilterRef.current === fileFilter) return
    previousFileFilterRef.current = fileFilter
    setNavigationSelectedFileId(null)
  }, [fileFilter])
  const reviewBaseSha = review.baseRevision
  const reviewHeadSha = review.headRevision
  const reviewIdentity = review.identity
  const reviewThreads = useReviewThreads(reviewThreadScope(review))
  const navigationTarget = navigationPresentation.activeTarget
  const navigationThreadAnchor =
    navigationTarget === null
      ? null
      : Match.valueTags(navigationTarget, {
          extension: () => null,
          file: () => null,
          hunk: () => null,
          line: () => null,
          range: () => null,
          thread: (target) =>
            reviewThreads.details.find((details) => details.thread.id === target.threadId)?.thread
              .activeAnchor ?? null,
        })
  useEffect(() => {
    const detailThreadId = Match.valueTags(threadSidebarState, {
      collapsed: () => null,
      list: () => null,
      detail: (state) => state.threadId,
    })
    if (
      Match.valueTags(threadSidebarState, {
        collapsed: () => false,
        list: () => false,
        detail: () => true,
      }) &&
      !reviewThreads.loading &&
      detailThreadId !== null &&
      !reviewThreads.details.some((details) => details.thread.id === detailThreadId)
    ) {
      setThreadSidebarState({ _tag: "list" })
    }
  }, [reviewThreads.details, reviewThreads.loading, threadSidebarState])
  const changedFiles = manifest.files
  const loadedFilesById = new Map(snapshotFiles.map((file) => [file.fileId, file]))
  const loadedChangedFiles = changedFiles.flatMap((file) => {
    const loaded = loadedFilesById.get(file.fileId)
    return loaded === undefined ? [] : [loaded]
  })
  const normalizedReviewSearchIndex = activeReviewSearchIndex
  const activeReviewSearchOccurrence = reviewSearchOpen ? activeReviewSearchMatch : null
  const hiddenFileCount = changedFiles.filter((file) =>
    DiffFileVisibility.guards.Hidden(file.visibility),
  ).length
  const visibleBaseFiles = showHiddenFiles
    ? changedFiles
    : changedFiles.filter((file) => DiffFileVisibility.guards.Visible(file.visibility))
  const normalizedFileFilter = fileFilter.trim().toLowerCase()
  const filteredChangedFiles =
    normalizedFileFilter.length === 0
      ? visibleBaseFiles
      : visibleBaseFiles.filter((file) => matchesReviewFileFilter(file, normalizedFileFilter))
  const navigationSelectedPath =
    navigationPresentation.selectedFileId === null
      ? null
      : (changedFiles.find((file) => file.fileId === navigationPresentation.selectedFileId)?.path ??
        null)
  const selectedVisiblePath =
    navigationSelectedPath ??
    (selectedPath !== null && visibleBaseFiles.some((file) => file.path === selectedPath)
      ? selectedPath
      : (visibleBaseFiles[0]?.path ?? null))
  const selectedTreePath =
    navigationSelectedPath !== null &&
    filteredChangedFiles.some((file) => file.path === navigationSelectedPath)
      ? navigationSelectedPath
      : selectedPath !== null && filteredChangedFiles.some((file) => file.path === selectedPath)
        ? selectedPath
        : null
  const totalAdditions = changedFiles.reduce((total, file) => total + file.additions, 0)
  const totalDeletions = changedFiles.reduce((total, file) => total + file.deletions, 0)
  const activeStoredWalkthrough =
    walkthroughState.status === "ready" ? walkthroughState.stored : null
  const activeWalkthrough =
    activeStoredWalkthrough === null ? null : activeStoredWalkthrough.walkthrough
  const walkthroughScope = reviewWalkthroughScope(review, activeStoredWalkthrough)
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
  const forcedVisibleFileIds = new Set(navigationPresentation.forceVisibleFileIds)
  if (sidebarTab !== "walkthrough" && navigationSelectedFileId !== null) {
    forcedVisibleFileIds.add(navigationSelectedFileId)
  }
  const renderedChangedFiles =
    (activeSearchReviewKey === null ||
      visibleChangedFiles.some((file) => file.reviewKey === activeSearchReviewKey)) &&
    forcedVisibleFileIds.size === 0
      ? visibleChangedFiles
      : (() => {
          const visibleReviewKeys = new Set(visibleChangedFiles.map((file) => file.reviewKey))
          return changedFiles.filter(
            (file) =>
              file.reviewKey === activeSearchReviewKey ||
              forcedVisibleFileIds.has(file.fileId) ||
              visibleReviewKeys.has(file.reviewKey),
          )
        })()
  const lastRenderedFileId = renderedChangedFiles.at(-1)?.fileId ?? null
  useLayoutEffect(() => {
    const container = diffScrollContainerRef.current
    const stickyChrome = stickyReviewChromeRef.current
    const content = reviewDiffContentRef.current
    if (container === null || stickyChrome === null || content === null) return undefined
    let previousStickyHeight = -1
    const update = () => {
      const stickyHeight = stickyChrome.offsetHeight
      container.style.setProperty("--review-sticky-chrome-height", `${stickyHeight}px`)
      if (stickyHeight !== previousStickyHeight) {
        previousStickyHeight = stickyHeight
        diffVirtualizer.markDOMDirty()
        for (const registration of reviewDiffRegistrationsRef.current.values()) {
          if (!registration.host.isConnected) continue
          registration.instance.syncVirtualizedTop()
          diffVirtualizer.requestHeightReconcile(registration.instance)
        }
      }
      const cards = content.querySelectorAll<HTMLElement>("[data-review-file-id]")
      const lastCard = cards.item(cards.length - 1)
      if (lastCard === null) {
        setScrollPastEndHeight(0)
        return
      }
      const trailingContentHeight = Math.max(
        0,
        content.getBoundingClientRect().bottom - lastCard.getBoundingClientRect().top,
      )
      setScrollPastEndHeight(
        Math.max(0, container.clientHeight - stickyChrome.offsetHeight - trailingContentHeight),
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(container)
    observer.observe(stickyChrome)
    observer.observe(content)
    const cards = content.querySelectorAll<HTMLElement>("[data-review-file-id]")
    const lastCard = cards.item(cards.length - 1)
    if (lastCard !== null) observer.observe(lastCard)
    return () => {
      observer.disconnect()
      container.style.removeProperty("--review-sticky-chrome-height")
    }
  }, [diffVirtualizer, lastRenderedFileId])
  const activeStepComplete =
    activeWalkthroughStep !== null &&
    activeStepFiles.length > 0 &&
    activeStepFiles.every((file) => viewedFileKeys.has(file.reviewKey))
  const resolvedDiffViewMode =
    aiSettings.diffViewMode === "auto" ? autoDiffViewMode : aiSettings.diffViewMode
  const reviewDiffOptions: FileDiffOptions<ReviewThreadAnnotation> = {
    ...REVIEW_DIFF_OPTIONS,
    diffStyle: resolvedDiffViewMode,
    theme: aiSettings.codeThemes,
    themeType: colorScheme,
  }
  const previousResolvedDiffViewModeRef = useRef(resolvedDiffViewMode)
  useEffect(() => {
    const previousMode = previousResolvedDiffViewModeRef.current
    previousResolvedDiffViewModeRef.current = resolvedDiffViewMode
    if (previousMode === resolvedDiffViewMode) return

    const frame = window.requestAnimationFrame(() => {
      diffVirtualizer.markDOMDirty()
      for (const registration of reviewDiffRegistrationsRef.current.values()) {
        if (!registration.host.isConnected) continue
        registration.instance.syncVirtualizedTop()
        diffVirtualizer.requestHeightReconcile(registration.instance)
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [diffVirtualizer, resolvedDiffViewMode])
  const navigableThreadIds = new Set<ReviewThreadId>(
    reviewThreads.details.flatMap((details) => {
      const anchor = details.thread.activeAnchor
      return anchor !== null &&
        changedFiles.some((file) => file.fileId === anchor.fileId && file.path === anchor.filePath)
        ? [details.thread.id]
        : []
    }),
  )
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
  const selectedFileId =
    selectedPath === null
      ? null
      : (changedFiles.find((file) => file.path === selectedPath)?.fileId ?? null)
  useEffect(() => {
    const pinnedFileIds = new Set<ReviewFileId>()
    if (selectedFileId !== null) pinnedFileIds.add(selectedFileId)
    if (activeReviewSearchOccurrence !== null) {
      pinnedFileIds.add(activeReviewSearchOccurrence.fileId)
    }
    if (expandedLineAnchor !== null) pinnedFileIds.add(expandedLineAnchor.fileId)
    for (const fileId of navigationPresentation.pinnedFileIds) pinnedFileIds.add(fileId)
    setPinnedSnapshotFileIds(pinnedFileIds)
  }, [
    activeReviewSearchOccurrence,
    expandedLineAnchor,
    selectedFileId,
    setPinnedSnapshotFileIds,
    navigationPresentation.pinnedFileIds,
  ])
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
  const moveReviewSearch = useStableCallback((direction: -1 | 1) => {
    reviewSearchController.move(direction)
  })
  const updateReviewSearchQuery = useStableCallback((query: string) => {
    const anchor =
      query.length === 0
        ? captureReviewSearchAnchor(
            diffScrollContainerRef.current,
            stickyReviewChromeRef.current,
            lastPointerPositionRef.current,
            changedFiles,
          )
        : undefined
    reviewSearchController.setQuery(query, anchor)
  })
  const focusReviewSearch = useStableCallback(() => {
    window.requestAnimationFrame(() => {
      reviewSearchInputRef.current?.focus()
      reviewSearchInputRef.current?.select()
    })
  })
  const openReviewSearch = useStableCallback(() => {
    if (reviewSearchOpen) {
      focusReviewSearch()
      return
    }
    if (!reviewSearchOpen && isHTMLElement(document.activeElement)) {
      previousReviewSearchFocusRef.current = document.activeElement
    }
    reviewSearchController.open(
      captureReviewSearchAnchor(
        diffScrollContainerRef.current,
        stickyReviewChromeRef.current,
        lastPointerPositionRef.current,
        changedFiles,
      ),
    )
    setGoToPaletteOpen(false)
    setActionPaletteOpen(false)
    focusReviewSearch()
  })
  const closeReviewSearch = useStableCallback(() => {
    reviewSearchController.close()
    const previousFocus = previousReviewSearchFocusRef.current
    previousReviewSearchFocusRef.current = null
    window.requestAnimationFrame(() => {
      if (previousFocus?.isConnected === true) previousFocus.focus()
    })
  })
  const requestReviewDiffReconciliation = useStableCallback((reviewKey: string) => {
    const registration = reviewDiffRegistrationsRef.current.get(reviewKey)
    if (registration === undefined || !registration.host.isConnected) {
      return null
    }

    registration.instance.syncVirtualizedTop()
    diffVirtualizer.markDOMDirty()
    diffVirtualizer.requestHeightReconcile(registration.instance)
    registration.instance.rerender()
    return registration.generation
  })
  const cancelFileNavigation = useStableCallback(() => {
    reviewNavigator.cancelActive()
  })
  const submitFileNavigation = useStableCallback(
    (file: ReviewSnapshotFileInventory, origin: "file-tree" | "walkthrough" | "command") => {
      void reviewNavigator.navigate(
        ReviewNavigationInput.make({
          location: ReviewLocationV1.make({
            version: 1,
            snapshot: reviewSnapshotAddress,
            target: FileReviewNavigationTarget.make({ fileId: file.fileId }),
          }),
          behavior: ReviewNavigationBehavior.make({
            alignment: "start",
            focus: "preserve",
            selection: "update",
            visibility: "temporarily-reveal",
          }),
          origin,
        }),
      )
    },
  )
  const submitThreadNavigation = useStableCallback((threadId: ReviewThreadId) => {
    void reviewNavigator.navigate(
      ReviewNavigationInput.make({
        location: ReviewLocationV1.make({
          version: 1,
          snapshot: reviewSnapshotAddress,
          target: ThreadReviewNavigationTarget.make({ threadId }),
        }),
        behavior: ReviewNavigationBehavior.make({
          alignment: "center",
          focus: "target",
          selection: "update",
          visibility: "temporarily-reveal",
        }),
        origin: "thread-detail",
      }),
    )
  })
  const prepareNavigationFile = useStableCallback(
    (file: ReviewSnapshotFileInventory, input: ReviewNavigationInput) => {
      if (input.behavior.selection === "update") onSelectPath(file.path)
      if (input.behavior.selection === "update") setNavigationSelectedFileId(file.fileId)
      setActivePane("diff")
      if (input.origin === "thread-detail") {
        setThreadSidebarState({ _tag: "collapsed" })
        setSidebarTab("tree")
        onSidebarExpandedChange(true)
      }
    },
  )
  reviewViewportBridge.update({
    manifest,
    containerRef: diffScrollContainerRef,
    stickyChromeRef: stickyReviewChromeRef,
    pages: snapshotPageReader,
    diffRegistrations: reviewDiffRegistrationsRef.current,
    diffVirtualizer,
    searchHighlights: reviewSearchHighlights,
    searchOccurrences: reviewSearchOccurrences,
    threads: reviewThreads.details,
    requestReconciliation: requestReviewDiffReconciliation,
    prepareFile: prepareNavigationFile,
    activateWindow: () => runRendererPromise(desktop.navigation.activateWindow()),
  })
  const navigationDisposeTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (navigationDisposeTimerRef.current !== null) {
      window.clearTimeout(navigationDisposeTimerRef.current)
      navigationDisposeTimerRef.current = null
    }
    reviewNavigator.attach(
      { projectId: manifest.projectId, snapshotId: manifest.snapshotId },
      reviewViewportBridge,
    )
    return () => {
      reviewNavigator.detach("review-loading")
      navigationDisposeTimerRef.current = window.setTimeout(() => {
        reviewNavigator.dispose()
        reviewNavigationAnchors.dispose()
      }, 0)
    }
  }, [
    manifest.projectId,
    manifest.snapshotId,
    reviewNavigationAnchors,
    reviewNavigator,
    reviewViewportBridge,
  ])
  const reviewSearchDisposeTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (reviewSearchDisposeTimerRef.current !== null) {
      window.clearTimeout(reviewSearchDisposeTimerRef.current)
      reviewSearchDisposeTimerRef.current = null
    }
    reviewSearchController.attach(
      ReviewSnapshotAddress.make({
        projectId: manifest.projectId,
        snapshotId: manifest.snapshotId,
      }),
    )
    return () => {
      reviewSearchController.detach()
      reviewSearchDisposeTimerRef.current = window.setTimeout(() => {
        reviewSearchController.dispose()
      }, 0)
    }
  }, [reviewSearchController, manifest.projectId, manifest.snapshotId])
  useEffect(() => {
    const previous = reviewSearchManifestRef.current
    reviewSearchManifestRef.current = manifest
    if (
      previous === manifest ||
      previous.projectId !== manifest.projectId ||
      previous.snapshotId !== manifest.snapshotId
    ) {
      return
    }
    reviewSearchController.attach(
      ReviewSnapshotAddress.make({
        projectId: manifest.projectId,
        snapshotId: manifest.snapshotId,
      }),
    )
  }, [manifest, reviewSearchController])
  useEffect(() => {
    if (!navigationLocked) return undefined
    const container = diffScrollContainerRef.current
    if (container === null) return undefined
    const preventViewportInput = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
    }
    container.addEventListener("wheel", preventViewportInput, { passive: false })
    container.addEventListener("touchmove", preventViewportInput, { passive: false })
    return () => {
      container.removeEventListener("wheel", preventViewportInput)
      container.removeEventListener("touchmove", preventViewportInput)
    }
  }, [navigationLocked])
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
  const handleDiffRendered = useStableCallback<
    (reviewKey: string, node: HTMLElement, instance: object, phase: PostRenderPhase) => void
  >((reviewKey, node, instance, phase) => {
    if (isVirtualizedFileDiff<TransportError>(instance)) {
      const previous = reviewDiffRegistrationsRef.current.get(reviewKey)
      if (previous !== undefined && previous.host !== node) {
        reviewDiffResizeObserverRef.current?.unobserve(previous.host)
        reviewDiffRegistrationsByHostRef.current.delete(previous.host)
      }
      const registration = {
        generation:
          previous?.host === node && previous.instance === instance ? previous.generation + 1 : 1,
        host: node,
        instance,
        rendered: phase !== "unmount",
      } satisfies ReviewDiffRegistration
      reviewDiffRegistrationsRef.current.set(reviewKey, registration)
      reviewDiffRegistrationsByHostRef.current.set(node, registration)
      if (phase === "unmount") {
        queueMicrotask(() => {
          const current = reviewDiffRegistrationsRef.current.get(reviewKey)
          if (current?.host === node && !node.isConnected) {
            reviewDiffResizeObserverRef.current?.unobserve(node)
            reviewDiffRegistrationsRef.current.delete(reviewKey)
            reviewDiffRegistrationsByHostRef.current.delete(node)
          }
        })
      } else {
        reviewDiffResizeObserverRef.current?.observe(node)
      }
    }
    reviewSearchHighlights.handlePostRender(reviewKey, node, instance, phase)
    handleViewedDiffRendered(reviewKey, phase)
  })
  useEffect(() => {
    lastPointerPositionRef.current = null
    for (const registration of reviewDiffRegistrationsRef.current.values()) {
      reviewDiffResizeObserverRef.current?.unobserve(registration.host)
    }
    reviewDiffRegistrationsRef.current.clear()
    reviewDiffRegistrationsByHostRef.current = new WeakMap()
    reviewNavigator.cancelActive()
    onSidebarExpandedChange(true)
    setWalkthroughState({ status: "idle" })
    setActiveWalkthroughStepIndex(0)
    setVisitedWalkthroughStepIndexes(new Set())
    setCollapsedWalkthroughFileKeys(new Set())
    setShowHiddenFiles(false)
    setGoToPaletteOpen(false)
    setActionPaletteOpen(false)
    setNavigationSelectedFileId(null)
    setExpandedLineAnchor(null)
    setThreadSidebarState({ _tag: "collapsed" })
    setRepositoryBannerDismissed(false)
    setRepositoryLinking(false)
    setRepositoryLinkError(null)
    setApprovalState("checking")
  }, [onSidebarExpandedChange, reviewBaseSha, reviewHeadSha, reviewIdentity, reviewNavigator])

  useEffect(() => {
    if (
      Match.valueTags(sourceOperations.decision, {
        supported: () => false,
        unsupported: () => true,
      })
    ) {
      setApprovalState("unapproved")
      return undefined
    }

    const decisionOperations = Match.valueTags(sourceOperations.decision, {
      supported: (operations) => operations,
      unsupported: () => null,
    })
    if (decisionOperations === null) return undefined
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
      if (navigationLocked && key === "escape") {
        event.preventDefault()
        event.stopPropagation()
        if (reviewSearchOpen) closeReviewSearch()
        else {
          setGoToPaletteOpen(false)
          setActionPaletteOpen(false)
          reviewNavigator.cancelForUser()
        }
        return
      }
      if (
        Match.valueTags(threadSidebarState, {
          collapsed: () => false,
          list: () => false,
          detail: () => true,
        })
      )
        return
      if (navigationLocked && isViewportScrollKey(key) && !isEditableTarget(event.target)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (
        key === "escape" &&
        Match.valueTags(threadSidebarState, {
          collapsed: () => false,
          list: () => true,
          detail: () => false,
        })
      ) {
        event.preventDefault()
        event.stopPropagation()
        setThreadSidebarState({ _tag: "collapsed" })
        onSidebarExpandedChange(false)
        setActivePane("diff")
        window.requestAnimationFrame(() => threadsActivityButtonRef.current?.focus())
        return
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

      const activePath = reviewActiveCard(
        diffScrollContainerRef.current,
        stickyReviewChromeRef.current,
        lastPointerPositionRef.current,
      )?.dataset.diffCardPath
      const file =
        visibleChangedFiles.find((changedFile) => changedFile.path === activePath) ??
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
    navigationLocked,
    onSidebarExpandedChange,
    openReviewSearch,
    reviewSearchOpen,
    selectedVisiblePath,
    setViewedPreservingViewport,
    threadSidebarState,
    reviewNavigator,
    viewedFileKeys,
    visibleChangedFiles,
  ])

  const loadWalkthrough = async (regenerate: boolean) => {
    if (changedFiles.length === 0) {
      setWalkthroughState({
        status: "empty",
        message: "This review has no reviewable file changes.",
      })
      return
    }
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
        status: "unavailable",
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
        const storedWalkthroughScope = reviewWalkthroughScope(review, stored)
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
        reviewType: Match.valueTags(review, {
          hosted: () => "pull_request" as const,
          local: () => "local_diff" as const,
          repositoryComparison: () => "repository_comparison" as const,
        }),
        regenerated: regenerate,
        provider: selectedProvider(agentSelection(aiSettings, "walkthrough")),
      })
    } catch (error) {
      const presentation = walkthroughErrorPresentation(error, {
        action: regenerate ? "regenerate" : "generate",
        appVersion: import.meta.env.VITE_APP_VERSION,
        model: selectedAIModelLabel(aiSettings, agentProviderCatalog),
        occurredAt: new Date().toISOString(),
        platform: window.navigator.platform,
        provider: aiProviderLabel(agentSelection(aiSettings, "walkthrough"), agentProviderCatalog),
        reviewSource: sourceOperations.source,
      })
      setWalkthroughState({ status: "error", ...presentation })
    }
  }

  const loadActiveWalkthrough = useEffectEvent(loadWalkthrough)
  useEffect(() => {
    if (sidebarTab === "walkthrough" && walkthroughState.status === "idle") {
      void loadActiveWalkthrough(false)
    }
  }, [sidebarTab, walkthroughState.status])

  const selectSidebarTab = (tab: ReviewSidebarTab) => {
    setSidebarTab(tab)
    onSidebarExpandedChange(true)
    setActivePane("context")
    setThreadSidebarState(tab === "threads" ? { _tag: "list" } : { _tag: "collapsed" })
  }
  const toggleSidebarTab = (tab: ReviewSidebarTab, placement: "rail" | "bottom") => {
    if (placement === "bottom" && tab === sidebarTab && activePane === "thread-detail") {
      setActivePane("diff")
      return
    }
    if (
      tab === sidebarTab &&
      sidebarExpanded &&
      (placement === "rail" || activePane === "context")
    ) {
      setThreadSidebarState({ _tag: "collapsed" })
      onSidebarExpandedChange(false)
      setActivePane("diff")
      return
    }
    selectSidebarTab(tab)
  }
  const focusActiveSidebarTab = () => {
    const button =
      sidebarTab === "reviews"
        ? reviewsActivityButtonRef.current
        : sidebarTab === "tree"
          ? treeActivityButtonRef.current
          : sidebarTab === "walkthrough"
            ? walkthroughActivityButtonRef.current
            : threadsActivityButtonRef.current
    window.requestAnimationFrame(() => button?.focus())
  }
  const updateThreadSidebarState = (state: ReviewThreadSidebarState) => {
    setThreadSidebarState(state)
    Match.valueTags(state, {
      collapsed: () => {
        cancelFileNavigation()
        onSidebarExpandedChange(false)
        setActivePane("diff")
        focusActiveSidebarTab()
      },
      detail: () => {
        setSidebarTab("threads")
        onSidebarExpandedChange(true)
        setActivePane("thread-detail")
      },
      list: () => {
        setSidebarTab("threads")
        onSidebarExpandedChange(true)
        setActivePane("context")
      },
    })
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
    selectSidebarTab("tree")
    setFileFilter("")
    setActivePane("diff")
    submitFileNavigation(file, "command")
  }
  const goToReviewThread = (details: ReviewThreadDetails) => {
    const anchor = details.thread.activeAnchor
    if (anchor === null) return
    const file = changedFiles.find(
      (candidate) => candidate.fileId === anchor.fileId && candidate.path === anchor.filePath,
    )
    if (file === undefined) return

    setExpandedLineAnchor(anchor)
    submitThreadNavigation(details.thread.id)
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
  const openReviewThreadDetail = (details: ReviewThreadDetails) => {
    setSidebarTab("threads")
    onSidebarExpandedChange(true)
    setThreadSidebarState({ _tag: "detail", threadId: details.thread.id })
    setActivePane("thread-detail")
  }
  const reviewGoToItems = reviewGoToPaletteItems({
    files: changedFiles,
    mode: sidebarTab === "walkthrough" ? "walkthrough" : "tree",
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
    approvalState: Match.valueTags(sourceOperations.decision, {
      supported: () => approvalState,
      unsupported: () => null,
    }),
    showHiddenFiles,
    walkthroughLoading: walkthroughState.status === "loading",
  })
  const toggleVisibleDiffCard = (reviewKey: string) => {
    const container = diffScrollContainerRef.current
    const stickyChrome = stickyReviewChromeRef.current
    const card = document.getElementById(diffCardDomId(reviewKey))
    if (container !== null && stickyChrome !== null && card !== null) {
      const visibleTop = container.getBoundingClientRect().top + stickyChrome.offsetHeight
      const cardRect = card.getBoundingClientRect()
      if (cardRect.top < visibleTop && cardRect.bottom > visibleTop) {
        const requested = container.scrollTop + cardRect.top - visibleTop
        const max = Math.max(0, container.scrollHeight - container.clientHeight)
        container.scrollTop = Math.min(Math.max(0, requested), max)
        container.dispatchEvent(new Event("scroll"))
      }
    }

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
    setActivePane("diff")
    const inventoryFile = changedFiles.find((candidate) => candidate.fileId === file.fileId)
    if (inventoryFile !== undefined) submitFileNavigation(inventoryFile, "walkthrough")
  }
  const selectPathAndScroll = (path: string) => {
    setActivePane("diff")
    const file = changedFiles.find((changedFile) => changedFile.path === path)
    if (file !== undefined) submitFileNavigation(file, "file-tree")
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
    const decisionOperations = Match.valueTags(sourceOperations.decision, {
      supported: (operations) => operations,
      unsupported: () => null,
    })
    const hostedReview = Match.valueTags(review, {
      hosted: (review) => review,
      local: () => null,
      repositoryComparison: () => null,
    })
    if (decisionOperations === null || hostedReview === null) return
    if (approvalState === "approved" || approvalState === "approving") return

    const pullRequest = hostedReview.manifest.detail.summary
    setApprovalState("approving")
    setFileOpenStatus(`Approving review #${pullRequest.locator.number}...`)
    try {
      await decisionOperations.approve()
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
    Match.valueTags(review, {
      hosted: () => true,
      local: () => false,
      repositoryComparison: () => false,
    }) &&
    repositoryLinkState === "unlinked" &&
    !repositoryBannerDismissed
  const reviewContent = (
    <>
      <ReviewWorkbenchLayout
        activePane={activePane}
        detailOpen={Match.valueTags(threadSidebarState, {
          collapsed: () => false,
          list: () => false,
          detail: () => true,
        })}
        preferences={{ contextWidth: sidebarWidth, threadDetailWidth }}
        sidebarRequestedOpen={sidebarExpanded}
        onContextCollapsedByUser={() => onSidebarExpandedChange(false)}
        onContextWidthCommit={onSidebarWidthChange}
        onDetailCollapsedByUser={() => updateThreadSidebarState({ _tag: "list" })}
        onDetailWidthCommit={onThreadDetailWidthChange}
        renderActivityNavigation={(placement) => (
          <ProjectActivityNavigation
            activeRibbon={activeRibbon}
            buttonRefs={{
              reviews: reviewsActivityButtonRef,
              files: treeActivityButtonRef,
              walkthrough: walkthroughActivityButtonRef,
              threads: threadsActivityButtonRef,
            }}
            placement={placement}
            sidebarExpanded={sidebarExpanded && (placement === "rail" || activePane === "context")}
            onSelect={(ribbon) => toggleSidebarTab(projectRibbonToSidebarTab(ribbon), placement)}
          />
        )}
        context={
          sidebarExpanded ? (
            sidebarTab === "reviews" ? (
              reviewsContext
            ) : sidebarTab === "threads" ? (
              <ReviewThreadListPane
                buttonRefs={threadButtonRefs}
                controller={reviewThreads}
                navigableThreadIds={navigableThreadIds}
                state={threadSidebarState}
                onCollapse={() => updateThreadSidebarState({ _tag: "collapsed" })}
                onOpenDetail={(threadId) => updateThreadSidebarState({ _tag: "detail", threadId })}
              >
                <WalkthroughSettingsMenu
                  catalog={agentProviderCatalog}
                  settings={aiSettings}
                  onChange={onAISettingsChange}
                />
              </ReviewThreadListPane>
            ) : (
              <aside
                data-review-context-panel
                className="bg-review-sidebar text-review-sidebar-fg relative z-20 flex h-full min-h-0 min-w-0 flex-col"
              >
                <header
                  data-review-context-header
                  className="border-review-sidebar-divider flex h-9 shrink-0 items-center gap-2 border-b px-3"
                >
                  <h2 className="text-caption min-w-0 flex-1 truncate font-semibold tracking-wide uppercase">
                    {sidebarTab === "walkthrough" ? "Walkthrough" : "Files"}
                  </h2>
                  {sidebarTab === "walkthrough" ? (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Refresh walkthrough"
                      title="Refresh walkthrough"
                      className="text-review-sidebar-muted hover:bg-review-sidebar-control-hover hover:text-review-sidebar-fg"
                      disabled={walkthroughState.status === "loading"}
                      onClick={() => void loadWalkthrough(true)}
                    >
                      <RefreshCw
                        className={`size-3 ${walkthroughState.status === "loading" ? "animate-spin" : ""}`}
                      />
                    </Button>
                  ) : null}
                  <WalkthroughSettingsMenu
                    catalog={agentProviderCatalog}
                    settings={aiSettings}
                    onChange={onAISettingsChange}
                  />
                </header>

                <div className="bg-review-sidebar-control/20 space-y-2 p-3">
                  <Input
                    value={fileFilter}
                    onChange={(event) => setFileFilter(event.currentTarget.value)}
                    className="border-review-sidebar-divider bg-review-sidebar-control text-review-sidebar-fg placeholder:text-review-sidebar-muted h-8 text-xs"
                    placeholder="Filter files"
                  />
                  {sidebarTab === "walkthrough" ? (
                    <div className="text-caption text-review-sidebar-muted min-w-0 truncate">
                      {aiProviderLabel(
                        agentSelection(aiSettings, "walkthrough"),
                        agentProviderCatalog,
                      )}{" "}
                      / {selectedAIModelLabel(aiSettings, agentProviderCatalog)}
                    </div>
                  ) : null}
                  {sidebarTab === "walkthrough" && !aiAgentAvailable ? (
                    <p className="text-caption text-review-sidebar-muted leading-4">
                      {CODING_AGENT_SETUP_MESSAGE}
                    </p>
                  ) : null}
                  {sidebarTab === "walkthrough" &&
                  agentUnavailableReason(
                    agentSelection(aiSettings, "walkthrough"),
                    agentProviderCatalog,
                    "walkthrough",
                  ) !== null ? (
                    <p className="text-caption text-review-sidebar-muted leading-4">
                      {agentUnavailableReason(
                        agentSelection(aiSettings, "walkthrough"),
                        agentProviderCatalog,
                        "walkthrough",
                      )}
                    </p>
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
                    {hiddenFileCount > 0 && !showHiddenFiles
                      ? `${hiddenFileCount} hidden`
                      : "Total"}
                  </span>
                  <span>
                    <span className="text-review-success-text">+{totalAdditions}</span>{" "}
                    <span className="text-review-danger-text">-{totalDeletions}</span>
                  </span>
                </div>
              </aside>
            )
          ) : null
        }
        detail={
          <ReviewThreadDetailPane
            buttonRefs={threadButtonRefs}
            controller={reviewThreads}
            navigableThreadIds={navigableThreadIds}
            state={threadSidebarState}
            onClose={() => updateThreadSidebarState({ _tag: "list" })}
            onGoToDiff={goToReviewThread}
          />
        }
        diff={
          <div
            ref={setDiffScrollContainer}
            data-review-diff-scroll-container
            data-review-navigation-outcome={
              navigationLastOutcome === null
                ? undefined
                : Match.valueTags(navigationLastOutcome, {
                    cancelled: (outcome) => `cancelled:${outcome.reason}:`,
                    completed: () => "completed::",
                    failed: (outcome) => `failed:${outcome.reason}:${outcome.phase}`,
                    superseded: () => "superseded::",
                    unavailable: (outcome) => `unavailable:${outcome.reason}:`,
                  })
            }
            data-review-navigation-phase={Match.valueTags(navigationStatus, {
              active: (status) => status.phase,
              idle: () => "idle",
            })}
            data-code-theme-light={aiSettings.codeThemes.light}
            data-code-theme-dark={aiSettings.codeThemes.dark}
            data-color-scheme={colorScheme}
            data-review-navigation-locked={navigationLocked ? "" : undefined}
            aria-busy={navigationLocked}
            style={{
              overflowAnchor: "none",
              overflowY: navigationLocked ? "hidden" : "auto",
              scrollbarGutter: "stable",
            }}
            className="bg-workspace-canvas h-full min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
            onPointerMove={(event) => {
              lastPointerPositionRef.current = { clientX: event.clientX, clientY: event.clientY }
            }}
            onPointerLeave={() => {
              lastPointerPositionRef.current = null
            }}
          >
            <div className="min-h-full">
              <div
                ref={stickyReviewChromeRef}
                data-review-sticky-chrome
                className="bg-workspace-canvas/95 sticky top-0 z-30 backdrop-blur"
              >
                <div
                  data-review-editor-header
                  className="bg-card/90 border-review-sidebar-border flex h-9 items-center gap-3 border-b px-3"
                >
                  <div className="text-muted-foreground flex min-w-0 flex-1 items-center gap-2 text-xs">
                    {Match.valueTags(review, {
                      hosted: () => <GitPullRequest className="text-primary size-3.5 shrink-0" />,
                      local: () => <GitBranch className="text-primary size-3.5 shrink-0" />,
                      repositoryComparison: () => (
                        <GitBranch className="text-primary size-3.5 shrink-0" />
                      ),
                    })}
                    {Match.valueTags(review, {
                      hosted: (review) => (
                        <span className="shrink-0 font-medium">
                          #{review.manifest.detail.summary.locator.number}
                        </span>
                      ),
                      local: (review) => (
                        <span
                          className="max-w-56 shrink-0 truncate font-medium"
                          title={
                            review.manifest.detail.branchName === null
                              ? "Local"
                              : `Local (${review.manifest.detail.branchName})`
                          }
                        >
                          {review.manifest.detail.branchName === null
                            ? "Local"
                            : `Local (${review.manifest.detail.branchName})`}
                        </span>
                      ),
                      repositoryComparison: (review) => (
                        <span className="max-w-56 shrink-0 truncate font-medium">
                          {review.target.baseRef}...
                          {review.target.headRef}
                        </span>
                      ),
                    })}
                    <span className="text-foreground min-w-0 truncate" title={review.title}>
                      {review.title}
                    </span>
                  </div>
                  <DiffViewSettingsMenu settings={aiSettings} onChange={onAISettingsChange} />
                </div>
                <div className="sr-only" aria-live="polite">
                  {operationError ?? fileOpenStatus ?? status}
                </div>
                {operationError === null ? null : (
                  <div
                    role="alert"
                    className="border-destructive/25 bg-destructive/10 text-destructive border-b px-4 py-2 text-xs"
                  >
                    {operationError}
                  </div>
                )}
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

              <main
                ref={reviewDiffContentRef}
                data-review-diff-content
                className="mx-auto max-w-review-diff space-y-4 px-5 py-4"
              >
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
                {normalizedFileFilter.length === 0 && renderedChangedFiles.length === 0 ? (
                  <EmptyState>
                    <div className="space-y-3">
                      <p>No changed files in this review.</p>
                      <Button variant="outline" onClick={() => onActiveRibbonChange("reviews")}>
                        Choose another review
                      </Button>
                    </div>
                  </EmptyState>
                ) : null}
                {normalizedFileFilter.length > 0 && renderedChangedFiles.length === 0 ? (
                  <EmptyState>No files match this filter.</EmptyState>
                ) : null}
                {renderedChangedFiles.map((file) => {
                  const parsedFile = loadedFilesById.get(file.fileId)
                  return parsedFile === undefined ? (
                    <ReviewPagePlaceholder
                      key={file.reviewKey}
                      error={fileErrors.get(file.fileId) ?? null}
                      file={file}
                      loading={loadingFileIds.has(file.fileId)}
                      scrollContainerRef={diffScrollContainerRef}
                      snapshotRefresh={snapshotRefresh}
                      tooLarge={tooLargeFileIds.has(file.fileId)}
                      onFileAnchorChange={(element, focusElement) =>
                        registerFileNavigationAnchor(file.fileId, element, focusElement)
                      }
                      onRetry={() => void loadSnapshotFiles([file.fileId])}
                      onRefresh={onReload}
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
                      expandedLineAnchor={navigationThreadAnchor ?? expandedLineAnchor}
                      file={parsedFile}
                      forceExpanded={
                        activeSearchReviewKey === file.reviewKey ||
                        expandedLineAnchor?.fileId === file.fileId ||
                        navigationPresentation.forceExpandedFileIds.includes(file.fileId)
                      }
                      reviewThreads={reviewThreads}
                      selected={
                        activeSearchReviewKey === file.reviewKey ||
                        selectedVisiblePath === file.path
                      }
                      viewed={viewedFileKeys.has(file.reviewKey)}
                      onDiffRendered={(node, instance, phase) =>
                        handleDiffRendered(file.reviewKey, node, instance, phase)
                      }
                      onFileAnchorChange={(element, focusElement) =>
                        registerFileNavigationAnchor(file.fileId, element, focusElement)
                      }
                      onOpenFile={() => void openRepositoryFile(file.path)}
                      onOpenThread={openReviewThreadDetail}
                      onSelect={() => selectPathAndScroll(file.path)}
                      onSetViewed={(viewed) => setViewedPreservingViewport(file.reviewKey, viewed)}
                      onToggleLine={toggleExpandedLine}
                      onToggleExpanded={() => toggleVisibleDiffCard(file.reviewKey)}
                    />
                  )
                })}
              </main>
              <div
                data-review-scroll-past-end
                aria-hidden="true"
                style={{ height: scrollPastEndHeight }}
              />
            </div>
          </div>
        }
      />
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
      <WorkbenchContextActions>
        <ReviewActionsMenu items={reviewActionItems} />
      </WorkbenchContextActions>
    </>
  )

  return (
    <WorkerPoolContextProvider
      highlighterOptions={reviewDiffHighlighterOptions(aiSettings.codeThemes)}
      poolOptions={REVIEW_DIFF_WORKER_POOL_OPTIONS}
    >
      <ReviewDiffThemeSync codeThemes={aiSettings.codeThemes} />
      <VirtualizerContext.Provider value={diffVirtualizer}>
        {reviewContent}
      </VirtualizerContext.Provider>
    </WorkerPoolContextProvider>
  )
}

const ReviewDiffThemeSync = ({ codeThemes }: { readonly codeThemes: CodeThemePreferences }) => {
  const workerPool = useWorkerPool()

  useEffect(() => {
    if (workerPool === undefined) return
    void workerPool.setRenderOptions({ theme: codeThemes }).catch(() => undefined)
  }, [codeThemes, workerPool])

  return null
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
          size="icon-sm"
          variant="ghost"
          aria-label="Review actions"
          title="Review actions"
          className="workbench-titlebar-interactive text-shell-titlebar-muted hover:bg-shell-titlebar-control-hover hover:text-shell-titlebar-fg"
          onClick={(event) => {
            if (event.detail === 0) setOpen((value) => !value)
          }}
        >
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="Review actions"
          align="end"
          sideOffset={8}
          className="bg-popover text-popover-foreground z-50 w-72 overflow-hidden rounded-xl border p-1 shadow-lg"
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

const DiffViewSettingsMenu = ({
  settings,
  onChange,
}: {
  readonly settings: AISettings
  readonly onChange: (settings: AISettings) => void
}) => {
  const [open, setOpen] = useState(false)

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Diff view settings"
          title="Diff view settings"
          className="text-muted-foreground hover:bg-accent hover:text-accent-foreground shrink-0"
          onClick={(event) => {
            if (event.detail === 0) setOpen((value) => !value)
          }}
        >
          <Settings2 className="size-3" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="Diff view settings"
          align="end"
          sideOffset={8}
          className="bg-popover text-popover-foreground z-50 w-56 space-y-1 rounded-xl border p-2 text-xs shadow-lg"
        >
          <DropdownMenu.RadioGroup
            value={settings.diffViewMode}
            onValueChange={(mode) => {
              if (mode !== "auto" && mode !== "unified" && mode !== "split") return
              onChange(AISettings.make({ ...settings, diffViewMode: mode }))
            }}
          >
            <DropdownMenu.Label className="text-muted-foreground px-2 pb-1 text-caption font-semibold tracking-wide uppercase">
              Diff layout
            </DropdownMenu.Label>
            <DiffViewSettingsMenuItem
              detail="Split when space allows"
              label="Auto"
              selected={settings.diffViewMode === "auto"}
              value="auto"
            />
            <DiffViewSettingsMenuItem
              detail="Show changes in one column"
              label="Unified"
              selected={settings.diffViewMode === "unified"}
              value="unified"
            />
            <DiffViewSettingsMenuItem
              detail="Show changes side by side"
              label="Split"
              selected={settings.diffViewMode === "split"}
              value="split"
            />
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

const DiffViewSettingsMenuItem = ({
  detail,
  label,
  selected,
  value,
}: {
  readonly detail: string
  readonly label: string
  readonly selected: boolean
  readonly value: DiffViewMode
}) => (
  <DropdownMenu.RadioItem asChild value={value}>
    <button
      type="button"
      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition ${
        selected
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      }`}
    >
      <span className="min-w-0">
        <span className="block">{label}</span>
        <span className="block text-caption opacity-75">{detail}</span>
      </span>
      {selected ? <Check className="size-3 shrink-0" /> : null}
    </button>
  </DropdownMenu.RadioItem>
)

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
  const walkthroughSelection = agentSelection(settings, "walkthrough")
  const walkthroughRoute = selectedProvider(walkthroughSelection)
  const walkthroughProviders = agentProviderOptions(catalog, walkthroughSelection, "walkthrough")
  const walkthroughModel = selectedModelForProvider(walkthroughSelection)
  const reviewThreadSelection = agentSelection(settings, "review-thread")
  const reviewThreadRoute = selectedProvider(reviewThreadSelection)
  const reviewThreadModel = selectedModelForProvider(reviewThreadSelection)
  const walkthroughModels = modelOptionsForProvider(walkthroughSelection, catalog, "walkthrough")
  const reviewThreadProviders = agentProviderOptions(
    catalog,
    reviewThreadSelection,
    "review-thread",
  )
  const reviewThreadModels = modelOptionsForProvider(
    reviewThreadSelection,
    catalog,
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
              onChange(
                aiSettingsWithProvider(
                  settings,
                  "walkthrough",
                  provider === "auto" ? "auto" : AIProviderId.make(provider),
                  catalog,
                ),
              )
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
                detail={option.reason}
                disabled={option.disabled}
              />
            ))}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.RadioGroup
            className="border-review-sidebar-divider space-y-1 border-t pt-2"
            value={reviewThreadRoute}
            onValueChange={(provider) =>
              onChange(
                aiSettingsWithProvider(
                  settings,
                  "review-thread",
                  provider === "auto" ? "auto" : AIProviderId.make(provider),
                  catalog,
                ),
              )
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

          <DropdownMenu.RadioGroup
            className="border-review-sidebar-divider space-y-1 border-t pt-2"
            value={reviewThreadModel}
            onValueChange={(model) =>
              onChange(aiSettingsWithModel(settings, "review-thread", model))
            }
          >
            <DropdownMenu.Label className="text-caption text-review-sidebar-muted px-2 font-semibold tracking-wide uppercase">
              Review comment model
            </DropdownMenu.Label>
            {reviewThreadModels.map((option) => (
              <WalkthroughSettingsMenuItem
                key={option.model}
                value={option.model}
                label={option.label}
                detail={option.reason}
                disabled={option.disabled}
                selected={reviewThreadModel === option.model}
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

const matchesReviewFileFilter = (
  file: Pick<ReviewSnapshotFileInventory, "path" | "oldPath">,
  normalizedFilter: string,
) =>
  file.path.toLowerCase().includes(normalizedFilter) ||
  (file.oldPath?.toLowerCase().includes(normalizedFilter) ?? false)

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
  if (!isHTMLElement(target)) return false
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
  readonly mode: "tree" | "walkthrough"
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

const isDiffCardVisible = (container: HTMLElement, card: HTMLElement, stickyHeaderOffset = 56) => {
  const containerRect = container.getBoundingClientRect()
  const cardRect = card.getBoundingClientRect()
  return (
    cardRect.bottom > containerRect.top + stickyHeaderOffset && cardRect.top < containerRect.bottom
  )
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

const reviewActiveCard = (
  container: HTMLElement | null,
  stickyChrome: HTMLElement | null,
  pointerPosition: { readonly clientX: number; readonly clientY: number } | null,
) => {
  if (container === null) return null
  const containerRect = container.getBoundingClientRect()
  const visibleTop = containerRect.top + (stickyChrome?.offsetHeight ?? 0)
  const cards = container.querySelectorAll<HTMLElement>("[data-diff-card-path]")
  const pointerCard =
    pointerPosition !== null &&
    pointerPosition.clientX >= containerRect.left &&
    pointerPosition.clientX <= containerRect.right &&
    pointerPosition.clientY >= visibleTop &&
    pointerPosition.clientY <= containerRect.bottom
      ? ([...cards].find((card) => {
          const rect = card.getBoundingClientRect()
          return (
            pointerPosition.clientX >= rect.left &&
            pointerPosition.clientX <= rect.right &&
            pointerPosition.clientY >= rect.top &&
            pointerPosition.clientY <= rect.bottom
          )
        }) ?? null)
      : null
  if (
    pointerCard !== null &&
    container.contains(pointerCard) &&
    isDiffCardVisible(container, pointerCard, stickyChrome?.offsetHeight ?? 0)
  ) {
    return pointerCard
  }
  return reviewViewportCard(container, stickyChrome)
}

const captureReviewSearchAnchor = (
  container: HTMLElement | null,
  stickyChrome: HTMLElement | null,
  pointerPosition: { readonly clientX: number; readonly clientY: number } | null,
  inventory: readonly ReviewSnapshotFileInventory[],
): ReviewSnapshotSearchFileAnchor | null => {
  const card = reviewActiveCard(container, stickyChrome, pointerPosition)
  const path = card?.dataset.diffCardPath
  if (container === null || card === null || path === undefined) return null
  const inventoryFile = inventory.find((file) => file.path === path)
  if (inventoryFile === undefined) return null
  return ReviewSnapshotSearchFileAnchor.make({ fileId: inventoryFile.fileId })
}

const projectRibbonToSidebarTab = (ribbon: ProjectWorkspaceRibbon): ReviewSidebarTab =>
  ribbon === "files" ? "tree" : ribbon

const sidebarTabToProjectRibbon = (tab: ReviewSidebarTab): ProjectWorkspaceRibbon =>
  tab === "tree" ? "files" : tab
