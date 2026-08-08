import { AISettings } from "@diffdash/domain/ai-settings"
import { DEFAULT_APP_STATE, AppState as SharedAppState } from "@diffdash/domain/app-state"
import { CoreMethod } from "@diffdash/core"
import type { AgentProviderCatalog } from "@diffdash/protocol/agent-providers"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { AppPrerequisites, type DiffDashCliInstallResult } from "@diffdash/protocol/prerequisites"
import { app } from "electron"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

const isDebugOnboardingEnabled = () => !app.isPackaged && process.env.DEBUG_ONBOARD === "1"

const debugMissingPrerequisites = () =>
  AppPrerequisites.make({
    checkedAt: new Date().toISOString(),
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

/** Defines settings IPC handler implementations. */
export const defineSettingsHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  handlers.define(
    InvokeChannel.agentProvidersGetCatalog,
    async (): Promise<AgentProviderCatalog> => {
      return runtime.execute(CoreMethod.agentProvidersGetCatalog, {})
    },
  )

  handlers.define(InvokeChannel.settingsGet, async (): Promise<AISettings> => {
    return runtime.execute(CoreMethod.settingsGet, {})
  })

  handlers.define(
    InvokeChannel.settingsUpdate,
    async (_event, { settings: parsed }): Promise<AISettings> => {
      return runtime.execute(CoreMethod.settingsUpdate, { settings: parsed })
    },
  )

  handlers.define(InvokeChannel.appStateGet, async (): Promise<SharedAppState> => {
    if (isDebugOnboardingEnabled()) return DEFAULT_APP_STATE

    return runtime.execute(CoreMethod.appStateGet, {})
  })

  handlers.define(
    InvokeChannel.appStateUpdate,
    async (_event, { state: parsed }): Promise<SharedAppState> => {
      if (isDebugOnboardingEnabled()) return parsed

      return runtime.execute(CoreMethod.appStateUpdate, { state: parsed })
    },
  )

  handlers.define(InvokeChannel.appDiagnostics, async (): Promise<AppPrerequisites> => {
    if (isDebugOnboardingEnabled()) return debugMissingPrerequisites()

    return runtime.execute(CoreMethod.appDiagnostics, {})
  })

  handlers.define(
    InvokeChannel.appInstallDiffDashCli,
    async (): Promise<DiffDashCliInstallResult> => {
      return runtime.execute(CoreMethod.appInstallDiffDashCli, {})
    },
  )
}
