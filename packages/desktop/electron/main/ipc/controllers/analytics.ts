import { AnalyticsEvent } from "@diffdash/protocol/analytics"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { Schema } from "effect"
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

  handlers.define(InvokeChannel.analyticsCapture, async (_event, input: unknown): Promise<void> => {
    const event = await run(Schema.decodeUnknown(AnalyticsEvent)(input))
    const analytics = await run(Analytics)
    return run(analytics.capture(event))
  })
}

/** Registers analytics handlers with Electron. */
export const installAnalyticsController = (registry: IpcControllerRegistry) =>
  registry.install([InvokeChannel.analyticsStart, InvokeChannel.analyticsCapture])
