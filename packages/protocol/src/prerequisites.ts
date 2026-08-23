import { AppPrerequisites } from "@diffdash/domain/prerequisites"

export {
  AppPrerequisites,
  CodingAgentName,
  DiffDashCliInstallResult,
  ProviderDiagnostic,
  SetupRequirement,
  SetupRequirementKey,
} from "@diffdash/domain/prerequisites"

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
