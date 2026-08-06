import { CoreMethod } from "@diffdash/core"
import { ReviewAgentProgress } from "@diffdash/domain/review-agent"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import type { ApplicationRuntime } from "../../application-runtime"
import { toPublicReviewThreadError } from "../review-thread-public-error"
import { sendProtocolEvent } from "../transport"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines review-thread IPC handlers over cohesive Core operations. */
export const defineThreadHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  handlers.define(InvokeChannel.listReviewThreads, async (_event, request) =>
    runtime.execute(CoreMethod.listReviewThreads, request),
  )
  handlers.define(InvokeChannel.addReviewThreadUserMessage, async (_event, request) =>
    runtime.execute(CoreMethod.addReviewThreadUserMessage, request),
  )
  handlers.define(InvokeChannel.createReviewThread, async (_event, request) =>
    runtime.execute(CoreMethod.createReviewThread, request),
  )
  handlers.define(InvokeChannel.getReviewThread, async (_event, request) =>
    runtime.execute(CoreMethod.getReviewThread, request),
  )
  handlers.define(
    InvokeChannel.runReviewThreadAgent,
    async (event, request) =>
      runtime.execute(CoreMethod.runReviewThreadAgent, request, {
        onReviewThreadAgentProgress: (stage) => {
          if (event.sender.isDestroyed()) return
          sendProtocolEvent(
            event.sender,
            EventChannel.reviewThreadAgentProgress,
            ReviewAgentProgress.make({ threadId: request.threadId, stage }),
          )
        },
      }),
    toPublicReviewThreadError,
  )
}
