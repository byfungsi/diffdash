import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"

import {
  ReviewAgentProviderRunId,
  ReviewAgentTurnInput,
  THREAD_MODE_REVIEW_AGENT_PERMISSIONS,
} from "../../shared/review-agent"
import { ReviewKey, ReviewRevision } from "../../shared/review-identity"
import { ReviewLevelAnchor, ReviewThreadId } from "../../shared/review-thread"
import { AgentArtifactNormalizer } from "./agent-artifact-normalizer"
import { openCodeReviewAgentLayer } from "./opencode-review-agent"
import {
  OpenCodeSdkClient,
  type OpenCodeSdkTurnInput,
  type OpenCodeSdkTurnOutput,
} from "./opencode-sdk-client"
import { ReviewAgentInvalidResponseError, ReviewAgentProvider } from "./review-agent-provider"

const baseInput = ReviewAgentTurnInput.make({
  threadId: ReviewThreadId.make("thread-73"),
  reviewKey: ReviewKey.make("github:fungsi/diffdash#73"),
  baseRevision: ReviewRevision.make("base-sha"),
  headRevision: ReviewRevision.make("head-sha"),
  anchor: ReviewLevelAnchor.make({}),
  stablePromptPrefix: "Stable review instructions and response schema",
  dynamicPromptSuffix: "Latest user message",
  cwd: "/repo",
  model: "anthropic/claude-sonnet-4-5",
  permissions: THREAD_MODE_REVIEW_AGENT_PERMISSIONS,
})

const mcp = {
  url: "http://127.0.0.1:9000/mcp",
  bearerToken: Redacted.make("secret-run-token"),
}
const execution = (providerRunId: ReviewAgentProviderRunId | null = null) => ({
  mcp,
  providerRunId,
})

const successfulOutput = (
  overrides: Partial<OpenCodeSdkTurnOutput> = {},
): OpenCodeSdkTurnOutput => ({
  sessionId: "opencode-session-73",
  messageId: "assistant-message-1",
  modelId: "claude-sonnet-4-5",
  providerId: "anthropic",
  structured: {
    bodyMarkdown: "The hunk is correct.",
    threadSummaryUpdate: null,
    referencedAnchors: null,
  },
  parts: [],
  usage: {
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 80,
    cacheWriteTokens: 10,
    costUsd: 0.004,
  },
  ...overrides,
})

const makeTestLayer = (options: {
  readonly output?: OpenCodeSdkTurnOutput
  readonly available?: boolean
  readonly providerRunId?: ReviewAgentProviderRunId | null
  readonly calls?: OpenCodeSdkTurnInput[]
}) => {
  const calls = options.calls ?? []
  const sdkLayer = Layer.succeed(
    OpenCodeSdkClient,
    OpenCodeSdkClient.of({
      isAvailable: Effect.succeed(options.available ?? true),
      runTurn: (input) =>
        Effect.sync(() => {
          calls.push(input)
          return options.output ?? successfulOutput()
        }),
    }),
  )
  return openCodeReviewAgentLayer.pipe(
    Layer.provide(Layer.mergeAll(sdkLayer, AgentArtifactNormalizer.layer)),
  )
}

describe("OpenCode review agent", () => {
  it.effect("FUN-73 AC: reports availability through the fake SDK boundary", () =>
    Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      expect(provider.id).toBe("opencode")
      expect(yield* provider.isAvailable).toBe(false)
    }).pipe(Effect.provide(makeTestLayer({ available: false }))),
  )

  it.effect("FUN-73 AC: constructs a read-only structured turn and reuses a session", () => {
    const calls: OpenCodeSdkTurnInput[] = []
    const priorSession = ReviewAgentProviderRunId.make("prior-opencode-session")
    return Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      const result = yield* provider.runThreadTurn(baseInput, execution(priorSession))

      expect(result.providerRunId).toBe("opencode-session-73")
      expect(result.response.bodyMarkdown).toBe("The hunk is correct.")
      expect(result.response.threadSummaryUpdate).toBeUndefined()
      expect(result.response.referencedAnchors).toBeUndefined()
      expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 30, costUsd: 0.004 })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        cwd: "/repo",
        model: "anthropic/claude-sonnet-4-5",
        stablePromptPrefix: "Stable review instructions and response schema",
        dynamicPromptSuffix: "Latest user message",
        threadId: "thread-73",
        providerRunId: priorSession,
        mcp: { url: "http://127.0.0.1:9000/mcp" },
      })
      expect(calls[0]?.permissionConfig.permission).toMatchObject({
        "*": "deny",
        edit: "deny",
        bash: "deny",
        "diffdash_*": "allow",
      })
    }).pipe(Effect.provide(makeTestLayer({ calls })))
  })

  it.effect("FUN-73 AC: validates structured output against ReviewThreadAgentResponse", () =>
    Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      const error = yield* provider.runThreadTurn(baseInput, execution()).pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReviewAgentInvalidResponseError)
      expect(error.reason).toContain("invalid review response")
    }).pipe(
      Effect.provide(
        makeTestLayer({
          output: successfulOutput({ structured: { bodyMarkdown: "" } }),
        }),
      ),
    ),
  )

  it.effect("FUN-73 AC: normalizes OpenCode message, file, and MCP tool parts", () =>
    Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      const result = yield* provider.runThreadTurn(baseInput, execution())

      expect(result.artifacts.map((artifact) => artifact.type)).toEqual([
        "provider_message",
        "file_read",
        "mcp_tool_result",
      ])
      expect(result.artifacts[1]).toMatchObject({
        title: "Read src/main.ts",
        content: "const main = true",
        metadata: {
          sourceProvider: "opencode",
          sessionId: "opencode-session-73",
          messageId: "assistant-message-1",
          partId: "tool-read-1",
          tool: "read",
          status: "completed",
        },
      })
      expect(JSON.stringify(result.artifacts)).not.toContain("secret-run-token")
    }).pipe(
      Effect.provide(
        makeTestLayer({
          output: successfulOutput({
            parts: [
              {
                type: "text",
                id: "text-1",
                messageId: "assistant-message-1",
                text: '{"bodyMarkdown":"The hunk is correct."}',
              },
              {
                type: "tool",
                id: "tool-read-1",
                messageId: "assistant-message-1",
                tool: "read",
                status: "completed",
                title: "Read src/main.ts",
                content: "const main = true",
                metadata: { path: "src/main.ts" },
              },
              {
                type: "tool",
                id: "tool-mcp-1",
                messageId: "assistant-message-1",
                tool: "diffdash_getDiffHunk",
                status: "completed",
                title: "Get diff hunk",
                content: "@@ -1 +1 @@",
                metadata: {},
              },
            ],
          }),
        }),
      ),
    ),
  )

  it.effect("FUN-73 AC: parses JSON message parts when structured output is absent", () =>
    Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      const result = yield* provider.runThreadTurn(baseInput, execution())
      expect(result.response.bodyMarkdown).toBe("Fallback response")
    }).pipe(
      Effect.provide(
        makeTestLayer({
          output: successfulOutput({
            structured: undefined,
            parts: [
              {
                type: "text",
                id: "text-fallback",
                messageId: "assistant-message-1",
                text: '```json\n{"bodyMarkdown":"Fallback response"}\n```',
              },
            ],
          }),
        }),
      ),
    ),
  )
})
