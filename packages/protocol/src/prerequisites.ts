import { Schema } from "effect"
import {
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitProviderId,
} from "@diffdash/domain/git-provider"

/** CLI coding agents that can power walkthrough generation. */
export const CodingAgentName = Schema.Literal("codex", "claude", "opencode")

/** CLI coding agent name. */
export type CodingAgentName = typeof CodingAgentName.Type

/** One configured provider and its current health. */
export class ProviderDiagnostic extends Schema.Class<ProviderDiagnostic>("ProviderDiagnostic")({
  descriptor: GitProviderDescriptor,
  diagnostic: GitProviderDiagnostic,
}) {}

/** One advisory setup item; hosted-provider items never block local-only use. */
export class SetupRequirement extends Schema.Class<SetupRequirement>("SetupRequirement")({
  key: Schema.String,
  providerId: Schema.NullOr(GitProviderId),
  title: Schema.String,
  description: Schema.String,
  detail: Schema.String,
  ready: Schema.Boolean,
  requiredForLocalUse: Schema.Boolean,
  helpUrl: Schema.NullOr(Schema.String),
}) {}

/** Runtime checks for external tools DiffDash depends on. */
export class AppPrerequisites extends Schema.Class<AppPrerequisites>("AppPrerequisites")({
  gitInstalled: Schema.Boolean,
  ghInstalled: Schema.Boolean,
  ghVersion: Schema.NullOr(Schema.String),
  ghSearchRepositoriesAvailable: Schema.Boolean,
  ghSupported: Schema.Boolean,
  ghAuthenticated: Schema.Boolean,
  codingAgentInstalled: Schema.Boolean,
  installedCodingAgents: Schema.Array(CodingAgentName),
  providerDiagnostics: Schema.optionalWith(Schema.Array(ProviderDiagnostic), { default: () => [] }),
  setupRequirements: Schema.optionalWith(Schema.Array(SetupRequirement), { default: () => [] }),
  diffDashCliInstalled: Schema.Boolean,
  diffDashCliInPath: Schema.Boolean,
  diffDashCliPath: Schema.NullOr(Schema.String),
  checkedAt: Schema.String,
}) {}

/** Result from installing the DiffDash CLI into PATH. */
export class DiffDashCliInstallResult extends Schema.Class<DiffDashCliInstallResult>(
  "DiffDashCliInstallResult",
)({
  path: Schema.String,
  pathSetupCommand: Schema.NullOr(Schema.String),
}) {}

/** Empty prerequisite status used before the first main-process check resolves. */
export const EMPTY_APP_PREREQUISITES = AppPrerequisites.make({
  checkedAt: "",
  codingAgentInstalled: false,
  diffDashCliInstalled: false,
  diffDashCliInPath: false,
  diffDashCliPath: null,
  gitInstalled: false,
  ghAuthenticated: false,
  ghInstalled: false,
  ghSearchRepositoriesAvailable: false,
  ghSupported: false,
  ghVersion: null,
  installedCodingAgents: [],
  providerDiagnostics: [],
  setupRequirements: [],
})
