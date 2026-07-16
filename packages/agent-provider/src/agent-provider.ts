import { type Effect, Redacted, Schema } from "effect"

/** Open identity owned by an agent provider package. */
export const AgentProviderId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("AgentProviderId"),
)

/** Open identity owned by an agent provider package. */
export type AgentProviderId = typeof AgentProviderId.Type

/** Provider-owned model identity. */
export const AgentModelId = Schema.String.pipe(Schema.minLength(1), Schema.brand("AgentModelId"))

/** Provider-owned model identity. */
export type AgentModelId = typeof AgentModelId.Type

/** Provider-owned resumable session identity. */
export const AgentSessionId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("AgentSessionId"),
)

/** Provider-owned resumable session identity. */
export type AgentSessionId = typeof AgentSessionId.Type

/** Identity of an MCP tool exposed for one run. */
export const McpToolName = Schema.String.pipe(Schema.minLength(1), Schema.brand("McpToolName"))

/** Identity of an MCP tool exposed for one run. */
export type McpToolName = typeof McpToolName.Type

/** Stable capabilities independently exposed by a provider. */
export const AgentCapability = Schema.Literal("walkthrough", "review-thread")

/** Stable capabilities independently exposed by a provider. */
export type AgentCapability = typeof AgentCapability.Type

/** User-facing provider metadata. */
export class AgentProviderDescriptor extends Schema.Class<AgentProviderDescriptor>(
  "AgentProviderDescriptor",
)({
  id: AgentProviderId,
  displayName: Schema.String.pipe(Schema.minLength(1)),
  description: Schema.String,
  homepage: Schema.NullOr(Schema.String),
}) {}

/** Provider-neutral model quality used by automatic capability routing. */
export const AgentModelQuality = Schema.Literal("fast", "balanced", "best")

/** Provider-neutral model quality used by automatic capability routing. */
export type AgentModelQuality = typeof AgentModelQuality.Type

/** One provider-owned model and the capabilities for which it is valid. */
export class AgentModelDescriptor extends Schema.Class<AgentModelDescriptor>(
  "AgentModelDescriptor",
)({
  id: AgentModelId,
  displayName: Schema.String.pipe(Schema.minLength(1)),
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
  name: Schema.String.pipe(Schema.minLength(1)),
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
  mode: Schema.Literal("none", "resume"),
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
    reason: Schema.String.pipe(Schema.minLength(1)),
  },
) {}

/** Runtime exists but cannot enforce the capability's required policy. */
export class AgentCapabilityPolicyUnsupported extends Schema.TaggedClass<AgentCapabilityPolicyUnsupported>()(
  "AgentCapabilityPolicyUnsupported",
  {
    capability: AgentCapability,
    reason: Schema.String.pipe(Schema.minLength(1)),
  },
) {}

/** Fail-closed result of probing one capability. */
export const AgentCapabilityProbe = Schema.Union(
  AgentCapabilityReady,
  AgentCapabilityUnavailable,
  AgentCapabilityPolicyUnsupported,
)

/** Fail-closed result of probing one capability. */
export type AgentCapabilityProbe = typeof AgentCapabilityProbe.Type

/** Explicit non-mutating policy requested for an agent execution. */
export class AgentExecutionPolicy extends Schema.Class<AgentExecutionPolicy>(
  "AgentExecutionPolicy",
)({
  network: Schema.Literal("deny", "allow"),
  sensitiveFiles: Schema.Literal("deny"),
  repository: Schema.Literal("reviewed-revision", "local-working-copy"),
  shell: Schema.Literal("deny", "read-only"),
  fileMutation: Schema.Literal("deny"),
  gitMutation: Schema.Literal("deny"),
  providerPublishing: Schema.Literal("deny"),
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
  enforced.allowedMcpTools.every((tool) => requested.allowedMcpTools.includes(tool))

/** Input to one scoped MCP invocation. */
export class ScopedMcpCall extends Schema.Class<ScopedMcpCall>("ScopedMcpCall")({
  tool: McpToolName,
  input: Schema.Unknown,
}) {}

/** Bounded output from one scoped MCP invocation. */
export class ScopedMcpResult extends Schema.Class<ScopedMcpResult>("ScopedMcpResult")({
  content: Schema.String,
  isError: Schema.Boolean,
}) {}

/** Host-owned MCP access that is valid only for one provider execution. */
export interface ScopedMcpAccess {
  readonly scopeId: string
  readonly endpoint: string
  readonly bearerToken: Redacted.Redacted<string>
  readonly allowedTools: readonly McpToolName[]
  readonly call: (
    input: ScopedMcpCall,
  ) => Effect.Effect<ScopedMcpResult, AgentProviderOperationError>
}

/** Provider-neutral reasoning effort requested for a walkthrough. */
export const AgentReasoningEffort = Schema.Literal("minimal", "low", "medium", "high")

/** Provider-neutral reasoning effort requested for a walkthrough. */
export type AgentReasoningEffort = typeof AgentReasoningEffort.Type

/** Complete input for non-mutating walkthrough text generation. */
export class WalkthroughRequest extends Schema.Class<WalkthroughRequest>("WalkthroughRequest")({
  prompt: Schema.String.pipe(Schema.minLength(1)),
  model: AgentModelId,
  workingDirectory: Schema.String.pipe(Schema.minLength(1)),
  timeoutMs: Schema.Number,
  reasoningEffort: AgentReasoningEffort,
  policy: AgentExecutionPolicy,
}) {}

/** Text returned by a walkthrough provider. */
export class WalkthroughResult extends Schema.Class<WalkthroughResult>("WalkthroughResult")({
  text: Schema.String.pipe(Schema.minLength(1)),
}) {}

/** Stable identity of the exact review revision made available to an agent. */
export const ReviewRevision = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("AgentReviewRevision"),
)

/** Stable identity of the exact review revision made available to an agent. */
export type ReviewRevision = typeof ReviewRevision.Type

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

/** Validated product response from a review-thread provider. */
export class ReviewThreadResponse extends Schema.Class<ReviewThreadResponse>(
  "ReviewThreadResponse",
)({
  bodyMarkdown: Schema.String.pipe(Schema.minLength(1)),
  threadSummary: Schema.NullOr(Schema.String.pipe(Schema.minLength(1))),
  referencedLocations: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
}) {}

/** Normalized optional usage values for one provider turn. */
export class AgentUsage extends Schema.Class<AgentUsage>("AgentUsage")({
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  cacheReadTokens: Schema.NullOr(Schema.Number),
  cacheWriteTokens: Schema.NullOr(Schema.Number),
  costUsd: Schema.NullOr(Schema.Number),
}) {}

/** Provider event candidate that the host must bound, redact, and normalize before persistence. */
export class AgentArtifactCandidate extends Schema.Class<AgentArtifactCandidate>(
  "AgentArtifactCandidate",
)({
  type: Schema.Literal(
    "file-read",
    "search-result",
    "shell-output",
    "web-result",
    "diff-context",
    "mcp-tool-result",
    "provider-message",
    "unknown",
  ),
  title: Schema.String,
  content: Schema.String,
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
}) {}

/** Complete validated output from one review-thread turn. */
export class ReviewThreadResult extends Schema.Class<ReviewThreadResult>("ReviewThreadResult")({
  response: ReviewThreadResponse,
  usage: Schema.NullOr(AgentUsage),
  artifacts: Schema.Array(AgentArtifactCandidate),
  sessionId: Schema.NullOr(AgentSessionId),
}) {}

/** Duplicate provider registration. */
export class DuplicateAgentProviderError extends Schema.TaggedError<DuplicateAgentProviderError>()(
  "DuplicateAgentProviderError",
  { providerId: AgentProviderId },
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
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** Recoverable provider execution failure with bounded diagnostics. */
export class AgentProviderOperationError extends Schema.TaggedError<AgentProviderOperationError>()(
  "AgentProviderOperationError",
  {
    providerId: AgentProviderId,
    capability: AgentCapability,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect),
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
