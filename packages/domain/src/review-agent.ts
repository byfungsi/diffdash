import { Schema } from "effect"

import { ReviewAnchor, ReviewThreadId } from "./review-thread"
import { ReviewKey, ReviewRevision } from "./review-identity"

/** Persistent identity for one review agent execution. */
export const AgentRunId = Schema.String.pipe(Schema.minLength(1), Schema.brand("AgentRunId"))

/** Persistent identity for one review agent execution. */
export type AgentRunId = typeof AgentRunId.Type

/** Persistent identity for one normalized agent artifact. */
export const ReviewAgentArtifactId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ReviewAgentArtifactId"),
)

/** Persistent identity for one normalized agent artifact. */
export type ReviewAgentArtifactId = typeof ReviewAgentArtifactId.Type

/** Provider-owned identity for an agent run or session. */
export const ReviewAgentProviderRunId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ReviewAgentProviderRunId"),
)

/** Provider-owned identity for an agent run or session. */
export type ReviewAgentProviderRunId = typeof ReviewAgentProviderRunId.Type

/** Open identity of the provider that produced a review run or artifact. */
export const ReviewAgentProviderId = Schema.String.pipe(Schema.minLength(1))

/** Open identity of the provider that produced a review run or artifact. */
export type ReviewAgentProviderId = typeof ReviewAgentProviderId.Type

/** Provider-neutral lifecycle stages shown while a review agent turn is running. */
export const ReviewAgentProgressStage = Schema.Literal(
  "preparing-context",
  "reserving-workspace",
  "creating-repository",
  "fetching-review-revision",
  "checking-out-revision",
  "starting-agent",
  "reviewing",
  "restoring-workspace",
)

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

/** Provider-neutral read-only permissions for one review agent turn. */
export class ReviewAgentPermissions extends Schema.Class<ReviewAgentPermissions>(
  "ReviewAgentPermissions",
)({
  filesystem: Schema.Literal("read-only"),
  editTools: Schema.Literal("deny"),
  gitMutation: Schema.Literal("deny"),
  dependencyMutation: Schema.Literal("deny"),
  formatting: Schema.Literal("deny"),
  githubPublishing: Schema.Literal("deny"),
  shell: Schema.Literal("provider-sandbox"),
  fileRead: Schema.Literal("allow"),
  search: Schema.Literal("allow"),
  diffDashMcp: Schema.Literal("allow"),
}) {}

/** Default fail-closed permissions for local AI comment thread mode. */
export const THREAD_MODE_REVIEW_AGENT_PERMISSIONS = ReviewAgentPermissions.make({
  filesystem: "read-only",
  editTools: "deny",
  gitMutation: "deny",
  dependencyMutation: "deny",
  formatting: "deny",
  githubPublishing: "deny",
  shell: "provider-sandbox",
  fileRead: "allow",
  search: "allow",
  diffDashMcp: "allow",
})

/** Validated product response returned by every review agent provider. */
export class ReviewThreadAgentResponse extends Schema.Class<ReviewThreadAgentResponse>(
  "ReviewThreadAgentResponse",
)({
  bodyMarkdown: Schema.String.pipe(Schema.minLength(1)),
  threadSummaryUpdate: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  referencedAnchors: Schema.optional(Schema.Array(ReviewAnchor)),
}) {}

/** Strict JSON Schema accepted by each provider's structured-output API. */
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
          reviewAnchorSchema("review", {}),
          reviewAnchorSchema("file", {
            fileId: { type: "string", minLength: 1 },
            filePath: { type: "string" },
            oldPath: { type: ["string", "null"] },
          }),
          reviewAnchorSchema("hunk", {
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
          reviewAnchorSchema("line", {
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

/** Converts nullable strict-output transport fields back to optional domain fields. */
export const normalizeReviewThreadAgentResponse = (value: unknown): unknown => {
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, field]) =>
        field !== null || (key !== "threadSummaryUpdate" && key !== "referencedAnchors"),
    ),
  )
}

function reviewAnchorSchema(
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Normalized artifact categories independent of provider event protocols. */
export const ReviewAgentArtifactType = Schema.Literal(
  "file_read",
  "search_result",
  "shell_output",
  "web_result",
  "diff_context",
  "mcp_tool_result",
  "provider_message",
  "unknown",
)

/** Normalized artifact categories independent of provider event protocols. */
export type ReviewAgentArtifactType = typeof ReviewAgentArtifactType.Type

/** A bounded provider artifact suitable for persistence and later prompt context. */
export class ReviewAgentArtifact extends Schema.Class<ReviewAgentArtifact>("ReviewAgentArtifact")({
  type: ReviewAgentArtifactType,
  provider: ReviewAgentProviderId,
  title: Schema.String,
  content: Schema.String,
  contentDigest: Schema.String,
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  truncated: Schema.Boolean,
  originalSize: Schema.Number,
}) {}

/** Provider-neutral usage and cost fields reported for one turn when available. */
export class ReviewAgentUsage extends Schema.Class<ReviewAgentUsage>("ReviewAgentUsage")({
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  cacheReadTokens: Schema.NullOr(Schema.Number),
  cacheWriteTokens: Schema.NullOr(Schema.Number),
  costUsd: Schema.NullOr(Schema.Number),
}) {}

/** Complete provider-neutral input for one local review thread turn. */
export class ReviewAgentTurnInput extends Schema.Class<ReviewAgentTurnInput>(
  "ReviewAgentTurnInput",
)({
  threadId: ReviewThreadId,
  reviewKey: ReviewKey,
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
  anchor: ReviewAnchor,
  stablePromptPrefix: Schema.String.pipe(Schema.minLength(1)),
  dynamicPromptSuffix: Schema.String.pipe(Schema.minLength(1)),
  cwd: Schema.NullOr(Schema.String),
  model: Schema.String.pipe(Schema.minLength(1)),
  permissions: ReviewAgentPermissions,
}) {}

/** Complete normalized result from one local review thread provider turn. */
export class ReviewAgentTurnResult extends Schema.Class<ReviewAgentTurnResult>(
  "ReviewAgentTurnResult",
)({
  response: ReviewThreadAgentResponse,
  artifacts: Schema.Array(ReviewAgentArtifact),
  providerRunId: Schema.NullOr(ReviewAgentProviderRunId),
  usage: Schema.NullOr(ReviewAgentUsage),
}) {}
