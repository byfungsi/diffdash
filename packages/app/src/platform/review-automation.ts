import { Context, Effect, Layer, Option, Stream } from "effect"

import type { LocalReviewTarget } from "@diffdash/domain/local-review"
import type { RepositoryComparisonTarget } from "@diffdash/domain/repository-comparison"
import type { ReviewAgentProgress } from "@diffdash/domain/review-agent"
import type {
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import type { AgentProviderCatalog } from "@diffdash/protocol/agent-providers"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import type {
  GenerateHostedWalkthroughRequest,
  HostedWalkthroughRequest,
} from "@diffdash/protocol/hosted-git"
import type {
  AddReviewThreadUserMessageRequest,
  CreateReviewThreadRequest,
  RunReviewThreadAgentRequest,
} from "@diffdash/protocol/review-threads"
import { PreloadClient } from "./preload-client"
import { invokePreload, preloadEventStream, type RendererApiError } from "./renderer-api-error"

/** Renderer walkthrough and review-agent capabilities. */
export class ReviewAutomation extends Context.Service<
  ReviewAutomation,
  {
    readonly getAgentCatalog: () => Effect.Effect<AgentProviderCatalog, RendererApiError>
    readonly walkthroughs: {
      readonly getHosted: (
        request: HostedWalkthroughRequest,
      ) => Effect.Effect<Option.Option<StoredWalkthrough>, RendererApiError>
      readonly generateHosted: (
        request: GenerateHostedWalkthroughRequest,
      ) => Effect.Effect<StoredWalkthrough, RendererApiError>
      readonly getLocal: (
        target: LocalReviewTarget,
        baseSha: string,
        headSha: string,
      ) => Effect.Effect<Option.Option<StoredWalkthrough>, RendererApiError>
      readonly generateLocal: (
        target: LocalReviewTarget,
        regenerate: boolean,
      ) => Effect.Effect<StoredWalkthrough, RendererApiError>
      readonly getRepositoryComparison: (
        target: RepositoryComparisonTarget,
      ) => Effect.Effect<Option.Option<StoredWalkthrough>, RendererApiError>
      readonly generateRepositoryComparison: (
        target: RepositoryComparisonTarget,
        regenerate: boolean,
      ) => Effect.Effect<StoredWalkthrough, RendererApiError>
    }
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

/** Desktop implementation of renderer walkthrough and review-agent capabilities. */
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
      walkthroughs: {
        getHosted: (request) =>
          invokePreload(InvokeChannel.getWalkthrough, () => api.walkthroughs.get(request)).pipe(
            Effect.map(Option.fromNullishOr),
          ),
        generateHosted: (request) =>
          invokePreload(InvokeChannel.generateWalkthrough, () =>
            api.walkthroughs.generate(request),
          ),
        getLocal: (target, baseSha, headSha) =>
          invokePreload(InvokeChannel.getLocalWalkthrough, () =>
            api.localWalkthroughs.get(target, baseSha, headSha),
          ).pipe(Effect.map(Option.fromNullishOr)),
        generateLocal: (target, regenerate) =>
          invokePreload(InvokeChannel.generateLocalWalkthrough, () =>
            regenerate
              ? api.localWalkthroughs.regenerate(target)
              : api.localWalkthroughs.generate(target),
          ),
        getRepositoryComparison: (target) =>
          invokePreload(InvokeChannel.getRepositoryComparisonWalkthrough, () =>
            api.repositoryComparisonWalkthroughs.get(target),
          ).pipe(Effect.map(Option.fromNullishOr)),
        generateRepositoryComparison: (target, regenerate) =>
          invokePreload(InvokeChannel.generateRepositoryComparisonWalkthrough, () =>
            regenerate
              ? api.repositoryComparisonWalkthroughs.regenerate(target)
              : api.repositoryComparisonWalkthroughs.generate(target),
          ),
      },
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
