import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"

import {
  REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA,
  ReviewThreadAgentResponse,
  ReviewThreadAgentResponseFromProvider,
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
      Schema.decodeUnknownSync(ReviewThreadAgentResponseFromProvider)({
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

  it("rejects non-record provider responses", () => {
    const decoded = Schema.decodeUnknownResult(ReviewThreadAgentResponseFromProvider)([
      "unexpected",
    ])
    expect(Result.isFailure(decoded)).toBe(true)
  })

  it("discards malformed anchors without throwing on provider-owned JSON", () => {
    expect(
      Schema.decodeUnknownSync(ReviewThreadAgentResponseFromProvider)({
        bodyMarkdown: "Finding",
        referencedAnchors: [{ _tag: "file" }, { line: 12 }],
      }),
    ).toEqual({ bodyMarkdown: "Finding", referencedAnchors: [] })
  })

  it("encodes optional domain fields as nullable provider fields", () => {
    const encoded = Schema.encodeSync(ReviewThreadAgentResponseFromProvider)(
      ReviewThreadAgentResponse.make({ bodyMarkdown: "Finding" }),
    )

    expect(encoded).toEqual({
      bodyMarkdown: "Finding",
      threadSummaryUpdate: null,
      referencedAnchors: null,
    })
  })

  it("decodes nullable provider fields without leaking null into the domain", () => {
    const decoded = Schema.decodeUnknownSync(ReviewThreadAgentResponseFromProvider)({
      bodyMarkdown: "Finding",
      threadSummaryUpdate: null,
      referencedAnchors: null,
    })

    expect(decoded.bodyMarkdown).toBe("Finding")
    expect(decoded.threadSummaryUpdate).toBeUndefined()
    expect(decoded.referencedAnchors).toEqual([])
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
