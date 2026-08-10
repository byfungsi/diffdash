import { CoreMethod } from "@diffdash/core"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines analytics IPC handler implementations. */
export const defineAnalyticsHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  handlers.defineCore(CoreMethod.analyticsStart, runtime.execute)
  handlers.defineCore(CoreMethod.analyticsCapture, runtime.execute)
}
