import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import type { ReviewFileId } from "@diffdash/domain/review-identity"
import type { ReviewThreadAnchor, ReviewThreadDetails } from "@diffdash/domain/review-thread"
import type { ReviewSessionIdentity } from "@diffdash/protocol/review-session"
import type { RefObject } from "react"
import { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { ChevronDown, ChevronRight, Copy, MessageSquare } from "lucide-react"
import { ContextMenu } from "radix-ui"

import { isHTMLElement } from "@/shared/dom"
import { Button } from "@/shared/ui/button"
import { formatError } from "@/shared/errors"
import { MiddleTruncatedText } from "@/shared/ui/middle-truncated-text"
import {
  ReviewThreadComposer,
  ReviewThreadPanel,
  type ReviewThreadsController,
  reviewLineLabel,
} from "@/threads/review-threads"
import type { ProgressiveReviewContentReader } from "./progressive-review-content-session"
import { parseProgressiveRangeFile, progressivePierreRange } from "./progressive-pierre-range"
import {
  createPierreRangeShellPool,
  PierreLoadedRangeAdapter,
  type PierreLoadedRange,
  type PierreRangeIdentity,
  type PierreRangePublication,
  type PierreRangeRequest,
} from "./pierre-loaded-range-adapter"
import {
  type DiffVirtualizer,
  type FileDiffOptions,
  useWorkerPool,
  type VirtualizedFileDiff,
  type VirtualFileMetrics,
} from "./pierre"
import { CompactReviewLayoutIndex } from "./review-layout-index"
import {
  D12_REVIEW_CACHE_BUDGETS,
  D12_REVIEW_VIRTUALIZER_LIMITS,
  ReviewGlobalVirtualizer,
  ReviewRendererCaches,
} from "./review-global-virtualizer"
import { D12_REVIEW_LOAD_LIMITS, ReviewLoadScheduler } from "./review-load-scheduler"
import {
  lineReviewAnchor,
  type ReviewThreadAnnotation,
  reviewThreadAnnotationContentId,
  reviewThreadAnnotations,
} from "./thread-annotations"
import { diffCardDomId } from "./viewed-file-viewport"

const FILE_HEADER_HEIGHT = 45
const FILE_GAP = 16
const ESTIMATED_ROW_HEIGHT = 20
const OVERSCAN = 1_200
const RANGE_OUTPUT_RESERVATION = 4 * 1_024 * 1_024
/** Pierre overscan shared by the production review virtualizer and its settlement check. */
export const REVIEW_DIFF_PIERRE_OVERSCAN = 500
const REVIEW_RANGE_METRICS = {
  diffHeaderHeight: 0,
  hunkLineCount: 10,
  lineHeight: ESTIMATED_ROW_HEIGHT,
  paddingBottom: 0,
  paddingTop: 0,
  spacing: 0,
} satisfies VirtualFileMetrics

/** Inputs for the production review-wide bounded mount plane. */
export interface ProgressiveReviewCanvasProps {
  readonly files: readonly ReviewSnapshotFileInventory[]
  readonly expandedFileKeys: ReadonlySet<string>
  readonly expandedLineAnchor: ReviewThreadAnchor | null
  readonly forceExpandedFileKeys: ReadonlySet<string>
  readonly diffVirtualizer: DiffVirtualizer
  readonly identity: ReviewSessionIdentity
  readonly mode: "unified" | "split"
  readonly navigationSeekGeneration: number
  readonly navigationActive: boolean
  readonly navigationTargetFileId: ReviewFileId | null
  readonly navigationRangeTarget: {
    readonly fileId: ReviewFileId
    readonly startLine: number
  } | null
  readonly options: FileDiffOptions<ReviewThreadAnnotation>
  readonly priorityFileId: ReviewFileId | null
  readonly reader: ProgressiveReviewContentReader
  readonly reviewThreads: ReviewThreadsController
  readonly scrollContainerRef: RefObject<HTMLDivElement | null>
  readonly selectedPath: string | null
  readonly viewedFileKeys: ReadonlySet<string>
  readonly onFileAnchorChange: (
    fileId: ReviewFileId,
    element: HTMLElement,
    focusElement: HTMLElement,
  ) => () => void
  readonly onDiffRendered: (
    reviewKey: string,
    ...args: Parameters<NonNullable<FileDiffOptions<ReviewThreadAnnotation>["onPostRender"]>>
  ) => void
  readonly onOpenFile: (path: string) => void
  readonly onOpenThread: (details: ReviewThreadDetails) => void
  readonly onSelect: (path: string) => void
  readonly onSetViewed: (reviewKey: string, viewed: boolean) => void
  readonly onToggleExpanded: (reviewKey: string) => void
  readonly onToggleLine: (anchor: ReviewThreadAnchor) => void
}

/** Renders only the review-wide global file/range window and reuses bounded Pierre hosts. */
export const ProgressiveReviewCanvas = ({
  files,
  expandedFileKeys,
  expandedLineAnchor,
  forceExpandedFileKeys,
  diffVirtualizer,
  identity,
  mode,
  navigationSeekGeneration,
  navigationActive,
  navigationTargetFileId,
  navigationRangeTarget,
  options,
  priorityFileId,
  reader,
  reviewThreads,
  scrollContainerRef,
  selectedPath,
  viewedFileKeys,
  onDiffRendered,
  onFileAnchorChange,
  onOpenFile,
  onOpenThread,
  onSelect,
  onSetViewed,
  onToggleExpanded,
  onToggleLine,
}: ProgressiveReviewCanvasProps) => {
  const workerManager = useWorkerPool()
  const canvasRef = useRef<HTMLDivElement>(null)
  const pageOriginRef = useRef(0)
  const previousLogicalTopRef = useRef(0)
  const viewportRevisionRef = useRef(0)
  const [viewport, setViewport] = useState({
    logicalTop: 0,
    height: 800,
    pageOrigin: 0,
    revision: 0,
  })
  const [settledViewportRevision, setSettledViewportRevision] = useState(0)
  const viewportRef = useRef(viewport)
  const renderedViewportRef = useRef(viewport)
  useLayoutEffect(() => {
    renderedViewportRef.current = viewport
  }, [viewport])
  const inventoryKey = files
    .map((file) => `${file.fileId}\u0001${estimatedRows(file)}`)
    .join("\u0000")
  const resources = useMemo(() => {
    const rowCounts = Uint32Array.from(
      inventoryKey.split("\u0000").filter((entry) => entry.length > 0),
      (entry) => Number(entry.slice(entry.lastIndexOf("\u0001") + 1)),
    )
    const layout = new CompactReviewLayoutIndex(
      rowCounts,
      new Uint8Array(files.length),
      estimateHeight,
    )
    return {
      caches: new ReviewRendererCaches(D12_REVIEW_CACHE_BUDGETS),
      scheduler: new ReviewLoadScheduler(D12_REVIEW_LOAD_LIMITS),
      shells: createPierreRangeShellPool<ReviewThreadAnnotation>(12, {
        virtualizer: diffVirtualizer,
        metrics: REVIEW_RANGE_METRICS,
        workerManager,
      }),
      virtualizer: new ReviewGlobalVirtualizer(
        layout,
        D12_REVIEW_VIRTUALIZER_LIMITS.browserPageHeight,
        D12_REVIEW_VIRTUALIZER_LIMITS.maximumMountedRows,
      ),
    }
  }, [diffVirtualizer, files.length, inventoryKey, workerManager])
  const selectedFileIndex =
    priorityFileId === null
      ? selectedPath === null
        ? undefined
        : files.findIndex((file) => file.path === selectedPath)
      : files.findIndex((file) => file.fileId === priorityFileId)
  const navigationFileIndex =
    navigationTargetFileId === null
      ? -1
      : files.findIndex((file) => file.fileId === navigationTargetFileId)
  const forceNavigationTarget =
    navigationFileIndex >= 0 && (navigationActive || priorityFileId === navigationTargetFileId)
  const mountPriorityFileIndex = forceNavigationTarget ? navigationFileIndex : selectedFileIndex

  useEffect(
    () => () => {
      resources.scheduler.dispose()
      resources.caches.clear()
      resources.shells.clear()
    },
    [resources],
  )

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const canvas = canvasRef.current
    if (container === null || canvas === null) return undefined
    let retirementTimeout: ReturnType<typeof setTimeout> | undefined
    const update = (settle: boolean) => {
      const physicalTop = Math.max(0, container.scrollTop - canvas.offsetTop)
      const position = resources.virtualizer.scroller.updatePhysical(physicalTop)
      const movement = position.logicalTop - previousLogicalTopRef.current
      const direction: -1 | 0 | 1 = movement < 0 ? -1 : movement > 0 ? 1 : 0
      const farSeek =
        Math.abs(position.logicalTop - previousLogicalTopRef.current) > container.clientHeight * 3
      resources.scheduler.updateDemand(direction, farSeek)
      previousLogicalTopRef.current = position.logicalTop
      viewportRevisionRef.current += 1
      const nextViewport = {
        logicalTop: position.logicalTop,
        height: Math.max(1, container.clientHeight),
        pageOrigin: position.pageOrigin,
        revision: viewportRevisionRef.current,
      }
      viewportRef.current = nextViewport
      const renderedViewport = renderedViewportRef.current
      const renderedWindow = resources.virtualizer.window(
        renderedViewport.logicalTop,
        renderedViewport.height,
        OVERSCAN,
        mountPriorityFileIndex === -1 ? undefined : mountPriorityFileIndex,
        forceNavigationTarget,
      )
      const nextWindow = resources.virtualizer.window(
        nextViewport.logicalTop,
        nextViewport.height,
        OVERSCAN,
        mountPriorityFileIndex === -1 ? undefined : mountPriorityFileIndex,
        forceNavigationTarget,
      )
      if (
        nextViewport.height !== renderedViewport.height ||
        nextViewport.pageOrigin !== renderedViewport.pageOrigin ||
        !sameFileWindow(renderedWindow.files, nextWindow.files)
      ) {
        startTransition(() =>
          setViewport((current) =>
            nextViewport.revision > current.revision ? nextViewport : current,
          ),
        )
      }
      if (settle) {
        clearTimeout(retirementTimeout)
        retirementTimeout = setTimeout(() => {
          setViewport(viewportRef.current)
          setSettledViewportRevision((revision) => revision + 1)
        }, 100)
      }
      if (position.pageOrigin !== pageOriginRef.current) {
        pageOriginRef.current = position.pageOrigin
        container.scrollTop = canvas.offsetTop + position.physicalTop
      }
    }
    const onScroll = () => update(true)
    update(false)
    container.addEventListener("scroll", onScroll, { passive: true })
    const observer = new ResizeObserver(() => update(false))
    observer.observe(container)
    return () => {
      clearTimeout(retirementTimeout)
      container.removeEventListener("scroll", onScroll)
      observer.disconnect()
    }
  }, [forceNavigationTarget, mountPriorityFileIndex, resources, scrollContainerRef])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const canvas = canvasRef.current
    if (container === null || canvas === null) return undefined
    const fileIndexes = new Map<string, number>(files.map((file, index) => [file.fileId, index]))
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (!isHTMLElement(entry.target)) continue
        const fileId = entry.target.dataset.reviewFileId
        const fileIndex = fileId === undefined ? undefined : fileIndexes.get(fileId)
        if (fileIndex === undefined) continue
        const nextHeight = entry.target.getBoundingClientRect().height + FILE_GAP
        if (Math.abs(resources.virtualizer.layout.heightOf(fileIndex) - nextHeight) <= 0.5) continue

        const current = viewportRef.current
        const anchorFile = resources.virtualizer.layout.fileAt(current.logicalTop)
        const position = resources.virtualizer.correctMeasurement(
          current.logicalTop,
          anchorFile,
          fileIndex,
          nextHeight,
        )
        previousLogicalTopRef.current = position.logicalTop
        pageOriginRef.current = position.pageOrigin
        if (
          position.logicalTop !== current.logicalTop ||
          position.pageOrigin !== current.pageOrigin
        ) {
          container.scrollTop = canvas.offsetTop + position.physicalTop
        }
        viewportRevisionRef.current += 1
        const nextViewport = {
          logicalTop: position.logicalTop,
          height: Math.max(1, container.clientHeight),
          pageOrigin: position.pageOrigin,
          revision: viewportRevisionRef.current,
        }
        viewportRef.current = nextViewport
        setViewport(nextViewport)
      }
    })
    canvas
      .querySelectorAll<HTMLElement>("[data-review-file-id]")
      .forEach((card) => observer.observe(card))
    return () => observer.disconnect()
  })

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const canvas = canvasRef.current
    if (navigationFileIndex < 0 || container === null || canvas === null) return
    const position = resources.virtualizer.primeTargetShell(
      navigationFileIndex,
      resources.virtualizer.layout.heightOf(navigationFileIndex),
    )
    previousLogicalTopRef.current = position.logicalTop
    pageOriginRef.current = position.pageOrigin
    viewportRevisionRef.current += 1
    const nextViewport = {
      logicalTop: position.logicalTop,
      height: Math.max(1, container.clientHeight),
      pageOrigin: position.pageOrigin,
      revision: viewportRevisionRef.current,
    }
    viewportRef.current = nextViewport
    setViewport(nextViewport)
    container.scrollTop = canvas.offsetTop + position.physicalTop
  }, [navigationFileIndex, navigationSeekGeneration, resources, scrollContainerRef])

  const mount = resources.virtualizer.window(
    viewport.logicalTop,
    viewport.height,
    OVERSCAN,
    mountPriorityFileIndex === -1 ? undefined : mountPriorityFileIndex,
    forceNavigationTarget,
  )
  const pageHeight = Math.min(
    D12_REVIEW_VIRTUALIZER_LIMITS.browserPageHeight,
    Math.max(1, resources.virtualizer.layout.logicalHeight - viewport.pageOrigin),
  )

  return (
    <div
      ref={canvasRef}
      data-review-global-canvas
      data-review-process-id={identity.processId}
      data-review-project-id={identity.projectId}
      data-review-review-key={identity.reviewKey}
      data-review-session-id={identity.sessionId}
      data-review-snapshot-id={identity.snapshotId}
      data-review-state-version={identity.stateVersion}
      data-review-logical-height={resources.virtualizer.layout.logicalHeight}
      data-review-mounted-rows={mount.mountedRows}
      data-review-viewport-top={viewport.logicalTop}
      style={{ height: pageHeight, position: "relative" }}
    >
      {[...mount.files].map((fileIndex) => {
        const file = files[fileIndex]
        if (file === undefined) return null
        const fileId = file.fileId
        const expanded =
          forceExpandedFileKeys.has(file.reviewKey) ||
          (expandedFileKeys.has(file.reviewKey) && !viewedFileKeys.has(file.reviewKey))
        return (
          <div
            key={`${identity.snapshotId}:${file.fileId}`}
            style={{
              left: 0,
              position: "absolute",
              right: 0,
              top: resources.virtualizer.layout.topOf(fileIndex) - viewport.pageOrigin,
            }}
          >
            <ProgressiveRangeCard
              caches={resources.caches}
              diffVirtualizer={diffVirtualizer}
              expanded={expanded}
              expandedLineAnchor={expandedLineAnchor}
              file={file}
              identity={identity}
              mode={mode}
              navigationActive={navigationActive}
              demandedStartLine={
                navigationRangeTarget?.fileId === file.fileId
                  ? navigationRangeTarget.startLine
                  : null
              }
              options={options}
              reader={reader}
              reviewThreads={reviewThreads}
              scheduler={resources.scheduler}
              selected={selectedPath === file.path}
              settledViewportRevision={settledViewportRevision}
              shells={resources.shells}
              viewed={viewedFileKeys.has(file.reviewKey)}
              onDiffRendered={onDiffRendered}
              onFileAnchorChange={onFileAnchorChange}
              onOpenFile={onOpenFile}
              onOpenThread={onOpenThread}
              onSelect={onSelect}
              onSetViewed={onSetViewed}
              onToggleExpanded={(reviewKey) => {
                if (expanded) {
                  const container = scrollContainerRef.current
                  const canvas = canvasRef.current
                  if (container !== null && canvas !== null) {
                    const position = resources.virtualizer.scroller.seekFile(fileIndex)
                    viewportRevisionRef.current += 1
                    const nextViewport = {
                      logicalTop: position.logicalTop,
                      height: Math.max(1, container.clientHeight),
                      pageOrigin: position.pageOrigin,
                      revision: viewportRevisionRef.current,
                    }
                    previousLogicalTopRef.current = position.logicalTop
                    pageOriginRef.current = position.pageOrigin
                    viewportRef.current = nextViewport
                    const stickyHeight = Number.parseFloat(
                      container.style.getPropertyValue("--review-sticky-chrome-height"),
                    )
                    container.scrollTop =
                      canvas.offsetTop +
                      position.physicalTop -
                      (Number.isFinite(stickyHeight) ? stickyHeight : 0)
                    setViewport(nextViewport)
                  }
                }
                onToggleExpanded(reviewKey)
                if (expanded) {
                  window.requestAnimationFrame(() => {
                    const container = scrollContainerRef.current
                    const card = canvasRef.current?.querySelector<HTMLElement>(
                      `[data-review-file-id="${fileId}"]`,
                    )
                    if (container === null || card === null || card === undefined) return
                    const stickyHeight = Number.parseFloat(
                      container.style.getPropertyValue("--review-sticky-chrome-height"),
                    )
                    if (!Number.isFinite(stickyHeight)) return
                    const visibleTop = container.getBoundingClientRect().top + stickyHeight
                    container.scrollTop += card.getBoundingClientRect().top - visibleTop
                    container.dispatchEvent(new Event("scroll"))
                  })
                }
              }}
              onToggleLine={onToggleLine}
              scrollContainerRef={scrollContainerRef}
            />
          </div>
        )
      })}
    </div>
  )
}

const ProgressiveRangeCard = ({
  caches,
  demandedStartLine,
  diffVirtualizer,
  expanded,
  expandedLineAnchor,
  file,
  identity,
  mode,
  navigationActive,
  options,
  reader,
  reviewThreads,
  scheduler,
  scrollContainerRef,
  selected,
  settledViewportRevision,
  shells,
  viewed,
  onDiffRendered,
  onFileAnchorChange,
  onOpenFile,
  onOpenThread,
  onSelect,
  onSetViewed,
  onToggleExpanded,
  onToggleLine,
}: Omit<
  ProgressiveReviewCanvasProps,
  | "diffVirtualizer"
  | "expandedFileKeys"
  | "forceExpandedFileKeys"
  | "files"
  | "navigationSeekGeneration"
  | "navigationActive"
  | "navigationTargetFileId"
  | "navigationRangeTarget"
  | "priorityFileId"
  | "selectedPath"
  | "viewedFileKeys"
> & {
  readonly caches: ReviewRendererCaches
  readonly diffVirtualizer: DiffVirtualizer
  readonly demandedStartLine: number | null
  readonly expanded: boolean
  readonly file: ReviewSnapshotFileInventory
  readonly navigationActive: boolean
  readonly scheduler: ReviewLoadScheduler
  readonly selected: boolean
  readonly settledViewportRevision: number
  readonly shells: ReturnType<typeof createPierreRangeShellPool<ReviewThreadAnnotation>>
  readonly viewed: boolean
}) => {
  const workerManager = useWorkerPool()
  const cardRef = useRef<HTMLElement>(null)
  const focusRef = useRef<HTMLButtonElement>(null)
  const rangeHostRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef(0)
  const optionsRef = useRef(options)
  const rangeFileRef = useRef<ReturnType<typeof parseProgressiveRangeFile> | null>(null)
  const virtualizedInstanceRef = useRef<VirtualizedFileDiff<ReviewThreadAnnotation> | null>(null)
  const navigationActiveRef = useRef(navigationActive)
  const annotationRootsRef = useRef<
    Map<
      string,
      { readonly container: HTMLDivElement; readonly root: Root; pinHistoryToBottom: boolean }
    >
  >(new Map())
  const selectedRef = useRef(selected)
  const [startLine, setStartLine] = useState(() => demandedStartLine ?? 0)
  const [nextStartLine, setNextStartLine] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renderPhase, setRenderPhase] = useState<"plain" | "highlighted">("plain")
  const [contextMenu, setContextMenu] = useState<{
    readonly line: number
    readonly copyStatus: "idle" | "copying" | "failed"
  } | null>(null)
  optionsRef.current = {
    ...options,
    onGutterUtilityClick: ({ side, start }) => {
      const rangeFile = rangeFileRef.current
      if (side === undefined || rangeFile === null) return
      const anchor = lineReviewAnchor(rangeFile, side, start)
      if (anchor !== null) onToggleLine(anchor)
    },
    onLineClick: ({ annotationSide, event, lineNumber, numberColumn }) => {
      if (numberColumn) return
      if (
        isHTMLElement(event.target) &&
        event.target.closest("[data-review-thread-annotation]") !== null
      ) {
        return
      }
      const rangeFile = rangeFileRef.current
      if (rangeFile === null) return
      const anchor = lineReviewAnchor(rangeFile, annotationSide, lineNumber)
      if (anchor !== null) onToggleLine(anchor)
    },
    renderAnnotation: (annotation) => {
      const contentId = reviewThreadAnnotationContentId(annotation.metadata.anchor)
      const retained = annotationRootsRef.current.get(contentId)
      const container = retained?.container ?? document.createElement("div")
      const root = retained?.root ?? createRoot(container)
      const state = retained ?? { container, root, pinHistoryToBottom: true }
      if (retained === undefined) annotationRootsRef.current.set(contentId, state)
      flushSync(() => {
        root.render(
          <ProgressiveThreadAnnotation
            annotation={annotation}
            reviewThreads={reviewThreads}
            onOpenThread={onOpenThread}
            onToggleLine={onToggleLine}
          />,
        )
      })
      const history = container.querySelector<HTMLElement>("[data-review-thread-history]")
      if (history !== null && history.dataset.reviewPinTracking === undefined) {
        history.dataset.reviewPinTracking = ""
        history.addEventListener("scroll", () => {
          if (history.scrollHeight - history.clientHeight - history.scrollTop <= 1) {
            state.pinHistoryToBottom = true
          }
        })
        history.addEventListener("pointerdown", () => {
          state.pinHistoryToBottom = false
        })
        history.addEventListener("wheel", (event) => {
          if (event.deltaY < 0) state.pinHistoryToBottom = false
        })
      }
      if (state.pinHistoryToBottom)
        window.requestAnimationFrame(() => {
          if (state.pinHistoryToBottom && history?.isConnected === true)
            history.scrollTop = history.scrollHeight
        })
      return container
    },
    onPostRender: (node, instance, phase) => onDiffRendered(file.reviewKey, node, instance, phase),
  }
  navigationActiveRef.current = navigationActive
  selectedRef.current = selected

  useEffect(
    () => () => {
      releaseAnnotationRoots(annotationRootsRef.current)
    },
    [],
  )

  useLayoutEffect(() => {
    if (demandedStartLine !== null) setStartLine(demandedStartLine)
  }, [demandedStartLine])

  useLayoutEffect(() => {
    const instance = virtualizedInstanceRef.current
    const scrollContainer = scrollContainerRef.current
    if (instance === null || scrollContainer === null) return
    diffVirtualizer.markDOMDirty()
    diffVirtualizer.requestHeightReconcile(instance)
    if (navigationActive) {
      reconcileDemandedRange(instance, 8)
    }
  }, [diffVirtualizer, navigationActive, scrollContainerRef, settledViewportRevision])

  useEffect(() => {
    if (navigationActive) return
    const instance = virtualizedInstanceRef.current
    const scrollContainer = scrollContainerRef.current
    if (instance === null || scrollContainer === null) return
    if (hasFocusedThreadComposer(scrollContainer)) return
    reconcileSettledRange(instance, diffVirtualizer, scrollContainer, 32)
  }, [diffVirtualizer, navigationActive, scrollContainerRef, settledViewportRevision])

  useLayoutEffect(() => {
    const card = cardRef.current
    const focus = focusRef.current
    if (card === null || focus === null) return undefined
    return onFileAnchorChange(file.fileId, card, focus)
  }, [file.fileId, onFileAnchorChange])

  useEffect(() => {
    const host = rangeHostRef.current
    if (host === null) return undefined
    const requestId = `${file.fileId}:${++requestRef.current}:${startLine}`
    const rangeIdentity: PierreRangeIdentity = {
      projectId: identity.projectId,
      processEpoch: identity.processId,
      snapshotGeneration: identity.snapshotId,
      sessionEpoch: identity.sessionId,
      rangeKey: `${file.fileId}:${startLine}`,
      requestId,
      width: Math.max(1, host.getBoundingClientRect().width),
      mode,
    }
    const adapter = new PierreLoadedRangeAdapter(
      caches,
      shells,
      { domContainer: 64 * 1_024, observer: 512, measurement: 256 },
      () => optionsRef.current,
      {
        onPrimeShell: () => undefined,
        onPublish: (publication: PierreRangePublication<ReviewThreadAnnotation>) => {
          const instance = publication.renderer.getVirtualizedInstance()
          virtualizedInstanceRef.current = instance
          host.replaceChildren(publication.container)
          setRenderPhase(
            Math.max(file.additions, file.deletions) > 5_000 ? publication.phase : "highlighted",
          )
          if (navigationActiveRef.current) {
            reconcileDemandedRange(instance, 8)
          } else {
            const scrollContainer = scrollContainerRef.current
            if (scrollContainer !== null) {
              reconcilePublishedRange(
                instance,
                diffVirtualizer,
                scrollContainer,
                () => navigationActiveRef.current,
                32,
              )
            }
          }
        },
        onHeightChange: () => undefined,
      },
    )
    const requestBase: PierreRangeRequest<ReviewThreadAnnotation> = {
      identity: rangeIdentity,
      estimatedHeight: estimateHeight(0, estimatedRows(file)),
      load: (adapterSignal) =>
        new Promise((resolve, reject) => {
          const admitted = scheduler.schedule({
            id: requestId,
            lane: selectedRef.current ? "target" : "prefetch",
            kind: "read",
            queuedBytes: 256,
            reservedOutputBytes: RANGE_OUTPUT_RESERVATION,
            run: async (schedulerSignal) => {
              const signal = AbortSignal.any([adapterSignal, schedulerSignal])
              try {
                const range = await reader.readRange(
                  { fileId: file.fileId, startLine },
                  true,
                  signal,
                )
                const rangeFile = parseProgressiveRangeFile(range)
                rangeFileRef.current = rangeFile
                const last = range.blocks.at(-1)
                setNextStartLine(
                  range.complete || last === undefined ? null : last.firstLine + last.lineCount,
                )
                setError(null)
                resolve({
                  ...progressivePierreRange<ReviewThreadAnnotation>(rangeIdentity, range),
                  annotations: reviewThreadAnnotations(
                    rangeFile,
                    reviewThreads.details,
                    expandedLineAnchor,
                  ),
                })
              } catch (cause) {
                if (!signal.aborted) setError(formatError(cause, "Could not load range"))
                reject(cause)
              }
            },
          })
          if (!admitted) {
            const cause = new Error("Range request exceeded the bounded scheduler budget")
            setError(cause.message)
            reject(cause)
          }
        }),
    }
    const request =
      workerManager === undefined
        ? requestBase
        : {
            ...requestBase,
            highlight: async (
              plain: PierreLoadedRange<ReviewThreadAnnotation>,
              signal: AbortSignal,
            ) => {
              if (signal.aborted) throw signal.reason
              await workerManager.primeDiffHighlightCache(plain.fileDiff)
              if (signal.aborted) throw signal.reason
              return { ...plain, resources: [] }
            },
          }
    adapter.request(request)
    return () => {
      virtualizedInstanceRef.current = null
      adapter.dispose()
    }
  }, [
    caches,
    diffVirtualizer,
    expanded,
    expandedLineAnchor,
    file,
    identity,
    mode,
    onDiffRendered,
    reader,
    reviewThreads.details,
    scheduler,
    scrollContainerRef,
    shells,
    startLine,
    workerManager,
  ])

  return (
    <section
      ref={cardRef}
      id={diffCardDomId(file.reviewKey)}
      data-review-file-id={file.fileId}
      data-diff-card-path={file.path}
      data-diff-file-status={file.status}
      data-diff-selected={selected ? "" : undefined}
      data-diff-render-mode={renderPhase}
      data-progressive-range-start={startLine}
      className="bg-card rounded-2xl border"
    >
      <div
        data-diff-card-header
        className="border-review-sidebar-divider sticky top-[var(--review-sticky-chrome-height,0px)] z-20 flex h-11 items-center gap-3 border-b bg-card px-3"
      >
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={expanded ? "Collapse diff" : "Expand diff"}
          aria-expanded={expanded}
          onClick={() => onToggleExpanded(file.reviewKey)}
        >
          {expanded ? <ChevronDown /> : <ChevronRight />}
        </Button>
        <button
          ref={focusRef}
          type="button"
          className="min-w-0 flex-1 overflow-hidden text-left"
          aria-label={`Select ${file.path}`}
          onClick={() => onSelect(file.path)}
        >
          <MiddleTruncatedText value={file.path} className="font-mono text-xs tracking-wide" />
        </button>
        <span className="text-muted-foreground text-caption shrink-0">
          +{file.additions} -{file.deletions}
        </span>
        <Button variant="outline" onClick={() => onOpenFile(file.path)}>
          Open
        </Button>
        <label className="flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium">
          <input
            type="checkbox"
            checked={viewed}
            onChange={(event) => onSetViewed(file.reviewKey, event.currentTarget.checked)}
          />
          Viewed
        </label>
      </div>
      {expanded ? (
        <ContextMenu.Root
          open={contextMenu !== null}
          onOpenChange={(open) => {
            if (!open) setContextMenu(null)
          }}
        >
          <ContextMenu.Trigger asChild>
            <div
              ref={rangeHostRef}
              data-diff-card-body
              data-progressive-range-host
              aria-busy="false"
              className="bg-diff-canvas min-h-20 overflow-clip rounded-b-2xl"
              onContextMenu={(event) => {
                const line = diffLineNumberFromEventPath(event.nativeEvent.composedPath())
                if (line === null) {
                  event.preventDefault()
                  setContextMenu(null)
                  return
                }
                setContextMenu({ line, copyStatus: "idle" })
              }}
            />
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content
              aria-label="Diff line actions"
              className="bg-popover text-popover-foreground z-50 min-w-44 rounded-xl border p-1 shadow-lg"
            >
              <ContextMenu.Item
                className="data-[highlighted]:bg-accent flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-xs outline-none"
                onSelect={(event) => {
                  const state = contextMenu
                  if (state === null) return
                  event.preventDefault()
                  setContextMenu({ ...state, copyStatus: "copying" })
                  void navigator.clipboard.writeText(`@${file.path}:${state.line}`).then(
                    () => setContextMenu(null),
                    () => setContextMenu({ ...state, copyStatus: "failed" }),
                  )
                }}
              >
                <Copy className="text-muted-foreground size-3.5 shrink-0" />
                <span>
                  {contextMenu?.copyStatus === "copying"
                    ? "Copying path..."
                    : contextMenu?.copyStatus === "failed"
                      ? "Copy failed, retry"
                      : "Copy path"}
                </span>
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-destructive px-3 py-2 text-xs">
          {error}
        </p>
      )}
      {!expanded || nextStartLine === null ? null : (
        <Button
          data-progressive-next-range={nextStartLine}
          className="m-3"
          size="sm"
          variant="outline"
          onClick={() => setStartLine(nextStartLine)}
        >
          Load next range
        </Button>
      )}
    </section>
  )
}

const ProgressiveThreadAnnotation = ({
  annotation,
  reviewThreads,
  onOpenThread,
  onToggleLine,
}: {
  readonly annotation: { readonly metadata: ReviewThreadAnnotation }
  readonly reviewThreads: ReviewThreadsController
  readonly onOpenThread: (details: ReviewThreadDetails) => void
  readonly onToggleLine: (anchor: ReviewThreadAnchor) => void
}) => {
  const { anchor, details, draftAnchor, expanded } = annotation.metadata
  const contentId = reviewThreadAnnotationContentId(anchor)
  const singleThreadDetails = details.length === 1 ? (details[0] ?? null) : null
  return (
    <div
      data-review-thread-annotation
      className="bg-diff-canvas box-border w-full min-w-0 max-w-full overflow-x-clip px-3 py-1.5 [overflow-wrap:anywhere]"
    >
      <section className="bg-card overflow-hidden rounded-lg border shadow-xs">
        <div className="flex min-w-0 items-center">
          <button
            type="button"
            className="text-muted-foreground hover:bg-muted/45 hover:text-foreground focus-visible:ring-ring flex min-h-9 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
            aria-controls={contentId}
            aria-expanded={expanded}
            onClick={() => onToggleLine(anchor)}
          >
            {expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            <span>
              Review on <strong className="text-foreground">{reviewLineLabel(anchor)}</strong>
            </span>
          </button>
          {singleThreadDetails === null ? null : (
            <div className="shrink-0 border-l px-1">
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Open ${reviewLineLabel(anchor)} thread details`}
                onClick={() => onOpenThread(singleThreadDetails)}
              >
                <MessageSquare />
              </Button>
            </div>
          )}
        </div>
        {expanded ? (
          <div
            id={contentId}
            data-review-thread-conversation
            className="flex min-h-0 flex-1 flex-col divide-y overflow-hidden border-t"
          >
            {details.map((threadDetails) => (
              <ReviewThreadPanel
                key={threadDetails.thread.id}
                embedded
                agentRunning={reviewThreads.runningThreadIds.includes(threadDetails.thread.id)}
                agentProgress={
                  reviewThreads.agentProgress.find(
                    (progress) => progress.threadId === threadDetails.thread.id,
                  )?.stage ?? null
                }
                agentError={reviewThreads.agentErrors[threadDetails.thread.id] ?? null}
                details={threadDetails}
                orchestration={{ retryAgentMessage: reviewThreads.runAgent }}
                {...(details.length > 1 ? { onOpenDetail: () => onOpenThread(threadDetails) } : {})}
                onAddUserMessage={reviewThreads.addUserMessage}
                onRefresh={reviewThreads.refreshThread}
              />
            ))}
            {draftAnchor === null ? null : (
              <div className="p-3">
                <ReviewThreadComposer
                  onCancel={() => onToggleLine(draftAnchor)}
                  onSubmit={(bodyMarkdown) => reviewThreads.createThread(draftAnchor, bodyMarkdown)}
                />
              </div>
            )}
          </div>
        ) : null}
      </section>
    </div>
  )
}

const estimatedRows = (file: ReviewSnapshotFileInventory): number =>
  Math.max(1, file.additions + file.deletions + file.hunkCount * 3)

const estimateHeight = (_file: number, rows: number): number =>
  FILE_HEADER_HEIGHT + Math.max(1, rows) * ESTIMATED_ROW_HEIGHT + FILE_GAP

const sameFileWindow = (left: Uint32Array, right: Uint32Array): boolean =>
  left.length === right.length && left.every((file, index) => file === right[index])

const reconcileDemandedRange = (
  instance: VirtualizedFileDiff<ReviewThreadAnnotation> | null,
  remainingFrames: number,
): void => {
  if (instance === null || remainingFrames <= 0) return
  window.requestAnimationFrame(() => {
    instance.syncVirtualizedTop()
    instance.rerender()
    reconcileDemandedRange(instance, remainingFrames - 1)
  })
}

const reconcileSettledRange = (
  instance: VirtualizedFileDiff<ReviewThreadAnnotation> | null,
  virtualizer: DiffVirtualizer,
  scrollContainer: HTMLElement,
  remainingFrames: number,
): void => {
  if (instance === null || remainingFrames <= 0 || hasFocusedThreadComposer(scrollContainer)) return
  const windowSpecs = virtualizer.getWindowSpecs()
  if (!isCurrentPierreWindow(windowSpecs, scrollContainer)) {
    window.requestAnimationFrame(() => {
      if (hasFocusedThreadComposer(scrollContainer)) return
      virtualizer.requestHeightReconcile(instance)
      reconcileSettledRange(instance, virtualizer, scrollContainer, remainingFrames - 1)
    })
    return
  }
  instance.syncVirtualizedTop()
  instance.rerender()
  verifySettledRange(instance, virtualizer, scrollContainer, remainingFrames - 1)
}

const verifySettledRange = (
  instance: VirtualizedFileDiff<ReviewThreadAnnotation>,
  virtualizer: DiffVirtualizer,
  scrollContainer: HTMLElement,
  remainingFrames: number,
): void => {
  if (remainingFrames <= 0) return
  window.requestAnimationFrame(() => {
    if (hasFocusedThreadComposer(scrollContainer)) return
    if (!isCurrentPierreWindow(virtualizer.getWindowSpecs(), scrollContainer)) {
      virtualizer.requestHeightReconcile(instance)
      reconcileSettledRange(instance, virtualizer, scrollContainer, remainingFrames - 1)
      return
    }
    if (mountedDiffLineCount(scrollContainer) <= D12_REVIEW_VIRTUALIZER_LIMITS.maximumMountedRows) {
      return
    }
    instance.syncVirtualizedTop()
    instance.rerender()
    verifySettledRange(instance, virtualizer, scrollContainer, remainingFrames - 1)
  })
}

const reconcilePublishedRange = (
  instance: VirtualizedFileDiff<ReviewThreadAnnotation> | null,
  virtualizer: DiffVirtualizer,
  scrollContainer: HTMLElement,
  isNavigationActive: () => boolean,
  remainingFrames: number,
  heightReconcileCooldown = 0,
): void => {
  if (instance === null || remainingFrames <= 0) return
  window.setTimeout(() => {
    if (isNavigationActive()) return
    if (hasFocusedThreadComposer(scrollContainer)) return
    if (!isCurrentPierreWindow(virtualizer.getWindowSpecs(), scrollContainer)) {
      if (heightReconcileCooldown <= 0) virtualizer.requestHeightReconcile(instance)
      reconcilePublishedRange(
        instance,
        virtualizer,
        scrollContainer,
        isNavigationActive,
        remainingFrames - 1,
        heightReconcileCooldown <= 0 ? 7 : heightReconcileCooldown - 1,
      )
      return
    }
    instance.syncVirtualizedTop()
    instance.rerender()
    window.requestAnimationFrame(() => {
      if (isNavigationActive() || hasFocusedThreadComposer(scrollContainer)) return
      if (!isCurrentPierreWindow(virtualizer.getWindowSpecs(), scrollContainer)) {
        reconcilePublishedRange(
          instance,
          virtualizer,
          scrollContainer,
          isNavigationActive,
          remainingFrames - 1,
        )
        return
      }
      if (
        mountedDiffLineCount(scrollContainer) > D12_REVIEW_VIRTUALIZER_LIMITS.maximumMountedRows
      ) {
        reconcilePublishedRange(
          instance,
          virtualizer,
          scrollContainer,
          isNavigationActive,
          remainingFrames - 1,
        )
      }
    })
  }, 0)
}

const mountedDiffLineCount = (container: HTMLElement): number =>
  [...container.querySelectorAll("diffs-container")].reduce((count, element) => {
    const lines = [...(element.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? [])]
    const columns = new Map<string, number>()
    for (const line of lines) {
      const column = line.dataset.columnNumber
      if (column !== undefined) columns.set(column, (columns.get(column) ?? 0) + 1)
    }
    return count + (columns.size > 1 ? Math.max(...columns.values()) : lines.length)
  }, 0)

const hasFocusedThreadComposer = (container: HTMLElement): boolean => {
  const active = document.activeElement
  return (
    isHTMLElement(active) &&
    active.tagName === "TEXTAREA" &&
    container.contains(active) &&
    active.closest("[data-review-thread-annotation]") !== null
  )
}

const isCurrentPierreWindow = (
  windowSpecs: { readonly bottom: number; readonly top: number },
  scrollContainer: HTMLElement,
): boolean => {
  const height = scrollContainer.clientHeight
  const scrollHeight = scrollContainer.scrollHeight
  const scrollTop = Math.max(0, Math.min(scrollContainer.scrollTop, scrollHeight - height))
  const windowHeight = height + REVIEW_DIFF_PIERRE_OVERSCAN * 2
  if (windowHeight >= scrollHeight) {
    const expectedBottom = Math.min(scrollTop + windowHeight, scrollHeight)
    return windowSpecs.top === scrollTop && windowSpecs.bottom === expectedBottom
  }

  const rawTop = scrollTop - REVIEW_DIFF_PIERRE_OVERSCAN
  const expectedTop = Math.floor(Math.max(rawTop, 0))
  const expectedBottom = Math.ceil(
    Math.max(Math.min(rawTop + windowHeight, scrollHeight), expectedTop),
  )
  return windowSpecs.top === expectedTop && windowSpecs.bottom === expectedBottom
}

const diffLineNumberFromEventPath = (path: readonly EventTarget[]): number | null => {
  for (const target of path) {
    if (!isHTMLElement(target)) continue
    const value = target.getAttribute("data-line") ?? target.getAttribute("data-column-number")
    if (value === null) continue
    const line = Number(value)
    if (Number.isSafeInteger(line) && line > 0) return line
  }
  return null
}

const releaseAnnotationRoots = (
  roots: Map<string, { readonly container: HTMLDivElement; readonly root: Root }>,
): void => {
  const released = [...roots.values()]
  roots.clear()
  queueMicrotask(() => {
    for (const { root } of released) root.unmount()
  })
}
