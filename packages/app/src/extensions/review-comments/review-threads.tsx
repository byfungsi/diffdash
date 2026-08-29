import type { AgentProviderFailure } from "@diffdash/domain/provider-failure"
import {
  REVIEW_AGENT_PROGRESS_LABELS,
  ReviewAgentProgress,
  type ReviewAgentProgressStage,
} from "@diffdash/domain/review-agent"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import {
  CommentDestination,
  CommentSubmission,
  CommentSubmissionReceipt,
  CommentSubject,
  CommentSubjectUnavailableError,
} from "@diffdash/domain/comment"
import { Array as EffectArray, Effect, Match, Option, Order, Schema } from "effect"
import {
  MarkdownBody,
  type ReviewThreadAnchor,
  ReviewThreadDetails,
  type ReviewThreadId,
  type ReviewThreadMessage,
  type ReviewThreadMessageId,
} from "@diffdash/domain/review-thread"
import { RunReviewThreadAgentRequest } from "@diffdash/protocol/review-threads"
import { AlertCircle, Bot, Loader2, MessageSquare, UserRound } from "lucide-react"
import {
  type KeyboardEvent,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { useCaptureAnalytics } from "@/shared/analytics"
import {
  runRendererPromise,
  useRendererStream,
  useReviewAutomation,
} from "@/platform/renderer-runtime"
import { formatError } from "@/shared/errors"
import { isDocumentOrShadowRoot } from "@/shared/dom"
import { formatTimestamp } from "@/shared/timestamp"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { MarkdownContent } from "@/shared/ui/markdown-content"
import { Textarea } from "@/shared/ui/textarea"
import { UnicodeLoadingText } from "@/shared/ui/unicode-loading-text"
import { cn } from "@/shared/utils"
import { useCommentSubmission } from "@/extensions/review-comments/comment-submission-context"
import {
  recordReviewThreadHistoryScrollState,
  reviewThreadIsPreviousRevision,
  syncPinnedReviewThreadHistories,
} from "./review-thread-presentation"
import {
  type ReviewThreadScope,
  type ReviewThreadScopeIdentity,
  reviewThreadScopeIdentity,
  reviewThreadTargetType,
} from "./review-thread-scope"

/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Scrollable conversation logs need keyboard focus. */

/** Optional orchestration seam for an agent API that is not currently exposed through preload. */
export type ReviewThreadOrchestration = {
  readonly retryAgentMessage: (threadId: ReviewThreadId) => Promise<void>
}

/** State and mutations shared by the review thread surfaces. */
export type ReviewThreadsController = {
  readonly details: readonly ReviewThreadDetails[]
  readonly error: string | null
  readonly loading: boolean
  readonly available: boolean
  readonly createThread: (
    anchor: ReviewThreadAnchor,
    bodyMarkdown: string,
  ) => Promise<CommentSubmissionReceipt>
  readonly addUserMessage: (threadId: ReviewThreadId, bodyMarkdown: string) => Promise<void>
  readonly runAgent: (threadId: ReviewThreadId) => Promise<void>
  readonly runningThreadIds: readonly ReviewThreadId[]
  readonly agentProgress: readonly ReviewAgentProgress[]
  readonly agentErrors: Readonly<Record<string, string>>
  readonly refreshThread: (threadId: ReviewThreadId) => Promise<void>
  readonly reload: () => Promise<void>
}

class ReviewThreadUnavailableError extends Schema.TaggedError<ReviewThreadUnavailableError>()(
  "ReviewThreadUnavailableError",
  {
    operation: Schema.Literals(["createThread", "runAgent"]),
    message: Schema.String,
  },
) {}

/** Loads and mutates persisted review threads exclusively through the typed preload API. */
export function useReviewThreads(scope: ReviewThreadScope): ReviewThreadsController {
  const captureAnalytics = useCaptureAnalytics()
  const automation = useReviewAutomation()
  const commentSubmission = useCommentSubmission()
  const [details, setDetails] = useState<readonly ReviewThreadDetails[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [runningThreadIds, setRunningThreadIds] = useState<readonly ReviewThreadId[]>([])
  const [agentProgress, setAgentProgress] = useState<readonly ReviewAgentProgress[]>([])
  const [agentErrors, setAgentErrors] = useState<Readonly<Record<string, string>>>({})
  const revisions = Option.all({
    baseRevision: scope.baseRevision,
    headRevision: scope.headRevision,
  })
  const target = scope.target
  const targetType = reviewThreadTargetType(target)
  const scopeKey = reviewThreadScopeIdentity(scope)
  const activeScopeKeyRef = useRef<ReviewThreadScopeIdentity | null>(scopeKey)
  const available = Option.isSome(revisions)
  const listThreadDetails = useEffectEvent(() => automation.threads.listDetails(target))

  useLayoutEffect(() => {
    activeScopeKeyRef.current = scopeKey
    return () => {
      if (activeScopeKeyRef.current === scopeKey) activeScopeKeyRef.current = null
    }
  }, [scopeKey])

  const load = async () => {
    const requestedScopeKey = scopeKey
    if (!available) {
      if (activeScopeKeyRef.current === requestedScopeKey) {
        setDetails([])
        setLoading(false)
        setError("Comments are unavailable until the review revisions are known.")
      }
      return
    }

    setLoading(true)
    setError(null)
    try {
      const loaded = await runRendererPromise(automation.threads.listDetails(target))
      if (activeScopeKeyRef.current === requestedScopeKey) {
        setDetails(sortThreadDetails(loaded))
      }
    } catch (cause) {
      if (activeScopeKeyRef.current === requestedScopeKey) {
        setError(formatError(cause, "Could not load review threads"))
      }
    } finally {
      if (activeScopeKeyRef.current === requestedScopeKey) setLoading(false)
    }
  }

  useRendererStream(
    automation.threads.progress,
    (progress) => {
      setAgentProgress((current) => [
        ...current.filter((item) => item.threadId !== progress.threadId),
        progress,
      ])
    },
    (cause) => setError(formatError(cause, "Could not receive review progress")),
  )

  useEffect(() => {
    let cancelled = false
    if (!available) {
      setDetails([])
      setLoading(false)
      setError("Comments are unavailable until the review revisions are known.")
      return undefined
    }

    setDetails([])
    setRunningThreadIds([])
    setAgentProgress([])
    setAgentErrors({})
    setLoading(true)
    setError(null)
    runRendererPromise(listThreadDetails())
      .then((loaded) => {
        if (!cancelled) setDetails(sortThreadDetails(loaded))
        return undefined
      })
      .catch((cause) => {
        if (!cancelled) setError(formatError(cause, "Could not load review threads"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [available, automation, scopeKey])

  const refreshThreadDetails = async (threadId: ReviewThreadId) => {
    if (activeScopeKeyRef.current !== scopeKey) return null
    try {
      const refreshed = await runRendererPromise(automation.threads.get(threadId))
      if (activeScopeKeyRef.current !== scopeKey) return null
      setDetails((current) =>
        sortThreadDetails([...current.filter((item) => item.thread.id !== threadId), refreshed]),
      )
      return refreshed
    } catch (cause) {
      if (activeScopeKeyRef.current !== scopeKey) return null
      setError(formatError(cause, "Could not refresh thread"))
      throw cause
    }
  }
  const refreshThread = async (threadId: ReviewThreadId) => {
    await refreshThreadDetails(threadId)
  }

  const reconcileAcceptedAgent = async (
    threadId: ReviewThreadId,
    initial: ReviewThreadDetails,
    requestedScopeKey: ReviewThreadScopeIdentity,
    previousLatestMessageId?: ReviewThreadMessageId,
  ) => {
    setAgentErrors((current) => {
      const { [threadId]: _removed, ...remaining } = current
      return remaining
    })
    setRunningThreadIds((current) =>
      current.includes(threadId) ? current : [...current, threadId],
    )
    setAgentProgress((current) => [
      ...current.filter((item) => item.threadId !== threadId),
      ReviewAgentProgress.make({ threadId, stage: "preparing-context" }),
    ])
    let current = initial
    try {
      while (
        activeScopeKeyRef.current === requestedScopeKey &&
        !hasNewTerminalAgentResponse(current, previousLatestMessageId)
      ) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 100))
        const refreshed = await refreshThreadDetails(threadId)
        if (refreshed === null) return
        current = refreshed
      }
    } catch (cause) {
      if (activeScopeKeyRef.current === requestedScopeKey) {
        setAgentErrors((errors) => ({
          ...errors,
          [threadId]: formatError(cause, "Could not refresh the accepted agent response"),
        }))
      }
    } finally {
      if (activeScopeKeyRef.current === requestedScopeKey) {
        setRunningThreadIds((threadIds) => threadIds.filter((id) => id !== threadId))
        setAgentProgress((progress) => progress.filter((item) => item.threadId !== threadId))
      }
    }
  }

  const runAgent = async (threadId: ReviewThreadId) => {
    const currentDetails = details.find((item) => item.thread.id === threadId)
    if (
      activeScopeKeyRef.current !== scopeKey ||
      currentDetails === undefined ||
      Option.isNone(revisions)
    ) {
      return Promise.reject(
        ReviewThreadUnavailableError.make({
          operation: "runAgent",
          message: "Review thread target is unavailable",
        }),
      )
    }
    const previousLatestMessageId = currentDetails.messages.at(-1)?.id
    setAgentErrors((current) => {
      const { [threadId]: _removed, ...remaining } = current
      return remaining
    })
    setRunningThreadIds((current) =>
      current.includes(threadId) ? current : [...current, threadId],
    )
    setAgentProgress((current) => [
      ...current.filter((item) => item.threadId !== threadId),
      ReviewAgentProgress.make({ threadId, stage: "preparing-context" }),
    ])
    try {
      const pending = runRendererPromise(
        automation.threads.runAgent(
          RunReviewThreadAgentRequest.make({
            threadId,
            target,
            repoId: ReviewProjectId.make(currentDetails.thread.repoId),
            reviewKey: currentDetails.thread.reviewKey,
            expectedBaseRevision: revisions.value.baseRevision,
            expectedHeadRevision: revisions.value.headRevision,
          }),
        ),
      )
      window.setTimeout(() => void refreshThread(threadId).catch(() => undefined), 100)
      const result = await pending
      if (activeScopeKeyRef.current !== scopeKey) return
      setDetails((current) =>
        sortThreadDetails([...current.filter((item) => item.thread.id !== threadId), result]),
      )
      captureAnalytics({
        event: "review_agent_completed",
        reviewType: targetType,
      })
      setError(null)
    } catch (cause) {
      const refreshed = await refreshThreadDetails(threadId).catch(() => null)
      if (activeScopeKeyRef.current !== scopeKey) throw cause
      const latestMessage = refreshed?.messages.at(-1)
      const persistedNewFailure =
        latestMessage !== undefined &&
        Match.valueTags(latestMessage, {
          Failed: (message) => message.id !== previousLatestMessageId,
          User: () => false,
          Pending: () => false,
          Completed: () => false,
        })
      if (!persistedNewFailure) {
        setAgentErrors((current) => ({
          ...current,
          [threadId]: formatError(cause, "Local review agent could not complete the response"),
        }))
      }
      throw cause
    } finally {
      if (activeScopeKeyRef.current === scopeKey) {
        setRunningThreadIds((current) => current.filter((id) => id !== threadId))
        setAgentProgress((current) => current.filter((item) => item.threadId !== threadId))
      }
    }
  }

  const createThread = async (anchor: ReviewThreadAnchor, bodyMarkdown: string) => {
    const requestedScopeKey = scopeKey
    if (Option.isNone(revisions)) {
      return Promise.reject(
        ReviewThreadUnavailableError.make({
          operation: "createThread",
          message: "Review revisions are unavailable",
        }),
      )
    }
    const body = MarkdownBody.make(bodyMarkdown)
    const subject = CommentSubject.cases.ReviewLine.make({
      target,
      expectedBaseRevision: revisions.value.baseRevision,
      expectedHeadRevision: revisions.value.headRevision,
      anchor,
    })
    try {
      const receipt = await commentSubmission.submit(
        CommentSubmission.cases.Start.make({ subject, body }),
      )
      if (activeScopeKeyRef.current !== requestedScopeKey) return receipt
      const reflected = await CommentSubmissionReceipt.match(receipt, {
        StoredLocally: async ({ threadId, agentAccepted }) => {
          const created = await refreshThreadDetails(threadId).catch(() => null)
          if (created === null) return false
          captureAnalytics({
            event: "review_thread_created",
            reviewType: targetType,
          })
          if (agentAccepted) {
            void reconcileAcceptedAgent(threadId, created, requestedScopeKey)
          }
          return true
        },
        Forwarded: async () => true,
      })
      if (reflected) setError(null)
      return receipt
    } catch (cause) {
      if (activeScopeKeyRef.current === requestedScopeKey) {
        setError(formatError(cause, "Could not submit comment"))
      }
      throw cause
    }
  }

  const addUserMessage = async (threadId: ReviewThreadId, bodyMarkdown: string) => {
    const requestedScopeKey = scopeKey
    const body = MarkdownBody.make(bodyMarkdown)
    const currentDetails = details.find((item) => item.thread.id === threadId)
    const previousLatestMessageId = currentDetails?.messages.at(-1)?.id
    try {
      const receipt = await runRendererPromise(
        Effect.fromOption(
          Option.all({
            details: Option.fromNullishOr(currentDetails),
            revisions,
          }),
          () => CommentSubjectUnavailableError.make({ threadId }),
        ).pipe(
          Effect.flatMap(({ details: current, revisions: currentRevisions }) => {
            const currentAnchor = current.thread.activeAnchor
            if (currentAnchor === null) {
              return Effect.fail(CommentSubjectUnavailableError.make({ threadId }))
            }
            return Effect.succeed(
              CommentSubject.cases.ReviewLine.make({
                target,
                expectedBaseRevision: currentRevisions.baseRevision,
                expectedHeadRevision: currentRevisions.headRevision,
                anchor: currentAnchor,
              }),
            )
          }),
          Effect.flatMap((reviewSubject) =>
            Effect.tryPromise(() =>
              commentSubmission.submit(
                CommentSubmission.cases.FollowUp.make({
                  subject: reviewSubject,
                  threadId,
                  body,
                }),
              ),
            ),
          ),
        ),
      )
      if (activeScopeKeyRef.current !== requestedScopeKey) return
      const reflected = await CommentSubmissionReceipt.match(receipt, {
        StoredLocally: async ({ threadId: updatedThreadId, agentAccepted }) => {
          const updated = await refreshThreadDetails(updatedThreadId).catch(() => null)
          if (updated === null) return false
          if (agentAccepted) {
            void reconcileAcceptedAgent(
              updatedThreadId,
              updated,
              requestedScopeKey,
              previousLatestMessageId,
            )
          }
          return true
        },
        Forwarded: async () => true,
      })
      if (reflected) setError(null)
    } catch (cause) {
      if (activeScopeKeyRef.current === requestedScopeKey) {
        setError(formatError(cause, "Could not send follow-up message"))
      }
      throw cause
    }
  }

  return {
    details,
    error,
    loading,
    available,
    createThread,
    addUserMessage,
    runAgent,
    runningThreadIds,
    agentProgress,
    agentErrors,
    refreshThread,
    reload: load,
  }
}

/** Inline composer for an initial line comment or a follow-up thread message. */
export function ReviewThreadComposer({
  label = "Line comment",
  placeholder = "Write a Markdown comment",
  diffDashSubmitLabel = "Comment",
  submitLabel,
  onCancel,
  onSubmit,
}: {
  readonly label?: string
  readonly placeholder?: string
  readonly diffDashSubmitLabel?: string
  readonly submitLabel?: string | undefined
  readonly onCancel?: () => void
  readonly onSubmit: (bodyMarkdown: string) => Promise<void>
}) {
  const { destination } = useCommentSubmission()
  const labelId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [body, setBody] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cancel = () => {
    setBody("")
    setError(null)
    onCancel?.()
  }
  const submit = async () => {
    const value = body.trim()
    if (value.length === 0 || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(value)
      setBody("")
    } catch (cause) {
      setError(formatError(cause, "Could not create thread"))
    } finally {
      setSubmitting(false)
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault()
      void submit()
    }
  }

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    const form = formRef.current
    const textarea = textareaRef.current
    if (
      form === null ||
      textarea === null ||
      form.closest("[data-review-thread-annotation]") === null
    ) {
      return undefined
    }

    const scrollContainer = form.ownerDocument.querySelector<HTMLElement>(
      "[data-review-diff-scroll-container]",
    )
    if (scrollContainer === null) return undefined

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.target === form && !entry.isIntersecting)) {
          const root = textarea.getRootNode()
          const activeElement = isDocumentOrShadowRoot(root) ? root.activeElement : null
          if (activeElement === textarea) textarea.blur()
        }
      },
      { root: scrollContainer },
    )
    observer.observe(form)
    return () => observer.disconnect()
  }, [])

  return (
    <form
      ref={formRef}
      className="bg-card w-full min-w-0 space-y-2 rounded-lg border p-2.5 shadow-xs"
      aria-labelledby={labelId}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div id={labelId} className="text-xs font-semibold">
        {label}
      </div>
      <Textarea
        value={body}
        ref={textareaRef}
        aria-label="Thread message"
        className="resize-none"
        placeholder={placeholder}
        onChange={(event) => setBody(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      {error === null ? (
        <p className="text-muted-foreground text-caption">
          Markdown supported · ⌘/Ctrl + Enter to send
        </p>
      ) : (
        <p role="alert" className="text-destructive text-caption">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        {onCancel === undefined ? null : (
          <Button type="button" size="xs" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="xs" disabled={body.trim().length === 0 || submitting}>
          {submitting ? <Loader2 className="animate-spin" /> : null}
          {submitLabel ??
            CommentDestination.match(destination, {
              DiffDash: () => diffDashSubmitLabel,
              OpenCode: () => "Send to OpenCode",
            })}
        </Button>
      </div>
    </form>
  )
}

/** One persisted line thread with its full local conversation. */
export function ReviewThreadPanel({
  details,
  embedded = false,
  fullHeight = false,
  agentRunning,
  agentProgress = null,
  agentError = null,
  orchestration,
  onOpenDetail,
  onAddUserMessage,
  onRefresh,
}: {
  readonly details: ReviewThreadDetails
  readonly embedded?: boolean
  readonly fullHeight?: boolean
  readonly agentRunning: boolean
  readonly agentProgress?: ReviewAgentProgressStage | null
  readonly agentError?: string | null
  readonly orchestration?: ReviewThreadOrchestration
  readonly onOpenDetail?: () => void
  readonly onAddUserMessage: (threadId: ReviewThreadId, bodyMarkdown: string) => Promise<void>
  readonly onRefresh: (threadId: ReviewThreadId) => Promise<void>
}) {
  const { thread, messages } = details
  const historyRef = useRef<HTMLDivElement>(null)
  const historyInitializedRef = useRef(false)
  const historyPinnedToBottomRef = useRef(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const previousRevision = reviewThreadIsPreviousRevision(thread)
  const hasPendingAgentMessage = messages.some((message) =>
    Match.valueTags(message, {
      Pending: () => true,
      User: () => false,
      Completed: () => false,
      Failed: () => false,
    }),
  )
  const progressLabel = REVIEW_AGENT_PROGRESS_LABELS[agentProgress ?? "preparing-context"]
  const latestMessage = messages.at(-1)
  const hasUnansweredUserMessage =
    latestMessage !== undefined &&
    Match.valueTags(latestMessage, {
      User: () => true,
      Pending: () => false,
      Completed: () => false,
      Failed: () => false,
    })
  const visibleAgentError = agentError
  const agentActive = agentRunning || hasPendingAgentMessage
  const interruptedTurn = hasUnansweredUserMessage && !agentActive
  const displayedError = agentActive
    ? null
    : (error ??
      visibleAgentError ??
      (interruptedTurn ? "The agent response did not start. Retry to try again." : null))
  const historyUpdateKey = `${messages
    .map(
      (message) =>
        `${message.id}:${Match.valueTags(message, {
          User: () => "User",
          Pending: () => "Pending",
          Completed: () => "Completed",
          Failed: () => "Failed",
        })}:${message.updatedAt}`,
    )
    .join("\u0000")}\u0001${agentRunning ? agentProgress : "idle"}`

  useEffect(() => {
    const history = historyRef.current
    if (history === null) return
    const shouldScroll = !historyInitializedRef.current || historyPinnedToBottomRef.current
    historyInitializedRef.current = true
    if (!shouldScroll) return
    const scrollToBottom = () => {
      if (!history.isConnected || !historyPinnedToBottomRef.current) return
      syncPinnedReviewThreadHistories(history.parentElement ?? history)
    }
    scrollToBottom()
    const frame = window.requestAnimationFrame(() => {
      if (!historyPinnedToBottomRef.current) return
      scrollToBottom()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [historyUpdateKey])

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(formatError(cause, fallback))
    } finally {
      setBusy(false)
    }
  }
  return (
    <article
      className={cn(
        "bg-card min-w-0 overflow-hidden",
        embedded
          ? "flex min-h-0 flex-1 flex-col rounded-none border-0 shadow-none"
          : "my-2 rounded-lg border shadow-xs",
      )}
      aria-label={`${anchorLabel(thread.displayAnchor)} review thread`}
      data-review-thread-id={thread.id}
    >
      {onOpenDetail === undefined ? null : (
        <div className="flex shrink-0 justify-end border-b px-2 py-1">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Open thread details"
            title="Open thread details"
            onClick={onOpenDetail}
          >
            <MessageSquare />
          </Button>
        </div>
      )}
      <div
        ref={historyRef}
        role="log"
        aria-label={`${anchorLabel(thread.displayAnchor)} conversation history`}
        aria-relevant="additions text"
        tabIndex={0}
        data-review-thread-history
        className={cn(
          "space-y-2.5 overflow-y-auto p-3",
          fullHeight ? "min-h-0 flex-1" : "max-h-review-thread-history",
        )}
        onScroll={(event) => {
          const history = event.currentTarget
          const pinned = history.scrollHeight - history.clientHeight - history.scrollTop <= 48
          historyPinnedToBottomRef.current = pinned
          recordReviewThreadHistoryScrollState(thread.id, {
            pinned,
            scrollTop: history.scrollTop,
          })
        }}
      >
        {previousRevision ||
        Match.valueTags(thread.currentAnchor, {
          Active: () => false,
          Outdated: () => true,
          Unresolved: () => true,
        }) ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {previousRevision ? (
              <Badge variant="outline" className="text-caption h-5 px-1.5 text-muted-foreground">
                Previous revision
              </Badge>
            ) : null}
            {Match.valueTags(thread.currentAnchor, {
              Active: () => false,
              Outdated: () => true,
              Unresolved: () => true,
            }) ? (
              <Badge variant="outline" className="text-caption h-5 px-1.5 text-muted-foreground">
                {Match.valueTags(thread.currentAnchor, {
                  Active: () => "Anchor unavailable",
                  Outdated: () => "Outdated",
                  Unresolved: () => "Anchor unavailable",
                })}
              </Badge>
            ) : null}
          </div>
        ) : null}
        {messages.map((message) => (
          <ThreadMessage
            key={message.id}
            message={message}
            progressLabel={progressLabel}
            retryAvailable={orchestration !== undefined && !busy}
            onRetry={() => {
              if (orchestration === undefined) return
              void run(async () => {
                await orchestration.retryAgentMessage(thread.id)
                await onRefresh(thread.id)
              }, "Could not retry agent response")
            }}
          />
        ))}
        {agentRunning && !hasPendingAgentMessage ? (
          <UnicodeLoadingText className="text-muted-foreground text-xs" text={progressLabel} />
        ) : null}
        {displayedError === null ? null : (
          <div role="alert" className="text-destructive flex items-center gap-1 text-xs">
            <AlertCircle className="size-3.5" />
            <span>{displayedError}</span>
            {orchestration !== undefined && (visibleAgentError !== null || interruptedTurn) ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy || latestMessage === undefined}
                onClick={() => {
                  if (latestMessage === undefined) return
                  void run(
                    () => orchestration.retryAgentMessage(thread.id),
                    "Could not retry agent response",
                  )
                }}
              >
                Retry
              </Button>
            ) : null}
          </div>
        )}
      </div>
      {agentRunning || hasPendingAgentMessage || hasUnansweredUserMessage ? null : (
        <div className={cn("shrink-0", embedded ? "border-t p-3" : "px-3 pb-3")}>
          <ReviewThreadComposer
            label="Continue conversation"
            placeholder="Ask a follow-up question"
            diffDashSubmitLabel="Send"
            onSubmit={(bodyMarkdown) => onAddUserMessage(thread.id, bodyMarkdown)}
          />
        </div>
      )}
    </article>
  )
}

/** GitHub-flavored Markdown renderer retained under the review-thread public name. */
export const ReviewMarkdown = MarkdownContent

const ThreadMessage = ({
  message,
  progressLabel,
  retryAvailable,
  onRetry,
}: {
  readonly message: ReviewThreadMessage
  readonly progressLabel: string
  readonly retryAvailable: boolean
  readonly onRetry: () => void
}) => {
  const messageView = Match.valueTags(message, {
    User: (user) => ({
      agent: false,
      body: user.bodyMarkdown,
      failurePresentation: null,
      failed: false,
      pending: false,
    }),
    Pending: () => ({
      agent: true,
      body: null,
      failurePresentation: null,
      failed: false,
      pending: true,
    }),
    Completed: (completed) => ({
      agent: true,
      body: completed.bodyMarkdown,
      failurePresentation: null,
      failed: false,
      pending: false,
    }),
    Failed: (failedMessage) => ({
      agent: true,
      body: null,
      failurePresentation: Match.valueTags(failedMessage.failure, {
        Provider: ({ details }) => reviewFailurePresentation(details),
        Internal: () => null,
      }),
      failed: true,
      pending: false,
    }),
  })
  return (
    <section
      className={cn(
        "max-w-[92%] rounded-lg border px-3 py-2 text-xs",
        messageView.agent ? "bg-muted/55 mr-auto" : "bg-primary/8 border-primary/20 ml-auto",
      )}
      aria-label={`${messageView.agent ? "Agent" : "User"} message`}
    >
      <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-caption font-medium">
        {messageView.agent ? <Bot className="size-3" /> : <UserRound className="size-3" />}
        <span>{messageView.agent ? "Agent" : "You"}</span>
        <time dateTime={message.createdAt}>
          {formatTimestamp(message.createdAt, message.createdAt)}
        </time>
      </div>
      {messageView.body !== null && messageView.body.length > 0 ? (
        <ReviewMarkdown>{messageView.body}</ReviewMarkdown>
      ) : null}
      {messageView.pending ? (
        <UnicodeLoadingText className="text-muted-foreground mt-1.5 text-xs" text={progressLabel} />
      ) : null}
      {messageView.failed ? (
        <div className="text-destructive mt-1.5 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <AlertCircle className="size-3" />
            <span role="alert">{messageView.failurePresentation?.title}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={!retryAvailable}
              title={retryAvailable ? undefined : "Agent retry API is not available in this build"}
              onClick={onRetry}
            >
              Retry
            </Button>
          </div>
          <p className="text-muted-foreground">{messageView.failurePresentation?.guidance}</p>
        </div>
      ) : null}
    </section>
  )
}

const reviewFailurePresentation = (
  failure: AgentProviderFailure | null,
): { readonly title: string; readonly guidance: string } => {
  if (failure === null) {
    return {
      title: "Agent response failed.",
      guidance: "Retry the response. If it fails again, check the configured AI provider.",
    }
  }
  if (failure.providerId === "unavailable") {
    return {
      title: "No configured AI provider is available.",
      guidance: "Configure a review provider in AI Settings, then retry.",
    }
  }
  const provider = providerDisplayName(failure.providerId)
  switch (failure.category) {
    case "authentication":
      return {
        title: `${provider} authentication failed or expired.`,
        guidance: `Sign in to ${provider} again, then retry.`,
      }
    case "authorization":
      return {
        title: `${provider} denied access.`,
        guidance: "Check access to the selected model and provider account, then retry.",
      }
    case "rate-limited":
      return {
        title: `${provider} is temporarily rate limited.`,
        guidance: "Wait briefly, then retry.",
      }
    case "usage-limited":
      return {
        title: `${provider} reached a session or usage limit.`,
        guidance: "Retry after the provider limit resets.",
      }
    case "quota-exhausted":
      return {
        title: `${provider} reached an account quota or billing limit.`,
        guidance: "Check the provider account before retrying.",
      }
    case "timeout":
      return {
        title: `${provider} timed out.`,
        guidance: "Retry the response or select a faster model.",
      }
    case "network":
      return {
        title: `${provider} could not connect to its service.`,
        guidance: "Check the network connection, then retry.",
      }
    case "model-unavailable":
      return {
        title: `${provider} could not use the selected model.`,
        guidance: "Choose another model in AI Settings, then retry.",
      }
    case "provider-unavailable":
      return {
        title: `${provider} is temporarily unavailable.`,
        guidance: "Retry shortly.",
      }
    case "configuration":
      return {
        title: `${provider} is not configured correctly.`,
        guidance: "Check AI Settings and the provider installation, then retry.",
      }
    case "invalid-response":
      return {
        title: `${provider} returned an unusable response.`,
        guidance: "Retry or choose another model.",
      }
    case "policy-violation":
      return {
        title: `${provider} could not satisfy the read-only policy.`,
        guidance: "Check the provider version and configuration, then retry.",
      }
    case "process-failure":
      return {
        title: `${provider} stopped before completing the response.`,
        guidance: "Check the provider installation, then retry.",
      }
    case "unknown":
      return {
        title: `${provider} could not complete the response.`,
        guidance: "Retry the response. If it fails again, check the provider directly.",
      }
  }
}

const providerDisplayName = (providerId: string): string => {
  if (providerId === "claude") return "Claude"
  if (providerId === "codex") return "Codex"
  if (providerId === "opencode") return "OpenCode"
  return providerId
}

const sortThreadDetails = (details: readonly ReviewThreadDetails[]) =>
  EffectArray.sort(
    details,
    Order.mapInput(Order.String, (detail: ReviewThreadDetails) => detail.thread.createdAt),
  )

const hasNewTerminalAgentResponse = (
  { messages }: ReviewThreadDetails,
  previousLatestMessageId?: ReviewThreadMessageId,
): boolean => {
  const latest = messages.at(-1)
  return (
    latest !== undefined &&
    Match.valueTags(latest, {
      Pending: () => false,
      User: () => false,
      Completed: (message) => message.id !== previousLatestMessageId,
      Failed: (message) => message.id !== previousLatestMessageId,
    })
  )
}

/** Human-readable label for any persisted anchor. */
const anchorLabel = (anchor: ReviewThreadAnchor) => {
  return `${anchor.filePath}:${anchor.lineNumber} · ${anchor.side}`
}
