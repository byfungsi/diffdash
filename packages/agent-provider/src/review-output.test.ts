import { describe, expect, it } from "@effect/vitest"

import {
  normalizeProviderReviewThreadResponse,
  REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA,
} from "./review-output"

describe("provider review output", () => {
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

  it("normalizes current and legacy response fields without changing precedence", () => {
    expect(
      normalizeProviderReviewThreadResponse({
        bodyMarkdown: "Finding",
        threadSummary: "current summary",
        threadSummaryUpdate: "legacy summary",
        referencedLocations: ["current", { _tag: "review" }],
        referencedAnchors: ["legacy"],
      }),
    ).toEqual({
      bodyMarkdown: "Finding",
      threadSummary: "current summary",
      referencedLocations: ["current", '{"_tag":"review"}'],
    })
  })

  it("leaves non-record responses unchanged", () => {
    const value = ["unexpected"]
    expect(normalizeProviderReviewThreadResponse(value)).toBe(value)
  })

  it("serializes referenced locations without throwing on provider-owned values", () => {
    const cyclic: { readonly _tag: string; self?: unknown } = { _tag: "review" }
    cyclic.self = cyclic

    expect(
      normalizeProviderReviewThreadResponse({
        bodyMarkdown: "Finding",
        referencedAnchors: [cyclic, { line: 12n }],
      }),
    ).toMatchObject({
      referencedLocations: ['{"_tag":"review","self":"[Circular]"}', '{"line":"12n"}'],
    })
  })
})
