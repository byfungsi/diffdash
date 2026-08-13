import { createE2EEmbeddedCore } from "@diffdash/core/e2e"
import { createApplicationRuntime } from "./application-runtime"
import type { DesktopApplicationComposition } from "./desktop-application"
import { makeE2EDesktopStartupConfiguration } from "./desktop-host-configuration.e2e"
import { resolveDesktopHostConfiguration } from "./desktop-host-configuration"

/** Playwright desktop composition with explicitly selected E2E behavior. */
export const e2eDesktopApplicationComposition: DesktopApplicationComposition = {
  createApplicationRuntime: (configuration) =>
    createApplicationRuntime(createE2EEmbeddedCore(configuration)),
  resolveHostConfiguration: (identity) =>
    resolveDesktopHostConfiguration(identity, makeE2EDesktopStartupConfiguration(process.env)),
}
