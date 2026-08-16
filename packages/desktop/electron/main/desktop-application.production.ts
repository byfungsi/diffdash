import type { DesktopApplicationComposition } from "./desktop-application"
import { createExternalApplicationRuntime } from "./external-application-runtime"
import {
  productionDesktopStartupConfiguration,
  resolveDesktopHostConfiguration,
} from "./desktop-host-configuration"

/** Production desktop composition with no E2E-controlled behavior. */
export const productionDesktopApplicationComposition: DesktopApplicationComposition = {
  createApplicationRuntime: createExternalApplicationRuntime,
  resolveHostConfiguration: (identity) =>
    resolveDesktopHostConfiguration(identity, productionDesktopStartupConfiguration),
}
