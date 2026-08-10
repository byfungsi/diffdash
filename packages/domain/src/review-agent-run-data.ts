import { Predicate, Schema } from "effect"

import { NonNegativeFiniteNumber, NonNegativeInteger } from "./domain-scalar"
import { ReviewAgentProviderId } from "./review-agent-provider-id"

/** Persistent identity for one normalized agent artifact. */
export const ReviewAgentArtifactId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("ReviewAgentArtifactId"),
)

/** Persistent identity for one normalized agent artifact. */
export type ReviewAgentArtifactId = typeof ReviewAgentArtifactId.Type

/** Provider-owned identity for an agent run or session. */
export const ReviewAgentProviderRunId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("ReviewAgentProviderRunId"),
)

/** Provider-owned identity for an agent run or session. */
export type ReviewAgentProviderRunId = typeof ReviewAgentProviderRunId.Type

/** Normalized artifact categories independent of provider event protocols. */
export const ReviewAgentArtifactType = Schema.Literals([
  "file_read",
  "search_result",
  "shell_output",
  "web_result",
  "diff_context",
  "mcp_tool_result",
  "provider_message",
  "unknown",
])

/** Normalized artifact categories independent of provider event protocols. */
export type ReviewAgentArtifactType = typeof ReviewAgentArtifactType.Type

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isReadonlyObject(value)

/** JSON object retained as provider-neutral artifact metadata. */
export const ReviewAgentArtifactMetadata = Schema.Json.pipe(
  Schema.refine(isJsonObject, { message: "Artifact metadata must be a JSON object" }),
)

/** JSON-safe provider-neutral artifact metadata. */
export type ReviewAgentArtifactMetadata = typeof ReviewAgentArtifactMetadata.Type

/** A bounded provider artifact suitable for persistence and later prompt context. */
export class ReviewAgentArtifact extends Schema.Class<ReviewAgentArtifact>("ReviewAgentArtifact")({
  type: ReviewAgentArtifactType,
  provider: ReviewAgentProviderId,
  title: Schema.String,
  content: Schema.String,
  contentDigest: Schema.String,
  metadata: ReviewAgentArtifactMetadata,
  truncated: Schema.Boolean,
  originalSize: NonNegativeInteger,
}) {}

/** Provider-neutral usage and cost fields reported for one turn when available. */
export class ReviewAgentUsage extends Schema.Class<ReviewAgentUsage>("ReviewAgentUsage")({
  inputTokens: Schema.NullOr(NonNegativeInteger),
  outputTokens: Schema.NullOr(NonNegativeInteger),
  cacheReadTokens: Schema.NullOr(NonNegativeInteger),
  cacheWriteTokens: Schema.NullOr(NonNegativeInteger),
  costUsd: Schema.NullOr(NonNegativeFiniteNumber),
}) {}
