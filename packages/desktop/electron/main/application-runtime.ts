import { createEmbeddedCore, type CoreConfiguration, type EmbeddedCore } from "@diffdash/core"

/** Typed embedded Core boundary used by the Electron host. */
export type ApplicationRuntime = EmbeddedCore

/** Creates the one embedded Core runtime owned by the desktop application. */
export const createApplicationRuntime = (configuration: CoreConfiguration): ApplicationRuntime =>
  createEmbeddedCore(configuration)
