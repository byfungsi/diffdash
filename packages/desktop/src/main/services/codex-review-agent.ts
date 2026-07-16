import { Effect, Either, Layer, Schema } from "effect"

import {
  AgentExecutionPolicy,
  AgentProviderId,
  AgentProviderOperationError,
  AgentSessionId,
  InvalidAgentProviderResponseError,
  ReviewRevision,
  type ReviewThreadRequest,
  type ScopedMcpCall,
} from "@diffdash/agent-provider"
import {
  CODEX_REVIEW_POLICY,
  codexMcpToolNames,
  codexModelId,
  makeCodexProvider,
} from "@diffdash/agent-provider-codex"
import {
  ReviewAgentProviderRunId,
  type ReviewAgentTurnInput,
  ReviewAgentTurnResult,
  ReviewAgentUsage,
  ReviewThreadAgentResponse,
} from "@diffdash/domain/review-agent"
import { ReviewAnchor } from "@diffdash/domain/review-thread"
import { AgentArtifactNormalizer } from "./agent-artifact-normalizer"
import { CliService } from "@diffdash/process/cli"
import { CliStreamService } from "@diffdash/process/cli-stream"
import type { DiffDashMcpRunAccess } from "./diffdash-mcp-server"
import {
  ReviewAgentExecutionError,
  ReviewAgentInvalidResponseError,
  ReviewAgentPermissionError,
  ReviewAgentProtocolError,
  type ReviewAgentExecutionContext,
  ReviewAgentProvider,
} from "./review-agent-provider"

const providerId = "codex" as const
const turnTimeoutMs = 10 * 60 * 1_000
const diffDashMcpTools = codexMcpToolNames([
  "getReviewContext",
  "getChangedFiles",
  "searchReviewDiff",
  "getDiffHunk",
  "getDiffFile",
  "searchRepository",
  "readRepositoryFile",
  "getThreadContext",
  "getOlderThreadMessages",
  "getPriorArtifact",
  "getWalkthroughContext",
])

/** Legacy review-provider layer backed by the extracted Codex SDK provider. */
export const codexReviewAgentLayer = Layer.effect(
  ReviewAgentProvider,
  Effect.gen(function* () {
    const cli = yield* CliService
    const cliStream = yield* CliStreamService
    const normalizer = yield* AgentArtifactNormalizer
    const registration = makeCodexProvider({ cli, cliStream })
    const review = registration.reviewThread
    if (review === undefined) throw new Error("Codex review capability is not registered")

    const runThreadTurn = Effect.fn("CodexReviewAgent.runThreadTurn")(function* (
      input: ReviewAgentTurnInput,
      execution: ReviewAgentExecutionContext,
    ) {
      if (input.cwd === null) {
        return yield* ReviewAgentPermissionError.make({
          provider: providerId,
          reason: "Codex review execution requires an isolated working directory",
        })
      }
      const request = makeReviewRequest(input, input.cwd, execution.mcp, execution.providerRunId)
      const result = yield* review.execute(request).pipe(Effect.mapError(mapProviderError))
      const artifacts = yield* Effect.forEach(
        result.artifacts,
        (artifact) =>
          normalizer
            .normalize({
              provider: providerId,
              type: legacyArtifactType(artifact.type),
              title: artifact.title,
              content: artifact.content,
              metadata: artifact.metadata,
            })
            .pipe(
              Effect.mapError((cause) =>
                ReviewAgentProtocolError.make({ provider: providerId, reason: cause.reason }),
              ),
            ),
        { concurrency: 1 },
      )
      const referencedAnchors = decodeReferencedAnchors(result.response.referencedLocations)
      return ReviewAgentTurnResult.make({
        response: ReviewThreadAgentResponse.make({
          bodyMarkdown: result.response.bodyMarkdown,
          ...(result.response.threadSummary === null
            ? {}
            : { threadSummaryUpdate: result.response.threadSummary }),
          ...(referencedAnchors.length === 0 ? {} : { referencedAnchors }),
        }),
        artifacts,
        providerRunId: null,
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
      })
    })

    return ReviewAgentProvider.of({
      id: providerId,
      sessionMode: "none",
      isAvailable: review.probe.pipe(
        Effect.map(({ _tag: tag }) => tag === "AgentCapabilityReady"),
        Effect.mapError((cause) =>
          ReviewAgentExecutionError.make({
            provider: providerId,
            reason: cause.reason,
            cause,
          }),
        ),
      ),
      runThreadTurn,
    })
  }),
)

const makeReviewRequest = (
  input: ReviewAgentTurnInput,
  cwd: string,
  mcp: DiffDashMcpRunAccess,
  providerRunId: ReviewAgentProviderRunId | null,
): ReviewThreadRequest => ({
  stablePrompt: input.stablePromptPrefix,
  dynamicPrompt: input.dynamicPromptSuffix,
  model: codexModelId(input.model),
  workingDirectory: cwd,
  revision: ReviewRevision.make(input.headRevision),
  timeoutMs: turnTimeoutMs,
  sessionId: providerRunId === null ? null : AgentSessionId.make(providerRunId),
  mcp: {
    scopeId: input.threadId,
    endpoint: mcp.url,
    bearerToken: mcp.bearerToken,
    allowedTools: diffDashMcpTools,
    call: (_call: ScopedMcpCall) =>
      AgentProviderOperationError.make({
        providerId: registrationProviderId,
        capability: "review-thread",
        reason: "Codex accesses MCP through its scoped transport",
      }),
  },
  policy: AgentExecutionPolicy.make({
    ...CODEX_REVIEW_POLICY,
    allowedMcpTools: diffDashMcpTools,
  }),
})

const registrationProviderId = AgentProviderId.make(providerId)

const mapProviderError = (
  cause: AgentProviderOperationError | InvalidAgentProviderResponseError,
) => {
  if (cause instanceof InvalidAgentProviderResponseError) {
    return ReviewAgentInvalidResponseError.make({ provider: providerId, reason: cause.reason })
  }
  if (/file change|non-mutating policy|MCP access includes tools/iu.test(cause.reason)) {
    return ReviewAgentPermissionError.make({ provider: providerId, reason: cause.reason })
  }
  if (/JSONL|lifecycle|omitted/iu.test(cause.reason)) {
    return ReviewAgentProtocolError.make({ provider: providerId, reason: cause.reason })
  }
  return ReviewAgentExecutionError.make({ provider: providerId, reason: cause.reason, cause })
}

const legacyArtifactType = (
  type:
    | "file-read"
    | "search-result"
    | "shell-output"
    | "web-result"
    | "diff-context"
    | "mcp-tool-result"
    | "provider-message"
    | "unknown",
) =>
  type.replaceAll("-", "_") as
    | "file_read"
    | "search_result"
    | "shell_output"
    | "web_result"
    | "diff_context"
    | "mcp_tool_result"
    | "provider_message"
    | "unknown"

const decodeReferencedAnchors = (locations: readonly string[]): ReviewAnchor[] =>
  locations.flatMap((location) => {
    try {
      const result = Schema.decodeUnknownEither(ReviewAnchor)(JSON.parse(location) as unknown)
      return Either.isRight(result) ? [result.right] : []
    } catch {
      return []
    }
  })
