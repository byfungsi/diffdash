import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Schema } from "effect"

import {
  normalizeReviewThreadAgentResponse,
  REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA,
  ReviewThreadAgentResponse,
  THREAD_MODE_REVIEW_AGENT_PERMISSIONS,
} from "./review-agent"

describe("review agent contract", () => {
  it.effect("FUN-70 AC: accepts a valid Markdown response and optional memory update", () =>
    Effect.gen(function* () {
      const response = yield* Schema.decodeUnknown(ReviewThreadAgentResponse)({
        bodyMarkdown: "## Finding\n\nUse the parsed value.",
        threadSummaryUpdate: "The thread is discussing boundary parsing.",
      })

      expect(response.bodyMarkdown).toContain("## Finding")
      expect(response.threadSummaryUpdate).toContain("boundary parsing")
    }),
  )

  it.effect("FUN-70 AC: rejects an empty final response", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        Schema.decodeUnknown(ReviewThreadAgentResponse)({ bodyMarkdown: "" }),
      )

      expect(Either.isLeft(result)).toBe(true)
    }),
  )

  it.effect("FUN-70 AC: converts nullable strict output fields to optional domain fields", () =>
    Effect.gen(function* () {
      const response = yield* Schema.decodeUnknown(ReviewThreadAgentResponse)(
        normalizeReviewThreadAgentResponse({
          bodyMarkdown: "The hunk is correct.",
          threadSummaryUpdate: null,
          referencedAnchors: null,
        }),
      )

      expect(response.bodyMarkdown).toBe("The hunk is correct.")
      expect(response.threadSummaryUpdate).toBeUndefined()
      expect(response.referencedAnchors).toBeUndefined()
    }),
  )

  it("FUN-70 AC: exposes a strict schema for provider structured output", () => {
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

  it("FUN-70 AC: explicitly denies mutation in thread mode", () => {
    expect(THREAD_MODE_REVIEW_AGENT_PERMISSIONS).toMatchObject({
      dependencyMutation: "deny",
      editTools: "deny",
      filesystem: "read-only",
      formatting: "deny",
      gitMutation: "deny",
      githubPublishing: "deny",
    })
  })
})
