import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Stream } from "effect"
import { readFileSync } from "node:fs"

import {
  REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA,
  ReviewAgentProviderRunId,
  ReviewAgentTurnInput,
  THREAD_MODE_REVIEW_AGENT_PERMISSIONS,
} from "@diffdash/domain/review-agent"
import { ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import { ReviewLevelAnchor, ReviewThreadId } from "@diffdash/domain/review-thread"
import { AgentArtifactNormalizer } from "./agent-artifact-normalizer"
import { CliStreamService, type CliStreamEvent, type CliStreamOptions } from "./cli-stream"
import { codexReviewAgentLayer } from "./codex-review-agent"
import {
  ReviewAgentExecutionError,
  ReviewAgentInvalidResponseError,
  ReviewAgentPermissionError,
  ReviewAgentProvider,
  ReviewAgentProtocolError,
} from "./review-agent-provider"

const baseInput = ReviewAgentTurnInput.make({
  threadId: ReviewThreadId.make("thread-74"),
  reviewKey: ReviewKey.make("github:fungsi/diffdash#74"),
  baseRevision: ReviewRevision.make("base-sanitized"),
  headRevision: ReviewRevision.make("head-sanitized"),
  anchor: ReviewLevelAnchor.make({}),
  stablePromptPrefix: "Return the DiffDash review response JSON object.",
  dynamicPromptSuffix: "Review the current hunk.",
  cwd: "/workspace/project",
  model: "gpt-5-codex-sanitized",
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
        command: "codex",
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
  readonly captureOutputSchema?: (content: string) => void
}) => {
  const cliLayer = Layer.succeed(
    CliStreamService,
    CliStreamService.of({
      stream: (command, args, runOptions) => {
        options.calls?.push({ command, args, options: runOptions })
        const schemaIndex = args.indexOf("--output-schema")
        const schemaPath = schemaIndex < 0 ? undefined : args[schemaIndex + 1]
        if (schemaPath !== undefined) {
          options.captureOutputSchema?.(readFileSync(schemaPath, "utf8"))
        }
        return Stream.fromIterable(fixture(options.fixture))
      },
    }),
  )
  return codexReviewAgentLayer.pipe(
    Layer.provide(Layer.mergeAll(cliLayer, AgentArtifactNormalizer.layer)),
  )
}

describe("Codex review agent", () => {
  it.effect("FUN-74 AC: streams a structured read-only ephemeral Codex turn", () => {
    const calls: CliCall[] = []
    let outputSchema = ""
    return Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      const result = yield* provider.runThreadTurn(baseInput, execution())

      expect(provider.id).toBe("codex")
      expect(result.providerRunId).toBe("codex-thread-sanitized-74")
      expect(result.response.bodyMarkdown).toBe("The changed hunk is correct.")
      expect(result.response.threadSummaryUpdate).toBeUndefined()
      expect(result.response.referencedAnchors).toBeUndefined()
      expect(result.usage).toMatchObject({
        inputTokens: 240,
        outputTokens: 42,
        cacheReadTokens: 120,
        costUsd: null,
      })
      expect(JSON.parse(outputSchema)).toEqual(REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA)

      const call = calls.find(({ args }) => args.includes("exec"))
      expect(call?.command).toBe("codex")
      expect(call?.args).toContain("exec")
      expect(call?.args).toContain("--json")
      expect(call?.args).toContain("--ephemeral")
      expect(call?.args).toContain("read-only")
      expect(call?.args).toContain("--output-schema")
      expect(call?.args).toContain('mcp_servers.diffdash.url="http://127.0.0.1:9000/mcp"')
      expect(call?.args).toContain(
        'mcp_servers.diffdash.bearer_token_env_var="DIFFDASH_MCP_BEARER_TOKEN"',
      )
      expect(call?.args).not.toContain("mcp_servers.diffdash.required=true")
      expect(JSON.stringify(call?.args)).not.toContain("sanitized-secret-token")
      expect(call?.options?.env).toEqual({
        DIFFDASH_MCP_BEARER_TOKEN: "sanitized-secret-token",
      })
      expect(call?.options?.stdin).toContain("Review the current hunk.")
    }).pipe(
      Effect.provide(
        makeTestLayer({
          fixture: "codex-review-success.jsonl",
          calls,
          captureOutputSchema: (content) => {
            outputSchema = content
          },
        }),
      ),
    )
  })

  it.effect("FUN-74 AC: normalizes command, MCP, and final message events", () =>
    Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      const result = yield* provider.runThreadTurn(baseInput, execution())

      expect(result.artifacts.map((artifact) => artifact.type)).toEqual([
        "shell_output",
        "mcp_tool_result",
        "provider_message",
      ])
      expect(result.artifacts[0]).toMatchObject({
        content: "@@ -1 +1 @@\n-old\n+new",
        metadata: { sourceProvider: "codex", exitCode: 0 },
      })
      expect(JSON.stringify(result.artifacts)).not.toContain("sanitized-secret-token")
    }).pipe(Effect.provide(makeTestLayer({ fixture: "codex-review-success.jsonl" }))),
  )

  it.effect("FUN-74 AC: rejects a final message that violates the response schema", () =>
    Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      const error = yield* provider.runThreadTurn(baseInput, execution()).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ReviewAgentInvalidResponseError)
      expect(error.reason).toContain("invalid review response")
    }).pipe(Effect.provide(makeTestLayer({ fixture: "codex-review-invalid-response.jsonl" }))),
  )

  it.effect("FUN-74 AC: maps provider error events to a provider execution failure", () =>
    Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      const error = yield* provider.runThreadTurn(baseInput, execution()).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ReviewAgentExecutionError)
      expect(error.reason).toContain("model request failed")
    }).pipe(Effect.provide(makeTestLayer({ fixture: "codex-review-error.jsonl" }))),
  )

  it.effect("rejects malformed JSONL as a protocol failure", () =>
    Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      const error = yield* provider.runThreadTurn(baseInput, execution()).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ReviewAgentProtocolError)
      expect(error.reason).toContain("Codex emitted invalid JSONL")
    }).pipe(Effect.provide(makeTestLayer({ fixture: "codex-review-malformed.jsonl" }))),
  )

  it.effect("fails closed when Codex emits a file change", () =>
    Effect.gen(function* () {
      const provider = yield* ReviewAgentProvider
      const error = yield* provider.runThreadTurn(baseInput, execution()).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ReviewAgentPermissionError)
      expect(error.reason).toContain("attempted a file change")
    }).pipe(Effect.provide(makeTestLayer({ fixture: "codex-review-file-change.jsonl" }))),
  )
})
