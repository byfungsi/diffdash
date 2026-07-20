import { Schema } from "effect"
import {
  AgentCapability,
  AgentModelDescriptor,
  AgentProviderDefaults,
  AgentProviderDescriptor,
  AgentProviderId,
  AgentRuntimeRequirement,
} from "@diffdash/agent-provider"

export {
  AgentModelId,
  AgentModelDescriptor as AgentProviderModel,
  AgentProviderDefaults,
  AgentProviderId,
  AgentRuntimeRequirement as AgentProviderSetupRequirement,
} from "@diffdash/agent-provider"

/** Serializable capability state reported by a registered agent provider. */
export class AgentProviderCapabilityStatus extends Schema.Class<AgentProviderCapabilityStatus>(
  "AgentProviderCapabilityStatus",
)({
  capability: AgentCapability,
  status: Schema.Literal("ready", "unavailable", "policy-unsupported", "unsupported"),
  runtimeVersion: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
}) {}

/** Complete renderer-facing state for one registered agent provider. */
export class AgentProviderStatus extends Schema.Class<AgentProviderStatus>("AgentProviderStatus")({
  ...AgentProviderDescriptor.fields,
  capabilities: Schema.Array(AgentProviderCapabilityStatus),
  models: Schema.Array(AgentModelDescriptor),
  defaults: AgentProviderDefaults,
  setup: Schema.Array(AgentRuntimeRequirement),
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
