import { Context, Effect, Layer, Schema } from "effect"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"

import {
  ReviewAgentArtifact,
  type ReviewAgentArtifactType,
  type ReviewAgentProviderId,
} from "../../shared/review-agent"

/** Default maximum UTF-8 byte size retained for one normalized artifact body. */
export const DEFAULT_AGENT_ARTIFACT_CONTENT_LIMIT_BYTES = 64 * 1024

/** Provider-boundary input after event classification but before product normalization. */
export interface NormalizeAgentArtifactInput {
  readonly type: ReviewAgentArtifactType
  readonly provider: ReviewAgentProviderId
  readonly title: string
  readonly content: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly maxContentBytes?: number
}

/** A provider artifact could not be converted to bounded, JSON-safe product data. */
export class AgentArtifactNormalizationError extends Schema.TaggedError<AgentArtifactNormalizationError>()(
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

/** Normalizes one classified provider event without retaining its raw protocol shape. */
export function normalizeAgentArtifact(
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
        ...input.metadata,
        sourceProvider: input.provider,
      })
      const originalSize = Buffer.byteLength(input.content, "utf8")
      const truncated = originalSize > limit
      const content = truncated ? truncateUtf8(input.content, limit) : input.content
      const retainedSize = Buffer.byteLength(content, "utf8")
      const contentDigest = `sha256:${createHash("sha256")
        .update(canonicalJson({ content: input.content, metadata: canonicalMetadata }))
        .digest("hex")}`

      return ReviewAgentArtifact.make({
        type: input.type,
        provider: input.provider,
        title: input.title,
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
        reason: cause instanceof Error ? cause.message : "Artifact normalization failed",
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

const truncateUtf8 = (value: string, limitBytes: number) => {
  const marker = "\n\n[DiffDash truncated artifact content]"
  const markerBytes = Buffer.byteLength(marker, "utf8")
  if (markerBytes >= limitBytes) return utf8Prefix(value, limitBytes)
  return `${utf8Prefix(value, limitBytes - markerBytes)}${marker}`
}

const utf8Prefix = (value: string, limitBytes: number) => {
  const output: string[] = []
  let size = 0
  for (const character of value) {
    const characterSize = Buffer.byteLength(character, "utf8")
    if (size + characterSize > limitBytes) break
    output.push(character)
    size += characterSize
  }
  return output.join("")
}
