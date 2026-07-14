import { Schema } from "effect"

/** CLI coding agents that can power walkthrough generation. */
export const CodingAgentName = Schema.Literal("codex", "claude", "opencode")

/** CLI coding agent name. */
export type CodingAgentName = typeof CodingAgentName.Type

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
  diffDashCliInstalled: Schema.Boolean,
  diffDashCliPath: Schema.NullOr(Schema.String),
  checkedAt: Schema.String,
}) {}

/** Result from installing the DiffDash CLI into PATH. */
export class DiffDashCliInstallResult extends Schema.Class<DiffDashCliInstallResult>(
  "DiffDashCliInstallResult",
)({
  path: Schema.String,
}) {}

/** Empty prerequisite status used before the first main-process check resolves. */
export const EMPTY_APP_PREREQUISITES = AppPrerequisites.make({
  checkedAt: "",
  codingAgentInstalled: false,
  diffDashCliInstalled: false,
  diffDashCliPath: null,
  gitInstalled: false,
  ghAuthenticated: false,
  ghInstalled: false,
  ghSearchRepositoriesAvailable: false,
  ghSupported: false,
  ghVersion: null,
  installedCodingAgents: [],
})
