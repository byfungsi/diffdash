import { CoreMethod } from "@diffdash/core"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import { EventContract } from "@diffdash/protocol/ipc"
import { Schema } from "effect"
import type { ApplicationRuntime } from "../../application-runtime"
import { sendProtocolEvent } from "../transport"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines review-thread IPC handlers over cohesive Core operations. */
export const defineThreadHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  handlers.defineCore(CoreMethod.listReviewThreads, runtime.core.listReviewThreads)
  handlers.defineCore(
    CoreMethod.addReviewThreadUserMessage,
    runtime.core.addReviewThreadUserMessage,
  )
  handlers.defineCore(CoreMethod.createReviewThread, runtime.core.createReviewThread)
  handlers.defineCore(CoreMethod.getReviewThread, runtime.core.getReviewThread)
  handlers.define(InvokeChannel.runReviewThreadAgent, async (event, request) =>
    runtime.core.runReviewThreadAgent(request, {
      onReviewThreadAgentProgress: (stage) => {
        sendProtocolEvent(
          event.sender,
          EventChannel.reviewThreadAgentProgress,
          Schema.decodeUnknownSync(EventContract[EventChannel.reviewThreadAgentProgress].payload)({
            threadId: request.threadId,
            stage,
          }),
        )
      },
    }),
  )
}
