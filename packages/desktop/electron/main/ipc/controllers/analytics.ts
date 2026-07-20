import { InvokeChannel } from "@diffdash/protocol/channels"
import { Analytics } from "../../../../src/main/services/analytics"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines analytics IPC handler implementations. */
export const defineAnalyticsHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  const run = runtime.runPromise

  handlers.define(InvokeChannel.analyticsStart, async (): Promise<void> => {
    const analytics = await run(Analytics)
    return run(analytics.start)
  })

  handlers.define(InvokeChannel.analyticsCapture, async (_event, { event }): Promise<void> => {
    const analytics = await run(Analytics)
    return run(analytics.capture(event))
  })
}
