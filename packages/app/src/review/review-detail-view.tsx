/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
/* oxlint-disable jsx-a11y/prefer-tag-over-role -- A focusable ARIA separator is the standard keyboard-resizable splitter pattern. */
import {
  AISettings,
  type CodeThemePreferences,
  DEFAULT_CODE_THEME_PREFERENCES,
  DiffViewMode,
} from "@diffdash/domain/ai-settings"
import {
  codeLineChangesFromHunks,
  type CodeLineChangeRange,
} from "@diffdash/domain/code-line-change"
import type { CodeWorkspaceTarget } from "@diffdash/domain/code-workspace"
import { DiffFileVisibility, type ParsedDiffFile } from "@diffdash/domain/diff"
import type { LanguageRange } from "@diffdash/domain/language"
import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import type { ReviewFileId } from "@diffdash/domain/review-identity"
import type { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  ReviewLocationV1,
  ReviewNavigationBehavior,
  ReviewNavigationInput,
  ReviewSnapshotAddress,
  ThreadReviewNavigationTarget,
  FileReviewNavigationTarget,
} from "@diffdash/domain/review-navigation"
import {
  HostedReviewTarget,
  type ReviewThreadAnchor,
  type ReviewThreadId,
} from "@diffdash/domain/review-thread"
import { ReviewSnapshotSearchFileAnchor } from "@diffdash/protocol/review-snapshot"
import { RegistryContext, useAtomValue } from "@effect/atom-react"
import { Effect, Exit, HashMap, HashSet, Match, Option, Schema, Scope } from "effect"
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
  X,
} from "lucide-react"
import { DropdownMenu } from "radix-ui"
import type { ReactNode } from "react"
import { createRef, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type {
  OwnedExtensionContribution,
  ProjectActivityContribution,
  ProjectSurfaceContribution,
  ReviewDiffContribution,
} from "@/extensions/extension-registry"
import { resolveProjectActivityMainPane } from "@/extensions/project-main-pane-resolver"
import { ReviewActivityPaneProvider } from "@/extensions/review/review-activity-panes"
import {
  usePublishReviewSurfaceCapability,
  useReviewActivityBehaviors,
} from "@/extensions/review/review-surface-capability"
import {
  runRendererPromise,
  useCodeWorkspace,
  useDesktopRuntime,
  useReviewContent,
} from "@/platform/renderer-runtime"
import type { ColorScheme } from "@/settings/theme"
import { useCaptureAnalytics } from "@/shared/analytics"
import { isHTMLElement } from "@/shared/dom"
import { formatError } from "@/shared/errors"
import { Button } from "@/shared/ui/button"
import { EmptyState } from "@/shared/ui/empty-state"
import { Input } from "@/shared/ui/input"
import { CommandPaletteDialog, type CommandPaletteItem } from "@/shell/command-palette"
import { WorkbenchContextActions } from "@/shell/workbench-context-actions"
import { ProjectActivityNavigation } from "@/project-workspace/project-activity-navigation"
import {
  SourceSurfaceSide,
  SourceSurfaceContributionId,
  type SourceSurfaceRenderObserver,
  useSourceSurfaceHost,
  useSourceSurfaceRuntime,
} from "@/source-surface/source-surface-runtime"
import {
  type LanguageNavigationSource,
  type LanguageNavigationDestination,
  useLanguageNavigationCapability,
} from "@/source-surface/language-navigation-capability"
import { CodeDefinitionPeek } from "@/project-workspace/code-definition-peek"
import { OpenDiffCard } from "./diff-card"
import type { ReviewDiffAnnotationMetadata } from "./review-diff-annotation"
import { useReviewDiffContributionHost } from "@/extensions/review-diff-contribution-host"
import {
  createDiffsWorker,
  DiffVirtualizer,
  isVirtualizedFileDiff,
  type FileDiffOptions,
  type PierreFileDiff,
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
import {
  makeReviewCodeWorkspaceSession,
  ReviewCodeWorkspaceSessionError,
  reviewCodeWorkspaceTargets,
} from "./review-code-workspace"
import { ReviewSearchToolbar } from "./review-search-toolbar"
import { orderReviewFilesAsTree } from "./file-tree-adapter"
import type { ReviewSelectionProjection } from "./review-selection"
import type { ReviewSourceOperations } from "./use-review-source-operations"
import type { ReviewActivePane } from "./review-sidebar-layout"
import { ReviewWorkbenchLayout } from "./review-workbench-layout"
import {
  type ReviewDiffRegistration,
  ReviewViewportNavigationBridge,
} from "./review-viewport-navigation"
import type { ProgressiveReviewContent } from "./use-progressive-review-content"
import { diffCardDomId, useViewedFileViewport } from "./viewed-file-viewport"

type PullRequestApprovalState = "checking" | "unapproved" | "approving" | "approved"

type ResolvedDiffViewMode = Exclude<DiffViewMode, "auto">
type SupportedReviewDecisionOperations = Extract<
  ReviewSourceOperations["decision"],
  { readonly _tag: "supported" }
>
type HostedReadyReview = Extract<
  Extract<ReviewSelectionProjection, { readonly _tag: "ready" }>["review"],
  { readonly _tag: "hosted" }
>

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
  readonly onOpenCodeFile: (
    path: RepositoryRelativePath,
    target: CodeWorkspaceTarget,
    files: readonly ReviewSnapshotFileInventory[],
    lineChanges: HashMap.HashMap<RepositoryRelativePath, readonly CodeLineChangeRange[]>,
    revealRange: Option.Option<LanguageRange>,
  ) => void
  readonly onShowFilesActivity: () => void
  readonly onSidebarExpandedChange: (expanded: boolean) => void
  readonly onSidebarWidthChange: (width: number) => void
  readonly onThreadDetailWidthChange: (width: number) => void
}

/** Ready review state assembled by ReviewScreen after source selection succeeds. */
export type ReadyReviewDetailState = {
  readonly selection: Extract<ReviewSelectionProjection, { readonly _tag: "ready" }>
  readonly progressiveContent: ProgressiveReviewContent
  readonly sourceOperations: ReviewSourceOperations
  readonly expandedFileKeys: ReadonlySet<string>
  readonly viewedFileKeys: HashSet.HashSet<string>
  readonly selectedPath: Option.Option<string>
  readonly isReloading: boolean
  readonly status: string
  readonly operationError: Option.Option<string>
  readonly onReload: () => void
  readonly onSelectPath: (path: string) => void
  readonly onSetViewed: (reviewKey: string, viewed: boolean) => void
  readonly onToggleExpanded: (reviewKey: string) => void
}

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
  expansionLineCount: 20,
  hunkSeparators: "line-info-basic",
  lineHoverHighlight: "both",
  lineDiffType: "word",
  overflow: "wrap",
  tokenizeMaxLineLength: 2_000,
  useTokenTransformer: true,
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
} satisfies FileDiffOptions<ReviewDiffAnnotationMetadata>

const REVIEW_DIFF_VIRTUALIZER_CONFIG = {
  intersectionObserverMargin: 1_500,
  overscrollSize: 1_000,
} as const

class ReviewLanguageSourceRequest extends Schema.Class<ReviewLanguageSourceRequest>(
  "ReviewLanguageSourceRequest",
)({
  path: RepositoryRelativePath,
  side: SourceSurfaceSide,
}) {}

const reviewLanguageSourceRequest = (
  source: LanguageNavigationSource,
  files: readonly ParsedDiffFile[],
): Option.Option<ReviewLanguageSourceRequest> =>
  Option.flatMap(source.side, (side) =>
    Option.map(
      Option.fromNullishOr(
        files.find((file) => file.reviewKey === source.surfaceId || file.path === source.surfaceId),
      ),
      (file) => {
        const pathBySide: Record<SourceSurfaceSide, RepositoryRelativePath> = {
          additions: file.path,
          deletions: Option.getOrElse(Option.fromNullishOr(file.oldPath), () => file.path),
        }
        return new ReviewLanguageSourceRequest({ path: pathBySide[side], side })
      },
    ),
  )

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
  useTokenTransformer: REVIEW_DIFF_OPTIONS.useTokenTransformer,
} satisfies WorkerInitializationRenderOptions

const reviewDiffHighlighterOptions = (
  codeThemes: CodeThemePreferences,
): WorkerInitializationRenderOptions => ({
  ...REVIEW_DIFF_HIGHLIGHTER_OPTIONS,
  theme: codeThemes,
})

/** Source-neutral review detail composition with its coupled ephemeral interaction state. */
export const ReviewDetailView = ({
  active,
  activeActivity,
  activities,
  environment,
  ready,
  reviewDiffContributions,
  reviewsContext,
  surfaceContribution,
  onActiveActivityChange,
}: {
  readonly active: boolean
  readonly activeActivity: ProjectWorkspaceActivityId
  readonly activities: readonly OwnedExtensionContribution<ProjectActivityContribution>[]
  readonly environment: ReviewDetailEnvironment
  readonly ready: ReadyReviewDetailState
  readonly reviewDiffContributions: readonly OwnedExtensionContribution<ReviewDiffContribution>[]
  readonly reviewsContext: ReactNode
  readonly surfaceContribution: OwnedExtensionContribution<ProjectSurfaceContribution>
  readonly onActiveActivityChange: (activityId: ProjectWorkspaceActivityId) => void
}) => {
  const activeActivityContribution = activities.find((activity) => activity.id === activeActivity)
  const ActivityContextPane = activeActivityContribution?.slots?.contextPane?.component
  const ActivityDetailPane = activeActivityContribution?.slots?.detailPane?.component
  const captureAnalytics = useCaptureAnalytics()
  const codeWorkspace = useCodeWorkspace()
  const desktop = useDesktopRuntime()
  const reviewContentService = useReviewContent()
  const {
    aiSettings,
    quickNavigationRequest,
    repositoryLinkState,
    sidebarExpanded,
    sidebarWidth,
    threadDetailWidth,
    colorScheme,
    onAISettingsChange,
    onLinkRepository,
    onOpenCodeFile,
    onShowFilesActivity,
    onSidebarExpandedChange,
    onSidebarWidthChange,
    onThreadDetailWidthChange,
  } = environment
  const {
    selection,
    progressiveContent,
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
  const reviewWorkspaceTargets = useMemo(() => reviewCodeWorkspaceTargets(review), [review])
  const reviewWorkspaceResource = useMemo(() => {
    const scope = Scope.makeUnsafe()
    const session = Effect.runSync(
      makeReviewCodeWorkspaceSession(codeWorkspace, reviewWorkspaceTargets).pipe(
        Scope.provide(scope),
      ),
    )
    let closeTimer: number | null = null
    const cancelClose = () => {
      if (closeTimer === null) return
      window.clearTimeout(closeTimer)
      closeTimer = null
    }
    const scheduleClose = () => {
      closeTimer = window.setTimeout(() => {
        closeTimer = null
        Effect.runFork(Scope.close(scope, Exit.void))
      }, 0)
    }
    return { cancelClose, scheduleClose, session }
  }, [codeWorkspace, reviewWorkspaceTargets])
  useEffect(() => {
    reviewWorkspaceResource.cancelClose()
    return reviewWorkspaceResource.scheduleClose
  }, [reviewWorkspaceResource])
  const reviewWorkspaceSession = reviewWorkspaceResource.session
  const reviewContributionTarget = useMemo(
    () =>
      Match.valueTags(review, {
        hosted: (hostedReview) =>
          HostedReviewTarget.make({ kind: "hosted", review: hostedReview.target }),
        local: (localReview) => localReview.target,
        repositoryComparison: (comparisonReview) => comparisonReview.target,
      }),
    [review],
  )
  const reviewContributionHost = useReviewDiffContributionHost(reviewDiffContributions, {
    projectId: manifest.projectId,
    target: reviewContributionTarget,
    baseRevision: manifest.baseRevision,
    headRevision: manifest.headRevision,
  })
  const reviewSnapshotAddress = ReviewSnapshotAddress.make({
    projectId: manifest.projectId,
    snapshotId: manifest.snapshotId,
  })
  const atomRegistry = useContext(RegistryContext)
  const navigationPresentation = useAtomValue(reviewNavigationPresentationAtom)
  const navigationLastOutcome = useAtomValue(reviewNavigationLastOutcomeAtom)
  const navigationStatus = useAtomValue(reviewNavigationStatusAtom)
  const navigationLocked = Match.valueTags(navigationStatus, {
    active: () => true,
    idle: () => false,
  })
  const diffScrollContainerRef = useRef<HTMLDivElement>(null)
  const retainedDiffScrollTopRef = useRef(0)
  const reviewDiffContentRef = useRef<HTMLElement>(null)
  const stickyReviewChromeRef = useRef<HTMLDivElement>(null)
  const reviewSearchInputRef = useRef<HTMLInputElement>(null)
  const reviewSearchManifestRef = useRef(manifest)
  const [activityButtonRefs] = useState(
    () => new Map(activities.map((activity) => [activity.id, createRef<HTMLButtonElement>()])),
  )
  const previousSidebarExpandedRef = useRef(sidebarExpanded)
  const quickNavigationRequestRef = useRef(quickNavigationRequest)
  const previousReviewSearchFocusRef = useRef<HTMLElement | null>(null)
  const lastPointerPositionRef = useRef<{
    readonly clientX: number
    readonly clientY: number
  } | null>(null)
  const reviewDiffRegistrationsRef = useRef<Map<string, ReviewDiffRegistration>>(new Map())
  const reviewDiffKeyByHostRef = useRef<WeakMap<HTMLElement, string>>(new WeakMap())
  const navigableThreadIdsRef = useRef({
    key: "",
    value: HashSet.empty<ReviewThreadId>(),
  })
  const diffHostResizeObserverRef = useRef<ResizeObserver | null>(null)
  const resizedDiffKeysRef = useRef<Set<string>>(new Set())
  const diffResizeFrameRef = useRef<number | null>(null)
  const reviewSurfaceRuntime =
    useSourceSurfaceRuntime<PierreFileDiff<ReviewDiffAnnotationMetadata>>()
  useSourceSurfaceHost(reviewSurfaceRuntime, diffScrollContainerRef)
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
  const [navigationSelectedFileId, setNavigationSelectedFileId] = useState<
    Option.Option<ReviewFileId>
  >(Option.none)
  const [detailActivity, setDetailActivity] = useState<Option.Option<ProjectWorkspaceActivityId>>(
    Option.none,
  )
  const [showHiddenFiles, setShowHiddenFiles] = useState(false)
  const [goToPaletteOpen, setGoToPaletteOpen] = useState(false)
  const [actionPaletteOpen, setActionPaletteOpen] = useState(false)
  const reviewSearchToolbar = useAtomValue(reviewSearchController.toolbarAtom)
  const activeReviewSearchMatch = useAtomValue(reviewSearchController.activeMatchAtom)
  const reviewSearchOccurrences = useAtomValue(reviewSearchController.retainedMatchesAtom)
  const [fileOpenStatus, setFileOpenStatus] = useState<Option.Option<string>>(Option.none)
  const [approvalState, setApprovalState] = useState<PullRequestApprovalState>("checking")
  const [activePane, setActivePane] = useState<ReviewActivePane>("diff")
  const [repositoryBannerDismissed, setRepositoryBannerDismissed] = useState(false)
  const [repositoryLinking, setRepositoryLinking] = useState(false)
  const [repositoryLinkError, setRepositoryLinkError] = useState<Option.Option<string>>(Option.none)
  const [scrollPastEndHeight, setScrollPastEndHeight] = useState(0)
  const previousFileFilterRef = useRef(fileFilter)
  const selectReviewFileRef = useRef<(file: ReviewSnapshotFileInventory) => void>(() => undefined)
  const reviewSearchOpen = reviewSearchToolbar.open
  const reviewSearchQuery = reviewSearchToolbar.query
  const reviewSearchTotalMatches = reviewSearchToolbar.totalMatches
  const activeReviewSearchIndex = reviewSearchToolbar.activeGlobalIndex
  useEffect(() => {
    if (active) return
    setGoToPaletteOpen(false)
    setActionPaletteOpen(false)
  }, [active])
  useEffect(() => {
    if (quickNavigationRequestRef.current === quickNavigationRequest) return
    quickNavigationRequestRef.current = quickNavigationRequest
    if (active) setGoToPaletteOpen(true)
  }, [active, quickNavigationRequest])
  useEffect(() => {
    const previouslyExpanded = previousSidebarExpandedRef.current
    previousSidebarExpandedRef.current = sidebarExpanded
    if (previouslyExpanded === sidebarExpanded) return
    if (!sidebarExpanded) {
      setDetailActivity(Option.none())
      setActivePane("diff")
      return
    }
    setActivePane((current) => (current === "diff" ? "context" : current))
  }, [sidebarExpanded])
  const {
    files: snapshotFiles,
    fileErrors,
    inventory: progressiveInventory,
    inventoryError,
    inventoryLoading,
    identity: progressiveIdentity,
    loadingFileIds,
    reader: snapshotPageReader,
    snapshotRefresh,
  } = progressiveContent
  const loadSnapshotFiles = snapshotPageReader.loadFiles
  reviewSearchController.updateRuntime({
    navigator: reviewNavigator,
    identity: progressiveIdentity,
    reviewKeys: new Map(progressiveInventory.map((file) => [file.fileId, file.reviewKey])),
    search: reviewContentService.progressive.search,
  })
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
    const releases = progressiveInventory.map((file) =>
      reviewNavigationAnchors.registerDescriptor({
        anchorKey: reviewFileAnchorKey(file.fileId),
        fileId: file.fileId,
      }),
    )
    return () => {
      for (const release of releases) release()
    }
  }, [manifest.snapshotId, progressiveInventory, reviewNavigationAnchors])
  const setDiffScrollContainer = useStableCallback<(node: HTMLDivElement | null) => void>(
    (node) => {
      if (node === null) {
        retainedDiffScrollTopRef.current = diffScrollContainerRef.current?.scrollTop ?? 0
        diffScrollContainerRef.current = null
        diffVirtualizer.cleanUp()
        return
      }

      diffScrollContainerRef.current = node
      node.scrollTop = retainedDiffScrollTopRef.current
      const content = node.firstElementChild
      diffVirtualizer.setup(node, isHTMLElement(content) ? content : undefined)
    },
  )
  useLayoutEffect(() => {
    const registrations = reviewDiffRegistrationsRef.current
    const resizedDiffKeys = resizedDiffKeysRef.current
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (!isHTMLElement(entry.target)) continue
        const reviewKey = reviewDiffKeyByHostRef.current.get(entry.target)
        if (reviewKey !== undefined) resizedDiffKeys.add(reviewKey)
      }
      if (resizedDiffKeys.size === 0 || diffResizeFrameRef.current !== null) return
      diffResizeFrameRef.current = window.requestAnimationFrame(() => {
        diffResizeFrameRef.current = null
        const reviewKeys = [...resizedDiffKeys]
        resizedDiffKeys.clear()
        diffVirtualizer.markDOMDirty()
        for (const reviewKey of reviewKeys) {
          const registration = registrations.get(reviewKey)
          if (registration === undefined || !registration.host.isConnected) continue
          diffVirtualizer.requestHeightReconcile(registration.instance)
        }
      })
    })
    diffHostResizeObserverRef.current = observer
    for (const registration of registrations.values()) {
      if (registration.host.isConnected) observer.observe(registration.host)
    }
    return () => {
      observer.disconnect()
      diffHostResizeObserverRef.current = null
      resizedDiffKeys.clear()
      if (diffResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(diffResizeFrameRef.current)
        diffResizeFrameRef.current = null
      }
      registrations.clear()
      reviewDiffKeyByHostRef.current = new WeakMap()
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
    setNavigationSelectedFileId(Option.none())
  }, [fileFilter])
  const reviewBaseSha = review.baseRevision
  const reviewHeadSha = review.headRevision
  const reviewIdentity = review.identity
  const reviewThreadDetails = reviewContributionHost.semantic.details
  const navigationThreadAnchor = Option.match(
    Option.fromNullishOr(navigationPresentation.activeTarget),
    {
      onNone: () => Option.none<ReviewThreadAnchor>(),
      onSome: (navigationTarget) =>
        Match.valueTags(navigationTarget, {
          extension: () => Option.none<ReviewThreadAnchor>(),
          file: () => Option.none<ReviewThreadAnchor>(),
          hunk: () => Option.none<ReviewThreadAnchor>(),
          line: () => Option.none<ReviewThreadAnchor>(),
          range: () => Option.none<ReviewThreadAnchor>(),
          thread: (target) =>
            Option.fromNullishOr(
              reviewThreadDetails.find((details) => details.thread.id === target.threadId)?.thread
                .activeAnchor,
            ),
        }),
    },
  )
  const changedFiles = progressiveInventory
  const loadedFilesById = useMemo(
    () => HashMap.fromIterable(snapshotFiles.map((file) => [file.fileId, file])),
    [snapshotFiles],
  )
  const loadedChangedFiles = useMemo(
    () =>
      changedFiles.flatMap((file) => {
        return Option.toArray(HashMap.get(loadedFilesById, file.fileId))
      }),
    [changedFiles, loadedFilesById],
  )
  const reviewLineChanges = useMemo(
    () =>
      HashMap.fromIterable(
        loadedChangedFiles.map(
          (file) => [file.path, codeLineChangesFromHunks(file.hunks)] as const,
        ),
      ),
    [loadedChangedFiles],
  )
  const openLanguageDestination = (destination: LanguageNavigationDestination) => {
    const side = Option.getOrElse(destination.origin.side, () =>
      SourceSurfaceSide.make("additions"),
    )
    const targetBySide: Record<SourceSurfaceSide, CodeWorkspaceTarget> = {
      additions: reviewWorkspaceTargets.head,
      deletions: Option.getOrElse(reviewWorkspaceTargets.base, () => reviewWorkspaceTargets.head),
    }
    onOpenCodeFile(
      destination.location.target.path,
      targetBySide[side],
      changedFiles,
      reviewLineChanges,
      Option.some(destination.location.targetSelectionRange),
    )
  }
  const languageNavigation = useLanguageNavigationCapability({
    enabled: active,
    navigate: Option.some(openLanguageDestination),
    providers: {
      definitions: Option.some((position, signal, source) => {
        const request = reviewLanguageSourceRequest(source, loadedChangedFiles)
        return runRendererPromise(
          Option.match(request, {
            onNone: () =>
              Effect.fail(
                new ReviewCodeWorkspaceSessionError({
                  message: `Review diff source is unavailable for ${source.surfaceId}.`,
                  reason: "sourceUnavailable",
                }),
              ),
            onSome: ({ path, side }) => reviewWorkspaceSession.definitions(side, path, position),
          }),
          signal,
        )
      }),
      references: Option.some((position, signal, source) => {
        const request = reviewLanguageSourceRequest(source, loadedChangedFiles)
        return runRendererPromise(
          Option.match(request, {
            onNone: () =>
              Effect.fail(
                new ReviewCodeWorkspaceSessionError({
                  message: `Review diff source is unavailable for ${source.surfaceId}.`,
                  reason: "sourceUnavailable",
                }),
              ),
            onSome: ({ path, side }) => reviewWorkspaceSession.references(side, path, position),
          }),
          signal,
        )
      }),
    },
    rootRef: diffScrollContainerRef,
    runtime: reviewSurfaceRuntime,
    surfaceId: (token) => {
      const root = token.tokenElement.getRootNode()
      let host = token.tokenElement
      if ("host" in root && isHTMLElement(root.host)) host = root.host
      return Option.getOrElse(
        Option.flatMap(
          Option.fromNullishOr(host.closest<HTMLElement>("[data-diff-card-path]")),
          (card) => Option.fromNullishOr(card.dataset.diffCardPath),
        ),
        () => review.identity,
      )
    },
  })
  const eagerLoadSettled =
    progressiveInventory.length === 0 ||
    (loadingFileIds.size === 0 &&
      HashMap.size(loadedFilesById) + fileErrors.size >= progressiveInventory.length)
  const snapshotRefreshFailure = Match.valueTags(snapshotRefresh, {
    failed: ({ message }) => Option.some(message),
    idle: () => Option.none<string>(),
    refreshing: () => Option.none<string>(),
  })
  const snapshotRefreshing = Match.valueTags(snapshotRefresh, {
    failed: () => false,
    idle: () => false,
    refreshing: () => true,
  })
  const normalizedReviewSearchIndex = activeReviewSearchIndex
  const activeReviewSearchOccurrence = reviewSearchOpen
    ? Option.fromNullishOr(activeReviewSearchMatch)
    : Option.none()
  const activeReviewSearchOccurrenceId = Option.getOrNull(
    Option.map(activeReviewSearchOccurrence, (occurrence) => occurrence.id),
  )
  const hiddenFileCount = changedFiles.filter((file) =>
    DiffFileVisibility.guards.Hidden(file.visibility),
  ).length
  const visibleBaseFiles = useMemo(
    () =>
      showHiddenFiles
        ? changedFiles
        : changedFiles.filter((file) => DiffFileVisibility.guards.Visible(file.visibility)),
    [changedFiles, showHiddenFiles],
  )
  const normalizedFileFilter = fileFilter.trim().toLowerCase()
  const filteredChangedFiles = useMemo(
    () =>
      normalizedFileFilter.length === 0
        ? visibleBaseFiles
        : visibleBaseFiles.filter((file) => matchesReviewFileFilter(file, normalizedFileFilter)),
    [normalizedFileFilter, visibleBaseFiles],
  )
  const activityBehaviors = useReviewActivityBehaviors(activeActivity, {
    activityId: activeActivity,
    restrictsInventory: false,
    visibleInventory: orderReviewFilesAsTree(filteredChangedFiles),
    collapsedFileKeys: HashSet.fromIterable(
      changedFiles
        .filter((file) => !expandedFileKeys.has(file.reviewKey))
        .map((file) => file.reviewKey),
    ),
    navigationItems: reviewGoToPaletteItems(changedFiles, (file) =>
      selectReviewFileRef.current(file),
    ),
    navigationPlaceholder: "Search files",
    actionItems: [],
    settings: null,
    toggleFileCollapsed: onToggleExpanded,
  })
  const activityBehavior = activityBehaviors.active
  const navigationSelectedPath = Option.flatMap(
    Option.fromNullishOr(navigationPresentation.selectedFileId),
    (selectedFileId) =>
      Option.fromNullishOr(changedFiles.find((file) => file.fileId === selectedFileId)?.path),
  )
  const selectedVisiblePath = Option.firstSomeOf([
    navigationSelectedPath,
    Option.filter(selectedPath, (path) => visibleBaseFiles.some((file) => file.path === path)),
    Option.fromNullishOr(visibleBaseFiles[0]?.path),
  ])
  const selectedTreePath = Option.firstSomeOf([
    Option.filter(navigationSelectedPath, (path) =>
      filteredChangedFiles.some((file) => file.path === path),
    ),
    Option.filter(selectedPath, (path) => filteredChangedFiles.some((file) => file.path === path)),
  ])
  const totalAdditions = changedFiles.reduce((total, file) => total + file.additions, 0)
  const totalDeletions = changedFiles.reduce((total, file) => total + file.deletions, 0)
  const visibleChangedFiles = activityBehavior.visibleInventory
  const activeSearchReviewKey = Option.map(
    activeReviewSearchOccurrence,
    (occurrence) => occurrence.reviewKey,
  )
  const forcedVisibleFileIds = useMemo(() => {
    let fileIds = HashSet.fromIterable(navigationPresentation.forceVisibleFileIds)
    if (!activityBehavior.restrictsInventory && Option.isSome(navigationSelectedFileId)) {
      fileIds = HashSet.add(fileIds, navigationSelectedFileId.value)
    }
    return fileIds
  }, [
    activityBehavior.restrictsInventory,
    navigationPresentation.forceVisibleFileIds,
    navigationSelectedFileId,
  ])
  const renderedChangedFiles = useMemo(() => {
    const visibleFileIds = HashSet.fromIterable(visibleChangedFiles.map((file) => file.fileId))
    if (
      (Option.isNone(activeSearchReviewKey) ||
        visibleChangedFiles.some((file) =>
          Option.contains(activeSearchReviewKey, file.reviewKey),
        )) &&
      [...forcedVisibleFileIds].every((fileId) => HashSet.has(visibleFileIds, fileId))
    ) {
      return visibleChangedFiles
    }
    const visibleReviewKeys = HashSet.fromIterable(
      visibleChangedFiles.map((file) => file.reviewKey),
    )
    const revealedFiles = changedFiles.filter(
      (file) =>
        Option.contains(activeSearchReviewKey, file.reviewKey) ||
        HashSet.has(forcedVisibleFileIds, file.fileId) ||
        HashSet.has(visibleReviewKeys, file.reviewKey),
    )
    return !activityBehavior.restrictsInventory
      ? orderReviewFilesAsTree(revealedFiles)
      : revealedFiles
  }, [
    activeSearchReviewKey,
    activityBehavior.restrictsInventory,
    changedFiles,
    forcedVisibleFileIds,
    visibleChangedFiles,
  ])
  const forceExpandedFileKeys = useMemo(() => {
    let keys = HashSet.empty<string>()
    if (Option.isSome(activeSearchReviewKey)) keys = HashSet.add(keys, activeSearchReviewKey.value)
    const activeLineAnchor = Option.orElse(
      navigationThreadAnchor,
      () => reviewContributionHost.semantic.activeLineAnchor,
    )
    if (Option.isSome(activeLineAnchor)) {
      const file = changedFiles.find(
        (candidate) => candidate.fileId === activeLineAnchor.value.fileId,
      )
      if (file !== undefined) keys = HashSet.add(keys, file.reviewKey)
    }
    for (const fileId of navigationPresentation.forceExpandedFileIds) {
      const file = changedFiles.find((candidate) => candidate.fileId === fileId)
      if (file !== undefined) keys = HashSet.add(keys, file.reviewKey)
    }
    return keys
  }, [
    activeSearchReviewKey,
    changedFiles,
    navigationPresentation.forceExpandedFileIds,
    navigationThreadAnchor,
    reviewContributionHost.semantic.activeLineAnchor,
  ])
  const lastRenderedFileId = renderedChangedFiles.at(-1)?.fileId ?? null
  useLayoutEffect(() => {
    const container = diffScrollContainerRef.current
    const stickyChrome = stickyReviewChromeRef.current
    const content = reviewDiffContentRef.current
    if (container === null || stickyChrome === null || content === null) return undefined
    let previousStickyHeight = stickyChrome.offsetHeight
    container.style.setProperty("--review-sticky-chrome-height", `${previousStickyHeight}px`)
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
  const resolvedDiffViewMode =
    aiSettings.diffViewMode === "auto" ? autoDiffViewMode : aiSettings.diffViewMode
  const onReviewTokenClick = useStableCallback<
    NonNullable<FileDiffOptions<ReviewDiffAnnotationMetadata>["onTokenClick"]>
  >((token, event) =>
    languageNavigation.onTokenClick(
      { ...token, side: Schema.decodeUnknownOption(SourceSurfaceSide)(token.side) },
      event,
    ),
  )
  const onReviewTokenEnter = useStableCallback<
    NonNullable<FileDiffOptions<ReviewDiffAnnotationMetadata>["onTokenEnter"]>
  >((token, event) =>
    languageNavigation.onTokenEnter(
      { ...token, side: Schema.decodeUnknownOption(SourceSurfaceSide)(token.side) },
      event,
    ),
  )
  const onReviewTokenLeave = useStableCallback<
    NonNullable<FileDiffOptions<ReviewDiffAnnotationMetadata>["onTokenLeave"]>
  >((token) =>
    languageNavigation.onTokenLeave({
      ...token,
      side: Schema.decodeUnknownOption(SourceSurfaceSide)(token.side),
    }),
  )
  const reviewDiffOptions: FileDiffOptions<ReviewDiffAnnotationMetadata> = {
    ...REVIEW_DIFF_OPTIONS,
    diffStyle: resolvedDiffViewMode,
    theme: aiSettings.codeThemes,
    themeType: colorScheme,
    onTokenClick: onReviewTokenClick,
    onTokenEnter: onReviewTokenEnter,
    onTokenLeave: onReviewTokenLeave,
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
  const navigableThreadIdValues = reviewThreadDetails.flatMap((details) => {
    const anchor = details.thread.activeAnchor
    if (
      anchor !== null &&
      changedFiles.some((file) => file.fileId === anchor.fileId && file.path === anchor.filePath)
    ) {
      return [details.thread.id]
    }
    return []
  })
  const navigableThreadIdsKey = JSON.stringify(navigableThreadIdValues)
  if (navigableThreadIdsRef.current.key !== navigableThreadIdsKey) {
    navigableThreadIdsRef.current = {
      key: navigableThreadIdsKey,
      value: HashSet.fromIterable(navigableThreadIdValues),
    }
  }
  const navigableThreadIds = navigableThreadIdsRef.current.value
  const viewportViewedFileKeys = useMemo(() => new Set(viewedFileKeys), [viewedFileKeys])
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
    viewedFileKeys: viewportViewedFileKeys,
    visibleFiles: visibleChangedFiles,
  })
  const reconcileReviewDiffRegistration = useStableCallback<
    SourceSurfaceRenderObserver<PierreFileDiff<ReviewDiffAnnotationMetadata>>
  >(({ generation, host: node, instance, phase, surfaceId: reviewKey }) => {
    if (isVirtualizedFileDiff<ReviewDiffAnnotationMetadata>(instance)) {
      const phaseHandlers = {
        unmount: () => {
          const current = reviewDiffRegistrationsRef.current.get(reviewKey)
          if (
            current?.generation === generation &&
            current.host === node &&
            current.instance === instance
          ) {
            diffHostResizeObserverRef.current?.unobserve(node)
            reviewDiffKeyByHostRef.current.delete(node)
            resizedDiffKeysRef.current.delete(reviewKey)
            reviewDiffRegistrationsRef.current.delete(reviewKey)
          }
        },
        mount: () => {
          const previous = reviewDiffRegistrationsRef.current.get(reviewKey)
          if (previous !== undefined && previous.host !== node) {
            diffHostResizeObserverRef.current?.unobserve(previous.host)
            reviewDiffKeyByHostRef.current.delete(previous.host)
          }
          reviewDiffRegistrationsRef.current.set(reviewKey, {
            generation,
            host: node,
            instance,
            reviewKey,
            rendered: true,
          })
          reviewDiffKeyByHostRef.current.set(node, reviewKey)
          diffHostResizeObserverRef.current?.observe(node)
        },
        update: () => {
          const previous = reviewDiffRegistrationsRef.current.get(reviewKey)
          if (previous !== undefined && previous.host !== node) {
            diffHostResizeObserverRef.current?.unobserve(previous.host)
            reviewDiffKeyByHostRef.current.delete(previous.host)
          }
          reviewDiffRegistrationsRef.current.set(reviewKey, {
            generation,
            host: node,
            instance,
            reviewKey,
            rendered: true,
          })
          reviewDiffKeyByHostRef.current.set(node, reviewKey)
          diffHostResizeObserverRef.current?.observe(node)
        },
      } satisfies Readonly<Record<PostRenderPhase, () => void>>
      phaseHandlers[phase]()
    }
  })
  const reconcileReviewSearchHighlights = useStableCallback<
    SourceSurfaceRenderObserver<PierreFileDiff<ReviewDiffAnnotationMetadata>>
  >(({ host, instance, phase, surfaceId }) => {
    reviewSearchHighlights.handlePostRender(surfaceId, host, instance, phase)
  })
  const reconcileReviewNavigationFocus = useStableCallback<
    SourceSurfaceRenderObserver<PierreFileDiff<ReviewDiffAnnotationMetadata>>
  >(({ phase, surfaceId }) => {
    if (phase !== "unmount") reviewViewportBridge.reconcileRenderedFocus(surfaceId)
  })
  const reconcileViewedFile = useStableCallback<
    SourceSurfaceRenderObserver<PierreFileDiff<ReviewDiffAnnotationMetadata>>
  >(({ phase, surfaceId }) => {
    handleViewedDiffRendered(surfaceId, phase)
  })
  useEffect(() => {
    // Reset before registration so late-observer replay repopulates every mounted diff.
    reviewDiffRegistrationsRef.current.clear()
    const disposers = [
      Effect.runSync(
        reviewSurfaceRuntime.registerRenderObserver(
          SourceSurfaceContributionId.make("diffdash.builtin.review-virtualization"),
          reconcileReviewDiffRegistration,
        ),
      ),
      Effect.runSync(
        reviewSurfaceRuntime.registerRenderObserver(
          SourceSurfaceContributionId.make("diffdash.builtin.review-search"),
          reconcileReviewSearchHighlights,
        ),
      ),
      Effect.runSync(
        reviewSurfaceRuntime.registerRenderObserver(
          SourceSurfaceContributionId.make("diffdash.builtin.review-navigation-focus"),
          reconcileReviewNavigationFocus,
        ),
      ),
      Effect.runSync(
        reviewSurfaceRuntime.registerRenderObserver(
          SourceSurfaceContributionId.make("diffdash.builtin.review-viewed-files"),
          reconcileViewedFile,
        ),
      ),
    ]
    return () => disposers.forEach((dispose) => dispose())
  }, [
    reconcileReviewDiffRegistration,
    reconcileReviewNavigationFocus,
    reconcileReviewSearchHighlights,
    reconcileViewedFile,
    reviewBaseSha,
    reviewHeadSha,
    reviewIdentity,
    reviewSurfaceRuntime,
  ])
  useEffect(() => {
    void loadSnapshotFiles(progressiveInventory.map((file) => file.fileId))
  }, [loadSnapshotFiles, manifest.snapshotId, progressiveInventory])
  const moveReviewSearch = useStableCallback((direction: -1 | 1) => {
    reviewSearchController.move(direction)
  })
  const updateReviewSearchQuery = useStableCallback((query: string) => {
    let anchor: ReviewSnapshotSearchFileAnchor | null | undefined
    if (query.length === 0) {
      anchor = Option.isNone(navigationSelectedFileId)
        ? captureReviewSearchAnchor(
            diffScrollContainerRef.current,
            stickyReviewChromeRef.current,
            lastPointerPositionRef.current,
            changedFiles,
          )
        : ReviewSnapshotSearchFileAnchor.make({ fileId: navigationSelectedFileId.value })
    }
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
      Option.isNone(navigationSelectedFileId)
        ? captureReviewSearchAnchor(
            diffScrollContainerRef.current,
            stickyReviewChromeRef.current,
            lastPointerPositionRef.current,
            changedFiles,
          )
        : ReviewSnapshotSearchFileAnchor.make({ fileId: navigationSelectedFileId.value }),
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
    (file: ReviewSnapshotFileInventory, origin: "file-tree" | "extension" | "command") => {
      onSelectPath(file.path)
      setNavigationSelectedFileId(Option.some(file.fileId))
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
  const showActivityContext = useStableCallback((activityId: ProjectWorkspaceActivityId) => {
    setDetailActivity(Option.none())
    onActiveActivityChange(activityId)
    onSidebarExpandedChange(true)
    setActivePane("context")
  })
  const showActivityDetail = useStableCallback((activityId: ProjectWorkspaceActivityId) => {
    setDetailActivity(Option.some(activityId))
    onActiveActivityChange(activityId)
    onSidebarExpandedChange(true)
    setActivePane("thread-detail")
  })
  const showMainPane = useStableCallback(() => setActivePane("diff"))
  const closeContextPane = useStableCallback(() => {
    setDetailActivity(Option.none())
    cancelFileNavigation()
    onSidebarExpandedChange(false)
    setActivePane("diff")
    window.requestAnimationFrame(() => activityButtonRefs.get(activeActivity)?.current?.focus())
  })
  const closeDetailPane = useStableCallback(() => {
    setDetailActivity(Option.none())
    setActivePane("context")
  })
  const submitThreadNavigation = useStableCallback((threadId: ReviewThreadId) => {
    setActivePane("diff")
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
  const reviewSurfaceCapability = useMemo(
    () => ({
      review,
      inventory: changedFiles,
      parsedFiles: loadedChangedFiles,
      viewedFileKeys,
      setViewedFiles: setViewedFilesPreservingViewport,
      aiAgentAvailable: environment.aiAgentAvailable,
      aiSettings,
      onAISettingsChange,
      navigateToFile: submitFileNavigation,
      navigableThreadIds,
      navigateToThread: submitThreadNavigation,
      panes: {
        showContext: showActivityContext,
        showDetail: showActivityDetail,
        showMain: showMainPane,
        closeContext: closeContextPane,
      },
    }),
    [
      changedFiles,
      environment.aiAgentAvailable,
      aiSettings,
      loadedChangedFiles,
      onAISettingsChange,
      navigableThreadIds,
      review,
      closeContextPane,
      setViewedFilesPreservingViewport,
      showActivityContext,
      showActivityDetail,
      showMainPane,
      submitFileNavigation,
      submitThreadNavigation,
      viewedFileKeys,
    ],
  )
  usePublishReviewSurfaceCapability(reviewSurfaceCapability)
  const prepareNavigationFile = useStableCallback(
    (file: ReviewSnapshotFileInventory, input: ReviewNavigationInput) => {
      if (input.behavior.selection === "update") onSelectPath(file.path)
      if (input.behavior.selection === "update")
        setNavigationSelectedFileId(Option.some(file.fileId))
      setActivePane("diff")
      if (input.origin === "thread-detail") {
        onShowFilesActivity()
        onSidebarExpandedChange(true)
      }
    },
  )
  reviewViewportBridge.update({
    review: {
      projectId: manifest.projectId,
      reviewKey: manifest.reviewKey,
      baseRevision: manifest.baseRevision,
      headRevision: manifest.headRevision,
    },
    inventory: progressiveInventory,
    containerRef: diffScrollContainerRef,
    stickyChromeRef: stickyReviewChromeRef,
    pages: snapshotPageReader,
    diffRegistrations: reviewDiffRegistrationsRef.current,
    diffVirtualizer,
    searchHighlights: reviewSearchHighlights,
    searchOccurrences: reviewSearchOccurrences,
    threads: reviewThreadDetails,
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
  useEffect(() => {
    const container = diffScrollContainerRef.current
    if (container === null) return undefined
    const blurThreadComposer = () => {
      const active = document.activeElement
      if (
        isHTMLElement(active) &&
        active.tagName === "TEXTAREA" &&
        active.closest("[data-review-thread-annotation]") !== null
      ) {
        active.blur()
      }
    }
    container.addEventListener("wheel", blurThreadComposer, { passive: true })
    container.addEventListener("touchmove", blurThreadComposer, { passive: true })
    return () => {
      container.removeEventListener("wheel", blurThreadComposer)
      container.removeEventListener("touchmove", blurThreadComposer)
    }
  }, [])
  useLayoutEffect(() => {
    reviewSearchHighlights.setSearch(
      reviewSearchOpen ? reviewSearchOccurrences : [],
      activeReviewSearchOccurrenceId,
    )
  }, [
    activeReviewSearchOccurrenceId,
    reviewSearchHighlights,
    reviewSearchOccurrences,
    reviewSearchOpen,
  ])
  useEffect(() => {
    lastPointerPositionRef.current = null
    reviewNavigator.cancelActive()
    onSidebarExpandedChange(true)
    setShowHiddenFiles(false)
    setGoToPaletteOpen(false)
    setActionPaletteOpen(false)
    setNavigationSelectedFileId(Option.none())
    setRepositoryBannerDismissed(false)
    setRepositoryLinking(false)
    setRepositoryLinkError(Option.none())
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
      supported: (operations) => Option.some(operations),
      unsupported: () => Option.none<SupportedReviewDecisionOperations>(),
    })
    if (Option.isNone(decisionOperations)) return undefined
    let cancelled = false
    setApprovalState("checking")
    decisionOperations.value
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
    if (!active) return undefined
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
      if (activePane === "thread-detail") return
      if (navigationLocked && isViewportScrollKey(key) && !isEditableTarget(event.target)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (key === "escape" && sidebarExpanded && activePane === "context") {
        event.preventDefault()
        event.stopPropagation()
        closeContextPane()
        return
      }
      if (isModKey(event) && key === "f") {
        event.preventDefault()
        event.stopPropagation()
        openReviewSearch()
        return
      }

      if (isModKey(event) && key === "r" && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        if (!isReloading) onReload()
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
      const file = Option.firstSomeOf([
        Option.fromNullishOr(
          visibleChangedFiles.find((changedFile) => changedFile.path === activePath),
        ),
        Option.fromNullishOr(
          visibleChangedFiles.find((changedFile) =>
            Option.contains(selectedVisiblePath, changedFile.path),
          ),
        ),
      ])
      if (Option.isNone(file)) return

      event.preventDefault()
      const nextViewed = !HashSet.has(viewedFileKeys, file.value.reviewKey)
      setViewedPreservingViewport(file.value.reviewKey, nextViewed)
      setFileOpenStatus(
        Option.some(
          `${nextViewed ? "Marked" : "Unmarked"} ${file.value.path} as viewed with shortcut v.`,
        ),
      )
    }

    window.addEventListener("keydown", handleReviewShortcut, true)
    return () => window.removeEventListener("keydown", handleReviewShortcut, true)
  }, [
    active,
    actionPaletteOpen,
    activeActivity,
    activePane,
    activityButtonRefs,
    cancelFileNavigation,
    closeReviewSearch,
    closeContextPane,
    goToPaletteOpen,
    moveReviewSearch,
    navigationLocked,
    isReloading,
    onReload,
    onSidebarExpandedChange,
    openReviewSearch,
    reviewSearchOpen,
    selectedVisiblePath,
    setViewedPreservingViewport,
    reviewNavigator,
    sidebarExpanded,
    viewedFileKeys,
    visibleChangedFiles,
  ])

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

    activityBehavior.toggleFileCollapsed(reviewKey)
  }
  const markAllFilesViewed = () => {
    setViewedFilesPreservingViewport(
      changedFiles.map((file) => ({ reviewKey: file.reviewKey, viewed: true })),
    )
    setFileOpenStatus(
      Option.some(
        `Marked ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} as viewed.`,
      ),
    )
  }
  const revealHiddenFiles = () => {
    setShowHiddenFiles(true)
    setFileOpenStatus(
      Option.some(`Revealed ${hiddenFileCount} hidden file${hiddenFileCount === 1 ? "" : "s"}.`),
    )
  }
  const selectReviewFile = (file: ReviewSnapshotFileInventory) => {
    setFileFilter("")
    setActivePane("diff")
    submitFileNavigation(file, "command")
  }
  selectReviewFileRef.current = selectReviewFile
  const reviewGoToItems = activityBehavior.navigationItems
  const reviewActionItems = reviewActionPaletteItems({
    changedFiles,
    hiddenFileCount,
    isReloading,
    onMarkAllViewed: markAllFilesViewed,
    onApprove: () => void approvePullRequest(),
    onReload,
    onRevealHidden: revealHiddenFiles,
    approvalState: Match.valueTags(sourceOperations.decision, {
      supported: () => Option.some(approvalState),
      unsupported: () => Option.none<PullRequestApprovalState>(),
    }),
    showHiddenFiles,
  }).concat(activityBehaviors.actionItems)
  const selectPathAndScroll = (path: string) => {
    setActivePane("diff")
    const file = changedFiles.find((changedFile) => changedFile.path === path)
    if (file !== undefined) submitFileNavigation(file, "file-tree")
  }
  const openRepositoryFile = (path: RepositoryRelativePath) => {
    onSelectPath(path)
    onOpenCodeFile(
      path,
      reviewWorkspaceTargets.head,
      changedFiles,
      reviewLineChanges,
      Option.none(),
    )
  }
  const approvePullRequest = async () => {
    const decisionOperations = Match.valueTags(sourceOperations.decision, {
      supported: (operations) => Option.some(operations),
      unsupported: () => Option.none<SupportedReviewDecisionOperations>(),
    })
    const hostedReview = Match.valueTags(review, {
      hosted: (hosted) => Option.some(hosted),
      local: () => Option.none<HostedReadyReview>(),
      repositoryComparison: () => Option.none<HostedReadyReview>(),
    })
    const approval = Option.all({ decisionOperations, hostedReview })
    if (Option.isNone(approval)) return
    if (approvalState === "approved" || approvalState === "approving") return

    const pullRequest = approval.value.hostedReview.manifest.detail.summary
    setApprovalState("approving")
    setFileOpenStatus(Option.some(`Approving review #${pullRequest.locator.number}...`))
    try {
      await approval.value.decisionOperations.approve()
      setApprovalState("approved")
      captureAnalytics({ event: "pull_request_approved" })
      setFileOpenStatus(Option.some(`Approved review #${pullRequest.locator.number}.`))
    } catch (error) {
      setApprovalState("unapproved")
      setFileOpenStatus(Option.some(formatError(error, "Could not approve pull request")))
    }
  }
  const linkRepository = async () => {
    if (repositoryLinking) return
    setRepositoryLinking(true)
    setRepositoryLinkError(Option.none())
    try {
      const linked = await onLinkRepository()
      if (linked) setRepositoryBannerDismissed(true)
    } catch (error) {
      setRepositoryLinkError(Option.some(formatError(error, "Could not link repository")))
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
  const paneHost = {
    contextOpen: sidebarExpanded && activePane === "context",
    detailOpen: Option.contains(detailActivity, activeActivity),
    contextActions: activityBehaviors.settings,
    openContext: () => showActivityContext(activeActivity),
    openDetail: () => showActivityDetail(activeActivity),
    closeContext: closeContextPane,
    closeDetail: closeDetailPane,
    showMain: showMainPane,
  }
  const activityPaneProps = {
    location: { surface: "review" as const, projectId: manifest.projectId },
    paneHost,
  }
  const filesContext = (
    <aside
      data-review-context-panel
      className="bg-review-sidebar text-review-sidebar-fg relative z-20 flex h-full min-h-0 min-w-0 flex-col"
    >
      <header
        data-review-context-header
        className="border-review-sidebar-divider flex h-9 shrink-0 items-center gap-2 border-b px-3"
      >
        <h2 className="text-caption min-w-0 flex-1 truncate font-semibold tracking-wide uppercase">
          Files
        </h2>
        {activityBehaviors.settings}
      </header>

      <div className="bg-review-sidebar-control/20 space-y-2 p-3">
        <Input
          value={fileFilter}
          onChange={(event) => setFileFilter(event.currentTarget.value)}
          className="border-review-sidebar-divider bg-review-sidebar-control text-review-sidebar-fg placeholder:text-review-sidebar-muted h-8 text-xs"
          placeholder="Filter files"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden overscroll-contain py-2 pr-1">
        <ReviewFileTree
          files={filteredChangedFiles}
          selectedPath={Option.getOrNull(selectedTreePath)}
          onSelectPath={selectPathAndScroll}
        />
      </div>

      <div className="border-review-sidebar-divider bg-review-sidebar-control text-review-sidebar-muted flex items-center justify-between gap-2 border-t px-3 py-2 text-xs">
        <span>
          {hiddenFileCount > 0 && !showHiddenFiles ? `${hiddenFileCount} hidden` : "Total"}
        </span>
        <span>
          <span className="text-review-success-text">+{totalAdditions}</span>{" "}
          <span className="text-review-danger-text">-{totalDeletions}</span>
        </span>
      </div>
    </aside>
  )
  const reviewContent = (
    <>
      {reviewContributionHost.mounts}
      <ReviewWorkbenchLayout
        activePane={activePane}
        detailOpen={
          Option.contains(detailActivity, activeActivity) && ActivityDetailPane !== undefined
        }
        preferences={{ contextWidth: sidebarWidth, threadDetailWidth }}
        sidebarRequestedOpen={sidebarExpanded}
        onContextCollapsedByUser={closeContextPane}
        onContextWidthCommit={onSidebarWidthChange}
        onDetailCollapsedByUser={closeDetailPane}
        onDetailWidthCommit={onThreadDetailWidthChange}
        renderActivityNavigation={(placement) => (
          <ProjectActivityNavigation
            activeActivity={activeActivity}
            activities={activities}
            buttonRefs={activityButtonRefs}
            placement={placement}
            sidebarExpanded={sidebarExpanded && (placement === "rail" || activePane === "context")}
            onSelect={(activity) => {
              if (
                placement === "bottom" &&
                activity.id === activeActivity &&
                activePane === "thread-detail"
              ) {
                setActivePane("diff")
                return
              }
              if (
                activity.id === activeActivity &&
                sidebarExpanded &&
                (placement === "rail" || activePane === "context")
              ) {
                onSidebarExpandedChange(false)
                setActivePane("diff")
                return
              }
              if (activity.id !== activeActivity) setDetailActivity(Option.none())
              onActiveActivityChange(activity.id)
              onSidebarExpandedChange(true)
              setActivePane("context")
            }}
          />
        )}
        context={
          sidebarExpanded && ActivityContextPane !== undefined ? (
            <ActivityContextPane
              key={activeActivityContribution?.ownerRegistrationToken.reactKey}
              {...activityPaneProps}
            />
          ) : null
        }
        detail={
          ActivityDetailPane === undefined ? null : (
            <ActivityDetailPane
              key={activeActivityContribution?.ownerRegistrationToken.reactKey}
              {...activityPaneProps}
            />
          )
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
                  <DiffViewSettingsMenu
                    active={active}
                    settings={aiSettings}
                    onChange={onAISettingsChange}
                  />
                </div>
                <div className="sr-only" aria-live="polite">
                  {Option.getOrElse(
                    Option.orElse(operationError, () => fileOpenStatus),
                    () => status,
                  )}
                </div>
                {Option.match(operationError, {
                  onNone: () => null,
                  onSome: (error) => (
                    <div
                      role="alert"
                      className="border-destructive/25 bg-destructive/10 text-destructive border-b px-4 py-2 text-xs"
                    >
                      {error}
                    </div>
                  ),
                })}
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
                        {Option.match(repositoryLinkError, {
                          onNone: () => null,
                          onSome: (error) => (
                            <p role="alert" className="text-destructive mt-1 text-xs">
                              {error}
                            </p>
                          ),
                        })}
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
                {resolveProjectActivityMainPane({
                  activeActivityId: activeActivity,
                  activities,
                  activityPaneProps,
                  baseMain: (
                    <>
                      {normalizedFileFilter.length === 0 && renderedChangedFiles.length === 0 ? (
                        <EmptyState>
                          <div className="space-y-3">
                            <p>
                              {inventoryLoading
                                ? "Loading changed files..."
                                : (inventoryError ?? "No changed files in this review.")}
                            </p>
                            <Button
                              variant="outline"
                              onClick={() => {
                                const defaultReviewActivity = activities.find(
                                  (activity) =>
                                    activity.id === surfaceContribution.defaultActivityId,
                                )
                                if (defaultReviewActivity !== undefined)
                                  onActiveActivityChange(defaultReviewActivity.id)
                              }}
                            >
                              Choose another review
                            </Button>
                          </div>
                        </EmptyState>
                      ) : null}
                      {normalizedFileFilter.length > 0 && renderedChangedFiles.length === 0 ? (
                        <EmptyState>No files match this filter.</EmptyState>
                      ) : null}
                      {progressiveIdentity !== null &&
                      renderedChangedFiles.length > 0 &&
                      !eagerLoadSettled ? (
                        <EmptyState>Loading review files...</EmptyState>
                      ) : null}
                      {progressiveIdentity === null && snapshotRefreshing ? (
                        <EmptyState>Refreshing review files...</EmptyState>
                      ) : null}
                      {progressiveIdentity === null && Option.isSome(snapshotRefreshFailure) ? (
                        <EmptyState>
                          <div className="space-y-3">
                            <p role="alert">{snapshotRefreshFailure.value}</p>
                            <Button variant="outline" onClick={onReload}>
                              Retry
                            </Button>
                          </div>
                        </EmptyState>
                      ) : null}
                      {progressiveIdentity === null || !eagerLoadSettled
                        ? null
                        : renderedChangedFiles.map((file) => {
                            const parsedFile = HashMap.get(loadedFilesById, file.fileId)
                            return Option.isNone(parsedFile) ? (
                              <ReviewPagePlaceholder
                                key={file.reviewKey}
                                error={fileErrors.get(file.fileId) ?? "Could not load this diff"}
                                file={file}
                                onFileAnchorChange={(element, focusElement) =>
                                  registerFileNavigationAnchor(file.fileId, element, focusElement)
                                }
                                onRetry={() => void loadSnapshotFiles([file.fileId])}
                              />
                            ) : (
                              <OpenDiffCard
                                key={file.reviewKey}
                                annotationProvider={reviewContributionHost.semantic.annotations}
                                navigationAnchor={navigationThreadAnchor}
                                diffOptions={reviewDiffOptions}
                                expanded={
                                  !HashSet.has(activityBehavior.collapsedFileKeys, file.reviewKey)
                                }
                                file={parsedFile.value}
                                forceExpanded={HashSet.has(forceExpandedFileKeys, file.reviewKey)}
                                selected={
                                  Option.contains(activeSearchReviewKey, file.reviewKey) ||
                                  Option.contains(selectedVisiblePath, file.path)
                                }
                                surfaceRuntime={reviewSurfaceRuntime}
                                viewed={HashSet.has(viewedFileKeys, file.reviewKey)}
                                onFileAnchorChange={(element, focusElement) =>
                                  registerFileNavigationAnchor(file.fileId, element, focusElement)
                                }
                                onLoadDiffFiles={() =>
                                  runRendererPromise(
                                    reviewWorkspaceSession.loadDiffFiles(parsedFile.value),
                                  )
                                }
                                onOpenFile={() => openRepositoryFile(file.path)}
                                onActivateLine={(side, lineNumber) =>
                                  reviewContributionHost.semantic.activateLine(
                                    parsedFile.value,
                                    side,
                                    lineNumber,
                                  )
                                }
                                onAnnotationsRendered={
                                  reviewContributionHost.semantic.annotationsRendered
                                }
                                onSelect={() => selectPathAndScroll(file.path)}
                                onSetViewed={(viewed) =>
                                  setViewedPreservingViewport(file.reviewKey, viewed)
                                }
                                onToggleExpanded={() => toggleVisibleDiffCard(file.reviewKey)}
                              />
                            )
                          })}
                    </>
                  ),
                  surface: surfaceContribution,
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
        placeholder={activityBehavior.navigationPlaceholder}
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
        {active ? <ReviewActionsMenu items={reviewActionItems} /> : null}
      </WorkbenchContextActions>
      {Option.match(languageNavigation.peek, {
        onNone: () => null,
        onSome: (peek) => (
          <CodeDefinitionPeek
            codeThemes={aiSettings.codeThemes}
            colorScheme={colorScheme}
            state={peek}
            onClose={languageNavigation.closePeek}
            onLoadSource={(path, signal) =>
              runRendererPromise(
                reviewWorkspaceSession.readSource(
                  Option.getOrElse(peek.origin.side, () => SourceSurfaceSide.make("additions")),
                  path,
                ),
                signal,
              )
            }
            onNavigate={(location) => openLanguageDestination({ location, origin: peek.origin })}
          />
        ),
      })}
    </>
  )

  if (!active) return null

  return (
    <WorkerPoolContextProvider
      highlighterOptions={reviewDiffHighlighterOptions(aiSettings.codeThemes)}
      poolOptions={REVIEW_DIFF_WORKER_POOL_OPTIONS}
    >
      <ReviewDiffThemeSync codeThemes={aiSettings.codeThemes} />
      <VirtualizerContext.Provider value={diffVirtualizer}>
        <ReviewActivityPaneProvider reviewsContext={reviewsContext} filesContext={filesContext}>
          {reviewContent}
        </ReviewActivityPaneProvider>
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
            const Icon = item.icon ?? reviewActionIcon(item.id)
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
  if (id === "action:approve-pull-request") return Check
  if (id === "action:mark-all-viewed") return Check
  return Search
}

const DiffViewSettingsMenu = ({
  active,
  settings,
  onChange,
}: {
  readonly active: boolean
  readonly settings: AISettings
  readonly onChange: (settings: AISettings) => void
}) => {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!active) setOpen(false)
  }, [active])

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

const reviewGoToPaletteItems = (
  files: readonly ReviewSnapshotFileInventory[],
  onSelectFile: (file: ReviewSnapshotFileInventory) => void,
): readonly CommandPaletteItem[] =>
  files.map((file) => ({
    id: `file:${file.reviewKey}`,
    keywords: `${file.path} ${file.oldPath ?? ""} file diff`,
    subtitle: `File · +${file.additions} -${file.deletions}`,
    title: file.path,
    onSelect: () => onSelectFile(file),
  }))

const reviewActionPaletteItems = ({
  approvalState,
  changedFiles,
  hiddenFileCount,
  isReloading,
  onMarkAllViewed,
  onApprove,
  onReload,
  onRevealHidden,
  showHiddenFiles,
}: {
  readonly approvalState: Option.Option<PullRequestApprovalState>
  readonly changedFiles: readonly ReviewSnapshotFileInventory[]
  readonly hiddenFileCount: number
  readonly isReloading: boolean
  readonly onMarkAllViewed: () => void
  readonly onApprove: () => void
  readonly onReload: () => void
  readonly onRevealHidden: () => void
  readonly showHiddenFiles: boolean
}): readonly CommandPaletteItem[] => {
  const items: CommandPaletteItem[] = [
    {
      disabled: isReloading,
      id: "action:reload-diff",
      keywords: "reload refresh pr local diff",
      subtitle: isReloading ? "Reload already running" : "Refetch review detail and diff",
      title: "Reload diff",
      onSelect: onReload,
    },
  ]
  if (Option.isSome(approvalState)) {
    const state = approvalState.value
    items.push({
      disabled: state !== "unapproved",
      id: "action:approve-pull-request",
      keywords: "approve pull request review",
      subtitle: state === "unapproved" ? "Approve this pull request" : approvalButtonLabel(state),
      title: approvalButtonLabel(state),
      onSelect: onApprove,
    })
  }
  items.push({
    disabled: changedFiles.length === 0,
    id: "action:mark-all-viewed",
    keywords: "mark all viewed complete",
    subtitle: `Mark ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} as viewed`,
    title: "Mark all viewed",
    onSelect: onMarkAllViewed,
  })
  if (hiddenFileCount > 0) {
    items.push({
      disabled: showHiddenFiles,
      id: "action:reveal-hidden",
      keywords: "reveal hidden noisy generated lockfile vendored binary files",
      subtitle: showHiddenFiles
        ? "Hidden files are already visible"
        : `Show ${hiddenFileCount} hidden file${hiddenFileCount === 1 ? "" : "s"}`,
      title: "Reveal hidden files",
      onSelect: onRevealHidden,
    })
  }
  return items
}

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
