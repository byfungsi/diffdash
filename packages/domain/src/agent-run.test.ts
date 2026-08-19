import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { AgentRunId, ReviewAgentProviderId, ReviewAgentUsage } from "./review-agent"
import { ReviewKey, ReviewRevision } from "./review-identity"
import { ReviewThreadId } from "./review-thread"
import {
  AgentPromptVersion,
  AgentRun,
  CancelledAgentRun,
  CompletedAgentRun,
  InterruptedAgentRun,
  RunningAgentRun,
  isTerminalAgentRun,
  ThreadMemory,
  ThreadMemorySummaryAlgorithm,
} from "./agent-run"

describe("AgentRun", () => {
  it("models run lifecycle fields structurally", () => {
    const usage = ReviewAgentUsage.make({
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: null,
      cacheWriteTokens: 10,
      costUsd: 0.0042,
    })
    const runId = AgentRunId.make("run-72")
    const completed = CompletedAgentRun.make({
      id: runId,
      threadId: ReviewThreadId.make("thread-72"),
      reviewKey: ReviewKey.make("github:fungsi/diffdash#72"),
      baseRevision: ReviewRevision.make("base-72"),
      headRevision: ReviewRevision.make("head-72"),
      provider: ReviewAgentProviderId.make("claude"),
      model: "claude-sonnet-4",
      promptVersion: AgentPromptVersion.make("thread-v1"),
      usage,
      startedAt: "2026-07-12T00:00:00.000Z",
      completedAt: "2026-07-12T00:00:01.000Z",
    })
    expect(completed.usage).toEqual(usage)
    const running = RunningAgentRun.make({
      id: AgentRunId.make("run-running"),
      threadId: completed.threadId,
      reviewKey: completed.reviewKey,
      baseRevision: completed.baseRevision,
      headRevision: completed.headRevision,
      provider: completed.provider,
      model: completed.model,
      promptVersion: completed.promptVersion,
      startedAt: completed.startedAt,
    })
    expect(running).toMatchObject({ _tag: "Running" })
    expect(Schema.encodeSync(AgentRun)(running)).toEqual({
      _tag: "Running",
      id: "run-running",
      threadId: "thread-72",
      reviewKey: "github:fungsi/diffdash#72",
      baseRevision: "base-72",
      headRevision: "head-72",
      provider: "claude",
      model: "claude-sonnet-4",
      promptVersion: "thread-v1",
      startedAt: "2026-07-12T00:00:00.000Z",
    })
  })

  it("models cancellation and Core interruption as distinct terminal states", () => {
    const identity = {
      id: AgentRunId.make("run-terminal"),
      threadId: ReviewThreadId.make("thread-terminal"),
      reviewKey: ReviewKey.make("github:fungsi/diffdash#256"),
      baseRevision: ReviewRevision.make("base-256"),
      headRevision: ReviewRevision.make("head-256"),
      provider: ReviewAgentProviderId.make("opencode"),
      model: "openai/gpt-5",
      promptVersion: AgentPromptVersion.make("thread-v1"),
      startedAt: "2026-08-16T00:00:00.000Z",
      completedAt: "2026-08-16T00:00:01.000Z",
    } as const
    const cancelled = CancelledAgentRun.make(identity)
    const interrupted = InterruptedAgentRun.make(identity)

    expect(Schema.decodeUnknownSync(AgentRun)(Schema.encodeSync(AgentRun)(cancelled))).toEqual(
      cancelled,
    )
    expect(Schema.decodeUnknownSync(AgentRun)(Schema.encodeSync(AgentRun)(interrupted))).toEqual(
      interrupted,
    )
    expect(isTerminalAgentRun(cancelled)).toBe(true)
    expect(isTerminalAgentRun(interrupted)).toBe(true)
    expect(
      isTerminalAgentRun(
        RunningAgentRun.make({
          id: identity.id,
          threadId: identity.threadId,
          reviewKey: identity.reviewKey,
          baseRevision: identity.baseRevision,
          headRevision: identity.headRevision,
          provider: identity.provider,
          model: identity.model,
          promptVersion: identity.promptVersion,
          startedAt: identity.startedAt,
        }),
      ),
    ).toBe(false)
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
    expect(() =>
      Schema.decodeUnknownSync(ThreadMemory)({
        ...valid,
        summarizedThroughSequence: 1.5,
      }),
    ).toThrow("summarizedThroughSequence")
    expect(() =>
      Schema.decodeUnknownSync(ThreadMemory)({
        ...valid,
        updatedAt: "2026-07-12T00:00:00+00:00",
      }),
    ).toThrow("updatedAt")
  })
})
