import { AISettings } from "@diffdash/domain/ai-settings"
import { DEFAULT_APP_STATE, AppState as SharedAppState } from "@diffdash/domain/app-state"
import type { AgentProviderCatalog } from "@diffdash/protocol/agent-providers"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { AppPrerequisites, type DiffDashCliInstallResult } from "@diffdash/protocol/prerequisites"
import { AppSettings } from "@diffdash/settings/app-settings"
import { AppState } from "@diffdash/settings/app-state"
import { Schema } from "effect"
import { app } from "electron"
import { AgentProviders } from "../../../../src/main/services/agent-providers"
import { Prerequisites } from "../../../../src/main/services/prerequisites"
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
  const run = runtime.runPromise

  handlers.define(
    InvokeChannel.agentProvidersGetCatalog,
    async (): Promise<AgentProviderCatalog> => {
      const providers = await run(AgentProviders)
      return run(providers.catalog)
    },
  )

  handlers.define(InvokeChannel.settingsGet, async (): Promise<AISettings> => {
    const settings = await run(AppSettings)
    return run(settings.get)
  })

  handlers.define(
    InvokeChannel.settingsUpdate,
    async (_event, input: unknown): Promise<AISettings> => {
      const parsed = await run(Schema.decodeUnknown(AISettings)(input))
      const settings = await run(AppSettings)
      return run(settings.save(parsed))
    },
  )

  handlers.define(InvokeChannel.appStateGet, async (): Promise<SharedAppState> => {
    if (isDebugOnboardingEnabled()) return DEFAULT_APP_STATE

    const appState = await run(AppState)
    return run(appState.get)
  })

  handlers.define(
    InvokeChannel.appStateUpdate,
    async (_event, input: unknown): Promise<SharedAppState> => {
      const parsed = await run(Schema.decodeUnknown(SharedAppState)(input))
      if (isDebugOnboardingEnabled()) return parsed

      const appState = await run(AppState)
      return run(appState.save(parsed))
    },
  )

  handlers.define(InvokeChannel.appDiagnostics, async (): Promise<AppPrerequisites> => {
    if (isDebugOnboardingEnabled()) return debugMissingPrerequisites()

    const prerequisites = await run(Prerequisites)
    return run(prerequisites.get)
  })

  handlers.define(
    InvokeChannel.appInstallDiffDashCli,
    async (): Promise<DiffDashCliInstallResult> => {
      const prerequisites = await run(Prerequisites)
      return run(prerequisites.installDiffDashCli)
    },
  )
}

/** Registers settings and setup handlers with Electron. */
export const installSettingsController = (registry: IpcControllerRegistry) =>
  registry.install([
    InvokeChannel.agentProvidersGetCatalog,
    InvokeChannel.settingsGet,
    InvokeChannel.settingsUpdate,
    InvokeChannel.appStateGet,
    InvokeChannel.appStateUpdate,
    InvokeChannel.appDiagnostics,
    InvokeChannel.appInstallDiffDashCli,
  ])
