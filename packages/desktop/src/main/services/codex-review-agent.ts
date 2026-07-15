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
} from "../../shared/review-agent"
import { AgentArtifactNormalizer } from "./agent-artifact-normalizer"
import { CliStreamService } from "./cli-stream"
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

const providerId = "codex" as const
const MCP_TOKEN_ENV = "DIFFDASH_MCP_BEARER_TOKEN"
const TURN_TIMEOUT_MS = 10 * 60 * 1_000

interface CodexReviewTurnInput extends ReviewAgentTurnInput {
  readonly mcp: DiffDashMcpRunAccess
  readonly providerRunId: ReviewAgentProviderRunId | null
}

interface PendingArtifact {
  readonly type: ReviewAgentArtifactType
  readonly title: string
  readonly content: string
  readonly metadata: Readonly<Record<string, unknown>>
}

interface CodexTurnState {
  threadId: string | null
  turnStarted: boolean
  turnCompleted: boolean
  finalMessage: string | null
  usage: ReviewAgentUsage | null
  readonly artifacts: PendingArtifact[]
}

/** Layer implementing read-only review turns through `codex exec --json`. */
export const codexReviewAgentLayer = Layer.effect(
  ReviewAgentProvider,
  Effect.gen(function* () {
    const cli = yield* CliStreamService
    const normalizer = yield* AgentArtifactNormalizer

    const runThreadTurn = Effect.fn("CodexReviewAgent.runThreadTurn")(function* (
      input: ReviewAgentTurnInput,
      execution: ReviewAgentExecutionContext,
    ) {
      const enriched: CodexReviewTurnInput = { ...input, ...execution }
      const permissionResult = resolveReviewAgentPermissionConfig(enriched.permissions, {
        provider: providerId,
        readOnlySandbox: true,
        nonInteractiveApprovalPolicy: true,
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
          reason: "Codex permission configuration was not produced",
        })
      }

      return yield* withOutputSchemaPath(null, (outputSchemaPath) =>
        Effect.gen(function* () {
          const state: CodexTurnState = {
            threadId: null,
            turnStarted: false,
            turnCompleted: false,
            finalMessage: null,
            usage: null,
            artifacts: [],
          }
          const args = makeCodexArgs(permissionConfig.cliArgs, enriched, outputSchemaPath)

          yield* cli
            .stream("codex", args, {
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
                  ? consumeCodexLine(state, event.line)
                  : Effect.void
              }),
            )

          if (!state.turnStarted || !state.turnCompleted) {
            return yield* ReviewAgentProtocolError.make({
              provider: providerId,
              reason: "Codex stream ended without a complete turn lifecycle",
            })
          }

          const response = yield* decodeResponse(state.finalMessage)
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
              state.threadId === null ? null : ReviewAgentProviderRunId.make(state.threadId),
            usage: state.usage,
          })
        }),
      )
    })

    const isAvailable = cli
      .stream("codex", ["--version"], { timeoutMs: 5_000, maxOutputBytes: 8 * 1_024 })
      .pipe(
        Stream.runDrain,
        Effect.as(true),
        Effect.catchAll(() => Effect.succeed(false)),
      )

    return ReviewAgentProvider.of({ id: providerId, isAvailable, runThreadTurn })
  }),
)

const makeCodexArgs = (
  permissionArgs: readonly string[],
  input: CodexReviewTurnInput,
  outputSchemaPath: string,
): readonly string[] => {
  const execIndex = permissionArgs.indexOf("exec")
  if (execIndex < 0) return permissionArgs
  const mcpOverrides = [
    "-c",
    `mcp_servers.diffdash.url=${JSON.stringify(input.mcp.url)}`,
    "-c",
    `mcp_servers.diffdash.bearer_token_env_var=${JSON.stringify(MCP_TOKEN_ENV)}`,
    "-c",
    "mcp_servers.diffdash.default_tools_approval_mode=auto",
  ]
  return [
    ...permissionArgs.slice(0, execIndex),
    ...mcpOverrides,
    ...permissionArgs.slice(execIndex),
    "--model",
    input.model,
    "--output-schema",
    outputSchemaPath,
    "-",
  ]
}

const consumeCodexLine = (
  state: CodexTurnState,
  line: string,
): Effect.Effect<void, ReviewAgentProviderError> =>
  Effect.gen(function* () {
    if (line.trim().length === 0) return
    const event = yield* parseJsonLine(line)
    const type = stringAt(event, "type")
    if (type === null) {
      return yield* protocolError("Codex emitted an event without a type")
    }

    switch (type) {
      case "thread.started": {
        const threadId = stringAt(event, "thread_id")
        if (threadId === null || threadId.length === 0) {
          return yield* protocolError("Codex thread.started event omitted thread_id")
        }
        state.threadId = threadId
        return
      }
      case "turn.started":
        state.turnStarted = true
        return
      case "turn.completed":
        state.turnCompleted = true
        state.usage = parseCodexUsage(recordAt(event, "usage"))
        return
      case "turn.failed":
      case "error": {
        const reason = errorMessage(event) ?? `Codex emitted ${type}`
        return yield* ReviewAgentExecutionError.make({
          provider: providerId,
          reason,
          cause: new Error(reason),
        })
      }
      case "item.completed": {
        const item = recordAt(event, "item")
        if (item === null) return yield* protocolError("Codex item.completed omitted item")
        yield* consumeCompletedItem(state, item)
        return
      }
      case "item.started": {
        const item = recordAt(event, "item")
        if (item !== null && stringAt(item, "type") === "file_change") {
          return yield* ReviewAgentPermissionError.make({
            provider: providerId,
            reason: "Codex attempted a file change despite the read-only sandbox",
          })
        }
        return
      }
      default:
        return
    }
  })

const consumeCompletedItem = (
  state: CodexTurnState,
  item: Readonly<Record<string, unknown>>,
): Effect.Effect<void, ReviewAgentProviderError> =>
  Effect.gen(function* () {
    const itemType = stringAt(item, "type")
    const itemId = stringAt(item, "id")
    switch (itemType) {
      case "agent_message": {
        const text = stringAt(item, "text")
        if (text === null) return yield* protocolError("Codex agent message omitted text")
        state.finalMessage = text
        state.artifacts.push({
          type: "provider_message",
          title: "Codex assistant message",
          content: text,
          metadata: metadata({ itemId, status: stringAt(item, "status") }),
        })
        return
      }
      case "command_execution": {
        const command = stringAt(item, "command") ?? "command"
        const content = stringAt(item, "aggregated_output") ?? stringAt(item, "output") ?? ""
        state.artifacts.push({
          type: "shell_output",
          title: `Codex command: ${command}`,
          content,
          metadata: metadata({
            itemId,
            command,
            status: stringAt(item, "status"),
            exitCode: numberAt(item, "exit_code"),
          }),
        })
        return
      }
      case "mcp_tool_call": {
        const server = stringAt(item, "server") ?? "unknown"
        const tool = stringAt(item, "tool") ?? "unknown"
        const result = item.result ?? item.output ?? item.error ?? null
        state.artifacts.push({
          type: server === "diffdash" ? "mcp_tool_result" : "unknown",
          title: `Codex MCP: ${server}/${tool}`,
          content: jsonContent(result),
          metadata: metadata({
            itemId,
            server,
            tool,
            status: stringAt(item, "status"),
          }),
        })
        return
      }
      case "file_change":
        return yield* ReviewAgentPermissionError.make({
          provider: providerId,
          reason: "Codex emitted a file change despite the read-only sandbox",
        })
      default:
        return
    }
  })

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
        reason: `Codex emitted invalid JSONL: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })

const decodeResponse = (
  finalMessage: string | null,
): Effect.Effect<ReviewThreadAgentResponse, ReviewAgentInvalidResponseError> => {
  const candidate = normalizeReviewThreadAgentResponse(
    finalMessage === null ? null : parseJsonText(finalMessage),
  )
  return Schema.decodeUnknown(ReviewThreadAgentResponse)(candidate).pipe(
    Effect.mapError((cause) =>
      ReviewAgentInvalidResponseError.make({
        provider: providerId,
        reason: `Codex returned an invalid review response: ${String(cause)}`,
      }),
    ),
  )
}

const parseCodexUsage = (
  usage: Readonly<Record<string, unknown>> | null,
): ReviewAgentUsage | null =>
  usage === null
    ? null
    : ReviewAgentUsage.make({
        inputTokens: numberAt(usage, "input_tokens"),
        outputTokens: numberAt(usage, "output_tokens"),
        cacheReadTokens: numberAt(usage, "cached_input_tokens"),
        cacheWriteTokens: null,
        costUsd: null,
      })

const withOutputSchemaPath = <A, E, R>(
  suppliedPath: string | null,
  runWithPath: (path: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ReviewAgentExecutionError, R> =>
  suppliedPath === null
    ? Effect.acquireUseRelease(
        createOutputSchemaFile,
        ({ path }) => runWithPath(path),
        ({ directory }) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
      )
    : runWithPath(suppliedPath)

const createOutputSchemaFile = Effect.tryPromise({
  try: async () => {
    const directory = await mkdtemp(join(tmpdir(), "diffdash-codex-"))
    const path = join(directory, "review-thread-response.schema.json")
    await writeFile(path, JSON.stringify(REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA), { mode: 0o600 })
    return { directory, path }
  },
  catch: (cause) => mapReviewAgentExecutionError(providerId, cause),
})

const protocolError = (reason: string) =>
  ReviewAgentProtocolError.make({ provider: providerId, reason })

const errorMessage = (event: Readonly<Record<string, unknown>>): string | null => {
  const direct = stringAt(event, "message")
  if (direct !== null) return direct
  const error = recordAt(event, "error")
  return error === null ? null : stringAt(error, "message")
}

const parseJsonText = (text: string): unknown => {
  const trimmed = text.trim()
  const json = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")
    : trimmed
  try {
    return JSON.parse(json) as unknown
  } catch {
    return text
  }
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

const metadata = (values: Readonly<Record<string, string | number | null>>) =>
  Object.fromEntries(Object.entries(values).filter((entry) => entry[1] !== null))

const jsonContent = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))
