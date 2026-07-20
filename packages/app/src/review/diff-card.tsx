import type { ParsedDiffFile } from "@diffdash/domain/diff"
import { isVeryLargeDiffFile } from "@diffdash/domain/large-diff-policy"
import type { ReviewThreadAnchor } from "@diffdash/domain/review-thread"
import { Check, ChevronDown, ChevronRight } from "lucide-react"
import { useMemo, useState } from "react"
import {
  type FileDiffOptions,
  PatchDiff,
  useStableCallback,
  type VirtualFileMetrics,
} from "./pierre"
import {
  lineReviewAnchor,
  type ReviewThreadAnnotation,
  reviewThreadAnnotationContentId,
  reviewThreadAnnotations,
} from "./thread-annotations"
import { diffCardDomId } from "./viewed-file-viewport"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { EmptyState } from "@/shared/ui/empty-state"
import {
  ReviewThreadComposer,
  ReviewThreadPanel,
  type ReviewThreadsController,
  reviewLineLabel,
} from "@/threads/review-threads"

const REVIEW_DIFF_METRICS = {
  diffHeaderHeight: 0,
  hunkLineCount: 50,
  lineHeight: 20,
  paddingBottom: 0,
  paddingTop: 0,
  spacing: 0,
} satisfies VirtualFileMetrics

/** Virtualized diff card with viewed, expansion, file-open, and inline-thread interactions. */
export const OpenDiffCard = ({
  diffOptions,
  expanded,
  expandedLineAnchor,
  file,
  forceExpanded,
  reviewThreads,
  selected,
  viewed,
  onDiffRendered,
  onOpenFile,
  onSelect,
  onSetViewed,
  onToggleLine,
  onToggleExpanded,
}: {
  readonly diffOptions: FileDiffOptions<ReviewThreadAnnotation>
  readonly expanded: boolean
  readonly expandedLineAnchor: ReviewThreadAnchor | null
  readonly file: ParsedDiffFile
  readonly forceExpanded: boolean
  readonly reviewThreads: ReviewThreadsController
  readonly selected: boolean
  readonly viewed: boolean
  readonly onDiffRendered: NonNullable<FileDiffOptions<ReviewThreadAnnotation>["onPostRender"]>
  readonly onOpenFile: () => void
  readonly onSelect: () => void
  readonly onSetViewed: (viewed: boolean) => void
  readonly onToggleLine: (anchor: ReviewThreadAnchor) => void
  readonly onToggleExpanded: () => void
}) => {
  const [renderedPatch, setRenderedPatch] = useState<string | null>(null)
  const diffReady = renderedPatch === file.patch
  const renderAsPlainText = isVeryLargeDiffFile(file)
  const isExpanded = forceExpanded || (expanded && !viewed)
  const annotations = useMemo(
    () => reviewThreadAnnotations(file, reviewThreads.details, expandedLineAnchor),
    [expandedLineAnchor, file, reviewThreads.details],
  )
  const onGutterUtilityClick = useStableCallback<
    NonNullable<FileDiffOptions<ReviewThreadAnnotation>["onGutterUtilityClick"]>
  >(({ side, start }) => {
    if (side === undefined) return
    const anchor = lineReviewAnchor(file, side, start)
    if (anchor !== null) onToggleLine(anchor)
  })
  const onLineClick = useStableCallback<
    NonNullable<FileDiffOptions<ReviewThreadAnnotation>["onLineClick"]>
  >(({ annotationSide, event, lineNumber, numberColumn }) => {
    if (numberColumn) return
    if (
      event.target instanceof Element &&
      event.target.closest("[data-review-thread-annotation]") !== null
    ) {
      return
    }
    const anchor = lineReviewAnchor(file, annotationSide, lineNumber)
    if (anchor !== null) onToggleLine(anchor)
  })
  const onPostRender = useStableCallback<
    NonNullable<FileDiffOptions<ReviewThreadAnnotation>["onPostRender"]>
  >((node, instance, phase) => {
    if (phase === "unmount") {
      onDiffRendered(node, instance, phase)
      return
    }
    setRenderedPatch(file.patch)
    onDiffRendered(node, instance, phase)
  })
  const interactiveDiffOptions = useMemo<FileDiffOptions<ReviewThreadAnnotation>>(
    () => ({
      ...diffOptions,
      ...(renderAsPlainText ? { tokenizeMaxLength: 0 } : {}),
      onGutterUtilityClick,
      onLineClick,
      onPostRender,
    }),
    [diffOptions, onGutterUtilityClick, onLineClick, onPostRender, renderAsPlainText],
  )
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
      data-diff-render-mode={renderAsPlainText ? "plain" : "highlighted"}
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
        <div
          data-diff-card-body
          aria-busy={!diffReady}
          className="bg-background relative -mt-px overflow-hidden border-t"
        >
          {diffReady ? null : <DiffLoadingSkeleton />}
          <PatchDiff<ReviewThreadAnnotation>
            className="block text-xs"
            lineAnnotations={annotations}
            metrics={REVIEW_DIFF_METRICS}
            options={interactiveDiffOptions}
            patch={file.patch}
            renderAnnotation={(annotation) => {
              const { anchor, details, draftAnchor, expanded: reviewExpanded } = annotation.metadata
              const contentId = reviewThreadAnnotationContentId(anchor)
              return (
                <div
                  data-review-thread-annotation
                  className="bg-background box-border w-full min-w-0 max-w-full overflow-x-clip px-3 py-1.5 [overflow-wrap:anywhere]"
                >
                  <section className="bg-card overflow-hidden rounded-lg border shadow-xs">
                    <button
                      type="button"
                      className="text-muted-foreground hover:bg-muted/45 hover:text-foreground focus-visible:ring-ring flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
                      aria-controls={contentId}
                      aria-expanded={reviewExpanded}
                      onClick={() => onToggleLine(anchor)}
                    >
                      {reviewExpanded ? (
                        <ChevronDown className="size-3.5 shrink-0" />
                      ) : (
                        <ChevronRight className="size-3.5 shrink-0" />
                      )}
                      <span>
                        Review on{" "}
                        <strong className="text-foreground">{reviewLineLabel(anchor)}</strong>
                      </span>
                    </button>
                    {reviewExpanded ? (
                      <div id={contentId} className="divide-y border-t">
                        {details.map((threadDetails) => (
                          <ReviewThreadPanel
                            key={threadDetails.thread.id}
                            embedded
                            agentRunning={reviewThreads.runningThreadIds.includes(
                              threadDetails.thread.id,
                            )}
                            agentProgress={
                              reviewThreads.agentProgress.find(
                                (progress) => progress.threadId === threadDetails.thread.id,
                              )?.stage ?? null
                            }
                            agentError={reviewThreads.agentErrors[threadDetails.thread.id] ?? null}
                            details={threadDetails}
                            orchestration={{ retryAgentMessage: reviewThreads.runAgent }}
                            onAddUserMessage={reviewThreads.addUserMessage}
                            onRefresh={reviewThreads.refreshThread}
                          />
                        ))}
                        {draftAnchor === null ? null : (
                          <div className="p-3">
                            <ReviewThreadComposer
                              label="Line comment"
                              onCancel={() => onToggleLine(draftAnchor)}
                              onSubmit={async (bodyMarkdown) => {
                                await reviewThreads.createThread(draftAnchor, bodyMarkdown)
                              }}
                            />
                          </div>
                        )}
                      </div>
                    ) : null}
                  </section>
                </div>
              )
            }}
          />
        </div>
      ) : null}
    </section>
  )
}

const DiffLoadingSkeleton = () => (
  <div
    data-diff-loading-skeleton
    aria-hidden="true"
    className="bg-background pointer-events-none absolute inset-x-0 top-0 z-10 space-y-2 px-3 py-3"
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
          className={`relative flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors ${viewed ? "border-review-success/45 bg-review-success/10 text-review-success hover:bg-review-success/15" : "hover:bg-accent"}`}
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
