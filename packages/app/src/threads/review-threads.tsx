import type { HostedReviewLocator } from "@diffdash/domain/git-provider"
import {
  BranchComparison,
  LocalReviewTarget,
  WorkingTreeComparison,
} from "@diffdash/domain/local-review"
import type { RepositoryComparisonTarget } from "@diffdash/domain/repository-comparison"
import {
  REVIEW_AGENT_PROGRESS_LABELS,
  ReviewAgentProgress,
  type ReviewAgentProgressStage,
} from "@diffdash/domain/review-agent"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import {
  HostedReviewTarget,
  MarkdownBody,
  normalizeMarkdownLineBreaks,
  type ReviewThread,
  type ReviewThreadAnchor,
  ReviewThreadDetails,
  type ReviewThreadId,
  type ReviewThreadMessage,
  type ReviewThreadMessageId,
  type ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import {
  AddReviewThreadUserMessageRequest,
  CreateReviewThreadRequest,
  RunReviewThreadAgentRequest,
} from "@diffdash/protocol/review-threads"
import { AlertCircle, Bot, Loader2, MessageSquare, UserRound } from "lucide-react"
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import { captureAnalytics } from "@/shared/analytics"
import { formatError } from "@/shared/errors"
import { formatTimestamp } from "@/shared/timestamp"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Textarea } from "@/shared/ui/textarea"
import { UnicodeLoadingText } from "@/shared/ui/unicode-loading-text"
import { cn } from "@/shared/utils"

/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Scrollable conversation logs need keyboard focus. */

type ReviewThreadHistoryScrollState = {
  readonly pinned: boolean
  readonly scrollTop: number
}

const reviewThreadHistoryScrollStates = new Map<string, ReviewThreadHistoryScrollState>()

/** Renderer-owned review scope used to derive typed preload requests. */
export type ReviewThreadScope =
  | {
      readonly kind: "hosted"
      readonly review: HostedReviewLocator
      readonly baseRevision: string | null
      readonly headRevision: string | null
    }
  | {
      readonly kind: "local"
      readonly target: LocalReviewTarget
      readonly baseRevision: string
      readonly headRevision: string
    }
  | {
      readonly kind: "repositoryComparison"
      readonly target: RepositoryComparisonTarget
      readonly baseRevision: string
      readonly headRevision: string
    }

/** Optional orchestration seam for an agent API that is not currently exposed through preload. */
export type ReviewThreadOrchestration = {
  readonly retryAgentMessage: (
    threadId: ReviewThreadId,
    messageId: ReviewThreadMessageId,
  ) => Promise<void>
}

/** State and mutations shared by the review thread surfaces. */
export type ReviewThreadsController = {
  readonly details: readonly ReviewThreadDetails[]
  readonly error: string | null
  readonly loading: boolean
  readonly available: boolean
  readonly createThread: (anchor: ReviewThreadAnchor, bodyMarkdown: string) => Promise<void>
  readonly addUserMessage: (threadId: ReviewThreadId, bodyMarkdown: string) => Promise<void>
  readonly runAgent: (threadId: ReviewThreadId) => Promise<void>
  readonly runningThreadIds: readonly ReviewThreadId[]
  readonly agentProgress: readonly ReviewAgentProgress[]
  readonly agentErrors: Readonly<Record<string, string>>
  readonly refreshThread: (threadId: ReviewThreadId) => Promise<void>
  readonly reload: () => Promise<void>
}

/** Loads and mutates persisted review threads exclusively through the typed preload API. */
export function useReviewThreads(scope: ReviewThreadScope): ReviewThreadsController {
  const [details, setDetails] = useState<readonly ReviewThreadDetails[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [runningThreadIds, setRunningThreadIds] = useState<readonly ReviewThreadId[]>([])
  const [agentProgress, setAgentProgress] = useState<readonly ReviewAgentProgress[]>([])
  const [agentErrors, setAgentErrors] = useState<Readonly<Record<string, string>>>({})
  const baseRevision = scope.baseRevision
  const headRevision = scope.headRevision
  const hostedReview = scope.kind === "hosted" ? scope.review : null
  const localRootPath = scope.kind === "local" ? scope.target.rootPath : null
  const comparisonTarget = scope.kind === "repositoryComparison" ? scope.target : null
  const localBranchName =
    scope.kind === "local" && scope.target.comparison["_tag"] === "branch"
      ? scope.target.comparison.branchName
      : null
  const localBaseRef =
    scope.kind === "local" && scope.target.comparison["_tag"] === "branch"
      ? scope.target.comparison.baseRef
      : null
  const localBaseSha =
    scope.kind === "local" && scope.target.comparison["_tag"] === "branch"
      ? scope.target.comparison.baseSha
      : null
  const localTarget = useMemo(
    () =>
      localRootPath === null
        ? null
        : LocalReviewTarget.make({
            kind: "local",
            rootPath: localRootPath,
            comparison:
              localBranchName === null || localBaseRef === null || localBaseSha === null
                ? WorkingTreeComparison.make({})
                : BranchComparison.make({
                    branchName: localBranchName,
                    baseRef: localBaseRef,
                    baseSha: localBaseSha,
                  }),
          }),
    [localBaseRef, localBaseSha, localBranchName, localRootPath],
  )
  const localTargetKey =
    localRootPath === null
      ? null
      : `${localRootPath}\u0000${localBaseRef ?? "workingTree"}\u0000${localBaseSha ?? ""}`
  const available = baseRevision !== null && headRevision !== null

  const load = async () => {
    if (!available) {
      setDetails([])
      setLoading(false)
      setError("Threads are unavailable until the review revisions are known.")
      return
    }

    setLoading(true)
    setError(null)
    try {
      const threads = await window.diffDash.reviewThreads.list(
        reviewThreadTarget(hostedReview, localTarget, comparisonTarget),
      )
      const loaded = await Promise.all(
        threads.map((thread) => window.diffDash.reviewThreads.get(thread.id)),
      )
      setDetails(sortThreadDetails(loaded))
    } catch (cause) {
      setError(formatError(cause, "Could not load review threads"))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    return window.diffDash.reviewThreads.onAgentProgress((progress) => {
      setAgentProgress((current) => [
        ...current.filter((item) => item.threadId !== progress.threadId),
        progress,
      ])
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!available) {
      setDetails([])
      setLoading(false)
      setError("Threads are unavailable until the review revisions are known.")
      return undefined
    }

    setDetails([])
    setRunningThreadIds([])
    setAgentProgress([])
    setAgentErrors({})
    setLoading(true)
    setError(null)
    window.diffDash.reviewThreads
      .list(reviewThreadTarget(hostedReview, localTarget, comparisonTarget))
      .then((threads) =>
        Promise.all(threads.map((thread) => window.diffDash.reviewThreads.get(thread.id))),
      )
      .then((loaded) => {
        if (!cancelled) setDetails(sortThreadDetails(loaded))
        return undefined
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(formatError(cause, "Could not load review threads"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [
    available,
    baseRevision,
    comparisonTarget,
    headRevision,
    hostedReview,
    localTarget,
    localTargetKey,
  ])

  const refreshThreadDetails = async (threadId: ReviewThreadId) => {
    try {
      const refreshed = await window.diffDash.reviewThreads.get(threadId)
      setDetails((current) =>
        sortThreadDetails([...current.filter((item) => item.thread.id !== threadId), refreshed]),
      )
      return refreshed
    } catch (cause) {
      setError(formatError(cause, "Could not refresh thread"))
      throw cause
    }
  }
  const refreshThread = async (threadId: ReviewThreadId) => {
    await refreshThreadDetails(threadId)
  }

  const runAgent = async (threadId: ReviewThreadId, resolvedDetails?: ReviewThreadDetails) => {
    const currentDetails = resolvedDetails ?? details.find((item) => item.thread.id === threadId)
    if (currentDetails === undefined || baseRevision === null || headRevision === null) {
      throw new Error("Review thread target is unavailable")
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
      const pending = window.diffDash.reviewThreads.runAgent(
        RunReviewThreadAgentRequest.make({
          threadId,
          target: reviewThreadTarget(hostedReview, localTarget, comparisonTarget),
          repoId: currentDetails.thread.repoId,
          reviewKey: currentDetails.thread.reviewKey,
          expectedBaseRevision: ReviewRevision.make(baseRevision),
          expectedHeadRevision: ReviewRevision.make(headRevision),
        }),
      )
      window.setTimeout(() => void refreshThread(threadId).catch(() => undefined), 100)
      const result = await pending
      setDetails((current) =>
        sortThreadDetails([...current.filter((item) => item.thread.id !== threadId), result]),
      )
      captureAnalytics({
        event: "review_agent_completed",
        reviewType:
          comparisonTarget !== null
            ? "repository_comparison"
            : localTarget === null
              ? "pull_request"
              : "local_diff",
      })
      setError(null)
    } catch (cause) {
      const refreshed = await refreshThreadDetails(threadId).catch(() => null)
      const latestMessage = refreshed?.messages.at(-1)
      const persistedNewFailure =
        latestMessage?.author === "agent" &&
        latestMessage.status === "failed" &&
        latestMessage.id !== previousLatestMessageId
      if (!persistedNewFailure) {
        setAgentErrors((current) => ({
          ...current,
          [threadId]: formatError(cause, "Local review agent could not complete the response"),
        }))
      }
      throw cause
    } finally {
      setRunningThreadIds((current) => current.filter((id) => id !== threadId))
      setAgentProgress((current) => current.filter((item) => item.threadId !== threadId))
    }
  }

  const createThread = async (anchor: ReviewThreadAnchor, bodyMarkdown: string) => {
    if (baseRevision === null || headRevision === null) {
      throw new Error("Review revisions are unavailable")
    }
    try {
      const created = await window.diffDash.reviewThreads.create(
        CreateReviewThreadRequest.make({
          target: reviewThreadTarget(hostedReview, localTarget, comparisonTarget),
          expectedBaseRevision: ReviewRevision.make(baseRevision),
          expectedHeadRevision: ReviewRevision.make(headRevision),
          anchor,
          bodyMarkdown: MarkdownBody.make(bodyMarkdown),
        }),
      )
      setDetails((current) => sortThreadDetails([...current, created]))
      captureAnalytics({
        event: "review_thread_created",
        reviewType:
          comparisonTarget !== null
            ? "repository_comparison"
            : localTarget === null
              ? "pull_request"
              : "local_diff",
      })
      setError(null)
      void runAgent(created.thread.id, created).catch(() => undefined)
    } catch (cause) {
      setError(formatError(cause, "Could not create thread"))
      throw cause
    }
  }

  const addUserMessage = async (threadId: ReviewThreadId, bodyMarkdown: string) => {
    try {
      const updatedDetails = await window.diffDash.reviewThreads.addUserMessage(
        AddReviewThreadUserMessageRequest.make({
          threadId,
          bodyMarkdown: MarkdownBody.make(bodyMarkdown),
        }),
      )
      setDetails((current) => replaceThreadDetails(current, updatedDetails))
      setError(null)
      void runAgent(threadId, updatedDetails).catch(() => undefined)
    } catch (cause) {
      setError(formatError(cause, "Could not send follow-up message"))
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
  submitLabel = "Comment",
  onCancel,
  onSubmit,
}: {
  readonly label?: string
  readonly placeholder?: string
  readonly submitLabel?: string
  readonly onCancel?: () => void
  readonly onSubmit: (bodyMarkdown: string) => Promise<void>
}) {
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
          const activeElement =
            root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null
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
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

/** Restores pinned or reader-controlled scroll positions after inline annotation rendering. */
export const syncPinnedReviewThreadHistories = (root: ParentNode) => {
  const histories = [...root.querySelectorAll<HTMLElement>("[data-review-thread-history]")]
  histories.forEach((history) => {
    const threadId = history.closest<HTMLElement>("[data-review-thread-id]")?.dataset.reviewThreadId
    if (threadId === undefined) return
    const state = reviewThreadHistoryScrollStates.get(threadId)
    if (state?.pinned === false) {
      history.scrollTop = state.scrollTop
      return
    }
    history.scrollTop = history.scrollHeight
    reviewThreadHistoryScrollStates.set(threadId, {
      pinned: true,
      scrollTop: history.scrollTop,
    })
  })
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
  const hasPendingAgentMessage = messages.some(
    (message) => message.author === "agent" && message.status === "pending",
  )
  const progressLabel = REVIEW_AGENT_PROGRESS_LABELS[agentProgress ?? "preparing-context"]
  const latestMessage = messages.at(-1)
  const hasUnansweredUserMessage = latestMessage?.author === "user"
  const visibleAgentError = agentError
  const agentActive = agentRunning || hasPendingAgentMessage
  const interruptedTurn = hasUnansweredUserMessage && !agentActive
  const displayedError = agentActive
    ? null
    : (error ??
      visibleAgentError ??
      (interruptedTurn ? "The agent response did not start. Retry to try again." : null))
  const historyUpdateKey = `${messages
    .map((message) => `${message.id}:${message.status}:${message.updatedAt}`)
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
      aria-label={`${anchorLabel(thread.currentAnchor ?? thread.originalAnchor)} review thread`}
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
        aria-label={`${anchorLabel(thread.currentAnchor ?? thread.originalAnchor)} conversation history`}
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
          reviewThreadHistoryScrollStates.set(thread.id, {
            pinned,
            scrollTop: history.scrollTop,
          })
        }}
      >
        {previousRevision ||
        thread.anchorStatus === "outdated" ||
        thread.anchorStatus === "unresolved_anchor" ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {previousRevision ? (
              <Badge variant="outline" className="text-caption h-5 px-1.5 text-muted-foreground">
                Previous revision
              </Badge>
            ) : null}
            {thread.anchorStatus === "outdated" || thread.anchorStatus === "unresolved_anchor" ? (
              <Badge variant="outline" className="text-caption h-5 px-1.5 text-muted-foreground">
                {thread.anchorStatus === "outdated" ? "Outdated" : "Anchor unavailable"}
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
                await orchestration.retryAgentMessage(thread.id, message.id)
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
                    () => orchestration.retryAgentMessage(thread.id, latestMessage.id),
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
            submitLabel="Send"
            onSubmit={(bodyMarkdown) => onAddUserMessage(thread.id, bodyMarkdown)}
          />
        </div>
      )}
    </article>
  )
}

/** Safe, dependency-free Markdown subset for persisted review messages. */
export function ReviewMarkdown({ children }: { readonly children: string }) {
  const lines = normalizeMarkdownLineBreaks(children).split("\n")
  const blocks: ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (line.trim().length === 0) {
      index += 1
      continue
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim()
      const code: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        code.push(lines[index] ?? "")
        index += 1
      }
      index += 1
      blocks.push(
        <div
          key={`code-${index}`}
          className="bg-surface-inset/60 overflow-hidden rounded-md border"
        >
          {language.length === 0 ? null : (
            <div className="text-review-file-reference border-b px-3 py-1 font-mono text-caption font-medium uppercase">
              {language}
            </div>
          )}
          <pre className="whitespace-pre-wrap px-3 py-2.5 font-mono text-xs leading-5 [overflow-wrap:anywhere]">
            <code data-language={language || undefined}>{code.join("\n")}</code>
          </pre>
        </div>,
      )
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading !== null) {
      const content = inlineMarkdown(heading[2] ?? "")
      const className = "font-semibold tracking-tight"
      blocks.push(
        heading[1]?.length === 1 ? (
          <h3 key={`heading-${index}`} className={cn(className, "text-base")}>
            {content}
          </h3>
        ) : (
          <h4 key={`heading-${index}`} className={className}>
            {content}
          </h4>
        ),
      )
      index += 1
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      const items: { readonly key: string; readonly value: string }[] = []
      const occurrences = new Map<string, number>()
      while (index < lines.length && /^[-*]\s+/.test(lines[index] ?? "")) {
        const value = (lines[index] ?? "").replace(/^[-*]\s+/, "")
        const occurrence = occurrences.get(value) ?? 0
        occurrences.set(value, occurrence + 1)
        items.push({ key: `${value}:${occurrence}`, value })
        index += 1
      }
      blocks.push(
        <ul key={`list-${index}`} className="marker:text-muted-foreground list-disc space-y-1 pl-5">
          {items.map((item) => (
            <li key={item.key}>{inlineMarkdown(item.value)}</li>
          ))}
        </ul>,
      )
      continue
    }
    if (line.startsWith("> ")) {
      blocks.push(
        <blockquote
          key={`quote-${index}`}
          className="border-primary/50 text-muted-foreground border-l-2 py-0.5 pl-3"
        >
          {inlineMarkdown(line.slice(2))}
        </blockquote>,
      )
      index += 1
      continue
    }

    const paragraph: string[] = [line]
    index += 1
    while (
      index < lines.length &&
      (lines[index] ?? "").trim().length > 0 &&
      !/^(#{1,3})\s+|^```|^[-*]\s+|^>\s+/.test(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "")
      index += 1
    }
    blocks.push(
      <p key={`paragraph-${index}`} className="leading-6">
        {inlineMarkdown(paragraph.join("\n"))}
      </p>,
    )
  }

  return <div className="space-y-3 break-words text-sm leading-6">{blocks}</div>
}

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
  const agent = message.author === "agent"
  const pending = message.status === "pending"
  const failed = message.status === "failed"
  return (
    <section
      className={cn(
        "max-w-[92%] rounded-lg border px-3 py-2 text-xs",
        agent ? "bg-muted/55 mr-auto" : "bg-primary/8 border-primary/20 ml-auto",
      )}
      aria-label={`${agent ? "Agent" : "User"} message`}
    >
      <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-caption font-medium">
        {agent ? <Bot className="size-3" /> : <UserRound className="size-3" />}
        <span>{agent ? "Agent" : "You"}</span>
        <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
      </div>
      {message.bodyMarkdown.length > 0 && !pending ? (
        <ReviewMarkdown>{message.bodyMarkdown}</ReviewMarkdown>
      ) : null}
      {pending ? (
        <UnicodeLoadingText className="text-muted-foreground mt-1.5 text-xs" text={progressLabel} />
      ) : null}
      {failed ? (
        <div className="text-destructive mt-1.5 flex flex-wrap items-center gap-1.5">
          <AlertCircle className="size-3" />
          <span role="alert">Agent response failed.</span>
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
      ) : null}
    </section>
  )
}

const inlineMarkdown = (value: string): readonly ReactNode[] => {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\*[^*]+\*|\n)/g
  let offset = 0
  return value
    .split(pattern)
    .filter(Boolean)
    .flatMap((part) => {
      const partOffset = offset
      const key = `${partOffset}:${part}`
      offset += part.length
      if (part === "\n") return [<br key={key} />]
      if (part.startsWith("**") && part.endsWith("**")) {
        return [<strong key={key}>{part.slice(2, -2)}</strong>]
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        const content = part.slice(1, -1)
        const fileReference = reviewFileReference.test(content)
        return [
          <code
            key={key}
            className={cn(
              "bg-muted rounded px-1 py-0.5 font-mono font-medium",
              fileReference ? "text-review-file-reference" : "text-review-symbol-reference",
            )}
            data-review-file-reference={fileReference || undefined}
            data-review-symbol-reference={!fileReference || undefined}
          >
            {content}
          </code>,
        ]
      }
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part)
      if (link !== null) {
        return [
          <a
            key={key}
            href={link[2]}
            className="text-link underline underline-offset-2"
            onClick={(event) => {
              event.preventDefault()
              if (link[2] !== undefined) void window.diffDash.openExternalUrl(link[2])
            }}
          >
            {link[1]}
          </a>,
        ]
      }
      if (part.startsWith("*") && part.endsWith("*")) {
        return [<em key={key}>{part.slice(1, -1)}</em>]
      }
      return renderTechnicalReferences(part, partOffset)
    })
}

const fileReferenceSource = String.raw`(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?`
const symbolReferenceSource = String.raw`(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*|[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+|[A-Z]{2,}[A-Za-z0-9]*|[a-z_$][a-z0-9_$]*(?:[A-Z][A-Za-z0-9_$]*)+`
const reviewFileReference = new RegExp(`^${fileReferenceSource}$`, "u")
const reviewSymbolReference = new RegExp(`^(?:${symbolReferenceSource})$`, "u")
const technicalReference = new RegExp(`(${fileReferenceSource}|${symbolReferenceSource})`, "gu")

const renderTechnicalReferences = (value: string, initialOffset: number): readonly ReactNode[] => {
  let offset = initialOffset
  return value
    .split(technicalReference)
    .filter(Boolean)
    .map((part) => {
      const key = `${offset}:${part}`
      offset += part.length
      if (reviewFileReference.test(part)) {
        return (
          <span
            key={key}
            className="text-review-file-reference font-mono font-medium"
            data-review-file-reference="true"
          >
            {part}
          </span>
        )
      }
      if (reviewSymbolReference.test(part)) {
        return (
          <span
            key={key}
            className="text-review-symbol-reference font-mono font-medium"
            data-review-symbol-reference="true"
          >
            {part}
          </span>
        )
      }
      return <Fragment key={key}>{part}</Fragment>
    })
}

const replaceThreadDetails = (
  details: readonly ReviewThreadDetails[],
  replacement: ReviewThreadDetails,
) => details.map((item) => (item.thread.id === replacement.thread.id ? replacement : item))

const sortThreadDetails = (details: readonly ReviewThreadDetails[]) => {
  const sorted: ReviewThreadDetails[] = []
  for (const item of details) {
    const insertionIndex = sorted.findIndex(
      (candidate) => candidate.thread.createdAt.localeCompare(item.thread.createdAt) > 0,
    )
    if (insertionIndex < 0) sorted.push(item)
    else sorted.splice(insertionIndex, 0, item)
  }
  return sorted
}

const reviewThreadTarget = (
  hostedReview: HostedReviewLocator | null,
  localTarget: LocalReviewTarget | null,
  comparisonTarget: RepositoryComparisonTarget | null,
): ReviewThreadTarget => {
  if (hostedReview !== null) {
    return HostedReviewTarget.make({ kind: "hosted", review: hostedReview })
  }
  if (comparisonTarget !== null) return comparisonTarget
  if (localTarget === null) throw new Error("Local review target is unavailable")
  return localTarget
}

/** Human-readable label for any persisted anchor. */
const anchorLabel = (anchor: ReviewThreadAnchor) => {
  return `${anchor.filePath}:${anchor.lineNumber} · ${anchor.side}`
}

/** Explains why a persisted thread cannot navigate to the current diff. */
export const fallbackThreadLabel = (details: ReviewThreadDetails) => {
  if (details.thread.anchorStatus === "outdated") return "Outdated"
  if (details.thread.anchorStatus === "unresolved_anchor") return "Anchor unavailable"
  if (reviewThreadIsPreviousRevision(details.thread)) return "Previous revision"
  return "Location unavailable"
}

/** Whether a thread originated on a revision older than its latest mapped review snapshot. */
export const reviewThreadIsPreviousRevision = (thread: ReviewThread) =>
  thread.baseRevision !== thread.currentBaseRevision ||
  thread.headRevision !== thread.currentHeadRevision

/** Compact GitHub-style side and line label for an inline review disclosure. */
export const reviewLineLabel = (anchor: ReviewThreadAnchor) =>
  `${anchor.side === "old" ? "L" : "R"}${anchor.lineNumber}`

const formatMessageTime = (value: string) => formatTimestamp(value, value)
