import { Context, Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"

import {
  ReviewAgentArtifact,
  type ReviewAgentArtifactType,
  type ReviewAgentProviderId,
} from "@diffdash/domain/review-agent"
import type { AgentArtifactCandidate } from "@diffdash/agent-provider"
import { boundedProviderReason } from "@diffdash/agent-provider/runtime"
import { redactProviderSecrets } from "@diffdash/agent-provider/security"
import { truncateUtf8, utf8ByteLength } from "./utf8-budget"

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
  readonly metadata: Readonly<Record<string, unknown>>
  readonly maxContentBytes?: number
}

/** A provider artifact could not be converted to bounded, JSON-safe product data. */
class AgentArtifactNormalizationError extends Schema.TaggedError<AgentArtifactNormalizationError>()(
  "AgentArtifactNormalizationError",
  {
    reason: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Creates stable digests and bounded normalized artifacts from provider-boundary values. */
export class AgentArtifactNormalizer extends Context.Tag("@diffdash/AgentArtifactNormalizer")<
  AgentArtifactNormalizer,
  {
    readonly normalize: (
      input: NormalizeAgentArtifactInput,
    ) => Effect.Effect<ReviewAgentArtifact, AgentArtifactNormalizationError>
  }
>() {
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
        cause,
      }),
  })
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const toCanonicalRecord = (value: Readonly<Record<string, unknown>>) => {
  const canonical = toJsonValue(value, new WeakSet())
  if (canonical === null || Array.isArray(canonical) || typeof canonical !== "object") {
    throw new Error("Artifact metadata must be a JSON object")
  }
  return canonical
}

const allowlistedMetadata = (metadata: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => ALLOWED_ARTIFACT_METADATA_KEYS.has(key))
      .map(([key, value]) => [key, redactMetadataValue(value, key)]),
  )

const redactMetadataValue = (value: unknown, key?: string): unknown => {
  if (key !== undefined && isProviderSecretMetadataKey(key)) return "[redacted]"
  if (typeof value === "string") return redactProviderSecrets(value)
  if (Array.isArray(value)) return value.map((item) => redactMetadataValue(item))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([nestedKey, nested]) => [
      nestedKey,
      redactMetadataValue(nested, nestedKey),
    ]),
  )
}

const isProviderSecretMetadataKey = (key: string) =>
  redactProviderSecrets(`${key}=credential`) !== `${key}=credential`

const toJsonValue = (value: unknown, ancestors: WeakSet<object>): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Artifact metadata numbers must be finite")
    return value
  }
  if (typeof value !== "object") throw new Error("Artifact metadata must contain only JSON values")
  if (ancestors.has(value)) throw new Error("Artifact metadata must not contain cycles")

  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => toJsonValue(item, ancestors))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Artifact metadata must contain only plain objects")
    }
    return Object.fromEntries(
      sortedObjectKeys(value).map((key) => [
        key,
        toJsonValue((value as Record<string, unknown>)[key], ancestors),
      ]),
    )
  } finally {
    ancestors.delete(value)
  }
}

const canonicalJson = (value: JsonValue) => JSON.stringify(toJsonValue(value, new WeakSet()))

const sortedObjectKeys = (value: object) => {
  const sorted: string[] = []
  for (const key of Object.keys(value)) {
    let index = 0
    while (index < sorted.length) {
      const current = sorted[index]
      if (current === undefined || current >= key) break
      index += 1
    }
    sorted.splice(index, 0, key)
  }
  return sorted
}
