import { CommentSubmissionReceipt } from "@diffdash/domain/comment"
import { type ReviewThreadAnchor, type ReviewThreadDetails } from "@diffdash/domain/review-thread"
import { Match, Option } from "effect"
import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import type {
  ReviewDiffContributionOutput,
  ReviewDiffContributionProps,
  ProjectActivityPaneProps,
} from "../extension-registry"
import { useReviewDiffContributionRegistration } from "../review-diff-contribution-host"
import { useReviewSurfaceCapability } from "../review/review-surface-capability"
import { REVIEW_COMMENTS_ACTIVITY_ID } from "./review-comments-identities"
import {
  lineReviewAnchor,
  reviewThreadAnnotationContentId,
  reviewThreadAnnotations,
  sameReviewThreadLine,
} from "./thread-annotations"
import { Button } from "@/shared/ui/button"
import { ReviewThreadDetailPane, ReviewThreadListPane } from "./review-thread-sidebar"
import { useReviewCommentsReviewState } from "./review-comments-review-state"
import { ReviewThreadComposer, ReviewThreadPanel, useReviewThreads } from "./review-threads"
import { reviewLineLabel, syncPinnedReviewThreadHistories } from "./review-thread-presentation"
import { ReviewThreadScope, reviewThreadScopeIdentity } from "./review-thread-scope"

/** Review Comments behavior mounted into one active Review diff host. */
export const ReviewCommentsReviewDiffContribution = (props: ReviewDiffContributionProps) => {
  const scope = reviewThreadScope(props)
  const controller = useReviewThreads(scope)
  const reviewCapability = useReviewSurfaceCapability()
  const reviewComments = useReviewCommentsReviewState()
  const controllerRef = useRef(controller)
  controllerRef.current = controller
  const [expandedLineAnchor, setExpandedLineAnchor] = useState<Option.Option<ReviewThreadAnchor>>(
    Option.none,
  )
  const sidebarState = reviewComments.sidebarState
  const setSidebarState = reviewComments.setSidebarState
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
  }, [controller.details, controller.loading, selectedThreadId, setSidebarState])
  const openDetail = useCallback(
    (details: ReviewThreadDetails) => {
      setSidebarState({ _tag: "detail", threadId: details.thread.id })
      Option.match(reviewCapability, {
        onNone: () => undefined,
        onSome: (capability) => capability.panes.showDetail(REVIEW_COMMENTS_ACTIVITY_ID),
      })
    },
    [reviewCapability, setSidebarState],
  )
  const toggleLine = useCallback(
    (anchor: ReviewThreadAnchor) =>
      setExpandedLineAnchor((current) => {
        if (Option.exists(current, (expanded) => sameReviewThreadLine(expanded, anchor))) {
          return Option.none()
        }
        return Option.some(anchor)
      }),
    [],
  )
  const revealLine = useCallback((anchor: ReviewThreadAnchor) => {
    setExpandedLineAnchor(Option.some(anchor))
  }, [])
  const scopeKey = reviewThreadScopeIdentity(scope)
  const controllerRenderVersion = JSON.stringify([
    controller.details,
    controller.available,
    controller.loading,
    controller.agentErrors,
    controller.agentProgress,
    controller.error,
    controller.runningThreadIds,
  ])
  const publishReview = reviewComments.publish
  const clearReview = reviewComments.clear
  useLayoutEffect(
    () => publishReview(scopeKey, controllerRenderVersion, controller, revealLine),
    [controller, controllerRenderVersion, publishReview, revealLine, scopeKey],
  )
  useLayoutEffect(() => () => clearReview(scopeKey), [clearReview, scopeKey])
  const annotations = useCallback<ReviewDiffContributionOutput["annotations"]>(
    (file, navigationAnchor) =>
      reviewThreadAnnotations(
        file,
        controller.details,
        Option.orElse(navigationAnchor, () => expandedLineAnchor),
      ).map((annotation) => ({
        lineNumber: annotation.lineNumber,
        side: annotation.side,
        render: () => (
          <ReviewCommentsAnnotation
            annotation={annotation.metadata}
            controller={controllerRef.current}
            onOpenDetail={openDetail}
            onToggleLine={toggleLine}
          />
        ),
      })),
    [controller.details, expandedLineAnchor, openDetail, toggleLine],
  )
  const output = useMemo<ReviewDiffContributionOutput>(() => {
    void controllerRenderVersion
    return {
      activeLineAnchor: expandedLineAnchor,
      details: controller.details,
      annotations,
      activateLine: (file, side, lineNumber) => {
        const anchor = lineReviewAnchor(file, side, lineNumber)
        return Option.match(anchor, {
          onNone: () => false,
          onSome: (value) => {
            toggleLine(value)
            return true
          },
        })
      },
      annotationsRendered: syncPinnedReviewThreadHistories,
    }
  }, [controller.details, annotations, controllerRenderVersion, expandedLineAnchor, toggleLine])
  useReviewDiffContributionRegistration(output)
  return null
}

/** Review Comments list rendered through its generic activity context slot. */
export const ReviewCommentsReviewContextPane = ({ paneHost }: ProjectActivityPaneProps) => {
  const capability = useReviewSurfaceCapability()
  const reviewComments = useReviewCommentsReviewState()
  const registration = reviewComments.registration
  const setSidebarState = reviewComments.setSidebarState
  const listClosed = Match.valueTags(reviewComments.sidebarState, {
    collapsed: () => true,
    detail: () => !paneHost.detailOpen,
    list: () => false,
  })
  useEffect(() => {
    if (listClosed) {
      setSidebarState({ _tag: "list" })
    }
  }, [listClosed, setSidebarState])
  if (Option.isNone(capability) || registration === null) return null
  return (
    <ReviewThreadListPane
      buttonRefs={reviewComments.buttonRefs}
      controller={registration.controller}
      navigableThreadIds={capability.value.navigableThreadIds}
      state={reviewComments.sidebarState}
      onCollapse={() => {
        reviewComments.setSidebarState({ _tag: "collapsed" })
        paneHost.closeContext()
      }}
      onOpenDetail={(threadId) => {
        reviewComments.setSidebarState({ _tag: "detail", threadId })
        paneHost.openDetail()
      }}
    >
      {paneHost.contextActions}
    </ReviewThreadListPane>
  )
}

/** Review Comments detail rendered through its generic activity detail slot. */
export const ReviewCommentsReviewDetailPane = ({ paneHost }: ProjectActivityPaneProps) => {
  const capability = useReviewSurfaceCapability()
  const reviewComments = useReviewCommentsReviewState()
  const registration = reviewComments.registration
  if (!paneHost.detailOpen || Option.isNone(capability) || registration === null) return null
  return (
    <ReviewThreadDetailPane
      buttonRefs={reviewComments.buttonRefs}
      controller={registration.controller}
      navigableThreadIds={capability.value.navigableThreadIds}
      state={reviewComments.sidebarState}
      onClose={() => {
        reviewComments.setSidebarState({ _tag: "list" })
        paneHost.closeDetail()
      }}
      onGoToDiff={(details) => {
        const anchor = details.thread.activeAnchor
        if (anchor === null) return
        registration.revealLine(anchor)
        reviewComments.setSidebarState({ _tag: "collapsed" })
        capability.value.navigateToThread(details.thread.id)
      }}
    />
  )
}

/** Comments detail pane selected for Review and omitted on unsupported surfaces. */
export const ReviewCommentsActivityDetailPane = (props: ProjectActivityPaneProps) =>
  props.location.surface === "review" ? <ReviewCommentsReviewDetailPane {...props} /> : null

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
            {details.map((threadDetails) => {
              let detailNavigationProps: { readonly onOpenDetail?: () => void } = {}
              if (details.length > 1) {
                detailNavigationProps = { onOpenDetail: () => onOpenDetail(threadDetails) }
              }
              return (
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
                  {...detailNavigationProps}
                  onAddUserMessage={controller.addUserMessage}
                  onRefresh={controller.refreshThread}
                />
              )
            })}
            {Option.match(draftAnchor, {
              onNone: () => null,
              onSome: (anchor) => (
                <div className="p-3">
                  <ReviewThreadComposer
                    label="Line comment"
                    onCancel={() => onToggleLine(anchor)}
                    onSubmit={async (bodyMarkdown) => {
                      const receipt = await controller.createThread(anchor, bodyMarkdown)
                      CommentSubmissionReceipt.match(receipt, {
                        StoredLocally: () => undefined,
                        Forwarded: () => onToggleLine(anchor),
                      })
                    }}
                  />
                </div>
              ),
            })}
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
}: ReviewDiffContributionProps): ReviewThreadScope =>
  ReviewThreadScope.make({
    target,
    baseRevision: Option.some(baseRevision),
    headRevision: Option.some(headRevision),
  })
