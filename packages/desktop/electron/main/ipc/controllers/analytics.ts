import { CoreMethod } from "@diffdash/core"
import { InvokeChannel } from "@diffdash/protocol/channels"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines analytics IPC handler implementations. */
export const defineAnalyticsHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  handlers.define(
    InvokeChannel.analyticsStart,
    async (): Promise<void> => runtime.execute(CoreMethod.analyticsStart, {}),
  )

  handlers.define(
    InvokeChannel.analyticsCapture,
    async (_event, request): Promise<void> => runtime.execute(CoreMethod.analyticsCapture, request),
  )
}
