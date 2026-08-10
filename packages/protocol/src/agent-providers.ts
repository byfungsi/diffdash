import { Schema } from "effect"
import { AgentCapability, AgentModelQuality } from "@diffdash/domain/ai-settings"
import { AgentModelId, AgentProviderId } from "@diffdash/domain/agent-provider"
import { WebUrl } from "@diffdash/domain/web-url"

export { AgentModelId, AgentProviderId } from "@diffdash/domain/agent-provider"

/** Renderer-facing metadata for one provider-owned model. */
export class AgentProviderModel extends Schema.Class<AgentProviderModel>("AgentProviderModel")({
  id: AgentModelId,
  displayName: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  capabilities: Schema.Array(AgentCapability),
  quality: AgentModelQuality,
}) {}

/** Renderer-facing default models selected for each provider capability. */
export class AgentProviderDefaults extends Schema.Class<AgentProviderDefaults>(
  "AgentProviderDefaults",
)({
  walkthroughModel: Schema.NullOr(AgentModelId),
  reviewThreadModel: Schema.NullOr(AgentModelId),
}) {}

/** Renderer-facing executable or SDK requirement reported by a provider. */
export class AgentProviderSetupRequirement extends Schema.Class<AgentProviderSetupRequirement>(
  "AgentProviderSetupRequirement",
)({
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  versionRange: Schema.NullOr(Schema.String),
  installHint: Schema.NullOr(Schema.String),
}) {}

/** Serializable capability state reported by a registered agent provider. */
export const AgentProviderCapabilityStatus = Schema.TaggedUnion({
  Ready: { runtimeVersion: Schema.NullOr(Schema.String) },
  Unavailable: { reason: Schema.String },
  PolicyUnsupported: { reason: Schema.String },
  Unsupported: { reason: Schema.String },
})

/** Serializable capability state reported by a registered agent provider. */
export type AgentProviderCapabilityStatus = typeof AgentProviderCapabilityStatus.Type

/** Complete capability state keyed by the canonical capability identity. */
export const AgentProviderCapabilities = Schema.Record(
  AgentCapability,
  AgentProviderCapabilityStatus,
)

/** Complete capability state keyed by the canonical capability identity. */
export type AgentProviderCapabilities = typeof AgentProviderCapabilities.Type

/** Complete renderer-facing state for one registered agent provider. */
export class AgentProviderStatus extends Schema.Class<AgentProviderStatus>("AgentProviderStatus")({
  id: AgentProviderId,
  displayName: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  description: Schema.String,
  homepage: Schema.NullOr(WebUrl),
  capabilities: AgentProviderCapabilities,
  models: Schema.Array(AgentProviderModel),
  defaults: AgentProviderDefaults,
  setup: Schema.Array(AgentProviderSetupRequirement),
}) {}

/** Independently ordered automatic candidates for each agent capability. */
export class AgentProviderAutoCandidates extends Schema.Class<AgentProviderAutoCandidates>(
  "AgentProviderAutoCandidates",
)({
  walkthrough: Schema.Array(AgentProviderId),
  reviewThread: Schema.Array(AgentProviderId),
}) {}

/** Serializable catalog exposed by the desktop provider registry. */
export class AgentProviderCatalog extends Schema.Class<AgentProviderCatalog>(
  "AgentProviderCatalog",
)({
  providers: Schema.Array(AgentProviderStatus),
  autoCandidates: AgentProviderAutoCandidates,
}) {}

/** Empty catalog used while the renderer is waiting for desktop composition. */
export const EMPTY_AGENT_PROVIDER_CATALOG = AgentProviderCatalog.make({
  providers: [],
  autoCandidates: AgentProviderAutoCandidates.make({ walkthrough: [], reviewThread: [] }),
})
