import { Array as EffectArray, Context, Effect, Layer, Order, Predicate, Schema } from "effect"
import { createHash } from "node:crypto"

import {
  ReviewAgentArtifact,
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

const PositiveContentByteLimit = Schema.Int.pipe(
  Schema.check(
    Schema.isGreaterThan(0, {
      message: "Artifact content limit must be a positive safe integer",
    }),
  ),
)

const CanonicalMetadata = Schema.Json.pipe(
  Schema.refine(
    (value): value is Schema.JsonObject => Predicate.isObject(value) && !Array.isArray(value),
    { message: "Artifact metadata must be a JSON object" },
  ),
)

const ArtifactMetadata = CanonicalMetadata.pipe(
  Schema.check(
    Schema.makeFilter((metadata) => !Object.hasOwn(metadata, "truncation"), {
      message: "Artifact metadata key 'truncation' is reserved by DiffDash",
    }),
  ),
)

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
  return Effect.gen(function* () {
    const limit = yield* Schema.decodeUnknownEffect(PositiveContentByteLimit)(
      input.maxContentBytes ?? DEFAULT_AGENT_ARTIFACT_CONTENT_LIMIT_BYTES,
    )
    const metadata = yield* Schema.decodeUnknownEffect(ArtifactMetadata)(input.metadata)
    const projectedMetadata = yield* Effect.try(() =>
      Object.fromEntries(
        Object.entries(metadata).filter(([key]) => ALLOWED_ARTIFACT_METADATA_KEYS.has(key)),
      ),
    )
    const canonicalMetadata = canonicalizeMetadataValue({
      ...projectedMetadata,
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
      .update(JSON.stringify({ content: redactedContent, metadata: canonicalMetadata }))
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
  }).pipe(
    Effect.mapError((cause) =>
      AgentArtifactNormalizationError.make({
        reason: boundedProviderReason(cause, "Artifact normalization failed"),
        cause: toCoreExpectedCause(cause),
      }),
    ),
  )
}

function canonicalizeMetadataValue(value: Schema.JsonObject): Schema.JsonObject
function canonicalizeMetadataValue(value: Schema.Json, key: string | undefined): Schema.Json
function canonicalizeMetadataValue(value: Schema.Json, key?: string): Schema.Json {
  if (key !== undefined && isProviderSecretMetadataKey(key)) return "[redacted]"
  if (Predicate.isString(value)) return redactProviderSecrets(value)
  if (value === null || Predicate.isNumber(value) || Predicate.isBoolean(value)) return value
  if (Array.isArray(value)) return value.map((item) => canonicalizeMetadataValue(item, undefined))
  return Object.fromEntries(
    EffectArray.sort(
      Object.entries(value),
      Order.mapInput(Order.String, ([nestedKey]: [string, Schema.Json]) => nestedKey),
    ).map(([nestedKey, nested]) => [nestedKey, canonicalizeMetadataValue(nested, nestedKey)]),
  )
}

const isProviderSecretMetadataKey = (key: string) =>
  redactProviderSecrets(`${key}=credential`) !== `${key}=credential`
