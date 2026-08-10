import { CoreMethod } from "@diffdash/core"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import { EventContract } from "@diffdash/protocol/ipc"
import { Schema } from "effect"
import type { ApplicationRuntime } from "../../application-runtime"
import { toPublicReviewThreadError } from "../review-thread-public-error"
import { sendProtocolEvent } from "../transport"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines review-thread IPC handlers over cohesive Core operations. */
export const defineThreadHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  handlers.defineCore(CoreMethod.listReviewThreads, runtime.execute)
  handlers.defineCore(CoreMethod.addReviewThreadUserMessage, runtime.execute)
  handlers.defineCore(CoreMethod.createReviewThread, runtime.execute)
  handlers.defineCore(CoreMethod.getReviewThread, runtime.execute)
  handlers.define(
    InvokeChannel.runReviewThreadAgent,
    async (event, request) =>
      runtime.execute(CoreMethod.runReviewThreadAgent, request, {
        onReviewThreadAgentProgress: (stage) => {
          sendProtocolEvent(
            event.sender,
            EventChannel.reviewThreadAgentProgress,
            Schema.decodeUnknownSync(EventContract[EventChannel.reviewThreadAgentProgress].payload)(
              {
                threadId: request.threadId,
                stage,
              },
            ),
          )
        },
      }),
    toPublicReviewThreadError,
  )
}
