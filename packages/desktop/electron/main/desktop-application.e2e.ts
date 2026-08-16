import type { DesktopApplicationComposition } from "./desktop-application"
import { makeE2EDesktopStartupConfiguration } from "./desktop-host-configuration.e2e"
import { resolveDesktopHostConfiguration } from "./desktop-host-configuration"
import { createExternalApplicationRuntime } from "./external-application-runtime"

/** Playwright desktop composition with explicitly selected E2E behavior. */
export const e2eDesktopApplicationComposition: DesktopApplicationComposition = {
  createApplicationRuntime: (configuration) =>
    createExternalApplicationRuntime(configuration, ["DIFFDASH_E2E_TERMINAL_HINT_DELIVERY"]),
  resolveHostConfiguration: (identity) =>
    resolveDesktopHostConfiguration(identity, makeE2EDesktopStartupConfiguration(process.env)),
}
