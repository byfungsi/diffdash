import type { CoreConfiguration } from "./core-configuration"
import type { EmbeddedCore } from "./core-contract"
import { createEmbeddedCoreWithProviderComposition } from "./embedded-core"
import { e2eProviderComposition } from "./provider-composition.e2e"

/** Creates the E2E Core runtime with deterministic fixture providers available. */
export const createE2EEmbeddedCore = (configuration: CoreConfiguration): EmbeddedCore =>
  createEmbeddedCoreWithProviderComposition(configuration, e2eProviderComposition)
