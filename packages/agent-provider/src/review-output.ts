import { Predicate } from "effect"

import { providerJsonContent } from "./provider-json"

/** Strict JSON Schema accepted by every provider's review structured-output API. */
export const REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bodyMarkdown", "threadSummaryUpdate", "referencedAnchors"],
  properties: {
    bodyMarkdown: { type: "string", minLength: 1 },
    threadSummaryUpdate: { type: ["string", "null"], minLength: 1 },
    referencedAnchors: {
      type: ["array", "null"],
      items: {
        anyOf: [
          reviewAnchorJsonSchema("review", {}),
          reviewAnchorJsonSchema("file", {
            fileId: { type: "string", minLength: 1 },
            filePath: { type: "string" },
            oldPath: { type: ["string", "null"] },
          }),
          reviewAnchorJsonSchema("hunk", {
            fileId: { type: "string", minLength: 1 },
            filePath: { type: "string" },
            oldPath: { type: ["string", "null"] },
            hunkId: { type: "string", minLength: 1 },
            hunkFingerprint: { type: "string", minLength: 1 },
            header: { type: "string" },
            oldStart: { type: "number" },
            oldLines: { type: "number" },
            newStart: { type: "number" },
            newLines: { type: "number" },
          }),
          reviewAnchorJsonSchema("line", {
            fileId: { type: "string", minLength: 1 },
            filePath: { type: "string" },
            oldPath: { type: ["string", "null"] },
            hunkId: { type: "string", minLength: 1 },
            hunkFingerprint: { type: "string", minLength: 1 },
            hunkHeader: { type: "string" },
            side: { type: "string", enum: ["old", "new"] },
            lineNumber: { type: "number" },
            lineContent: { type: "string" },
          }),
        ],
      },
    },
  },
} as const

/** Normalizes current and legacy provider fields to the provider-neutral review response shape. */
export const normalizeProviderReviewThreadResponse = (value: unknown): unknown => {
  if (!Predicate.isReadonlyRecord(value)) return value
  const locations = value.referencedLocations ?? value.referencedAnchors ?? []
  return {
    bodyMarkdown: value.bodyMarkdown,
    threadSummary: value.threadSummary ?? value.threadSummaryUpdate ?? null,
    referencedLocations: Array.isArray(locations) ? locations.map(providerJsonContent) : locations,
  }
}

function reviewAnchorJsonSchema(
  tag: "review" | "file" | "hunk" | "line",
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["_tag", ...Object.keys(properties)],
    properties: { _tag: { type: "string", enum: [tag] }, ...properties },
  }
}
