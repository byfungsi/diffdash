import { Effect, Layer, Schema } from "effect"

import {
  type ReviewAgentArtifactType,
  normalizeReviewThreadAgentResponse,
  ReviewAgentProviderRunId,
  type ReviewAgentTurnInput,
  ReviewAgentTurnResult,
  ReviewAgentUsage,
  ReviewThreadAgentResponse,
} from "../../shared/review-agent"
import { AgentArtifactNormalizer } from "./agent-artifact-normalizer"
import {
  OpenCodeSdkClient,
  type OpenCodeSdkPart,
  type OpenCodeSdkToolPart,
  type OpenCodeSdkTurnOutput,
} from "./opencode-sdk-client"
import { resolveReviewAgentPermissionConfig } from "./review-agent-permissions"
import {
  mapReviewAgentExecutionError,
  ReviewAgentInvalidResponseError,
  ReviewAgentPermissionError,
  ReviewAgentProtocolError,
  ReviewAgentProvider,
  type ReviewAgentExecutionContext,
} from "./review-agent-provider"

const providerId = "opencode" as const

/** Layer implementing the provider-neutral review agent contract through the OpenCode SDK. */
export const openCodeReviewAgentLayer = Layer.effect(
  ReviewAgentProvider,
  Effect.gen(function* () {
    const sdk = yield* OpenCodeSdkClient
    const normalizer = yield* AgentArtifactNormalizer

    const runThreadTurn = Effect.fn("OpenCodeReviewAgent.runThreadTurn")(function* (
      input: ReviewAgentTurnInput,
      execution: ReviewAgentExecutionContext,
    ) {
      const permissionResult = resolveReviewAgentPermissionConfig(input.permissions, {
        provider: providerId,
        toolPermissions: true,
      })
      if (!permissionResult.enabled || permissionResult.config.provider !== providerId) {
        return yield* ReviewAgentPermissionError.make({
          provider: providerId,
          reason: permissionResult.enabled
            ? "OpenCode permission configuration was not produced"
            : permissionResult.reason,
        })
      }

      const output = yield* sdk
        .runTurn({
          cwd: input.cwd,
          model: input.model,
          stablePromptPrefix: input.stablePromptPrefix,
          dynamicPromptSuffix: input.dynamicPromptSuffix,
          threadId: input.threadId,
          reviewKey: input.reviewKey,
          providerRunId: execution.providerRunId,
          permissionConfig: permissionResult.config.sdkConfig,
          mcp: execution.mcp,
        })
        .pipe(Effect.mapError((error) => mapReviewAgentExecutionError(providerId, error)))

      if (output.parts.some((part) => part.type === "patch")) {
        return yield* ReviewAgentPermissionError.make({
          provider: providerId,
          reason: "OpenCode emitted a patch despite read-only thread permissions",
        })
      }

      const response = yield* decodeResponse(output)
      const artifacts = yield* Effect.forEach(
        output.parts.filter((part) => part.type !== "patch"),
        (part) =>
          normalizer
            .normalize(toArtifactInput(part, output))
            .pipe(
              Effect.mapError((error) =>
                ReviewAgentProtocolError.make({ provider: providerId, reason: error.reason }),
              ),
            ),
        { concurrency: 1 },
      )

      return ReviewAgentTurnResult.make({
        response,
        artifacts,
        providerRunId: ReviewAgentProviderRunId.make(output.sessionId),
        usage: ReviewAgentUsage.make({
          inputTokens: output.usage.inputTokens,
          outputTokens: output.usage.outputTokens,
          cacheReadTokens: output.usage.cacheReadTokens,
          cacheWriteTokens: output.usage.cacheWriteTokens,
          costUsd: output.usage.costUsd,
        }),
      })
    })

    return ReviewAgentProvider.of({
      id: providerId,
      isAvailable: sdk.isAvailable.pipe(
        Effect.mapError((error) => mapReviewAgentExecutionError(providerId, error)),
      ),
      runThreadTurn,
    })
  }),
)

const decodeResponse = (
  output: OpenCodeSdkTurnOutput,
): Effect.Effect<ReviewThreadAgentResponse, ReviewAgentInvalidResponseError> => {
  const candidate =
    output.structured === undefined ? parseTextResponse(output.parts) : output.structured
  return Schema.decodeUnknown(ReviewThreadAgentResponse)(
    normalizeReviewThreadAgentResponse(candidate),
  ).pipe(
    Effect.mapError((cause) =>
      ReviewAgentInvalidResponseError.make({
        provider: providerId,
        reason: `OpenCode returned an invalid review response: ${String(cause)}`,
      }),
    ),
  )
}

const parseTextResponse = (parts: readonly OpenCodeSdkPart[]): unknown => {
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
  const json = text.startsWith("```")
    ? text.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")
    : text
  try {
    return JSON.parse(json) as unknown
  } catch {
    return text
  }
}

const toArtifactInput = (
  part: Exclude<OpenCodeSdkPart, { readonly type: "patch" }>,
  output: OpenCodeSdkTurnOutput,
) => {
  const commonMetadata = {
    sessionId: output.sessionId,
    messageId: part.messageId,
    partId: part.id,
    modelId: output.modelId,
    providerId: output.providerId,
  }
  if (part.type === "text") {
    return {
      type: "provider_message" as const,
      provider: providerId,
      title: "OpenCode assistant message",
      content: part.text,
      metadata: commonMetadata,
    }
  }
  return {
    type: artifactTypeForTool(part),
    provider: providerId,
    title: part.title,
    content: part.content,
    metadata: {
      ...commonMetadata,
      tool: part.tool,
      status: part.status,
      providerMetadata: part.metadata,
    },
  }
}

const artifactTypeForTool = (part: OpenCodeSdkToolPart): ReviewAgentArtifactType => {
  const tool = part.tool.toLowerCase()
  if (tool.startsWith("diffdash_")) return "mcp_tool_result"
  if (tool === "read") return "file_read"
  if (tool === "glob" || tool === "grep" || tool === "list") return "search_result"
  if (tool === "bash" || tool === "shell") return "shell_output"
  if (tool === "webfetch" || tool === "websearch") return "web_result"
  return "unknown"
}
