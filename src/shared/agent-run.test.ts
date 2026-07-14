import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { AgentRunId, ReviewAgentUsage } from "./review-agent"
import { ReviewThreadId } from "./review-thread"
import {
  AgentPromptVersion,
  AgentRun,
  CompleteAgentRunInput,
  ThreadMemory,
  ThreadMemorySummaryAlgorithm,
} from "./agent-run"

describe("AgentRun", () => {
  it("FUN-72 AC: models nullable normalized usage on runs and completion input", () => {
    const usage = ReviewAgentUsage.make({
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: null,
      cacheWriteTokens: 10,
      costUsd: 0.0042,
    })
    const runId = AgentRunId.make("run-72")
    const completed = AgentRun.make({
      id: runId,
      threadId: ReviewThreadId.make("thread-72"),
      provider: "claude",
      model: "claude-sonnet-4",
      promptVersion: AgentPromptVersion.make("thread-v1"),
      status: "completed",
      providerRunId: null,
      usage,
      error: null,
      startedAt: "2026-07-12T00:00:00.000Z",
      completedAt: "2026-07-12T00:00:01.000Z",
    })
    const completion = CompleteAgentRunInput.make({ runId, usage })

    expect(completed.usage).toEqual(usage)
    expect(completion.usage).toEqual(usage)
    expect(AgentRun.make({ ...completed, status: "running", usage: null }).usage).toBeNull()
  })
})

describe("ThreadMemory", () => {
  it("FUN-76 AC: validates summary watermark and algorithm metadata", () => {
    const valid = ThreadMemory.make({
      threadId: ReviewThreadId.make("thread-76"),
      summary: "Compact summary",
      summarizedThroughSequence: 8,
      summaryAlgorithm: ThreadMemorySummaryAlgorithm.make("deterministic-transcript"),
      summaryVersion: 1,
      importantArtifactIds: [],
      updatedAt: "2026-07-12T00:00:00.000Z",
    })

    expect(valid.summarizedThroughSequence).toBe(8)
    expect(() =>
      Schema.decodeUnknownSync(ThreadMemory)({
        ...valid,
        summarizedThroughSequence: -1,
      }),
    ).toThrow("summarizedThroughSequence")
    expect(() =>
      Schema.decodeUnknownSync(ThreadMemory)({
        ...valid,
        summaryVersion: 0,
      }),
    ).toThrow("summaryVersion")
  })
})
