import { CoreMethod } from "@diffdash/core"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { InvokeContract } from "@diffdash/protocol/ipc"
import { AppPrerequisites } from "@diffdash/protocol/prerequisites"
import { Schema } from "effect"
import type { ApplicationRuntime } from "../../application-runtime"
import type { DesktopHostConfiguration } from "../../desktop-host-configuration"
import { IpcControllerRegistry } from "./controller-registry"

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

const debugAppState = () =>
  Schema.decodeUnknownSync(InvokeContract[InvokeChannel.appStateGet].response)({
    onboardingCompleted: false,
  })

/** Defines settings IPC handler implementations. */
export const defineSettingsHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
  configuration: DesktopHostConfiguration,
) => {
  handlers.defineCore(CoreMethod.agentProvidersGetCatalog, runtime.core.agentProvidersGetCatalog)
  handlers.defineCore(CoreMethod.settingsGet, runtime.core.settingsGet)
  handlers.defineCore(CoreMethod.settingsUpdate, runtime.core.settingsUpdate)

  handlers.define(InvokeChannel.appStateGet, async () => {
    if (configuration.policies.debugOnboarding) return debugAppState()

    return runtime.core.appStateGet({})
  })

  handlers.define(InvokeChannel.appStateUpdate, async (_event, { state: parsed }) => {
    if (configuration.policies.debugOnboarding) return parsed

    return runtime.core.appStateUpdate({ state: parsed })
  })

  handlers.define(InvokeChannel.appDiagnostics, async (): Promise<AppPrerequisites> => {
    if (configuration.policies.debugOnboarding) return debugMissingPrerequisites()

    return runtime.core.appDiagnostics({})
  })

  handlers.defineCore(CoreMethod.appInstallDiffDashCli, runtime.core.appInstallDiffDashCli)
}
