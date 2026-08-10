import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"

import { ReviewAgentArtifact, ReviewAgentUsage } from "./review-agent-run-data"

const isRejected = (schema: Schema.ConstraintDecoder<unknown>, input: unknown) =>
  Result.isFailure(Schema.decodeUnknownResult(schema)(input))

describe("review agent run data", () => {
  it("rejects invalid token counts and USD costs", () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
      costUsd: 0.01,
    }

    expect(isRejected(ReviewAgentUsage, { ...usage, inputTokens: -1 })).toBe(true)
    expect(isRejected(ReviewAgentUsage, { ...usage, outputTokens: 1.5 })).toBe(true)
    expect(
      isRejected(ReviewAgentUsage, { ...usage, cacheReadTokens: Number.POSITIVE_INFINITY }),
    ).toBe(true)
    expect(isRejected(ReviewAgentUsage, { ...usage, costUsd: -0.01 })).toBe(true)
    expect(isRejected(ReviewAgentUsage, { ...usage, costUsd: Number.NaN })).toBe(true)
  })

  it("rejects invalid artifact original sizes", () => {
    const artifact = {
      type: "file_read",
      provider: "codex",
      title: "File",
      content: "content",
      contentDigest: "digest",
      metadata: {},
      truncated: false,
      originalSize: 0,
    }

    expect(Schema.decodeUnknownSync(ReviewAgentArtifact)(artifact).originalSize).toBe(0)
    expect(isRejected(ReviewAgentArtifact, { ...artifact, originalSize: -1 })).toBe(true)
    expect(isRejected(ReviewAgentArtifact, { ...artifact, originalSize: 2.5 })).toBe(true)
  })
})
