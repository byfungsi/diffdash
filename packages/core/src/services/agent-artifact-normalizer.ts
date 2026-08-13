import { Array as EffectArray, Context, Effect, Layer, Order, Predicate, Schema } from "effect"
import { createHash } from "node:crypto"

import {
  ReviewAgentArtifact,
  ReviewAgentArtifactMetadata,
  type ReviewAgentArtifactType,
  type ReviewAgentProviderId,
} from "@diffdash/domain/review-agent"
import type { AgentArtifactCandidate, AgentArtifactMetadata } from "@diffdash/agent-provider"
import { boundedProviderReason } from "@diffdash/agent-provider/runtime"
import { redactProviderSecrets } from "@diffdash/agent-provider/security"
import { truncateUtf8, utf8ByteLength } from "@diffdash/mcp/utf8-budget"
import { CoreExpectedCause, toCoreExpectedCause } from "../core-error-cause"

/** Default maximum UTF-8 byte size retained for one normalized artifact body. */
const DEFAULT_AGENT_ARTIFACT_CONTENT_LIMIT_BYTES = 64 * 1024
const ALLOWED_ARTIFACT_METADATA_KEYS = new Set([
  "command",
  "eventType",
  "exitCode",
  "file",
  "hunkId",
  "isError",
  "itemId",
  "line",
  "messageId",
  "model",
  "nested",
  "partId",
  "path",
  "query",
  "server",
  "status",
  "tool",
  "toolName",
  "toolUseId",
  "url",
])

/** Provider-boundary input after event classification but before product normalization. */
interface NormalizeAgentArtifactInput {
  readonly type: ReviewAgentArtifactType
  readonly provider: ReviewAgentProviderId
  readonly title: string
  readonly content: string
  readonly metadata: AgentArtifactMetadata
  readonly maxContentBytes?: number
}

/** A provider artifact could not be converted to bounded, JSON-safe product data. */
class AgentArtifactNormalizationError extends Schema.TaggedError<AgentArtifactNormalizationError>()(
  "AgentArtifactNormalizationError",
  {
    reason: Schema.String,
    cause: CoreExpectedCause,
  },
) {}

/** Creates stable digests and bounded normalized artifacts from provider-boundary values. */
export class AgentArtifactNormalizer extends Context.Service<
  AgentArtifactNormalizer,
  {
    readonly normalize: (
      input: NormalizeAgentArtifactInput,
    ) => Effect.Effect<ReviewAgentArtifact, AgentArtifactNormalizationError>
  }
>()("@diffdash/AgentArtifactNormalizer") {
  static readonly layer = Layer.succeed(
    AgentArtifactNormalizer,
    AgentArtifactNormalizer.of({
      normalize: Effect.fn("AgentArtifactNormalizer.normalize")(normalizeAgentArtifact),
    }),
  )
}

const artifactTypeByCandidate = {
  "file-read": "file_read",
  "search-result": "search_result",
  "shell-output": "shell_output",
  "web-result": "web_result",
  "diff-context": "diff_context",
  "mcp-tool-result": "mcp_tool_result",
  "provider-message": "provider_message",
  unknown: "unknown",
} satisfies Readonly<Record<AgentArtifactCandidate["type"], ReviewAgentArtifactType>>

/** Converts the SDK wire category into the persisted domain category. */
export const normalizeAgentArtifactType = (
  type: AgentArtifactCandidate["type"],
): ReviewAgentArtifactType => artifactTypeByCandidate[type]

/** Normalizes one classified provider event without retaining its raw protocol shape. */
function normalizeAgentArtifact(
  input: NormalizeAgentArtifactInput,
): Effect.Effect<ReviewAgentArtifact, AgentArtifactNormalizationError> {
  return Effect.try({
    try: () => {
      const limit = input.maxContentBytes ?? DEFAULT_AGENT_ARTIFACT_CONTENT_LIMIT_BYTES
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new Error("Artifact content limit must be a positive safe integer")
      }
      if (Object.hasOwn(input.metadata, "truncation")) {
        throw new Error("Artifact metadata key 'truncation' is reserved by DiffDash")
      }

      const canonicalMetadata = toCanonicalRecord({
        ...allowlistedMetadata(input.metadata),
        sourceProvider: input.provider,
      })
      const redactedContent = redactProviderSecrets(input.content)
      const originalSize = utf8ByteLength(redactedContent)
      const truncated = originalSize > limit
      const content = truncated
        ? truncateUtf8(redactedContent, limit, "\n\n[DiffDash truncated artifact content]")
        : redactedContent
      const retainedSize = utf8ByteLength(content)
      const contentDigest = `sha256:${createHash("sha256")
        .update(canonicalJson({ content: redactedContent, metadata: canonicalMetadata }))
        .digest("hex")}`

      return ReviewAgentArtifact.make({
        type: input.type,
        provider: input.provider,
        title: redactProviderSecrets(input.title),
        content,
        contentDigest,
        metadata: {
          ...canonicalMetadata,
          truncation: {
            truncated,
            originalSizeBytes: originalSize,
            retainedSizeBytes: retainedSize,
            limitBytes: limit,
          },
        },
        truncated,
        originalSize,
      })
    },
    catch: (cause) =>
      AgentArtifactNormalizationError.make({
        reason: boundedProviderReason(cause, "Artifact normalization failed"),
        cause: toCoreExpectedCause(cause),
      }),
  })
}

const toCanonicalRecord = (value: AgentArtifactMetadata): Schema.JsonObject => {
  const canonical = toJsonValue(value, new WeakSet())
  if (!isJsonObject(canonical)) {
    throw new Error("Artifact metadata must be a JSON object")
  }
  return canonical
}

const allowlistedMetadata = (metadata: AgentArtifactMetadata): ReviewAgentArtifactMetadata =>
  Schema.decodeUnknownSync(ReviewAgentArtifactMetadata)(
    Object.fromEntries(
      Object.entries(metadata)
        .filter(([key]) => ALLOWED_ARTIFACT_METADATA_KEYS.has(key))
        .map(([key, value]) => [key, redactMetadataValue(value, key)]),
    ),
  )

const redactMetadataValue = (value: Schema.Json, key?: string): Schema.Json => {
  if (key !== undefined && isProviderSecretMetadataKey(key)) return "[redacted]"
  if (Predicate.isString(value)) return redactProviderSecrets(value)
  if (Array.isArray(value)) return value.map((item) => redactMetadataValue(item))
  if (value === null || !isJsonObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([nestedKey, nested]) => [
      nestedKey,
      redactMetadataValue(nested, nestedKey),
    ]),
  )
}

const isProviderSecretMetadataKey = (key: string) =>
  redactProviderSecrets(`${key}=credential`) !== `${key}=credential`

const toJsonValue = (value: Schema.Json, ancestors: WeakSet<object>): Schema.Json => {
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) return value
  if (Predicate.isNumber(value)) {
    if (!Number.isFinite(value)) throw new Error("Artifact metadata numbers must be finite")
    return value
  }
  if (!Predicate.isObject(value) && !Array.isArray(value)) {
    throw new Error("Artifact metadata must contain only JSON values")
  }
  if (ancestors.has(value)) throw new Error("Artifact metadata must not contain cycles")

  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => toJsonValue(item, ancestors))
    if (!isJsonObject(value)) throw new Error("Artifact metadata must contain only JSON values")
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Artifact metadata must contain only plain objects")
    }
    return Object.fromEntries(
      EffectArray.sort(Object.keys(value), Order.String).map((key) => {
        const nested = value[key]
        if (nested === undefined) throw new Error("Artifact metadata contains an undefined value")
        return [key, toJsonValue(nested, ancestors)]
      }),
    )
  } finally {
    ancestors.delete(value)
  }
}

const canonicalJson = (value: Schema.Json) => JSON.stringify(toJsonValue(value, new WeakSet()))

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)
