import { Predicate, Result, Schema } from "effect"
export { AgentRunId } from "./agent-run-id"
export { ReviewAgentProviderId } from "./review-agent-provider-id"
export {
  ReviewAgentArtifact,
  ReviewAgentArtifactId,
  ReviewAgentArtifactMetadata,
  ReviewAgentArtifactType,
  ReviewAgentProviderRunId,
  ReviewAgentUsage,
} from "./review-agent-run-data"

import { ReviewAnchor, ReviewThreadId } from "./review-thread"
import {
  ReviewAgentArtifact,
  ReviewAgentProviderRunId,
  ReviewAgentUsage,
} from "./review-agent-run-data"

/** Provider-neutral lifecycle stages shown while a review agent turn is running. */
export const ReviewAgentProgressStage = Schema.Literals([
  "preparing-context",
  "reserving-workspace",
  "creating-repository",
  "fetching-review-revision",
  "checking-out-revision",
  "starting-agent",
  "reviewing",
  "restoring-workspace",
])

/** Provider-neutral lifecycle stages shown while a review agent turn is running. */
export type ReviewAgentProgressStage = typeof ReviewAgentProgressStage.Type

/** One transient lifecycle update for a running review thread agent. */
export class ReviewAgentProgress extends Schema.Class<ReviewAgentProgress>("ReviewAgentProgress")({
  threadId: ReviewThreadId,
  stage: ReviewAgentProgressStage,
}) {}

/** User-facing copy for each provider-neutral review-agent lifecycle stage. */
export const REVIEW_AGENT_PROGRESS_LABELS: Readonly<Record<ReviewAgentProgressStage, string>> = {
  "preparing-context": "Preparing review context...",
  "reserving-workspace": "Reserving isolated workspace...",
  "creating-repository": "Creating isolated repository...",
  "fetching-review-revision": "Fetching latest review revision...",
  "checking-out-revision": "Checking out and verifying review revision...",
  "starting-agent": "Starting agent...",
  reviewing: "Agent is reviewing...",
  "restoring-workspace": "Restoring isolated workspace...",
}

/** Validated product response returned by every review agent provider. */
export class ReviewThreadAgentResponse extends Schema.Class<ReviewThreadAgentResponse>(
  "ReviewThreadAgentResponse",
)({
  bodyMarkdown: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  threadSummaryUpdate: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
  referencedAnchors: Schema.optional(Schema.Array(ReviewAnchor)),
}) {}

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

/** Decodes a raw or JSON-stringified value into a validated review anchor. */
export const decodeReviewAnchor = <Value>(value: Value): ReviewAnchor | null => {
  const serialized = Predicate.isString(value) ? value : reviewAgentJsonContent(value)
  try {
    const parsed = Schema.decodeUnknownResult(Schema.Json)(JSON.parse(serialized))
    if (Result.isFailure(parsed)) return null
    const decoded = Schema.decodeUnknownResult(ReviewAnchor)(parsed.success)
    return Result.isSuccess(decoded) ? decoded.success : null
  } catch {
    return null
  }
}

/** Converts current and legacy provider fields into the canonical review-agent response shape. */
export const normalizeReviewThreadAgentResponse = <Value>(value: Value) => {
  if (!Predicate.isReadonlyObject(value)) return value
  const rawAnchors = value.referencedLocations ?? value.referencedAnchors ?? []
  const referencedAnchors = Array.isArray(rawAnchors)
    ? rawAnchors.flatMap((anchor) => {
        const decoded = decodeReviewAnchor(anchor)
        return decoded === null ? [] : [decoded]
      })
    : rawAnchors
  const threadSummaryUpdate = value.threadSummary ?? value.threadSummaryUpdate
  if (threadSummaryUpdate === null || threadSummaryUpdate === undefined) {
    return { bodyMarkdown: value.bodyMarkdown, referencedAnchors }
  }
  return { bodyMarkdown: value.bodyMarkdown, threadSummaryUpdate, referencedAnchors }
}

function reviewAnchorJsonSchema(
  tag: "review" | "file" | "hunk" | "line",
  properties: Schema.JsonObject,
) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["_tag", ...Object.keys(properties)],
    properties: { _tag: { type: "string", enum: [tag] }, ...properties },
  }
}

const reviewAgentJsonContent = <Value>(value: Value): string => {
  if (Predicate.isString(value)) return value
  const ancestors: object[] = []
  try {
    const serialized = JSON.stringify(value, function (_key, nestedValue) {
      if (Predicate.isBigInt(nestedValue)) return `${nestedValue.toString()}n`
      if (!Predicate.isObjectOrArray(nestedValue)) return nestedValue
      while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop()
      if (ancestors.includes(nestedValue)) return "[Circular]"
      ancestors.push(nestedValue)
      return nestedValue
    })
    if (serialized !== undefined) return serialized
  } catch {
    return "[Unserializable]"
  }
  if (value === undefined) return "undefined"
  if (Predicate.isFunction(value)) return "[Function]"
  if (Predicate.isSymbol(value)) return "[Symbol]"
  return "[Unserializable]"
}

/** Complete normalized result from one local review thread provider turn. */
export class ReviewAgentTurnResult extends Schema.Class<ReviewAgentTurnResult>(
  "ReviewAgentTurnResult",
)({
  response: ReviewThreadAgentResponse,
  artifacts: Schema.Array(ReviewAgentArtifact),
  providerRunId: Schema.NullOr(ReviewAgentProviderRunId),
  usage: Schema.NullOr(ReviewAgentUsage),
}) {}
