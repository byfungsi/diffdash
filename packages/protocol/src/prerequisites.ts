import { Effect, Schema } from "effect"
import {
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitProviderId,
} from "@diffdash/domain/git-provider"
import { ExecutablePath } from "@diffdash/domain/executable-path"
import { AgentProviderId } from "@diffdash/domain/agent-provider"
import { WebUrl } from "@diffdash/domain/web-url"

/** Open registered agent-provider identity retained for legacy diagnostic consumers. */
export const CodingAgentName = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("CodingAgentName"),
)

/** CLI coding agent name. */
export type CodingAgentName = typeof CodingAgentName.Type

/** Stable key for one setup requirement. */
export const SetupRequirementKey = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("SetupRequirementKey"),
)

/** Stable key for one setup requirement. */
export type SetupRequirementKey = typeof SetupRequirementKey.Type

/** One configured provider and its current health. */
export class ProviderDiagnostic extends Schema.Class<ProviderDiagnostic>("ProviderDiagnostic")({
  descriptor: GitProviderDescriptor,
  diagnostic: GitProviderDiagnostic,
}) {}

/** One advisory setup item; hosted-provider items never block local-only use. */
export class SetupRequirement extends Schema.Class<SetupRequirement>("SetupRequirement")({
  key: SetupRequirementKey,
  providerId: Schema.NullOr(Schema.Union([GitProviderId, AgentProviderId])),
  title: Schema.String,
  description: Schema.String,
  detail: Schema.String,
  ready: Schema.Boolean,
  requiredForLocalUse: Schema.Boolean,
  helpUrl: Schema.NullOr(WebUrl),
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
  providerDiagnostics: Schema.Array(ProviderDiagnostic).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  setupRequirements: Schema.Array(SetupRequirement).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  diffDashCliInstalled: Schema.Boolean,
  diffDashCliInPath: Schema.Boolean,
  diffDashCliPath: Schema.NullOr(ExecutablePath),
  checkedAt: Schema.String,
}) {}

/** Result from installing the DiffDash CLI into PATH. */
export class DiffDashCliInstallResult extends Schema.Class<DiffDashCliInstallResult>(
  "DiffDashCliInstallResult",
)({
  path: ExecutablePath,
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
