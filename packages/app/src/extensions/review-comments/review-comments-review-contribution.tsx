import { CommentSubmissionReceipt } from "@diffdash/domain/comment"
import {
  type ReviewThreadAnchor,
  type ReviewThreadDetails,
  type ReviewThreadId,
} from "@diffdash/domain/review-thread"
import { Match } from "effect"
import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type {
  ReviewDiffContributionOutput,
  ReviewDiffContributionProps,
} from "../extension-registry"
import { useReviewDiffContributionRegistration } from "@/review/review-diff-contribution-host"
import {
  lineReviewAnchor,
  reviewThreadAnnotationContentId,
  reviewThreadAnnotations,
  sameReviewThreadLine,
} from "@/review/thread-annotations"
import { Button } from "@/shared/ui/button"
import {
  ReviewThreadDetailPane,
  ReviewThreadListPane,
  type ReviewThreadSidebarState,
} from "@/threads/review-thread-sidebar"
import {
  ReviewThreadComposer,
  ReviewThreadPanel,
  type ReviewThreadScope,
  useReviewThreads,
} from "@/threads/review-threads"
import {
  reviewLineLabel,
  syncPinnedReviewThreadHistories,
} from "@/threads/review-thread-presentation"

/** Review Comments behavior mounted into one active Review diff host. */
export const ReviewCommentsReviewDiffContribution = (props: ReviewDiffContributionProps) => {
  const controller = useReviewThreads(reviewThreadScope(props))
  const controllerRef = useRef(controller)
  controllerRef.current = controller
  const [expandedLineAnchor, setExpandedLineAnchor] = useState<ReviewThreadAnchor | null>(null)
  const [sidebarState, setSidebarState] = useState<ReviewThreadSidebarState>({ _tag: "collapsed" })
  const buttonRefs = useRef(new Map<ReviewThreadId, HTMLButtonElement>())
  const selectedThreadId = Match.valueTags(sidebarState, {
    collapsed: () => null,
    list: () => null,
    detail: ({ threadId }) => threadId,
  })
  useEffect(() => {
    if (
      selectedThreadId !== null &&
      !controller.loading &&
      !controller.details.some((details) => details.thread.id === selectedThreadId)
    ) {
      setSidebarState({ _tag: "list" })
    }
  }, [controller.details, controller.loading, selectedThreadId])
  const toggleLine = useCallback(
    (anchor: ReviewThreadAnchor) =>
      setExpandedLineAnchor((current) => (sameReviewThreadLine(current, anchor) ? null : anchor)),
    [],
  )
  const annotations = useCallback<ReviewDiffContributionOutput["annotations"]>(
    (file, navigationAnchor) =>
      reviewThreadAnnotations(file, controller.details, navigationAnchor ?? expandedLineAnchor).map(
        (annotation) => ({
          lineNumber: annotation.lineNumber,
          side: annotation.side,
          render: () => (
            <ReviewCommentsAnnotation
              annotation={annotation.metadata}
              controller={controllerRef.current}
              onOpenDetail={(details) =>
                setSidebarState({ _tag: "detail", threadId: details.thread.id })
              }
              onToggleLine={toggleLine}
            />
          ),
        }),
      ),
    [controller.details, expandedLineAnchor, toggleLine],
  )
  const controllerRenderVersion = JSON.stringify([
    controller.agentErrors,
    controller.agentProgress,
    controller.error,
    controller.runningThreadIds,
  ])

  const output = useMemo<ReviewDiffContributionOutput>(() => {
    void controllerRenderVersion
    return {
      activeLineAnchor: expandedLineAnchor,
      details: controller.details,
      loading: controller.loading,
      listOpen: Match.valueTags(sidebarState, {
        collapsed: () => false,
        list: () => true,
        detail: () => false,
      }),
      detailOpen: Match.valueTags(sidebarState, {
        collapsed: () => false,
        list: () => false,
        detail: () => true,
      }),
      annotations,
      activateLine: (file, side, lineNumber) => {
        const anchor = lineReviewAnchor(file, side, lineNumber)
        if (anchor === null) return false
        toggleLine(anchor)
        return true
      },
      annotationsRendered: syncPinnedReviewThreadHistories,
      openDetail: (details) => setSidebarState({ _tag: "detail", threadId: details.thread.id }),
      revealLine: setExpandedLineAnchor,
      showList: () => setSidebarState({ _tag: "list" }),
      collapse: () => setSidebarState({ _tag: "collapsed" }),
      renderContextPane: ({ navigableThreadIds, settings, onCollapse }) => (
        <ReviewThreadListPane
          buttonRefs={buttonRefs}
          controller={controllerRef.current}
          navigableThreadIds={navigableThreadIds}
          state={sidebarState}
          onCollapse={onCollapse}
          onOpenDetail={(threadId) => setSidebarState({ _tag: "detail", threadId })}
        >
          {settings}
        </ReviewThreadListPane>
      ),
      renderDetailPane: ({ navigableThreadIds, onClose, onGoToDiff }) => (
        <ReviewThreadDetailPane
          buttonRefs={buttonRefs}
          controller={controllerRef.current}
          navigableThreadIds={navigableThreadIds}
          state={sidebarState}
          onClose={onClose}
          onGoToDiff={onGoToDiff}
        />
      ),
    }
  }, [
    controller.details,
    controller.loading,
    annotations,
    controllerRenderVersion,
    expandedLineAnchor,
    sidebarState,
    toggleLine,
  ])
  useReviewDiffContributionRegistration(output)
  return null
}

const ReviewCommentsAnnotation = ({
  annotation,
  controller,
  onOpenDetail,
  onToggleLine,
}: {
  readonly annotation: ReturnType<typeof reviewThreadAnnotations>[number]["metadata"]
  readonly controller: ReturnType<typeof useReviewThreads>
  readonly onOpenDetail: (details: ReviewThreadDetails) => void
  readonly onToggleLine: (anchor: ReviewThreadAnchor) => void
}) => {
  const { anchor, details, draftAnchor, expanded } = annotation
  const contentId = reviewThreadAnnotationContentId(anchor)
  const singleThreadDetails = details.length === 1 ? (details.at(0) ?? null) : null
  return (
    <div
      data-review-contribution-annotation
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
              <ChevronDown className="size-3.5 shrink-0" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0" />
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
                title="Open thread details"
                onClick={() => onOpenDetail(singleThreadDetails)}
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
                agentRunning={controller.runningThreadIds.includes(threadDetails.thread.id)}
                agentProgress={
                  controller.agentProgress.find(
                    (progress) => progress.threadId === threadDetails.thread.id,
                  )?.stage ?? null
                }
                agentError={controller.agentErrors[threadDetails.thread.id] ?? null}
                details={threadDetails}
                orchestration={{ retryAgentMessage: controller.runAgent }}
                {...(details.length > 1 ? { onOpenDetail: () => onOpenDetail(threadDetails) } : {})}
                onAddUserMessage={controller.addUserMessage}
                onRefresh={controller.refreshThread}
              />
            ))}
            {draftAnchor === null ? null : (
              <div className="p-3">
                <ReviewThreadComposer
                  label="Line comment"
                  onCancel={() => onToggleLine(draftAnchor)}
                  onSubmit={async (bodyMarkdown) => {
                    const receipt = await controller.createThread(draftAnchor, bodyMarkdown)
                    CommentSubmissionReceipt.match(receipt, {
                      StoredLocally: () => undefined,
                      Forwarded: () => onToggleLine(draftAnchor),
                    })
                  }}
                />
              </div>
            )}
          </div>
        ) : null}
      </section>
    </div>
  )
}

const reviewThreadScope = ({
  target,
  baseRevision,
  headRevision,
}: ReviewDiffContributionProps): ReviewThreadScope => {
  if (target.kind === "hosted") {
    return { kind: "hosted", review: target.review, baseRevision, headRevision }
  }
  if (target.kind === "local") {
    return { kind: "local", target, baseRevision, headRevision }
  }
  return { kind: "repositoryComparison", target, baseRevision, headRevision }
}
