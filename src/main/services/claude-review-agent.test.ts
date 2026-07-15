import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Stream } from "effect"
import { readFileSync } from "node:fs"

import {
  ReviewAgentProviderRunId,
  ReviewAgentTurnInput,
  THREAD_MODE_REVIEW_AGENT_PERMISSIONS,
} from "../../shared/review-agent"
import { ReviewKey, ReviewRevision } from "../../shared/review-identity"
import { ReviewLevelAnchor, ReviewThreadId } from "../../shared/review-thread"
import { AgentArtifactNormalizer } from "./agent-artifact-normalizer"
import { claudeReviewAgentLayer } from "./claude-review-agent"
import { CliStreamService, type CliStreamEvent, type CliStreamOptions } from "./cli-stream"
import {
  ReviewAgentExecutionError,
  ReviewAgentInvalidResponseError,
  ReviewAgentProvider,
  ReviewAgentProtocolError,
} from "./review-agent-provider"

const baseInput = ReviewAgentTurnInput.make({
  threadId: ReviewThreadId.make("thread-78"),
  reviewKey: ReviewKey.make("github:fungsi/diffdash#78"),
  baseRevision: ReviewRevision.make("base-sanitized"),
  headRevision: ReviewRevision.make("head-sanitized"),
  anchor: ReviewLevelAnchor.make({}),
  stablePromptPrefix: "Return the DiffDash review response JSON object.",
  dynamicPromptSuffix: "Review the current hunk.",
  cwd: "/workspace/project",
  model: "claude-sonnet-sanitized",
  permissions: THREAD_MODE_REVIEW_AGENT_PERMISSIONS,
})

const mcp = {
  url: "http://127.0.0.1:9000/mcp",
  bearerToken: Redacted.make("sanitized-secret-token"),
}
const execution = (providerRunId: ReviewAgentProviderRunId | null = null) => ({
  mcp,
  providerRunId,
})

interface CliCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: CliStreamOptions | undefined
}

const fixture = (name: string): readonly CliStreamEvent[] => {
  const lines = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
  return [
    ...lines.map((line): CliStreamEvent => ({ _tag: "CliLine", source: "stdout", line })),
    {
      _tag: "CliExit",
      result: {
        command: "claude",
        args: [],
        cwd: "/workspace/project",
        stdout: lines.join("\n"),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        outputTruncated: false,
        exitCode: 0,
        signal: null,
      },
    },
  ]
}

const makeTestLayer = (options: {
  readonly fixture: string
  readonly calls?: CliCall[]
  readonly providerRunId?: ReviewAgentProviderRunId | null
  readonly captureMcpConfig?: (content: string) => void
}) => {
  const cliLayer = Layer.succeed(
    CliStreamService,
    CliStreamService.of({
      stream: (command, args, runOptions) => {
        options.calls?.push({ command, args, options: runOptions })
        const configIndex = args.indexOf("--mcp-config")
        const configPath = configIndex < 0 ? undefined : args[configIndex + 1]
        if (configPath !== undefined) {
          options.captureMcpConfig?.(readFileSync(configPath, "utf8"))
        }
        return Stream.fromIterable(fixture(options.fixture))
      },
    }),
  )
  return claudeReviewAgentLayer.pipe(
    Layer.provide(Layer.mergeAll(cliLayer, AgentArtifactNormalizer.layer)),
  )
}

describe("Claude review agent", () => {
  it.effect("FUN-78 AC: streams a strict noninteractive Claude turn with scoped MCP", () => {
    const calls: CliCall[] = []
    let mcpConfig = ""
    const priorRunId = ReviewAgentProviderRunId.make("claude-prior-sanitized")
    return Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      const result = yield* provider.runThreadTurn(baseInput, execution(priorRunId))

      expect(provider.id).toBe("claude")
      expect(result.providerRunId).toBe("claude-session-sanitized-78")
      expect(result.response.bodyMarkdown).toContain("preserves the expected behavior")
      expect(result.response.threadSummaryUpdate).toBeUndefined()
      expect(result.response.referencedAnchors).toBeUndefined()
      expect(result.usage).toMatchObject({
        inputTokens: 220,
        outputTokens: 35,
        cacheReadTokens: 120,
        cacheWriteTokens: 20,
        costUsd: 0.0042,
      })

      const call = calls.find(({ args }) => args.includes("--print"))
      expect(call?.command).toBe("claude")
      expect(call?.args).toContain("--print")
      expect(call?.args).toContain("--verbose")
      expect(call?.args).toContain("stream-json")
      expect(call?.args).toContain("--strict-mcp-config")
      expect(call?.args).toContain("dontAsk")
      expect(call?.args).toContain("--disallowedTools")
      expect(call?.args).toContain("--resume")
      expect(call?.args).toContain(priorRunId)
      expect(JSON.stringify(call?.args)).not.toContain("sanitized-secret-token")
      expect(call?.options?.env).toEqual({
        DIFFDASH_MCP_BEARER_TOKEN: "sanitized-secret-token",
      })
      expect(mcpConfig).toContain('"type":"http"')
      expect(mcpConfig).toContain("Bearer ${DIFFDASH_MCP_BEARER_TOKEN}")
      expect(mcpConfig).not.toContain("sanitized-secret-token")
    }).pipe(
      Effect.provide(
        makeTestLayer({
          fixture: "claude-review-success.jsonl",
          calls,
          captureMcpConfig: (content) => {
            mcpConfig = content
          },
        }),
      ),
    )
  })

  it.effect("FUN-78 AC: normalizes Read and DiffDash MCP tool results", () =>
    Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      const result = yield* provider.runThreadTurn(baseInput, execution())

      expect(result.artifacts.map((artifact) => artifact.type)).toEqual([
        "file_read",
        "mcp_tool_result",
        "provider_message",
      ])
      expect(result.artifacts[0]).toMatchObject({
        content: "export const value = 1",
        metadata: { sourceProvider: "claude", tool: "Read" },
      })
      expect(result.artifacts[1]?.content).toContain('"status":"available"')
      expect(JSON.stringify(result.artifacts)).not.toContain("sanitized-secret-token")
    }).pipe(Effect.provide(makeTestLayer({ fixture: "claude-review-success.jsonl" }))),
  )

  it.effect("FUN-78 AC: rejects a result that violates the response schema", () =>
    Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      const error = yield* provider.runThreadTurn(baseInput, execution()).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ReviewAgentInvalidResponseError)
      expect(error.reason).toContain("invalid review response")
    }).pipe(Effect.provide(makeTestLayer({ fixture: "claude-review-invalid-response.jsonl" }))),
  )

  it.effect("FUN-78 AC: maps provider error events to a provider execution failure", () =>
    Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      const error = yield* provider.runThreadTurn(baseInput, execution()).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ReviewAgentExecutionError)
      expect(error.reason).toContain("authentication failed")
    }).pipe(Effect.provide(makeTestLayer({ fixture: "claude-review-error.jsonl" }))),
  )

  it.effect("rejects malformed JSONL as a protocol failure", () =>
    Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      const error = yield* provider.runThreadTurn(baseInput, execution()).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ReviewAgentProtocolError)
      expect(error.reason).toContain("Claude emitted invalid stream-json")
    }).pipe(Effect.provide(makeTestLayer({ fixture: "claude-review-malformed.jsonl" }))),
  )
})
