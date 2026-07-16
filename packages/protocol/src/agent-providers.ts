import { Schema } from "effect"

/** Serializable capability state reported by a registered agent provider. */
export class AgentProviderCapabilityStatus extends Schema.Class<AgentProviderCapabilityStatus>(
  "AgentProviderCapabilityStatus",
)({
  capability: Schema.Literal("walkthrough", "review-thread"),
  status: Schema.Literal("ready", "unavailable", "policy-unsupported", "unsupported"),
  runtimeVersion: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
}) {}

/** Serializable model descriptor owned by a registered agent provider. */
export class AgentProviderModel extends Schema.Class<AgentProviderModel>("AgentProviderModel")({
  id: Schema.String,
  displayName: Schema.String,
  capabilities: Schema.Array(Schema.Literal("walkthrough", "review-thread")),
  quality: Schema.Literal("fast", "balanced", "best"),
}) {}

/** Serializable default model selections owned by a registered agent provider. */
export class AgentProviderDefaults extends Schema.Class<AgentProviderDefaults>(
  "AgentProviderDefaults",
)({
  walkthroughModel: Schema.NullOr(Schema.String),
  reviewThreadModel: Schema.NullOr(Schema.String),
}) {}

/** Serializable setup requirement owned by a registered agent provider. */
export class AgentProviderSetupRequirement extends Schema.Class<AgentProviderSetupRequirement>(
  "AgentProviderSetupRequirement",
)({
  name: Schema.String,
  versionRange: Schema.NullOr(Schema.String),
  installHint: Schema.NullOr(Schema.String),
}) {}

/** Complete renderer-facing state for one registered agent provider. */
export class AgentProviderStatus extends Schema.Class<AgentProviderStatus>("AgentProviderStatus")({
  id: Schema.String,
  displayName: Schema.String,
  description: Schema.String,
  homepage: Schema.NullOr(Schema.String),
  capabilities: Schema.Array(AgentProviderCapabilityStatus),
  models: Schema.Array(AgentProviderModel),
  defaults: AgentProviderDefaults,
  setup: Schema.Array(AgentProviderSetupRequirement),
}) {}

/** Independently ordered automatic candidates for each agent capability. */
export class AgentProviderAutoCandidates extends Schema.Class<AgentProviderAutoCandidates>(
  "AgentProviderAutoCandidates",
)({
  walkthrough: Schema.Array(Schema.String),
  reviewThread: Schema.Array(Schema.String),
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
