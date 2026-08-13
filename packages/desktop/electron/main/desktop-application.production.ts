import { createEmbeddedCore } from "@diffdash/core"
import { createApplicationRuntime } from "./application-runtime"
import type { DesktopApplicationComposition } from "./desktop-application"
import {
  productionDesktopStartupConfiguration,
  resolveDesktopHostConfiguration,
} from "./desktop-host-configuration"

/** Production desktop composition with no E2E-controlled behavior. */
export const productionDesktopApplicationComposition: DesktopApplicationComposition = {
  createApplicationRuntime: (configuration) =>
    createApplicationRuntime(createEmbeddedCore(configuration)),
  resolveHostConfiguration: (identity) =>
    resolveDesktopHostConfiguration(identity, productionDesktopStartupConfiguration),
}
