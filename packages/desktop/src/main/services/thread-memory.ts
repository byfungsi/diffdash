import {
  ThreadMemorySummaryAlgorithm,
  type ThreadMemory,
  UpsertThreadMemoryInput,
} from "../../shared/agent-run"
import type { ReviewAgentArtifactId } from "../../shared/review-agent"
import type { ReviewThreadId, ReviewThreadMessage } from "../../shared/review-thread"

/** Number of recent completed messages retained beside compact thread memory. */
export const DEFAULT_THREAD_MEMORY_MESSAGE_LIMIT = 10

/** Maximum UTF-16 code units retained by the deterministic fallback summary. */
export const DEFAULT_THREAD_MEMORY_SUMMARY_CHARACTER_LIMIT = 4_000

/** Stable metadata for summaries generated without a provider-authored summary. */
export const FALLBACK_THREAD_MEMORY_SUMMARY_ALGORITHM = ThreadMemorySummaryAlgorithm.make(
  "deterministic-transcript",
)

/** Version of the deterministic transcript fallback format. */
export const FALLBACK_THREAD_MEMORY_SUMMARY_VERSION = 1

/** Inputs for selecting bounded prompt memory for one review thread. */
export interface SelectThreadMemoryWindowInput {
  readonly threadId: ReviewThreadId
  readonly memory: ThreadMemory | null
  readonly messages: readonly ReviewThreadMessage[]
  readonly messageLimit?: number
}

/** Compact memory plus the latest completed messages in deterministic sequence order. */
export interface ThreadMemoryWindow {
  readonly memory: ThreadMemory | null
  readonly messages: readonly ReviewThreadMessage[]
}

/** Inputs for deriving a bounded fallback memory update after a completed agent reply. */
export interface CreateFallbackThreadMemoryUpdateInput {
  readonly threadId: ReviewThreadId
  readonly memory: ThreadMemory | null
  readonly messages: readonly ReviewThreadMessage[]
  readonly importantArtifactIds?: readonly ReviewAgentArtifactId[]
  readonly summaryCharacterLimit?: number
}

/** Selects compact memory and the latest N complete messages without mutating the input. */
export const selectThreadMemoryWindow = (
  input: SelectThreadMemoryWindowInput,
): ThreadMemoryWindow => {
  const messageLimit = normalizeLimit(input.messageLimit, DEFAULT_THREAD_MEMORY_MESSAGE_LIMIT)
  const completed = orderedCompletedMessages(input.threadId, input.messages)
  return {
    memory: memoryForThread(input.threadId, input.memory),
    messages: messageLimit === 0 ? [] : completed.slice(-messageLimit),
  }
}

/**
 * Builds a bounded cumulative summary only when a newer completed agent reply exists.
 * The returned watermark never includes a pending or failed agent message.
 */
export const createFallbackThreadMemoryUpdate = (
  input: CreateFallbackThreadMemoryUpdateInput,
): UpsertThreadMemoryInput | null => {
  const memory = memoryForThread(input.threadId, input.memory)
  const completed = orderedCompletedMessages(input.threadId, input.messages)
  const latestSuccessfulReply = findLast(completed, (message) => message.author === "agent")
  const priorWatermark = memory?.summarizedThroughSequence ?? 0
  if (latestSuccessfulReply === undefined || latestSuccessfulReply.sequence <= priorWatermark) {
    return null
  }

  const additions = completed.filter(
    (message) =>
      message.sequence > priorWatermark && message.sequence <= latestSuccessfulReply.sequence,
  )
  const parts = [memory?.summary.trim() ?? "", ...additions.map(renderMessage)].filter(
    (part) => part.length > 0,
  )
  const summaryCharacterLimit = normalizePositiveLimit(
    input.summaryCharacterLimit,
    DEFAULT_THREAD_MEMORY_SUMMARY_CHARACTER_LIMIT,
  )

  return UpsertThreadMemoryInput.make({
    threadId: input.threadId,
    summary: boundSummary(parts.join("\n"), summaryCharacterLimit),
    summarizedThroughSequence: latestSuccessfulReply.sequence,
    summaryAlgorithm: FALLBACK_THREAD_MEMORY_SUMMARY_ALGORITHM,
    summaryVersion: FALLBACK_THREAD_MEMORY_SUMMARY_VERSION,
    importantArtifactIds: orderedUniqueArtifactIds(
      input.importantArtifactIds ?? memory?.importantArtifactIds ?? [],
    ),
  })
}

const memoryForThread = (threadId: ReviewThreadId, memory: ThreadMemory | null) =>
  memory?.threadId === threadId ? memory : null

const orderedCompletedMessages = (
  threadId: ReviewThreadId,
  messages: readonly ReviewThreadMessage[],
) => {
  const completed = messages.filter(
    (message) => message.threadId === threadId && message.status === "complete",
  )
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks toSorted; only the copy mutates.
  return completed.sort(
    (left, right) => left.sequence - right.sequence || compareStrings(left.id, right.id),
  )
}

const renderMessage = (message: ReviewThreadMessage) => {
  const author = message.author === "agent" ? "assistant" : "user"
  const body = message.bodyMarkdown.trim().replace(/\s+/g, " ") || "(empty)"
  return `[#${message.sequence}] ${author}: ${body}`
}

const boundSummary = (summary: string, characterLimit: number) => {
  if (summary.length <= characterLimit) return summary
  const marker = "[Earlier context omitted]\n"
  if (characterLimit <= marker.length) return summary.slice(-characterLimit)
  return `${marker}${summary.slice(-(characterLimit - marker.length))}`
}

const orderedUniqueArtifactIds = (artifactIds: readonly ReviewAgentArtifactId[]) => {
  const unique = [...new Set(artifactIds)]
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks toSorted; only the copy mutates.
  return unique.sort(compareStrings)
}

const findLast = <Item>(items: readonly Item[], predicate: (item: Item) => boolean) => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return item
  }
  return undefined
}

const normalizeLimit = (value: number | undefined, fallback: number) =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value))

const normalizePositiveLimit = (value: number | undefined, fallback: number) => {
  const normalized = normalizeLimit(value, fallback)
  return normalized > 0 ? normalized : fallback
}

const compareStrings = (left: string, right: string) => (left === right ? 0 : left < right ? -1 : 1)
