import type { ParsedDiffFile } from "@diffdash/domain/diff"
import type {
  ReviewDiffContributionAnnotation,
  ReviewDiffContributionOutput,
} from "@/extensions/extension-registry"
import { isVeryLargeDiffFile } from "@diffdash/domain/large-diff-policy"
import { makeReviewDiffIdentity } from "@diffdash/domain/review-identity"
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react"
import { ContextMenu } from "radix-ui"
import { Effect, Option } from "effect"
import { type RefObject, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  FileDiff,
  type FileDiffMetadata,
  type FileDiffOptions,
  getSingularPatch,
  type PierreFileDiff,
  useStableCallback,
  type VirtualFileMetrics,
} from "./pierre"
import { diffCardDomId } from "./viewed-file-viewport"
import type { ReviewDiffAnnotationMetadata } from "./review-diff-annotation"
import { Badge } from "@/shared/ui/badge"
import { isHTMLElement } from "@/shared/dom"
import { Button } from "@/shared/ui/button"
import { EmptyState } from "@/shared/ui/empty-state"
import { MiddleTruncatedText } from "@/shared/ui/middle-truncated-text"
import {
  SourceSurfaceContributionId,
  decodePierrePositiveInteger,
  type SourceSurfaceRuntime,
} from "@/source-surface/source-surface-runtime"

type ReviewDiffCardAnnotation = {
  readonly lineNumber: number
  readonly side: "additions" | "deletions"
  readonly metadata: ReviewDiffAnnotationMetadata
}

const REVIEW_DIFF_METRICS = {
  diffHeaderHeight: 0,
  hunkLineCount: 50,
  lineHeight: 20,
  paddingBottom: 0,
  paddingTop: 0,
  spacing: 0,
} satisfies VirtualFileMetrics

type DiffLineContextMenuState =
  | { readonly status: "closed" }
  | {
      readonly status: "open"
      readonly lineNumber: number
      readonly copyStatus: "idle" | "copying" | "failed"
    }

/** Virtualized diff card with viewed, expansion, file-open, and inline-thread interactions. */
export const OpenDiffCard = ({
  diffOptions,
  expanded,
  annotationProvider,
  navigationAnchor,
  file,
  forceExpanded,
  selected,
  surfaceRuntime,
  viewed,
  onFileAnchorChange,
  onOpenFile,
  onActivateLine,
  onAnnotationsRendered,
  onSelect,
  onSetViewed,
  onToggleExpanded,
}: {
  readonly diffOptions: FileDiffOptions<ReviewDiffCardAnnotation["metadata"]>
  readonly annotationProvider: ReviewDiffContributionOutput["annotations"]
  readonly navigationAnchor: Parameters<ReviewDiffContributionOutput["annotations"]>[1]
  readonly expanded: boolean
  readonly file: ParsedDiffFile
  readonly forceExpanded: boolean
  readonly selected: boolean
  readonly surfaceRuntime: SourceSurfaceRuntime<
    PierreFileDiff<ReviewDiffCardAnnotation["metadata"]>
  >
  readonly viewed: boolean
  readonly onFileAnchorChange: (element: HTMLElement, focusElement: HTMLElement) => () => void
  readonly onOpenFile: () => void
  readonly onActivateLine: (side: "additions" | "deletions", lineNumber: number) => boolean
  readonly onAnnotationsRendered: (card: HTMLElement) => void
  readonly onSelect: () => void
  readonly onSetViewed: (viewed: boolean) => void
  readonly onToggleExpanded: () => void
}) => {
  const fileCardRef = useRef<HTMLElement>(null)
  const fileHeaderFocusRef = useRef<HTMLButtonElement>(null)
  const copyOperationRef = useRef(0)
  const threadHistorySyncFrameRef = useRef<number | null>(null)
  const localContributionId = useId()
    .replaceAll(/[^a-z0-9]+/giu, "")
    .toLowerCase()
  const renderObserverId = SourceSurfaceContributionId.make(
    `diffdash.builtin.review-card.${localContributionId}`,
  )
  const [contextMenuState, setContextMenuState] = useState<DiffLineContextMenuState>({
    status: "closed",
  })
  const [renderedPatch, setRenderedPatch] = useState<string | null>(null)
  const diffReady = renderedPatch === file.patch
  const renderAsPlainText = isVeryLargeDiffFile(file)
  const isExpanded = forceExpanded || (expanded && !viewed)
  const pierreFileDiff = useMemo(
    () =>
      ({
        ...getSingularPatch(file.patch),
        cacheKey: `${file.fileId}:${makeReviewDiffIdentity(file.patch)}`,
      }) satisfies FileDiffMetadata,
    [file.fileId, file.patch],
  )
  const annotations = useMemo<readonly ReviewDiffCardAnnotation[]>(
    () =>
      annotationProvider(file, navigationAnchor).map(
        ({ lineNumber, side, render }: ReviewDiffContributionAnnotation) => ({
          lineNumber,
          side,
          metadata: { render },
        }),
      ),
    [annotationProvider, file, navigationAnchor],
  )
  const onGutterUtilityClick = useStableCallback<
    NonNullable<FileDiffOptions<ReviewDiffCardAnnotation["metadata"]>["onGutterUtilityClick"]>
  >(({ side, start }) => {
    if (side === undefined) return
    onActivateLine(side, start)
  })
  const onLineClick = useStableCallback<
    NonNullable<FileDiffOptions<ReviewDiffCardAnnotation["metadata"]>["onLineClick"]>
  >(({ annotationSide, event, lineNumber, numberColumn }) => {
    if (numberColumn) return
    if (
      isHTMLElement(event.target) &&
      event.target.closest("[data-review-contribution-annotation]") !== null
    ) {
      return
    }
    onActivateLine(annotationSide, lineNumber)
  })
  const publishSurfaceRender = useMemo(
    () => surfaceRuntime.createRenderPublisher(file.reviewKey),
    [file.reviewKey, surfaceRuntime],
  )
  const interactiveDiffOptions = useMemo<FileDiffOptions<ReviewDiffCardAnnotation["metadata"]>>(
    () =>
      renderAsPlainText
        ? {
            ...diffOptions,
            tokenizeMaxLength: 0,
            onGutterUtilityClick,
            onLineClick,
            onPostRender: publishSurfaceRender,
          }
        : {
            ...diffOptions,
            onGutterUtilityClick,
            onLineClick,
            onPostRender: publishSurfaceRender,
          },
    [diffOptions, onGutterUtilityClick, onLineClick, publishSurfaceRender, renderAsPlainText],
  )
  useLayoutEffect(
    () =>
      Effect.runSync(
        surfaceRuntime.registerRenderObserver(renderObserverId, ({ phase, surfaceId }) => {
          if (surfaceId !== file.reviewKey || phase === "unmount") return
          setRenderedPatch(file.patch)
          if (annotations.length === 0 || threadHistorySyncFrameRef.current !== null) return
          threadHistorySyncFrameRef.current = window.requestAnimationFrame(() => {
            threadHistorySyncFrameRef.current = null
            const card = document.getElementById(diffCardDomId(file.reviewKey))
            if (card !== null) onAnnotationsRendered(card)
          })
        }),
      ),
    [
      annotations.length,
      file.patch,
      file.reviewKey,
      onAnnotationsRendered,
      renderObserverId,
      surfaceRuntime,
    ],
  )
  useLayoutEffect(
    () => () => {
      if (threadHistorySyncFrameRef.current === null) return
      window.cancelAnimationFrame(threadHistorySyncFrameRef.current)
      threadHistorySyncFrameRef.current = null
    },
    [],
  )
  useLayoutEffect(() => {
    const card = fileCardRef.current
    const focusElement = fileHeaderFocusRef.current
    if (card === null || focusElement === null) return undefined
    return onFileAnchorChange(card, focusElement)
  }, [onFileAnchorChange])

  if (file.status === "binary" || file.hunks.length === 0) {
    return (
      <section
        ref={fileCardRef}
        id={diffCardDomId(file.reviewKey)}
        data-review-file-id={file.fileId}
        data-diff-card-path={file.path}
        data-diff-file-status={file.status}
        data-diff-selected={selected ? "" : undefined}
        className="bg-card scroll-mt-14 overflow-clip rounded-2xl border"
      >
        <DiffCardHeader
          expanded={isExpanded}
          file={file}
          focusRef={fileHeaderFocusRef}
          viewed={viewed}
          onOpenFile={onOpenFile}
          onSelect={onSelect}
          onSetViewed={onSetViewed}
          onToggleExpanded={onToggleExpanded}
        />
        {isExpanded ? (
          <div className="p-4">
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
      ref={fileCardRef}
      id={diffCardDomId(file.reviewKey)}
      data-review-file-id={file.fileId}
      data-diff-card-path={file.path}
      data-diff-file-status={file.status}
      data-diff-selected={selected ? "" : undefined}
      data-diff-render-mode={renderAsPlainText ? "plain" : "highlighted"}
      className="bg-card scroll-mt-14 overflow-clip rounded-2xl border"
    >
      <DiffCardHeader
        expanded={isExpanded}
        file={file}
        focusRef={fileHeaderFocusRef}
        viewed={viewed}
        onOpenFile={onOpenFile}
        onSelect={onSelect}
        onSetViewed={onSetViewed}
        onToggleExpanded={onToggleExpanded}
      />
      {isExpanded ? (
        <ContextMenu.Root
          open={contextMenuState.status === "open"}
          onOpenChange={(open) => {
            if (open) return
            copyOperationRef.current += 1
            setContextMenuState({ status: "closed" })
          }}
        >
          <ContextMenu.Trigger asChild>
            <div
              data-diff-card-body
              aria-busy={!diffReady}
              className="bg-diff-canvas relative overflow-hidden"
              onContextMenu={(event) => {
                const lineNumber = diffLineNumberFromEventPath(event.nativeEvent.composedPath())
                Option.match(lineNumber, {
                  onNone: () => {
                    event.preventDefault()
                    copyOperationRef.current += 1
                    setContextMenuState({ status: "closed" })
                  },
                  onSome: (selectedLineNumber) => {
                    copyOperationRef.current += 1
                    setContextMenuState({
                      status: "open",
                      lineNumber: selectedLineNumber,
                      copyStatus: "idle",
                    })
                  },
                })
              }}
            >
              {diffReady ? null : <DiffLoadingSkeleton />}
              <FileDiff<ReviewDiffCardAnnotation["metadata"]>
                className="block text-xs"
                fileDiff={pierreFileDiff}
                lineAnnotations={[...annotations]}
                metrics={REVIEW_DIFF_METRICS}
                options={interactiveDiffOptions}
                renderAnnotation={(annotation) => annotation.metadata.render()}
              />
            </div>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content
              aria-label="Diff line actions"
              className="bg-popover text-popover-foreground z-50 min-w-44 overflow-hidden rounded-xl border p-1 shadow-lg"
            >
              <ContextMenu.Item
                className="data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-xs outline-none"
                disabled={
                  contextMenuState.status === "open" && contextMenuState.copyStatus === "copying"
                }
                onSelect={(event) => {
                  if (contextMenuState.status !== "open") return
                  event.preventDefault()
                  const lineNumber = contextMenuState.lineNumber
                  const operation = copyOperationRef.current + 1
                  copyOperationRef.current = operation
                  setContextMenuState({ ...contextMenuState, copyStatus: "copying" })
                  void navigator.clipboard.writeText(`@${file.path}:${lineNumber}`).then(
                    () => {
                      if (copyOperationRef.current !== operation) return undefined
                      setContextMenuState({ status: "closed" })
                      return undefined
                    },
                    () => {
                      if (copyOperationRef.current !== operation) return undefined
                      setContextMenuState((current) =>
                        current.status === "open" && current.lineNumber === lineNumber
                          ? { ...current, copyStatus: "failed" }
                          : current,
                      )
                      return undefined
                    },
                  )
                }}
              >
                <Copy className="text-muted-foreground size-3.5 shrink-0" />
                <span>
                  {contextMenuState.status === "open" && contextMenuState.copyStatus === "copying"
                    ? "Copying path..."
                    : contextMenuState.status === "open" && contextMenuState.copyStatus === "failed"
                      ? "Copy failed, retry"
                      : "Copy path"}
                </span>
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      ) : null}
    </section>
  )
}

const diffLineNumberFromEventPath = (path: readonly EventTarget[]) =>
  Option.firstSomeOf(
    path.map((target) =>
      Option.flatMap(Option.liftPredicate(target, isHTMLElement), (element) =>
        Option.flatMap(
          Option.fromNullishOr(
            element.getAttribute("data-line") ?? element.getAttribute("data-column-number"),
          ),
          decodePierrePositiveInteger,
        ),
      ),
    ),
  )

const DiffLoadingSkeleton = () => (
  <div
    data-diff-loading-skeleton
    aria-hidden="true"
    className="bg-diff-canvas pointer-events-none absolute inset-x-0 top-0 z-10 space-y-2 px-3 py-3"
  >
    <div className="bg-muted h-3 w-3/4 rounded-sm" />
    <div className="bg-muted h-3 w-11/12 rounded-sm" />
    <div className="bg-muted h-3 w-2/3 rounded-sm" />
    <div className="bg-muted h-3 w-4/5 rounded-sm" />
  </div>
)

const DiffCardHeader = ({
  expanded,
  file,
  focusRef,
  viewed,
  onOpenFile,
  onSelect,
  onSetViewed,
  onToggleExpanded,
}: {
  readonly expanded: boolean
  readonly file: ParsedDiffFile
  readonly focusRef: RefObject<HTMLButtonElement | null>
  readonly viewed: boolean
  readonly onOpenFile: () => void
  readonly onSelect: () => void
  readonly onSetViewed: (viewed: boolean) => void
  readonly onToggleExpanded: () => void
}) => {
  const ChevronIcon = expanded ? ChevronDown : ChevronRight
  return (
    <div
      data-diff-card-header
      className="border-review-sidebar-divider flex items-center justify-between gap-3 border-b px-3 py-2"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
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
        <button
          ref={focusRef}
          type="button"
          className="min-w-0 flex-1 overflow-hidden text-left"
          aria-label={`Select ${file.path}`}
          title={file.path}
          onClick={onSelect}
        >
          <div className="min-w-0">
            <MiddleTruncatedText
              value={file.path}
              className={`font-mono text-xs tracking-wide ${viewed ? "text-muted-foreground" : ""}`}
            />
            {file.oldPath === null ? null : (
              <MiddleTruncatedText
                value={`from ${file.oldPath}`}
                className="text-muted-foreground text-caption font-mono"
              />
            )}
          </div>
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="secondary" className="text-caption gap-1">
          <span className="text-review-success-text">+{file.additions}</span>
          <span className="text-review-danger-text">-{file.deletions}</span>
        </Badge>
        <Badge
          variant="secondary"
          data-diff-status-badge={file.status}
          className="text-caption capitalize"
        >
          {file.status}
        </Badge>
        <Button variant="outline" onClick={onOpenFile}>
          Open
        </Button>
        <label
          className={`relative flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors ${viewed ? "border-review-success/20 bg-review-success/[0.06] text-review-success-text hover:bg-review-success/10" : "hover:bg-accent"}`}
        >
          <input
            type="checkbox"
            checked={viewed}
            className="peer sr-only"
            onChange={(event) => onSetViewed(event.currentTarget.checked)}
          />
          <span
            aria-hidden="true"
            className={`flex size-3.5 items-center justify-center rounded-sm border transition-colors ${viewed ? "border-review-success bg-review-success text-review-success-foreground" : "border-muted-foreground/50 bg-background"}`}
          >
            {viewed ? <Check className="size-3" strokeWidth={3} /> : null}
          </span>
          Viewed
        </label>
      </div>
    </div>
  )
}
