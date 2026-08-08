import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"

import { ReviewThreadAgentResponse } from "./review-agent"

describe("review agent contract", () => {
  it.effect("FUN-70 AC: accepts a valid Markdown response and optional memory update", () =>
    Effect.gen(function* () {
      const response = yield* Schema.decodeUnknownEffect(ReviewThreadAgentResponse)({
        bodyMarkdown: "## Finding\n\nUse the parsed value.",
        threadSummaryUpdate: "The thread is discussing boundary parsing.",
      })

      expect(response.bodyMarkdown).toContain("## Finding")
      expect(response.threadSummaryUpdate).toContain("boundary parsing")
    }),
  )

  it.effect("FUN-70 AC: rejects an empty final response", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        Schema.decodeUnknownEffect(ReviewThreadAgentResponse)({ bodyMarkdown: "" }),
      )

      expect(Result.isFailure(result)).toBe(true)
    }),
  )
})
