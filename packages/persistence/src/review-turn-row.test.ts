import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import {
  decodeAgentRunRow,
  decodeReviewThreadMessageRow,
  projectReviewConversation,
  ReviewConversationAgentRunReuseError,
  ReviewLifecycleRowDecodeError,
} from "./review-turn-row"

describe("review lifecycle row compatibility", () => {
  it.effect("rejects a running run carrying completion fields", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeAgentRunRow({
          id: "run-1",
          thread_id: "thread-1",
          review_key: "review-1",
          base_sha: "base",
          head_sha: "head",
          provider: "fixture",
          model: "fixture-model",
          prompt_version: "fixture-v1",
          status: "running",
          provider_run_id: null,
          usage_json: null,
          error: null,
          started_at: "2026-08-10T00:00:00.000Z",
          completed_at: "2026-08-10T00:00:01.000Z",
        }),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(ReviewLifecycleRowDecodeError)
      }
    }),
  )

  it.effect("normalizes a legacy failed response without provider metadata", () =>
    Effect.gen(function* () {
      const message = yield* decodeReviewThreadMessageRow({
        id: "message-1",
        thread_id: "thread-1",
        sequence: 2,
        author: "agent",
        body_markdown: "Legacy diagnostic is owned by the failed run.",
        status: "failed",
        agent_run_id: "run-1",
        failure_json: null,
        created_at: "2026-08-10T00:00:00.000Z",
        updated_at: "2026-08-10T00:00:01.000Z",
      })

      expect(message).toMatchObject({
        _tag: "Failed",
        failure: { _tag: "Internal" },
      })
      expect("bodyMarkdown" in message).toBe(false)
    }),
  )

  it.effect("rejects one agent run reused by multiple response messages", () =>
    Effect.gen(function* () {
      const run = yield* decodeAgentRunRow({
        id: "run-reused",
        thread_id: "thread-1",
        review_key: "review-1",
        base_sha: "base",
        head_sha: "head",
        provider: "fixture",
        model: "fixture-model",
        prompt_version: "fixture-v1",
        status: "completed",
        provider_run_id: null,
        usage_json: null,
        error: null,
        started_at: "2026-08-10T00:00:00.000Z",
        completed_at: "2026-08-10T00:00:01.000Z",
      })
      const messages = yield* Effect.forEach(["message-1", "message-2"], (id, index) =>
        decodeReviewThreadMessageRow({
          id,
          thread_id: "thread-1",
          sequence: index + 1,
          author: "agent",
          body_markdown: `Response ${index + 1}`,
          status: "complete",
          agent_run_id: run.id,
          failure_json: null,
          created_at: "2026-08-10T00:00:00.000Z",
          updated_at: "2026-08-10T00:00:01.000Z",
        }),
      )
      const firstMessage = messages[0]
      const secondMessage = messages[1]
      if (firstMessage === undefined || secondMessage === undefined) {
        throw new Error("Expected two decoded response messages")
      }

      const result = yield* Effect.result(projectReviewConversation(messages, [run]))

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toEqual(
          expect.objectContaining<Partial<ReviewConversationAgentRunReuseError>>({
            _tag: "ReviewConversationAgentRunReuseError",
            agentRunId: run.id,
            firstMessageId: firstMessage.id,
            reusedByMessageId: secondMessage.id,
          }),
        )
      }
    }),
  )
})
