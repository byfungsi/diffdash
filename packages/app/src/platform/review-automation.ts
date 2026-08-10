import { Context, Effect, Layer, Stream } from "effect"

import type { ReviewAgentProgress } from "@diffdash/domain/review-agent"
import type {
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import type { AgentProviderCatalog } from "@diffdash/protocol/agent-providers"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import type {
  AddReviewThreadUserMessageRequest,
  CreateReviewThreadRequest,
  RunReviewThreadAgentRequest,
} from "@diffdash/protocol/review-threads"
import { PreloadClient } from "./preload-client"
import { invokePreload, preloadEventStream, type RendererApiError } from "./renderer-api-error"

/** Renderer agent-provider catalog and review-thread capabilities. */
export class ReviewAutomation extends Context.Service<
  ReviewAutomation,
  {
    readonly getAgentCatalog: () => Effect.Effect<AgentProviderCatalog, RendererApiError>
    readonly threads: {
      readonly list: (
        target: ReviewThreadTarget,
      ) => Effect.Effect<readonly ReviewThread[], RendererApiError>
      readonly listDetails: (
        target: ReviewThreadTarget,
      ) => Effect.Effect<readonly ReviewThreadDetails[], RendererApiError>
      readonly get: (
        threadId: ReviewThreadId,
      ) => Effect.Effect<ReviewThreadDetails, RendererApiError>
      readonly create: (
        request: CreateReviewThreadRequest,
      ) => Effect.Effect<ReviewThreadDetails, RendererApiError>
      readonly addUserMessage: (
        request: AddReviewThreadUserMessageRequest,
      ) => Effect.Effect<ReviewThreadDetails, RendererApiError>
      readonly runAgent: (
        request: RunReviewThreadAgentRequest,
      ) => Effect.Effect<ReviewThreadDetails, RendererApiError>
      readonly progress: Stream.Stream<ReviewAgentProgress, RendererApiError>
    }
  }
>()("@diffdash/app/ReviewAutomation") {}

/** Desktop implementation of renderer provider-catalog and review-thread capabilities. */
export const reviewAutomationLayer = Layer.effect(
  ReviewAutomation,
  Effect.gen(function* () {
    const api = yield* PreloadClient
    const getThread = (threadId: ReviewThreadId) =>
      invokePreload(InvokeChannel.getReviewThread, () => api.reviewThreads.get(threadId))
    const listThreads = (target: ReviewThreadTarget) =>
      invokePreload(InvokeChannel.listReviewThreads, () => api.reviewThreads.list(target))

    return ReviewAutomation.of({
      getAgentCatalog: () =>
        invokePreload(InvokeChannel.agentProvidersGetCatalog, () =>
          api.agentProviders.getCatalog(),
        ),
      threads: {
        list: listThreads,
        listDetails: (target) =>
          listThreads(target).pipe(
            Effect.flatMap((threads) =>
              Effect.forEach(threads, (thread) => getThread(thread.id), {
                concurrency: "unbounded",
              }),
            ),
          ),
        get: getThread,
        create: (request) =>
          invokePreload(InvokeChannel.createReviewThread, () => api.reviewThreads.create(request)),
        addUserMessage: (request) =>
          invokePreload(InvokeChannel.addReviewThreadUserMessage, () =>
            api.reviewThreads.addUserMessage(request),
          ),
        runAgent: (request) =>
          invokePreload(InvokeChannel.runReviewThreadAgent, () =>
            api.reviewThreads.runAgent(request),
          ),
        progress: preloadEventStream(EventChannel.reviewThreadAgentProgress, (listener) =>
          api.reviewThreads.onAgentProgress(listener),
        ),
      },
    })
  }),
)
