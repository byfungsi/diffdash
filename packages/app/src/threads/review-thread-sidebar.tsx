/* oxlint-disable eslint/no-underscore-dangle -- Sidebar states use the project-standard tagged-union discriminant. */
import type { ReviewThreadDetails, ReviewThreadId } from "@diffdash/domain/review-thread"
import { Match } from "effect"
import { Loader2, X } from "lucide-react"
import { type ReactNode, type RefObject, useEffect, useEffectEvent, useRef } from "react"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { EmptyState } from "@/shared/ui/empty-state"
import { MiddleTruncatedText } from "@/shared/ui/middle-truncated-text"
import { UnicodeLoadingText } from "@/shared/ui/unicode-loading-text"
import { cn } from "@/shared/utils"
import { ReviewThreadPanel, type ReviewThreadsController } from "./review-threads"
import {
  fallbackThreadLabel,
  reviewLineLabel,
  reviewThreadIsPreviousRevision,
} from "./review-thread-presentation"

/** Progressive visibility state for the attached review thread panels. */
export type ReviewThreadSidebarState =
  | { readonly _tag: "collapsed" }
  | { readonly _tag: "list" }
  | { readonly _tag: "detail"; readonly threadId: ReviewThreadId }

/** Stable thread-row button registry used to restore focus after closing detail. */
export type ReviewThreadButtonRefs = RefObject<Map<ReviewThreadId, HTMLButtonElement>>

/** Full-height thread list pane content. */
export function ReviewThreadListPane({
  buttonRefs,
  children,
  controller,
  navigableThreadIds,
  state,
  onCollapse,
  onOpenDetail,
}: {
  readonly buttonRefs: ReviewThreadButtonRefs
  readonly children?: ReactNode
  readonly controller: ReviewThreadsController
  readonly navigableThreadIds: ReadonlySet<ReviewThreadId>
  readonly state: ReviewThreadSidebarState
  readonly onCollapse: () => void
  readonly onOpenDetail: (threadId: ReviewThreadId) => void
}) {
  const count = controller.details.length

  useEffect(() => {
    if (!Match.valueTags(state, { list: () => true, collapsed: () => false, detail: () => false }))
      return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      onCollapse()
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [onCollapse, state])

  return (
    <aside
      id="review-thread-list"
      aria-label="Review threads"
      data-review-thread-list
      className="bg-review-sidebar text-review-sidebar-fg relative z-20 flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <header className="border-review-sidebar-divider flex h-9 shrink-0 items-center gap-3 border-b px-3">
        <h2 className="text-caption min-w-0 flex-1 font-semibold tracking-wide uppercase">
          Threads
        </h2>
        {children}
      </header>

      {controller.error === null ? null : (
        <div
          role="alert"
          className="border-review-sidebar-divider bg-review-sidebar-control/35 border-b p-3 text-xs"
        >
          <p className="text-destructive">{controller.error}</p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="mt-2"
            disabled={controller.loading}
            onClick={() => void controller.reload()}
          >
            Retry
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {controller.loading ? (
          <UnicodeLoadingText className="text-review-sidebar-muted p-3 text-xs" text="Loading" />
        ) : null}
        {!controller.loading && count === 0 ? (
          <EmptyState className="m-2 p-5 text-xs">No review threads yet.</EmptyState>
        ) : null}
        <div data-review-thread-items>
          {controller.details.map((details) => {
            const { thread } = details
            const anchor = thread.displayAnchor
            const navigable = navigableThreadIds.has(thread.id)
            const previousRevision = reviewThreadIsPreviousRevision(thread)
            const selected = Match.valueTags(state, {
              detail: ({ threadId }) => threadId === thread.id,
              collapsed: () => false,
              list: () => false,
            })
            const initialMessage = details.messages[0]
            return (
              <div
                key={thread.id}
                data-review-thread-list-item={thread.id}
                className={cn(
                  "border-review-sidebar-divider flex min-w-0 items-stretch border-b transition-colors",
                  selected
                    ? "bg-review-tree-selected text-review-sidebar-emphasis"
                    : "hover:bg-review-sidebar-control-hover",
                )}
              >
                <button
                  ref={(node) => {
                    if (node === null) buttonRefs.current.delete(thread.id)
                    else buttonRefs.current.set(thread.id, node)
                  }}
                  type="button"
                  className="focus-visible:ring-ring min-w-0 flex-1 px-3 py-2.5 text-left focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
                  aria-label={`Open thread details for ${anchor.filePath} ${reviewLineLabel(anchor)}`}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onOpenDetail(thread.id)}
                >
                  <span className="flex min-w-0 items-center gap-2 text-xs">
                    <MiddleTruncatedText value={anchor.filePath} className="font-mono" />
                    {!Match.valueTags(thread.currentAnchor, {
                      Active: () => true,
                      Outdated: () => false,
                      Unresolved: () => false,
                    }) ||
                    previousRevision ||
                    !navigable ? (
                      <span className="text-review-sidebar-muted shrink-0">
                        {Match.valueTags(thread.currentAnchor, {
                          Active: () =>
                            previousRevision ? "Previous revision" : fallbackThreadLabel(details),
                          Outdated: () => fallbackThreadLabel(details),
                          Unresolved: () => fallbackThreadLabel(details),
                        })}
                      </span>
                    ) : null}
                  </span>
                  {initialMessage === undefined ? null : (
                    <span className="text-review-sidebar-muted mt-1 block truncate text-caption">
                      {Match.valueTags(initialMessage, {
                        User: ({ bodyMarkdown }) => bodyMarkdown,
                        Completed: ({ bodyMarkdown }) => bodyMarkdown,
                        Pending: () => "Agent response",
                        Failed: () => "Agent response",
                      })}
                    </span>
                  )}
                </button>
                <div className="text-review-sidebar-muted flex shrink-0 items-center gap-1.5 px-3 text-caption">
                  {controller.runningThreadIds.includes(thread.id) ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : null}
                  <span data-review-thread-line-label>{reviewLineLabel(anchor)}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </aside>
  )
}

/** Full-height structural pane for the selected thread conversation. */
export function ReviewThreadDetailPane({
  buttonRefs,
  controller,
  navigableThreadIds,
  state,
  onClose,
  onGoToDiff,
}: {
  readonly buttonRefs: ReviewThreadButtonRefs
  readonly controller: ReviewThreadsController
  readonly navigableThreadIds: ReadonlySet<ReviewThreadId>
  readonly state: ReviewThreadSidebarState
  readonly onClose: (threadId: ReviewThreadId) => void
  readonly onGoToDiff: (details: ReviewThreadDetails) => void
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const selectedThreadId = Match.valueTags(state, {
    detail: ({ threadId }) => threadId,
    collapsed: () => null,
    list: () => null,
  })
  const selectedDetails =
    selectedThreadId === null
      ? null
      : (controller.details.find((details) => details.thread.id === selectedThreadId) ?? null)
  const selectedAnchor = selectedDetails === null ? null : selectedDetails.thread.displayAnchor
  const closeDetail = (threadId: ReviewThreadId) => {
    onClose(threadId)
    window.requestAnimationFrame(() => buttonRefs.current.get(threadId)?.focus())
  }
  const closeDetailFromEffect = useEffectEvent(closeDetail)
  const selectedDetailAvailable = selectedDetails !== null

  useEffect(() => {
    if (selectedThreadId === null || !selectedDetailAvailable) return undefined
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      closeDetailFromEffect(selectedThreadId)
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener("keydown", closeOnEscape)
    }
  }, [selectedDetailAvailable, selectedThreadId])

  if (selectedThreadId === null || selectedDetails === null || selectedAnchor === null) return null

  return (
    <aside
      aria-label="Thread details"
      data-review-thread-detail
      className="bg-card relative z-10 flex h-full min-h-0 min-w-0 flex-col overflow-hidden outline-none"
    >
      <header className="bg-muted/25 shrink-0 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <MiddleTruncatedText
            value={selectedAnchor.filePath}
            className="flex-1 font-mono text-xs"
          />
          <Button
            ref={closeButtonRef}
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Close thread details"
            onClick={() => closeDetail(selectedThreadId)}
          >
            <X />
          </Button>
        </div>
        <div className="text-muted-foreground mt-0.5 flex min-h-5 flex-wrap items-center gap-1.5 text-caption">
          <span>{reviewLineLabel(selectedAnchor)}</span>
          {navigableThreadIds.has(selectedDetails.thread.id) ? (
            <Button
              type="button"
              size="xs"
              variant="link"
              aria-label="Go to thread in diff"
              className="h-auto px-0 py-0 text-caption underline decoration-dashed"
              onClick={() => onGoToDiff(selectedDetails)}
            >
              go to diff
            </Button>
          ) : null}
          {reviewThreadIsPreviousRevision(selectedDetails.thread) ? (
            <Badge variant="outline" className="h-5 px-1.5 text-caption">
              Previous revision
            </Badge>
          ) : null}
          {Match.valueTags(selectedDetails.thread.currentAnchor, {
            Active: () => null,
            Outdated: () => (
              <Badge variant="outline" className="h-5 px-1.5 text-caption">
                {fallbackThreadLabel(selectedDetails)}
              </Badge>
            ),
            Unresolved: () => (
              <Badge variant="outline" className="h-5 px-1.5 text-caption">
                {fallbackThreadLabel(selectedDetails)}
              </Badge>
            ),
          })}
        </div>
      </header>
      <ReviewThreadPanel
        embedded
        fullHeight
        agentRunning={controller.runningThreadIds.includes(selectedDetails.thread.id)}
        agentProgress={
          controller.agentProgress.find(
            (progress) => progress.threadId === selectedDetails.thread.id,
          )?.stage ?? null
        }
        agentError={controller.agentErrors[selectedDetails.thread.id] ?? null}
        details={selectedDetails}
        orchestration={{ retryAgentMessage: controller.runAgent }}
        onAddUserMessage={controller.addUserMessage}
        onRefresh={controller.refreshThread}
      />
    </aside>
  )
}
