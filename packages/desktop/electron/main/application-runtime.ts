import type { CoreConfiguration } from "@diffdash/core"
import { createEmbeddedCore, type LegacyEmbeddedCore } from "@diffdash/core/legacy"

/** Typed boundary around the desktop application's managed Effect runtime. */
export interface ApplicationRuntime {
  readonly start: () => Promise<void>
  readonly dispose: () => Promise<void>
  readonly runPromise: LegacyEmbeddedCore["runLegacy"]
}

/** Adapts embedded Core to the temporary desktop controller runtime contract. */
export const createApplicationRuntime = (configuration: CoreConfiguration): ApplicationRuntime => {
  const core = createEmbeddedCore(configuration)
  return {
    start: core.start,
    dispose: core.dispose,
    runPromise: core.runLegacy,
  }
}
