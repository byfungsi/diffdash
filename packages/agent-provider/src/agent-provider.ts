import { Predicate, type Effect, Redacted, Schema } from "effect"
import { AgentModelId, AgentProviderId, McpToolName } from "@diffdash/domain/agent-provider"
import {
  AgentCapability as DomainAgentCapability,
  AgentModelQuality as DomainAgentModelQuality,
} from "@diffdash/domain/ai-settings"
import { ReviewThreadAgentResponse } from "@diffdash/domain/review-agent"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import { WebUrl } from "@diffdash/domain/web-url"

export { WebUrl } from "@diffdash/domain/web-url"
export { AgentModelId, AgentProviderId, McpToolName } from "@diffdash/domain/agent-provider"

/** Provider-owned resumable session identity. */
export const AgentSessionId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("AgentSessionId"),
)

/** Provider-owned resumable session identity. */
export type AgentSessionId = typeof AgentSessionId.Type

/** Stable capabilities independently exposed by a provider. */
export const AgentCapability = DomainAgentCapability

/** Stable capabilities independently exposed by a provider. */
export type AgentCapability = typeof AgentCapability.Type

/** Provider-internal failure categories projected to public domain data at host boundaries. */
export const AgentProviderFailureCategory = Schema.Literals([
  "authentication",
  "authorization",
  "rate-limited",
  "usage-limited",
  "quota-exhausted",
  "timeout",
  "network",
  "model-unavailable",
  "provider-unavailable",
  "configuration",
  "invalid-response",
  "policy-violation",
  "process-failure",
  "unknown",
])

/** Provider-internal failure categories projected to public domain data at host boundaries. */
export type AgentProviderFailureCategory = typeof AgentProviderFailureCategory.Type

/** Local process stage that failed before a provider operation completed. */
export const AgentProviderProcessFailureKind = Schema.Literals([
  "options",
  "spawn",
  "stdin",
  "output",
  "timeout",
  "cleanup",
  "exit",
])

/** Local process stage that failed before a provider operation completed. */
export type AgentProviderProcessFailureKind = typeof AgentProviderProcessFailureKind.Type

const isUtcTimestamp = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false
  const normalized = value.includes(".") ? value : value.replace("Z", ".000Z")
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === normalized
}

const AgentProviderFailureResetAt = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(
    Schema.makeFilter(isUtcTimestamp, { message: "Invalid UTC provider reset timestamp" }),
  ),
)

/** Closed provider failure evidence retained without provider-owned text. */
export class AgentProviderFailure extends Schema.Class<AgentProviderFailure>(
  "AgentProviderFailure",
)({
  version: Schema.Literal(1),
  providerId: AgentProviderId.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(100)),
    Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
  ),
  capability: AgentCapability,
  category: AgentProviderFailureCategory,
  processKind: Schema.NullOr(AgentProviderProcessFailureKind),
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(
    Schema.String.pipe(
      Schema.check(Schema.isMinLength(1)),
      Schema.check(Schema.isMaxLength(100)),
      Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/u)),
    ),
  ),
  httpStatus: Schema.NullOr(Schema.Int),
  retryAfterSeconds: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  resetsAt: Schema.NullOr(AgentProviderFailureResetAt),
}) {}

/** User-facing provider metadata. */
export class AgentProviderDescriptor extends Schema.Class<AgentProviderDescriptor>(
  "AgentProviderDescriptor",
)({
  id: AgentProviderId,
  displayName: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  description: Schema.String,
  homepage: Schema.NullOr(WebUrl),
}) {}

/** Provider-neutral model quality used by automatic capability routing. */
export const AgentModelQuality = DomainAgentModelQuality

/** Provider-neutral model quality used by automatic capability routing. */
export type AgentModelQuality = typeof AgentModelQuality.Type

/** One provider-owned model and the capabilities for which it is valid. */
export class AgentModelDescriptor extends Schema.Class<AgentModelDescriptor>(
  "AgentModelDescriptor",
)({
  id: AgentModelId,
  displayName: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  capabilities: Schema.Array(AgentCapability),
  quality: AgentModelQuality,
}) {}

/** Default models selected for each independently optional capability. */
export class AgentProviderDefaults extends Schema.Class<AgentProviderDefaults>(
  "AgentProviderDefaults",
)({
  walkthroughModel: Schema.NullOr(AgentModelId),
  reviewThreadModel: Schema.NullOr(AgentModelId),
}) {}

/** Executable or SDK requirements reported by a provider package. */
export class AgentRuntimeRequirement extends Schema.Class<AgentRuntimeRequirement>(
  "AgentRuntimeRequirement",
)({
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  versionRange: Schema.NullOr(Schema.String),
  installHint: Schema.NullOr(Schema.String),
}) {}

/** Manifest declaration for one capability and its automatic-routing candidacy. */
export class AgentCapabilityDeclaration extends Schema.Class<AgentCapabilityDeclaration>(
  "AgentCapabilityDeclaration",
)({
  supported: Schema.Boolean,
  autoPriority: Schema.NullOr(Schema.Number),
}) {}

/** Capability declarations kept separate to prevent provider-wide availability assumptions. */
export class AgentCapabilityManifest extends Schema.Class<AgentCapabilityManifest>(
  "AgentCapabilityManifest",
)({
  walkthrough: AgentCapabilityDeclaration,
  reviewThread: AgentCapabilityDeclaration,
}) {}

/** Declared provider behavior for resumable review sessions. */
export class AgentSessionSupport extends Schema.Class<AgentSessionSupport>("AgentSessionSupport")({
  mode: Schema.Literals(["none", "resume"]),
}) {}

/** Complete static contribution exported by one provider package. */
export class AgentProviderManifest extends Schema.Class<AgentProviderManifest>(
  "AgentProviderManifest",
)({
  descriptor: AgentProviderDescriptor,
  models: Schema.Array(AgentModelDescriptor),
  defaults: AgentProviderDefaults,
  requirements: Schema.Array(AgentRuntimeRequirement),
  capabilities: AgentCapabilityManifest,
  session: AgentSessionSupport,
}) {}

/** Capability is available and its required execution policy can be enforced. */
export class AgentCapabilityReady extends Schema.TaggedClass<AgentCapabilityReady>()(
  "AgentCapabilityReady",
  {
    capability: AgentCapability,
    runtimeVersion: Schema.NullOr(Schema.String),
  },
) {}

/** Capability runtime is absent, unhealthy, or unsupported. */
export class AgentCapabilityUnavailable extends Schema.TaggedClass<AgentCapabilityUnavailable>()(
  "AgentCapabilityUnavailable",
  {
    capability: AgentCapability,
    reason: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  },
) {}

/** Runtime exists but cannot enforce the capability's required policy. */
export class AgentCapabilityPolicyUnsupported extends Schema.TaggedClass<AgentCapabilityPolicyUnsupported>()(
  "AgentCapabilityPolicyUnsupported",
  {
    capability: AgentCapability,
    reason: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  },
) {}

/** Fail-closed result of probing one capability. */
export const AgentCapabilityProbe = Schema.Union([
  AgentCapabilityReady,
  AgentCapabilityUnavailable,
  AgentCapabilityPolicyUnsupported,
])

/** Fail-closed result of probing one capability. */
export type AgentCapabilityProbe = typeof AgentCapabilityProbe.Type

/** Explicit non-mutating policy requested for an agent execution. */
export class AgentExecutionPolicy extends Schema.Class<AgentExecutionPolicy>(
  "AgentExecutionPolicy",
)({
  network: Schema.Literals(["deny", "allow"]),
  sensitiveFiles: Schema.Literal("deny"),
  repository: Schema.Literals(["reviewed-revision", "local-working-copy"]),
  shell: Schema.Literals(["deny", "read-only"]),
  fileMutation: Schema.Literal("deny"),
  gitMutation: Schema.Literal("deny"),
  providerPublishing: Schema.Literal("deny"),
  providerPublishingTools: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
  allowedMcpTools: Schema.Array(McpToolName),
}) {}

/** Returns whether an enforced policy is equal to or stricter than the requested policy. */
export const isAgentExecutionPolicyEnforced = (
  requested: AgentExecutionPolicy,
  enforced: AgentExecutionPolicy,
): boolean =>
  requested.network === enforced.network &&
  requested.sensitiveFiles === enforced.sensitiveFiles &&
  requested.repository === enforced.repository &&
  (requested.shell === enforced.shell ||
    (requested.shell === "read-only" && enforced.shell === "deny")) &&
  requested.fileMutation === enforced.fileMutation &&
  requested.gitMutation === enforced.gitMutation &&
  requested.providerPublishing === enforced.providerPublishing &&
  (enforced.providerPublishingTools.length === 0 ||
    requested.providerPublishingTools.every((tool) =>
      enforced.providerPublishingTools.includes(tool),
    )) &&
  enforced.allowedMcpTools.every((tool) => requested.allowedMcpTools.includes(tool))

/** Input to one scoped MCP invocation. */
export class ScopedMcpCall extends Schema.Class<ScopedMcpCall>("ScopedMcpCall")({
  tool: McpToolName,
  input: Schema.Json,
}) {}

/** Bounded output from one scoped MCP invocation. */
export class ScopedMcpResult extends Schema.Class<ScopedMcpResult>("ScopedMcpResult")({
  content: Schema.String,
  isError: Schema.Boolean,
}) {}

/** Bounded host failure from one scoped MCP call. */
export class ScopedMcpAccessError extends Schema.TaggedError<ScopedMcpAccessError>()(
  "ScopedMcpAccessError",
  { reason: Schema.String },
) {}

/** Host-owned MCP access that is valid only for one provider execution. */
export interface ScopedMcpAccess {
  readonly scopeId: string
  readonly endpoint: string
  readonly bearerToken: Redacted.Redacted<string>
  readonly allowedTools: readonly McpToolName[]
  readonly call: (input: ScopedMcpCall) => Effect.Effect<ScopedMcpResult, ScopedMcpAccessError>
}

/** Provider-neutral reasoning effort requested for a walkthrough. */
export const AgentReasoningEffort = Schema.Literals(["minimal", "low", "medium", "high"])

/** Provider-neutral reasoning effort requested for a walkthrough. */
export type AgentReasoningEffort = typeof AgentReasoningEffort.Type

/** Complete input for non-mutating walkthrough text generation. */
export class WalkthroughRequest extends Schema.Class<WalkthroughRequest>("WalkthroughRequest")({
  prompt: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  model: AgentModelId,
  workingDirectory: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  timeoutMs: Schema.Number,
  reasoningEffort: AgentReasoningEffort,
  policy: AgentExecutionPolicy,
}) {}

/** Text returned by a walkthrough provider. */
export class WalkthroughResult extends Schema.Class<WalkthroughResult>("WalkthroughResult")({
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
}) {}

/** Complete input for one review-thread provider turn. */
export interface ReviewThreadRequest {
  readonly stablePrompt: string
  readonly dynamicPrompt: string
  readonly model: AgentModelId
  readonly workingDirectory: string
  readonly revision: ReviewRevision
  readonly timeoutMs: number
  readonly sessionId: AgentSessionId | null
  readonly mcp: ScopedMcpAccess
  readonly policy: AgentExecutionPolicy
}

/** Normalized optional usage values for one provider turn. */
export class AgentUsage extends Schema.Class<AgentUsage>("AgentUsage")({
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  cacheReadTokens: Schema.NullOr(Schema.Number),
  cacheWriteTokens: Schema.NullOr(Schema.Number),
  costUsd: Schema.NullOr(Schema.Number),
}) {}

/** Narrows an immutable JSON value to an object for artifact metadata. */
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

/** Provider event candidate that the host must bound, redact, and normalize before persistence. */
export const AgentArtifactMetadata = Schema.Json.pipe(
  Schema.refine(isJsonObject, { message: "Artifact metadata must be a JSON object" }),
)

/** Provider-neutral JSON object carried as artifact metadata. */
export type AgentArtifactMetadata = typeof AgentArtifactMetadata.Type

/** Bounded diagnostics accepted from provider and process adapter seams. */
const AgentProviderDiagnosticCause = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  statusCode: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
  signal: Schema.optional(Schema.NullOr(Schema.String)),
})

/** Bounded diagnostics accepted from provider and process adapter seams. */
export type AgentProviderDiagnosticCause = typeof AgentProviderDiagnosticCause.Type

/** Provider failure cause retained only as a finite diagnostic shape. */
export const AgentProviderCause = Schema.Union([
  Schema.instanceOf(Error),
  Schema.Null,
  AgentProviderDiagnosticCause,
])

/** Provider failure cause retained only as a finite diagnostic shape. */
export type AgentProviderCause = typeof AgentProviderCause.Type

/** Provider event candidate that the host must bound, redact, and normalize before persistence. */
export class AgentArtifactCandidate extends Schema.Class<AgentArtifactCandidate>(
  "AgentArtifactCandidate",
)({
  type: Schema.Literals([
    "file-read",
    "search-result",
    "shell-output",
    "web-result",
    "diff-context",
    "mcp-tool-result",
    "provider-message",
    "unknown",
  ]),
  title: Schema.String,
  content: Schema.String,
  metadata: AgentArtifactMetadata,
}) {}

/** Complete validated output from one review-thread turn. */
export class ReviewThreadResult extends Schema.Class<ReviewThreadResult>("ReviewThreadResult")({
  response: ReviewThreadAgentResponse,
  usage: Schema.NullOr(AgentUsage),
  artifacts: Schema.Array(AgentArtifactCandidate),
  sessionId: Schema.NullOr(AgentSessionId),
}) {}

/** Duplicate provider registration. */
export class DuplicateAgentProviderError extends Schema.TaggedError<DuplicateAgentProviderError>()(
  "DuplicateAgentProviderError",
  { providerId: AgentProviderId },
) {}

/** Provider registration contradicts its manifest or returns mismatched capability evidence. */
export class InvalidAgentProviderRegistrationError extends Schema.TaggedError<InvalidAgentProviderRegistrationError>()(
  "InvalidAgentProviderRegistrationError",
  { providerId: AgentProviderId, capability: AgentCapability, reason: Schema.String },
) {}

/** Explicitly selected provider is not registered. */
export class MissingAgentProviderError extends Schema.TaggedError<MissingAgentProviderError>()(
  "MissingAgentProviderError",
  { providerId: AgentProviderId },
) {}

/** Selected provider does not implement the requested capability. */
export class UnsupportedAgentCapabilityError extends Schema.TaggedError<UnsupportedAgentCapabilityError>()(
  "UnsupportedAgentCapabilityError",
  { providerId: AgentProviderId, capability: AgentCapability },
) {}

/** Selected capability is currently unavailable. */
export class AgentCapabilityUnavailableError extends Schema.TaggedError<AgentCapabilityUnavailableError>()(
  "AgentCapabilityUnavailableError",
  { providerId: AgentProviderId, capability: AgentCapability, reason: Schema.String },
) {}

/** Selected runtime cannot prove enforcement of the requested policy. */
export class AgentPolicyEnforcementError extends Schema.TaggedError<AgentPolicyEnforcementError>()(
  "AgentPolicyEnforcementError",
  { providerId: AgentProviderId, capability: AgentCapability, reason: Schema.String },
) {}

/** Provider probing failed before availability could be established. */
export class AgentProviderProbeError extends Schema.TaggedError<AgentProviderProbeError>()(
  "AgentProviderProbeError",
  {
    providerId: AgentProviderId,
    capability: AgentCapability,
    reason: Schema.String,
    cause: Schema.optional(AgentProviderCause),
  },
) {}

/** Recoverable provider execution failure with bounded diagnostics. */
export class AgentProviderOperationError extends Schema.TaggedError<AgentProviderOperationError>()(
  "AgentProviderOperationError",
  {
    providerId: AgentProviderId,
    capability: AgentCapability,
    failure: AgentProviderFailure,
    reason: Schema.String,
    cause: Schema.optional(AgentProviderCause),
  },
) {}

/** Provider output failed its required product schema. */
export class InvalidAgentProviderResponseError extends Schema.TaggedError<InvalidAgentProviderResponseError>()(
  "InvalidAgentProviderResponseError",
  { providerId: AgentProviderId, capability: AgentCapability, reason: Schema.String },
) {}

/** Errors exposed by registry resolution. */
export type AgentProviderResolutionError =
  | MissingAgentProviderError
  | UnsupportedAgentCapabilityError
  | AgentCapabilityUnavailableError
  | AgentPolicyEnforcementError
  | AgentProviderProbeError
  | InvalidAgentProviderRegistrationError

/** Optional walkthrough implementation contributed by a provider. */
export interface WalkthroughCapability {
  readonly probe: Effect.Effect<AgentCapabilityProbe, AgentProviderProbeError>
  readonly execute: (
    request: WalkthroughRequest,
  ) => Effect.Effect<
    WalkthroughResult,
    AgentProviderOperationError | InvalidAgentProviderResponseError
  >
}

/** Optional review-thread implementation contributed by a provider. */
export interface ReviewThreadCapability {
  readonly probe: Effect.Effect<AgentCapabilityProbe, AgentProviderProbeError>
  readonly execute: (
    request: ReviewThreadRequest,
  ) => Effect.Effect<
    ReviewThreadResult,
    AgentProviderOperationError | InvalidAgentProviderResponseError
  >
}

/** The single registration contributed by one agent provider package. */
export interface AgentProviderRegistration {
  readonly manifest: AgentProviderManifest
  readonly walkthrough?: WalkthroughCapability
  readonly reviewThread?: ReviewThreadCapability
}

/** Reveals a scoped MCP token only at the provider transport boundary. */
export const revealScopedMcpToken = (access: ScopedMcpAccess): string =>
  Redacted.value(access.bearerToken)
