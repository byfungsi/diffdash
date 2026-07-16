import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  type ReviewAgentArtifactType,
  normalizeReviewThreadAgentResponse,
  REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA,
  ReviewAgentProviderRunId,
  type ReviewAgentTurnInput,
  ReviewAgentTurnResult,
  ReviewAgentUsage,
  ReviewThreadAgentResponse,
} from "@diffdash/domain/review-agent"
import { AgentArtifactNormalizer } from "./agent-artifact-normalizer"
import { CliStreamService } from "@diffdash/process/cli-stream"
import type { DiffDashMcpRunAccess } from "./diffdash-mcp-server"
import { resolveReviewAgentPermissionConfig } from "./review-agent-permissions"
import {
  mapReviewAgentExecutionError,
  ReviewAgentExecutionError,
  ReviewAgentInvalidResponseError,
  ReviewAgentPermissionError,
  ReviewAgentProtocolError,
  type ReviewAgentExecutionContext,
  ReviewAgentProvider,
  type ReviewAgentProviderError,
} from "./review-agent-provider"

const providerId = "claude" as const
const MCP_TOKEN_ENV = "DIFFDASH_MCP_BEARER_TOKEN"
const TURN_TIMEOUT_MS = 10 * 60 * 1_000

interface ClaudeReviewTurnInput extends ReviewAgentTurnInput {
  readonly mcp: DiffDashMcpRunAccess
  readonly providerRunId: ReviewAgentProviderRunId | null
}

interface ToolUse {
  readonly id: string
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
}

interface PendingArtifact {
  readonly type: ReviewAgentArtifactType
  readonly title: string
  readonly content: string
  readonly metadata: Readonly<Record<string, unknown>>
}

interface ClaudeTurnState {
  sessionId: string | null
  finalResponse: unknown
  sawResult: boolean
  usage: ReviewAgentUsage | null
  readonly toolUses: Map<string, ToolUse>
  readonly artifacts: PendingArtifact[]
}

/** Layer implementing read-only review turns through Claude stream-json output. */
export const claudeReviewAgentLayer = Layer.effect(
  ReviewAgentProvider,
  Effect.gen(function* () {
    const cli = yield* CliStreamService
    const normalizer = yield* AgentArtifactNormalizer

    const runThreadTurn = Effect.fn("ClaudeReviewAgent.runThreadTurn")(function* (
      input: ReviewAgentTurnInput,
      execution: ReviewAgentExecutionContext,
    ) {
      const enriched: ClaudeReviewTurnInput = { ...input, ...execution }
      const permissionResult = resolveReviewAgentPermissionConfig(enriched.permissions, {
        provider: providerId,
        exactToolAllowlist: true,
        nonInteractivePermissionMode: true,
      })
      if (!permissionResult.enabled) {
        return yield* ReviewAgentPermissionError.make({
          provider: providerId,
          reason: permissionResult.reason,
        })
      }
      const permissionConfig = permissionResult.config
      if (permissionConfig.provider !== providerId) {
        return yield* ReviewAgentPermissionError.make({
          provider: providerId,
          reason: "Claude permission configuration was not produced",
        })
      }

      return yield* withMcpConfigPath(enriched, (mcpConfigPath) =>
        Effect.gen(function* () {
          const state: ClaudeTurnState = {
            sessionId: null,
            finalResponse: null,
            sawResult: false,
            usage: null,
            toolUses: new Map(),
            artifacts: [],
          }
          const args = makeClaudeArgs(permissionConfig.cliArgs, enriched, mcpConfigPath)

          yield* cli
            .stream("claude", args, {
              ...(enriched.cwd === null ? {} : { cwd: enriched.cwd }),
              env: { [MCP_TOKEN_ENV]: Redacted.value(enriched.mcp.bearerToken) },
              stdin: `${enriched.stablePromptPrefix}\n\n${enriched.dynamicPromptSuffix}\n`,
              timeoutMs: TURN_TIMEOUT_MS,
            })
            .pipe(
              Stream.mapError((error) => mapReviewAgentExecutionError(providerId, error)),
              Stream.runForEach((event) => {
                const { _tag: tag } = event
                return tag === "CliLine" && event.source === "stdout"
                  ? consumeClaudeLine(state, event.line)
                  : Effect.void
              }),
            )

          if (!state.sawResult) {
            return yield* ReviewAgentProtocolError.make({
              provider: providerId,
              reason: "Claude stream ended without a result event",
            })
          }
          const response = yield* Schema.decodeUnknown(ReviewThreadAgentResponse)(
            normalizeReviewThreadAgentResponse(state.finalResponse),
          ).pipe(
            Effect.mapError((cause) =>
              ReviewAgentInvalidResponseError.make({
                provider: providerId,
                reason: `Claude returned an invalid review response: ${String(cause)}`,
              }),
            ),
          )
          const artifacts = yield* Effect.forEach(
            state.artifacts,
            (artifact) =>
              normalizer
                .normalize({ ...artifact, provider: providerId })
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
            providerRunId:
              state.sessionId === null ? null : ReviewAgentProviderRunId.make(state.sessionId),
            usage: state.usage,
          })
        }),
      )
    })

    const isAvailable = cli
      .stream("claude", ["--version"], { timeoutMs: 5_000, maxOutputBytes: 8 * 1_024 })
      .pipe(
        Stream.runDrain,
        Effect.as(true),
        Effect.catchAll(() => Effect.succeed(false)),
      )

    return ReviewAgentProvider.of({
      id: providerId,
      sessionMode: "resume",
      isAvailable,
      runThreadTurn,
    })
  }),
)

const makeClaudeArgs = (
  permissionArgs: readonly string[],
  input: ClaudeReviewTurnInput,
  mcpConfigPath: string,
): readonly string[] => [
  ...permissionArgs,
  "--verbose",
  "--output-format",
  "stream-json",
  "--json-schema",
  JSON.stringify(REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA),
  "--mcp-config",
  mcpConfigPath,
  "--model",
  input.model,
  ...(input.providerRunId === null ? [] : ["--resume", input.providerRunId]),
]

const consumeClaudeLine = (
  state: ClaudeTurnState,
  line: string,
): Effect.Effect<void, ReviewAgentProviderError> =>
  Effect.gen(function* () {
    if (line.trim().length === 0) return
    const event = yield* parseJsonLine(line)
    const type = stringAt(event, "type")
    if (type === null) return yield* protocolError("Claude emitted an event without a type")
    const sessionId = stringAt(event, "session_id")
    if (sessionId !== null) state.sessionId = sessionId

    switch (type) {
      case "assistant":
        yield* consumeAssistant(state, event)
        return
      case "user":
      case "tool_result":
        consumeToolResults(state, event)
        return
      case "result": {
        state.sawResult = true
        if (event.is_error === true || stringAt(event, "subtype") === "error") {
          const reason = stringAt(event, "result") ?? "Claude result reported an error"
          return yield* executionError(reason)
        }
        state.finalResponse = parseResult(event.structured_output ?? event.result)
        state.usage = parseClaudeUsage(recordAt(event, "usage"), numberAt(event, "total_cost_usd"))
        return
      }
      case "error":
        return yield* executionError(errorMessage(event) ?? "Claude emitted an error event")
      case "system":
        if (stringAt(event, "subtype") === "error") {
          return yield* executionError(errorMessage(event) ?? "Claude system error")
        }
        return
      default:
        return
    }
  })

const consumeAssistant = (
  state: ClaudeTurnState,
  event: Readonly<Record<string, unknown>>,
): Effect.Effect<void, ReviewAgentProtocolError> =>
  Effect.gen(function* () {
    const message = recordAt(event, "message")
    if (message === null) return yield* protocolError("Claude assistant event omitted message")
    const usage = recordAt(message, "usage")
    if (usage !== null) state.usage = parseClaudeUsage(usage, state.usage?.costUsd ?? null)
    const content = arrayAt(message, "content")
    for (const block of content) {
      if (!isRecord(block)) continue
      const blockType = stringAt(block, "type")
      if (blockType === "text") {
        const text = stringAt(block, "text")
        if (text !== null && text.length > 0) {
          state.artifacts.push({
            type: "provider_message",
            title: "Claude assistant message",
            content: text,
            metadata: metadata({
              messageId: stringAt(message, "id"),
              model: stringAt(message, "model"),
            }),
          })
        }
      } else if (blockType === "tool_use") {
        const id = stringAt(block, "id")
        const name = stringAt(block, "name")
        if (id === null || name === null) {
          return yield* protocolError("Claude tool_use block omitted id or name")
        }
        state.toolUses.set(id, { id, name, input: recordAt(block, "input") ?? {} })
      }
    }
  })

const consumeToolResults = (
  state: ClaudeTurnState,
  event: Readonly<Record<string, unknown>>,
): void => {
  const message = recordAt(event, "message")
  const blocks = message === null ? [event] : arrayAt(message, "content")
  for (const block of blocks) {
    if (!isRecord(block) || stringAt(block, "type") !== "tool_result") continue
    const toolUseId = stringAt(block, "tool_use_id")
    const toolUse = toolUseId === null ? undefined : state.toolUses.get(toolUseId)
    const name = toolUse?.name ?? stringAt(block, "name") ?? "unknown"
    state.artifacts.push({
      type: artifactTypeForClaudeTool(name),
      title: `Claude tool: ${toolTitle(name, toolUse?.input)}`,
      content: claudeToolContent(block.content),
      metadata: metadata({
        toolUseId,
        tool: name,
        isError: typeof block.is_error === "boolean" ? String(block.is_error) : null,
      }),
    })
  }
}

const artifactTypeForClaudeTool = (name: string): ReviewAgentArtifactType => {
  if (name.startsWith("mcp__diffdash__")) return "mcp_tool_result"
  if (name === "Read") return "file_read"
  if (name === "Glob" || name === "Grep") return "search_result"
  if (name === "Bash") return "shell_output"
  if (name === "WebFetch" || name === "WebSearch") return "web_result"
  return "unknown"
}

const toolTitle = (name: string, input: Readonly<Record<string, unknown>> | undefined) => {
  if (input === undefined) return name
  const detail =
    stringAt(input, "file_path") ?? stringAt(input, "path") ?? stringAt(input, "command")
  return detail === null ? name : `${name} ${detail}`
}

const claudeToolContent = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return jsonContent(content)
  const text = content.flatMap((part) => {
    if (!isRecord(part)) return []
    const value = stringAt(part, "text")
    return value === null ? [] : [value]
  })
  return text.length > 0 ? text.join("\n") : jsonContent(content)
}

const parseJsonLine = (
  line: string,
): Effect.Effect<Readonly<Record<string, unknown>>, ReviewAgentProtocolError> =>
  Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) throw new Error("event is not a JSON object")
      return parsed
    },
    catch: (cause) =>
      ReviewAgentProtocolError.make({
        provider: providerId,
        reason: `Claude emitted invalid stream-json: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })

const parseClaudeUsage = (
  usage: Readonly<Record<string, unknown>> | null,
  costUsd: number | null,
): ReviewAgentUsage | null =>
  usage === null
    ? costUsd === null
      ? null
      : ReviewAgentUsage.make({
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costUsd,
        })
    : ReviewAgentUsage.make({
        inputTokens: numberAt(usage, "input_tokens"),
        outputTokens: numberAt(usage, "output_tokens"),
        cacheReadTokens: numberAt(usage, "cache_read_input_tokens"),
        cacheWriteTokens: numberAt(usage, "cache_creation_input_tokens"),
        costUsd,
      })

const withMcpConfigPath = <A, E, R>(
  input: ClaudeReviewTurnInput,
  runWithPath: (path: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ReviewAgentExecutionError, R> =>
  Effect.acquireUseRelease(
    createMcpConfigFile(input.mcp),
    ({ path }) => runWithPath(path),
    ({ directory }) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  )

const createMcpConfigFile = (mcp: DiffDashMcpRunAccess) =>
  Effect.tryPromise({
    try: async () => {
      const directory = await mkdtemp(join(tmpdir(), "diffdash-claude-"))
      const path = join(directory, "mcp.json")
      await writeFile(path, JSON.stringify(makeMcpConfig(mcp)), { mode: 0o600 })
      return { directory, path }
    },
    catch: (cause) => mapReviewAgentExecutionError(providerId, cause),
  })

const makeMcpConfig = (mcp: DiffDashMcpRunAccess) => ({
  mcpServers: {
    diffdash: {
      type: "http",
      url: mcp.url,
      headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` },
    },
  },
})

const executionError = (reason: string) =>
  ReviewAgentExecutionError.make({ provider: providerId, reason, cause: new Error(reason) })

const protocolError = (reason: string) =>
  ReviewAgentProtocolError.make({ provider: providerId, reason })

const parseResult = (value: unknown): unknown => {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  const json = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")
    : trimmed
  try {
    return JSON.parse(json) as unknown
  } catch {
    return value
  }
}

const errorMessage = (event: Readonly<Record<string, unknown>>): string | null => {
  const direct = stringAt(event, "message") ?? stringAt(event, "error")
  if (direct !== null) return direct
  const error = recordAt(event, "error")
  return error === null ? null : stringAt(error, "message")
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringAt = (record: Readonly<Record<string, unknown>>, key: string) =>
  typeof record[key] === "string" ? record[key] : null

const numberAt = (record: Readonly<Record<string, unknown>>, key: string) =>
  typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : null

const recordAt = (record: Readonly<Record<string, unknown>>, key: string) => {
  const value = record[key]
  return isRecord(value) ? value : null
}

const arrayAt = (record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] => {
  const value = record[key]
  return Array.isArray(value) ? value : []
}

const metadata = (values: Readonly<Record<string, string | number | null>>) =>
  Object.fromEntries(Object.entries(values).filter((entry) => entry[1] !== null))

const jsonContent = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))
