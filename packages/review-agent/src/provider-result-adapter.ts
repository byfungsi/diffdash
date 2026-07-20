import type { AgentProviderId, ReviewThreadResult } from "@diffdash/agent-provider"
import {
  ReviewAgentProviderRunId,
  ReviewAgentTurnResult,
  ReviewAgentUsage,
  ReviewThreadAgentResponse,
} from "@diffdash/domain/review-agent"
import { ReviewAnchor } from "@diffdash/domain/review-thread"
import { Context, Effect, Either, Schema } from "effect"
import { AgentArtifactNormalizer, normalizeAgentArtifactType } from "./agent-artifact-normalizer"

/** Converts one validated provider result into bounded persisted review-agent data. */
export const adaptProviderResult = (
  providerId: AgentProviderId,
  result: ReviewThreadResult,
  normalizer: Context.Tag.Service<AgentArtifactNormalizer>,
) =>
  Effect.forEach(
    result.artifacts,
    (artifact) =>
      normalizer.normalize({
        provider: providerId,
        type: normalizeAgentArtifactType(artifact.type),
        title: artifact.title,
        content: artifact.content,
        metadata: artifact.metadata,
      }),
    { concurrency: 1 },
  ).pipe(
    Effect.map((artifacts) =>
      ReviewAgentTurnResult.make({
        response: ReviewThreadAgentResponse.make({
          bodyMarkdown: result.response.bodyMarkdown,
          ...(result.response.threadSummary === null
            ? {}
            : { threadSummaryUpdate: result.response.threadSummary }),
          ...(result.response.referencedLocations.length === 0
            ? {}
            : { referencedAnchors: decodeReferencedAnchors(result.response.referencedLocations) }),
        }),
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

const decodeReferencedAnchors = (locations: readonly string[]) =>
  locations.flatMap((location) => {
    const decoded = Schema.decodeUnknownEither(Schema.parseJson(ReviewAnchor))(location)
    return Either.isRight(decoded) ? [decoded.right] : []
  })
