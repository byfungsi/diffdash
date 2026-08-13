import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"

import {
  normalizeReviewThreadAgentResponse,
  REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA,
  ReviewThreadAgentResponse,
} from "./review-agent"
import { ReviewLevelAnchor } from "./review-thread"

describe("review agent contract", () => {
  it("exposes the strict provider structured-output schema", () => {
    const schema = REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA
    const anchors = schema.properties.referencedAnchors.items.anyOf

    expect(schema.required).toEqual(["bodyMarkdown", "threadSummaryUpdate", "referencedAnchors"])
    expect(schema.properties.threadSummaryUpdate.type).toEqual(["string", "null"])
    expect(schema.properties.referencedAnchors.type).toEqual(["array", "null"])
    expect(anchors).toHaveLength(4)
    expect(JSON.stringify(schema)).not.toContain('"oneOf"')
    expect(JSON.stringify(schema)).not.toContain('"const"')
    for (const anchor of anchors) {
      expect(anchor.additionalProperties).toBe(false)
      expect(anchor.required).toEqual(Object.keys(anchor.properties))
      for (const property of Object.values(anchor.properties)) {
        expect(property).toHaveProperty("type")
      }
    }
  })

  it("normalizes current and legacy response fields and decodes anchors", () => {
    const anchor = ReviewLevelAnchor.make({})

    expect(
      normalizeReviewThreadAgentResponse({
        bodyMarkdown: "Finding",
        threadSummary: "current summary",
        threadSummaryUpdate: "legacy summary",
        referencedLocations: ["current", JSON.stringify(anchor)],
        referencedAnchors: ["legacy"],
      }),
    ).toEqual({
      bodyMarkdown: "Finding",
      threadSummaryUpdate: "current summary",
      referencedAnchors: [anchor],
    })
  })

  it("leaves non-record responses unchanged", () => {
    const value = ["unexpected"]
    expect(normalizeReviewThreadAgentResponse(value)).toBe(value)
  })

  it("discards malformed anchors without throwing on provider-owned values", () => {
    const cyclic: { readonly _tag: string; self?: unknown } = { _tag: "file" }
    cyclic.self = cyclic

    expect(
      normalizeReviewThreadAgentResponse({
        bodyMarkdown: "Finding",
        referencedAnchors: [cyclic, { line: 12n }],
      }),
    ).toEqual({ bodyMarkdown: "Finding", referencedAnchors: [] })
  })

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
