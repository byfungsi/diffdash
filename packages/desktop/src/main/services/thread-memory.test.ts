import { describe, expect, it } from "@effect/vitest"

import { ThreadMemory, ThreadMemorySummaryAlgorithm } from "../../shared/agent-run"
import { ReviewAgentArtifactId } from "../../shared/review-agent"
import {
  MarkdownBody,
  ReviewThreadId,
  ReviewThreadMessage,
  ReviewThreadMessageId,
  type ReviewThreadMessageStatus,
} from "../../shared/review-thread"
import {
  createFallbackThreadMemoryUpdate,
  FALLBACK_THREAD_MEMORY_SUMMARY_ALGORITHM,
  FALLBACK_THREAD_MEMORY_SUMMARY_VERSION,
  selectThreadMemoryWindow,
} from "./thread-memory"

const threadId = ReviewThreadId.make("thread-76")
const otherThreadId = ReviewThreadId.make("other-thread")

const makeMessage = (
  sequence: number,
  author: "user" | "agent",
  status: ReviewThreadMessageStatus = "complete",
  body = `message ${sequence}`,
  owner = threadId,
) =>
  ReviewThreadMessage.make({
    id: ReviewThreadMessageId.make(`${owner}-${sequence}-${status}`),
    threadId: owner,
    sequence,
    author,
    bodyMarkdown: MarkdownBody.make(body),
    status,
    agentRunId: author === "agent" ? `run-${sequence}` : null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  })

const memory = ThreadMemory.make({
  threadId,
  summary: "Existing compact summary.",
  summarizedThroughSequence: 2,
  summaryAlgorithm: ThreadMemorySummaryAlgorithm.make("provider-summary"),
  summaryVersion: 3,
  importantArtifactIds: [],
  updatedAt: "2026-07-12T00:00:00.000Z",
})

describe("thread memory", () => {
  it("FUN-76 AC: selects the latest ten complete messages in deterministic order", () => {
    const complete = Array.from({ length: 12 }, (_, index) =>
      makeMessage(index + 1, index % 2 === 0 ? "user" : "agent"),
    )
    const messages = [
      makeMessage(14, "agent", "pending", "interrupted partial"),
      ...complete.slice(6),
      ...complete.slice(0, 6),
      makeMessage(13, "agent", "failed", "failed partial"),
      makeMessage(15, "user", "complete", "foreign", otherThreadId),
    ]

    const window = selectThreadMemoryWindow({ threadId, memory, messages })

    expect(window.memory).toBe(memory)
    expect(window.messages.map(({ sequence }) => sequence)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ])
    expect(window.messages.map(({ bodyMarkdown }) => bodyMarkdown)).not.toContain(
      "interrupted partial",
    )
    expect(messages[0]?.sequence).toBe(14)
  })

  it("FUN-76 AC: creates no update until a completed agent reply exists", () => {
    const messages = [
      makeMessage(1, "user"),
      makeMessage(2, "agent", "failed", "failed partial"),
      makeMessage(3, "agent", "pending", "interrupted partial"),
    ]

    expect(createFallbackThreadMemoryUpdate({ threadId, memory: null, messages })).toBeNull()
  })

  it("FUN-76 AC: advances the watermark through a successful reply and excludes partial replies", () => {
    const artifactA = ReviewAgentArtifactId.make("artifact-a")
    const artifactB = ReviewAgentArtifactId.make("artifact-b")
    const update = createFallbackThreadMemoryUpdate({
      threadId,
      memory,
      messages: [
        makeMessage(5, "agent", "complete", "Final answer"),
        makeMessage(4, "agent", "failed", "Do not retain this partial answer"),
        makeMessage(3, "user", "complete", "Follow-up question"),
      ],
      importantArtifactIds: [artifactB, artifactA, artifactB],
    })

    expect(update).toMatchObject({
      summarizedThroughSequence: 5,
      summaryAlgorithm: FALLBACK_THREAD_MEMORY_SUMMARY_ALGORITHM,
      summaryVersion: FALLBACK_THREAD_MEMORY_SUMMARY_VERSION,
      importantArtifactIds: [artifactA, artifactB],
    })
    expect(update?.summary).toContain("Existing compact summary.")
    expect(update?.summary).toContain("[#3] user: Follow-up question")
    expect(update?.summary).toContain("[#5] assistant: Final answer")
    expect(update?.summary).not.toContain("partial answer")
  })

  it("FUN-76 AC: produces the same bounded fallback summary for the same inputs", () => {
    const input = {
      threadId,
      memory,
      messages: [
        makeMessage(3, "user", "complete", "x".repeat(100)),
        makeMessage(4, "agent", "complete", "newest-reply"),
      ],
      summaryCharacterLimit: 80,
    } as const

    const first = createFallbackThreadMemoryUpdate(input)
    const second = createFallbackThreadMemoryUpdate(input)

    expect(first).toEqual(second)
    expect(first?.summary.length).toBeLessThanOrEqual(80)
    expect(first?.summary).toContain("newest-reply")
    expect(first?.summarizedThroughSequence).toBe(4)
  })

  it("does not replace memory when the successful reply is already summarized", () => {
    const update = createFallbackThreadMemoryUpdate({
      threadId,
      memory,
      messages: [makeMessage(1, "user"), makeMessage(2, "agent")],
    })

    expect(update).toBeNull()
  })
})
