import type { ReviewThreadAgentOutcome } from "@diffdash/agents/review-thread"
import type { AgentProviderId } from "@diffdash/agent-provider"
import {
  ReviewAgentProviderRunId,
  ReviewAgentProviderId,
  ReviewAgentTurnResult,
  ReviewAgentUsage,
} from "@diffdash/domain/review-agent"
import { Context, Effect } from "effect"
import { AgentArtifactNormalizer, normalizeAgentArtifactType } from "./agent-artifact-normalizer"

/** Converts one validated agent outcome into bounded persisted review-agent data. */
export const adaptReviewAgentOutcome = (
  providerId: AgentProviderId,
  result: ReviewThreadAgentOutcome,
  normalizer: Context.Service.Shape<typeof AgentArtifactNormalizer>,
) =>
  Effect.forEach(
    result.artifacts,
    (artifact) =>
      normalizer.normalize({
        provider: ReviewAgentProviderId.make(providerId),
        type: normalizeAgentArtifactType(artifact.type),
        title: artifact.title,
        content: artifact.content,
        metadata: artifact.metadata,
      }),
    { concurrency: 1 },
  ).pipe(
    Effect.map((artifacts) =>
      ReviewAgentTurnResult.make({
        response: result.response,
        artifacts,
        providerRunId:
          result.sessionId === null ? null : ReviewAgentProviderRunId.make(result.sessionId),
        usage:
          result.usage === null
            ? null
            : ReviewAgentUsage.make({
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                cacheReadTokens: result.usage.cacheReadTokens,
                cacheWriteTokens: result.usage.cacheWriteTokens,
                costUsd: result.usage.costUsd,
              }),
      }),
    ),
  )
