import {
  AgentModelId,
  AgentProviderId,
  type AgentArtifactCandidate,
  type AgentProviderOperationError,
  type AgentSessionId,
  type AgentUsage,
  InvalidAgentProviderResponseError,
  type ReviewThreadCapability,
  type ReviewThreadRequest,
  ReviewThreadResult,
} from "@diffdash/agent-provider"
import type { ReviewThreadAgentResponse } from "@diffdash/domain/review-agent"
import { Context, Effect, Layer, Schema } from "effect"
import {
  buildReviewThreadPrompt,
  type ReviewThreadPromptError,
  type ReviewThreadPromptInput,
} from "./review-thread-prompt"

export {
  buildReviewThreadPrompt,
  type ReviewThreadPromptContext,
  type ReviewThreadPromptInput,
  ReviewThreadPromptError,
  type SelectedReviewAgentArtifact,
} from "./review-thread-prompt"

const REVIEW_THREAD_TIMEOUT_MS = 10 * 60 * 1_000

/** Review state and resolved capabilities required for one review-thread execution. */
export interface ReviewThreadAgentContext extends ReviewThreadPromptInput {
  readonly providerId: AgentProviderId
  readonly capability: ReviewThreadCapability
  readonly model: AgentModelId
  readonly workingDirectory: string
  readonly revision: ReviewThreadRequest["revision"]
  readonly sessionId: AgentSessionId | null
  readonly mcp: ReviewThreadRequest["mcp"]
  readonly policy: ReviewThreadRequest["policy"]
  readonly timeoutMs?: number
}

/** Provider-neutral response and artifact candidates returned after one review-thread execution. */
export interface ReviewThreadAgentOutcome {
  readonly response: ReviewThreadAgentResponse
  readonly usage: AgentUsage | null
  readonly artifacts: readonly AgentArtifactCandidate[]
  readonly sessionId: AgentSessionId | null
}

/** Provider-neutral review-thread execution engine. */
export class ReviewThreadAgentEngine extends Context.Service<
  ReviewThreadAgentEngine,
  {
    readonly run: (
      context: ReviewThreadAgentContext,
    ) => Effect.Effect<
      ReviewThreadAgentOutcome,
      ReviewThreadPromptError | AgentProviderOperationError | InvalidAgentProviderResponseError
    >
  }
>()("@diffdash/ReviewThreadAgentEngine") {
  static readonly layer = Layer.succeed(
    ReviewThreadAgentEngine,
    ReviewThreadAgentEngine.of({
      run: Effect.fn("ReviewThreadAgentEngine.run")(runReviewThreadAgent),
    }),
  )
}

function runReviewThreadAgent(
  context: ReviewThreadAgentContext,
): Effect.Effect<
  ReviewThreadAgentOutcome,
  ReviewThreadPromptError | AgentProviderOperationError | InvalidAgentProviderResponseError
> {
  return Effect.gen(function* () {
    const prompt = yield* buildReviewThreadPrompt(context)
    const result = yield* context.capability.execute({
      stablePrompt: prompt.stablePromptPrefix,
      dynamicPrompt: prompt.dynamicPromptSuffix,
      model: context.model,
      workingDirectory: context.workingDirectory,
      revision: context.revision,
      timeoutMs: context.timeoutMs ?? REVIEW_THREAD_TIMEOUT_MS,
      sessionId: context.sessionId,
      mcp: context.mcp,
      policy: context.policy,
    })
    const decoded = yield* Schema.decodeUnknownEffect(ReviewThreadResult)(result).pipe(
      Effect.mapError(() =>
        InvalidAgentProviderResponseError.make({
          providerId: context.providerId,
          capability: "review-thread",
          reason: "Provider returned an invalid review-thread response.",
        }),
      ),
    )
    return {
      response: decoded.response,
      usage: decoded.usage,
      artifacts: decoded.artifacts,
      sessionId: decoded.sessionId,
    }
  })
}
