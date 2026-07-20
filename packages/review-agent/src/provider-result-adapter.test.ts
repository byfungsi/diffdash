import { describe, expect, it } from "@effect/vitest"
import {
  AgentArtifactCandidate,
  AgentProviderId,
  AgentSessionId,
  AgentUsage,
  ReviewThreadResponse,
  ReviewThreadResult,
} from "@diffdash/agent-provider"
import { ReviewAgentArtifact } from "@diffdash/domain/review-agent"
import { ReviewLevelAnchor } from "@diffdash/domain/review-thread"
import { Effect } from "effect"
import { AgentArtifactNormalizer } from "./agent-artifact-normalizer"
import { adaptProviderResult } from "./provider-result-adapter"

describe("adaptProviderResult", () => {
  it.effect("owns SDK-result conversion into bounded persisted review-agent data", () => {
    const candidate = AgentArtifactCandidate.make({
      type: "web-result",
      title: "Codex web search",
      content: "result body",
      metadata: {
        rawEvent: { mustNotPersist: true },
        status: "completed",
        url: "https://example.com/result",
      },
    })
    const anchor = ReviewLevelAnchor.make({})
    const providerResult = ReviewThreadResult.make({
      response: ReviewThreadResponse.make({
        bodyMarkdown: "Reviewed the selected line.",
        threadSummary: "The line has been reviewed.",
        referencedLocations: [JSON.stringify(anchor), "not-json"],
      }),
      artifacts: [candidate],
      usage: AgentUsage.make({
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 80,
        cacheWriteTokens: null,
        costUsd: 0.02,
      }),
      sessionId: AgentSessionId.make("codex-session-1"),
    })

    return Effect.gen(function* () {
      const normalizer = yield* AgentArtifactNormalizer
      const result = yield* adaptProviderResult(
        AgentProviderId.make("codex"),
        providerResult,
        normalizer,
      )

      expect(candidate).toBeInstanceOf(AgentArtifactCandidate)
      expect(candidate).not.toHaveProperty("contentDigest")
      expect(result.response).toMatchObject({
        bodyMarkdown: "Reviewed the selected line.",
        threadSummaryUpdate: "The line has been reviewed.",
        referencedAnchors: [anchor],
      })
      expect(result.providerRunId).toBe("codex-session-1")
      expect(result.usage).toMatchObject({
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 80,
        cacheWriteTokens: null,
        costUsd: 0.02,
      })
      expect(result.artifacts).toHaveLength(1)
      expect(result.artifacts[0]).toBeInstanceOf(ReviewAgentArtifact)
      expect(result.artifacts[0]).toMatchObject({
        type: "web_result",
        provider: "codex",
        title: "Codex web search",
        content: "result body",
        truncated: false,
        metadata: {
          sourceProvider: "codex",
          status: "completed",
          url: "https://example.com/result",
        },
      })
      expect(result.artifacts[0]?.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(result.artifacts[0]?.metadata).not.toHaveProperty("rawEvent")
    }).pipe(Effect.provide(AgentArtifactNormalizer.layer))
  })

  it.effect("preserves nullable SDK fields and discards invalid referenced locations", () =>
    Effect.gen(function* () {
      const normalizer = yield* AgentArtifactNormalizer
      const result = yield* adaptProviderResult(
        AgentProviderId.make("codex"),
        ReviewThreadResult.make({
          response: ReviewThreadResponse.make({
            bodyMarkdown: "No optional updates.",
            threadSummary: null,
            referencedLocations: ["invalid-anchor"],
          }),
          artifacts: [],
          usage: null,
          sessionId: null,
        }),
        normalizer,
      )

      expect(result.response.bodyMarkdown).toBe("No optional updates.")
      expect(result.response).not.toHaveProperty("threadSummaryUpdate")
      expect(result.response.referencedAnchors).toEqual([])
      expect(result.providerRunId).toBeNull()
      expect(result.usage).toBeNull()
      expect(result.artifacts).toEqual([])
    }).pipe(Effect.provide(AgentArtifactNormalizer.layer)),
  )
})
