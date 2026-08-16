import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"

import type { ApplicationRuntime } from "../../application-runtime"
import { sendProtocolEvent } from "../transport"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines source-neutral durable walkthrough operation IPC handlers. */
export const defineWalkthroughHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  const relayHints = (target: Parameters<typeof sendProtocolEvent>[0]) => {
    void runtime.walkthroughOperations
      .replayHints()
      .then((hints) => {
        for (const hint of hints) {
          sendProtocolEvent(target, EventChannel.walkthroughOperationHint, hint)
        }
        return undefined
      })
      .catch(() => undefined)
  }

  handlers.define(InvokeChannel.startWalkthroughOperation, async (event, request) => {
    const result = await runtime.walkthroughOperations.start(request)
    relayHints(event.sender)
    return result
  })
  handlers.define(InvokeChannel.getWalkthroughOperation, async (event, request) => {
    const result = await runtime.walkthroughOperations.getOperation(request)
    relayHints(event.sender)
    return result
  })
  handlers.define(InvokeChannel.cancelWalkthroughOperation, async (event, request) => {
    const result = await runtime.walkthroughOperations.cancel(request)
    relayHints(event.sender)
    return result
  })
  handlers.define(InvokeChannel.getStoredWalkthrough, async (event, request) => {
    const result = await runtime.walkthroughOperations.getStored(request)
    relayHints(event.sender)
    return result
  })
}
