import { Effect, Match, Option, Schema, Stream } from "effect"

import {
  AgentArtifactCandidate,
  AgentCapabilityDeclaration,
  AgentCapabilityManifest,
  AgentExecutionPolicy,
  AgentModelDescriptor,
  AgentModelId,
  AgentProviderDefaults,
  AgentProviderDescriptor,
  AgentProviderId,
  AgentProviderManifest,
  AgentProviderOperationError,
  AgentRuntimeRequirement,
  AgentSessionId,
  AgentSessionSupport,
  AgentUsage,
  InvalidAgentProviderResponseError,
  isAgentExecutionPolicyEnforced,
  McpToolName,
  type AgentCapability,
  type AgentProviderRegistration,
  type ReviewThreadRequest,
  ReviewThreadResult,
  type WalkthroughRequest,
  WalkthroughResult,
  WebUrl,
  revealScopedMcpToken,
} from "@diffdash/agent-provider"
import {
  REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA as reviewResponseJsonSchema,
  ReviewThreadAgentResponse,
  ReviewThreadAgentResponseFromProvider,
} from "@diffdash/domain/review-agent"
import {
  parseProviderJsonText as parseResult,
  providerJsonContent as jsonContent,
} from "@diffdash/agent-provider/provider-json"
import { makeNonMutatingAgentExecutionPolicy } from "@diffdash/agent-provider/policy"
import {
  boundedProviderDiagnostic,
  type AgentProviderFailureCategory,
  classifyProviderFailureText,
  makeAgentProviderOperationErrorFactory,
  probeAgentRuntime,
  projectAgentCapabilityProbe,
} from "@diffdash/agent-provider/runtime"
import { isScopedMcpToolSubset } from "@diffdash/agent-provider/security"
import { processRequest, type ProcessRunner } from "@diffdash/process"
import type { TempResourceOperations } from "@diffdash/process/temp-resource"

const providerId = AgentProviderId.make("claude")
const executable = "claude"
const mcpTokenEnvironmentVariable = "DIFFDASH_MCP_BEARER_TOKEN"
const operationErrors = makeAgentProviderOperationErrorFactory({
  providerId,
  fallbackReason: "Claude execution failed",
})
const builtInTools = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"] as const
const sensitiveReadRules = [
  "Read(./.env)",
  "Read(./.env.*)",
  "Read(**/.env)",
  "Read(**/.env.*)",
  "Read(**/credentials*)",
  "Read(**/.aws/**)",
  "Read(**/.ssh/**)",
] as const
const mutationRules = ["Edit", "Write", "NotebookEdit", "Bash"] as const

/** Claude model selected for new installations. */
export const CLAUDE_DEFAULT_MODEL = AgentModelId.make("claude-sonnet-5")

/** Claude models and quality metadata owned by this provider. */
export const CLAUDE_MODELS = [
  modelDescriptor("claude-opus-5", "Opus 5", "best"),
  modelDescriptor("claude-sonnet-5", "Sonnet 5", "balanced"),
  modelDescriptor("claude-haiku-4-5", "Haiku 4.5", "fast"),
] as const

/** Static Claude provider contribution. */
export const CLAUDE_MANIFEST = AgentProviderManifest.make({
  descriptor: AgentProviderDescriptor.make({
    id: providerId,
    displayName: "Claude",
    description: "Local Anthropic Claude Code CLI integration.",
    homepage: WebUrl.make("https://docs.anthropic.com/en/docs/claude-code"),
  }),
  models: [...CLAUDE_MODELS],
  defaults: AgentProviderDefaults.make({
    walkthroughModel: CLAUDE_DEFAULT_MODEL,
    reviewThreadModel: CLAUDE_DEFAULT_MODEL,
  }),
  requirements: [
    AgentRuntimeRequirement.make({
      name: executable,
      versionRange: null,
      installHint: "Install Claude Code and authenticate it before using DiffDash.",
    }),
  ],
  capabilities: AgentCapabilityManifest.make({
    walkthrough: AgentCapabilityDeclaration.make({ supported: true, autoPriority: 10 }),
    reviewThread: AgentCapabilityDeclaration.make({ supported: true, autoPriority: 10 }),
  }),
  session: AgentSessionSupport.make({ mode: "resume" }),
})

/** Explicit non-mutating policy accepted by Claude walkthrough execution. */
export const CLAUDE_WALKTHROUGH_POLICY = makeNonMutatingAgentExecutionPolicy({
  network: "allow",
  repository: "local-working-copy",
  shell: "deny",
})

/** Explicit non-mutating policy accepted by Claude review execution. */
export const CLAUDE_REVIEW_POLICY = makeNonMutatingAgentExecutionPolicy({
  network: "allow",
  repository: "reviewed-revision",
  shell: "deny",
})

/** Provider-native permission controls used for fail-closed Claude execution. */
export interface ClaudePermissionControls {
  readonly exactToolAllowlist: boolean
  readonly networkToolAllowlist: boolean
  readonly nonInteractivePermissionMode: boolean
  readonly sensitiveReadDenylist: boolean
  readonly shellToolDenylist: boolean
  readonly strictMcpConfiguration: boolean
}

const defaultPermissionControls: ClaudePermissionControls = {
  exactToolAllowlist: true,
  networkToolAllowlist: true,
  nonInteractivePermissionMode: true,
  sensitiveReadDenylist: true,
  shellToolDenylist: true,
  strictMcpConfiguration: true,
}

/** Host dependencies required to construct the Claude leaf provider. */
export interface ClaudeProviderDependencies {
  readonly processes: ProcessRunner
  readonly tempResources: TempResourceOperations
  readonly tempDirectory?: string
  readonly permissionControls?: ClaudePermissionControls
}

/** Creates the complete Claude SDK registration. */
export const makeClaudeProvider = (
  dependencies: ClaudeProviderDependencies,
): AgentProviderRegistration => {
  const runtimeProbe = probeClaudeRuntime(dependencies.processes)
  const controls = dependencies.permissionControls ?? defaultPermissionControls
  return {
    manifest: CLAUDE_MANIFEST,
    walkthrough: {
      probe: projectAgentCapabilityProbe(runtimeProbe, "walkthrough", () =>
        policyEnforcementFailure(controls),
      ),
      execute: (request) => executeWalkthrough(dependencies, request),
    },
    reviewThread: {
      probe: projectAgentCapabilityProbe(runtimeProbe, "review-thread", () =>
        policyEnforcementFailure(controls),
      ),
      execute: (request) => executeReview(dependencies, request),
    },
  }
}

const probeClaudeRuntime = (processes: ProcessRunner) =>
  probeAgentRuntime({
    versionOutput: processes
      .run(processRequest(executable, ["--version"], { timeoutMs: 5_000 }))
      .pipe(Effect.map((result) => result.stdout)),
    unavailableReason: "Claude is not installed or available",
  })

const policyEnforcementFailure = (controls: ClaudePermissionControls): string | null => {
  if (!controls.nonInteractivePermissionMode)
    return "Claude noninteractive permissions are required"
  if (!controls.exactToolAllowlist) return "Claude exact tool allowlisting is required"
  if (!controls.networkToolAllowlist) return "Claude network tool controls are required"
  if (!controls.sensitiveReadDenylist) return "Claude sensitive-file read denials are required"
  if (!controls.shellToolDenylist) return "Claude shell tool denials are required"
  if (!controls.strictMcpConfiguration) return "Claude strict MCP configuration is required"
  return null
}

const executeWalkthrough = (
  dependencies: ClaudeProviderDependencies,
  request: WalkthroughRequest,
): Effect.Effect<
  WalkthroughResult,
  AgentProviderOperationError | InvalidAgentProviderResponseError
> =>
  Effect.gen(function* () {
    yield* requirePolicy("walkthrough", request.policy, CLAUDE_WALKTHROUGH_POLICY)
    yield* requireControls("walkthrough", dependencies.permissionControls)
    const result = yield* dependencies.processes
      .run(
        processRequest(executable, makeWalkthroughArgs(request), {
          cwd: request.workingDirectory,
          timeoutMs: request.timeoutMs,
          stdin: request.prompt,
        }),
      )
      .pipe(Effect.mapError(operationErrors.fromCause("walkthrough")))
    const text = result.stdout.trim()
    if (text.length === 0) {
      return yield* InvalidAgentProviderResponseError.make({
        providerId,
        capability: "walkthrough",
        reason: "Claude completed without generated text",
      })
    }
    return WalkthroughResult.make({ text })
  })

const makeWalkthroughArgs = (request: WalkthroughRequest) => [
  ...basePermissionArgs([]),
  "--print",
  "--input-format",
  "text",
  "--output-format",
  "text",
  "--no-session-persistence",
  "--model",
  request.model,
  ...reasoningEffortArgs(request.reasoningEffort),
]

const ClaudeJsonObject = Schema.StructWithRest(Schema.Struct({}), [
  Schema.Record(Schema.String, Schema.Json),
])
type ClaudeJsonObject = typeof ClaudeJsonObject.Type

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

const ClaudeUsage = Schema.Struct({
  input_tokens: Schema.optionalKey(NonNegativeFinite),
  output_tokens: Schema.optionalKey(NonNegativeFinite),
  cache_read_input_tokens: Schema.optionalKey(NonNegativeFinite),
  cache_creation_input_tokens: Schema.optionalKey(NonNegativeFinite),
})
type ClaudeUsage = typeof ClaudeUsage.Type

const ClaudeMessage = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(ClaudeUsage),
  content: Schema.optionalKey(Schema.Array(Schema.Json)),
})
type ClaudeMessage = typeof ClaudeMessage.Type

const ClaudeStreamEvent = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.optionalKey(Schema.String),
    subtype: Schema.optionalKey(Schema.String),
    session_id: Schema.optionalKey(Schema.String),
    is_error: Schema.optionalKey(Schema.Boolean),
    result: Schema.optionalKey(Schema.Json),
    structured_output: Schema.optionalKey(Schema.Json),
    total_cost_usd: Schema.optionalKey(Schema.Finite),
    usage: Schema.optionalKey(ClaudeUsage),
    message: Schema.optionalKey(Schema.Union([ClaudeMessage, Schema.String])),
    error: Schema.optionalKey(Schema.Json),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
)
type ClaudeStreamEvent = typeof ClaudeStreamEvent.Type

const ClaudeStreamEventFromJson = Schema.fromJsonString(ClaudeStreamEvent)

const ClaudeTextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.optionalKey(Schema.String),
})

const ClaudeToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(ClaudeJsonObject),
})

const ClaudeToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Json),
  is_error: Schema.optionalKey(Schema.Boolean),
})

const ClaudeTextPart = Schema.Struct({ text: Schema.String })
const ClaudeToolInputDetails = Schema.Struct({
  file_path: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
})
const ClaudeErrorDetails = Schema.Struct({ message: Schema.String })

interface ToolUse {
  readonly name: string
  readonly input: ClaudeJsonObject
}

interface PendingArtifact {
  readonly type: AgentArtifactCandidate["type"]
  readonly title: string
  readonly content: string
  readonly metadata: AgentArtifactCandidate["metadata"]
}

interface ClaudeTurnState {
  sessionId: string | null
  finalResponse: Schema.Json
  sawResult: boolean
  usage: AgentUsage | null
  failureHint: AgentProviderFailureCategory | null
  readonly toolUses: Map<string, ToolUse>
  readonly artifacts: PendingArtifact[]
}

const executeReview = (
  dependencies: ClaudeProviderDependencies,
  request: ReviewThreadRequest,
): Effect.Effect<
  ReviewThreadResult,
  AgentProviderOperationError | InvalidAgentProviderResponseError
> =>
  Effect.gen(function* () {
    yield* requirePolicy("review-thread", request.policy, CLAUDE_REVIEW_POLICY)
    yield* requireControls("review-thread", dependencies.permissionControls)
    if (!isScopedMcpToolSubset(request.mcp.allowedTools, request.policy.allowedMcpTools)) {
      return yield* operationErrors.fromReason(
        "review-thread",
        "Scoped MCP access includes tools outside the execution policy",
        "policy-violation",
      )
    }
    return yield* withMcpConfigPath(
      dependencies.tempResources,
      dependencies.tempDirectory,
      request,
      (mcpConfigPath) =>
        Effect.gen(function* () {
          const state: ClaudeTurnState = {
            sessionId: null,
            finalResponse: null,
            sawResult: false,
            usage: null,
            failureHint: null,
            toolUses: new Map(),
            artifacts: [],
          }
          yield* dependencies.processes
            .streamLines(
              processRequest(executable, makeReviewArgs(request, mcpConfigPath), {
                cwd: request.workingDirectory,
                env: { [mcpTokenEnvironmentVariable]: revealScopedMcpToken(request.mcp) },
                stdin: `${request.stablePrompt}\n\n${request.dynamicPrompt}\n`,
                timeoutMs: request.timeoutMs,
              }),
            )
            .pipe(
              Stream.mapError(operationErrors.fromCause("review-thread")),
              Stream.runForEach((event) =>
                Match.valueTags(event, {
                  ProcessLine: (line) =>
                    line.source === "stdout" ? consumeClaudeLine(state, line.line) : Effect.void,
                  ProcessExit: () => Effect.void,
                }),
              ),
            )
          if (!state.sawResult) {
            return yield* operationErrors.fromReason(
              "review-thread",
              "Claude stream ended without a result event",
              state.failureHint ?? "invalid-response",
            )
          }
          const response = yield* decodeReviewResponse(state.finalResponse)
          return ReviewThreadResult.make({
            response,
            usage: state.usage,
            artifacts: state.artifacts.map((artifact) => AgentArtifactCandidate.make(artifact)),
            sessionId: state.sessionId === null ? null : AgentSessionId.make(state.sessionId),
          })
        }),
    )
  })

const makeReviewArgs = (request: ReviewThreadRequest, mcpConfigPath: string) => [
  ...basePermissionArgs(request.mcp.allowedTools),
  "--print",
  "--verbose",
  "--output-format",
  "stream-json",
  "--json-schema",
  JSON.stringify(reviewResponseJsonSchema),
  "--mcp-config",
  mcpConfigPath,
  "--model",
  request.model,
  ...(request.sessionId === null ? [] : ["--resume", request.sessionId]),
]

const basePermissionArgs = (mcpTools: readonly McpToolName[]) => {
  const allowedTools = [...builtInTools, ...mcpTools.map((tool) => `mcp__diffdash__${tool}`)]
  return [
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    "--tools",
    builtInTools.join(","),
    "--allowedTools",
    allowedTools.join(","),
    "--disallowedTools",
    [...mutationRules, ...sensitiveReadRules].join(","),
  ]
}

const consumeClaudeLine = (
  state: ClaudeTurnState,
  line: string,
): Effect.Effect<void, AgentProviderOperationError> =>
  Effect.gen(function* () {
    if (line.trim().length === 0) return
    if (!line.trimStart().startsWith("{")) {
      const category = classifyProviderFailureText(line)
      if (category !== null) {
        return yield* operationErrors.fromReason("review-thread", line, category)
      }
    }
    const event = yield* parseJsonLine(line)
    const type = event.type ?? null
    if (type === null) {
      return yield* operationErrors.fromReason(
        "review-thread",
        "Claude emitted an event without a type",
        "invalid-response",
      )
    }
    if (event.session_id !== undefined) state.sessionId = event.session_id
    switch (type) {
      case "assistant":
        yield* consumeAssistant(state, event)
        return
      case "user":
      case "tool_result":
        consumeToolResults(state, event)
        return
      case "result":
        state.sawResult = true
        if (event.is_error === true || event.subtype === "error") {
          return yield* operationErrors.fromReason(
            "review-thread",
            Schema.is(Schema.String)(event.result)
              ? event.result
              : "Claude result reported an error",
          )
        }
        state.finalResponse = parseJsonValue(
          parseResult(event.structured_output ?? event.result ?? null),
        )
        state.usage = parseClaudeUsage(event.usage ?? null, event.total_cost_usd ?? null)
        return
      case "error":
        return yield* operationErrors.fromReason(
          "review-thread",
          errorMessage(event) ?? "Claude emitted an error event",
        )
      case "system":
        if (event.subtype === "error") {
          return yield* operationErrors.fromReason(
            "review-thread",
            errorMessage(event) ?? "Claude system error",
          )
        }
        return
      case "rate_limit_event":
        state.failureHint = claudeRateLimitCategory(event)
        return
      default:
        return
    }
  })

const consumeAssistant = (
  state: ClaudeTurnState,
  event: ClaudeStreamEvent,
): Effect.Effect<void, AgentProviderOperationError> =>
  Effect.gen(function* () {
    const message = Option.getOrNull(Schema.decodeUnknownOption(ClaudeMessage)(event.message))
    if (message === null) {
      return yield* operationErrors.fromReason(
        "review-thread",
        "Claude assistant event omitted message",
        "invalid-response",
      )
    }
    if (message.usage !== undefined) {
      state.usage = parseClaudeUsage(message.usage, state.usage?.costUsd ?? null)
    }
    for (const block of message.content ?? []) {
      const textBlock = Option.getOrNull(Schema.decodeUnknownOption(ClaudeTextBlock)(block))
      if (textBlock !== null) {
        if (textBlock.text !== undefined && textBlock.text.length > 0) {
          const metadata: { messageId?: string; model?: string } = {}
          if (message.id !== undefined) metadata.messageId = message.id
          if (message.model !== undefined) metadata.model = message.model
          state.artifacts.push({
            type: "provider-message",
            title: "Claude assistant message",
            content: textBlock.text,
            metadata,
          })
        }
        continue
      }
      const toolUseBlock = Option.getOrNull(Schema.decodeUnknownOption(ClaudeToolUseBlock)(block))
      if (toolUseBlock !== null) {
        if (toolUseBlock.id === undefined || toolUseBlock.name === undefined) {
          return yield* operationErrors.fromReason(
            "review-thread",
            "Claude tool_use block omitted id or name",
            "invalid-response",
          )
        }
        state.toolUses.set(toolUseBlock.id, {
          name: toolUseBlock.name,
          input: toolUseBlock.input ?? {},
        })
      }
    }
  })

const consumeToolResults = (state: ClaudeTurnState, event: ClaudeStreamEvent) => {
  const message = Option.getOrNull(Schema.decodeUnknownOption(ClaudeMessage)(event.message))
  const blocks = message === null ? [event] : (message.content ?? [])
  for (const block of blocks) {
    const toolResult = Option.getOrNull(Schema.decodeUnknownOption(ClaudeToolResultBlock)(block))
    if (toolResult === null) continue
    const toolUseId = toolResult.tool_use_id ?? null
    const toolUse =
      toolResult.tool_use_id === undefined ? undefined : state.toolUses.get(toolResult.tool_use_id)
    const name = toolUse?.name ?? toolResult.name ?? "unknown"
    const metadata: { toolUseId?: string; tool: string; isError?: string } = { tool: name }
    if (toolUseId !== null) metadata.toolUseId = toolUseId
    if (toolResult.is_error !== undefined) metadata.isError = String(toolResult.is_error)
    state.artifacts.push({
      type: artifactTypeForClaudeTool(name),
      title: `Claude tool: ${toolTitle(name, toolUse?.input)}`,
      content: claudeToolContent(toolResult.content),
      metadata,
    })
  }
}

const artifactTypeForClaudeTool = (name: string): AgentArtifactCandidate["type"] => {
  if (name.startsWith("mcp__diffdash__")) return "mcp-tool-result"
  if (name === "Read") return "file-read"
  if (name === "Glob" || name === "Grep") return "search-result"
  if (name === "Bash") return "shell-output"
  if (name === "WebFetch" || name === "WebSearch") return "web-result"
  return "unknown"
}

const parseClaudeUsage = (usage: ClaudeUsage | null, costUsd: number | null): AgentUsage | null =>
  usage === null
    ? costUsd === null
      ? null
      : AgentUsage.make({
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costUsd,
        })
    : AgentUsage.make({
        inputTokens: usage.input_tokens ?? null,
        outputTokens: usage.output_tokens ?? null,
        cacheReadTokens: usage.cache_read_input_tokens ?? null,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? null,
        costUsd: costUsd === null || costUsd >= 0 ? costUsd : null,
      })

const withMcpConfigPath = <A, E, R>(
  tempResources: TempResourceOperations,
  tempDirectory: string | undefined,
  request: ReviewThreadRequest,
  use: (path: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | AgentProviderOperationError, R> =>
  Effect.scoped(
    tempResources
      .makeTempFileScoped(
        JSON.stringify(makeMcpConfig(request)),
        tempDirectory === undefined
          ? { prefix: "diffdash-claude-", fileName: "mcp.json" }
          : {
              parentDirectory: tempDirectory,
              prefix: "diffdash-claude-",
              fileName: "mcp.json",
            },
      )
      .pipe(Effect.mapError(operationErrors.fromCause("review-thread")), Effect.flatMap(use)),
  )

const makeMcpConfig = (request: ReviewThreadRequest) => ({
  mcpServers: {
    diffdash: {
      type: "http",
      url: request.mcp.endpoint,
      headers: { Authorization: `Bearer \${${mcpTokenEnvironmentVariable}}` },
    },
  },
})

const decodeReviewResponse = (
  value: Schema.Json,
): Effect.Effect<ReviewThreadAgentResponse, InvalidAgentProviderResponseError> =>
  Schema.decodeUnknownEffect(ReviewThreadAgentResponseFromProvider)(value).pipe(
    Effect.mapError((cause) =>
      InvalidAgentProviderResponseError.make({
        providerId,
        capability: "review-thread",
        reason: boundedProviderDiagnostic(
          `Claude returned an invalid review response: ${String(cause)}`,
        ),
      }),
    ),
  )

const requirePolicy = (
  capability: AgentCapability,
  policy: AgentExecutionPolicy,
  expected: AgentExecutionPolicy,
) => {
  const valid = isAgentExecutionPolicyEnforced(policy, expected)
  return valid
    ? Effect.void
    : operationErrors.fromReason(
        capability,
        "Claude requires the explicit non-mutating policy",
        "policy-violation",
      )
}

const requireControls = (
  capability: AgentCapability,
  controls: ClaudePermissionControls | undefined,
) => {
  const reason = policyEnforcementFailure(controls ?? defaultPermissionControls)
  return reason === null
    ? Effect.void
    : operationErrors.fromReason(capability, reason, "policy-violation")
}

const reasoningEffortArgs = (effort: WalkthroughRequest["reasoningEffort"]) => [
  "--effort",
  effort === "minimal" ? "low" : effort,
]

const parseJsonLine = (line: string) =>
  Schema.decodeUnknownEffect(ClaudeStreamEventFromJson)(line).pipe(
    Effect.mapError((cause) =>
      operationErrors.fromReason(
        "review-thread",
        `Claude emitted invalid stream-json: ${String(cause)}`,
        "invalid-response",
      ),
    ),
  )

const claudeRateLimitCategory = (event: ClaudeStreamEvent): AgentProviderFailureCategory =>
  /(?:five[_ -]?hour|seven[_ -]?day|session|daily|weekly|monthly|usage)/iu.test(
    JSON.stringify(event),
  )
    ? "usage-limited"
    : "rate-limited"

const toolTitle = (name: string, input: ClaudeJsonObject | undefined) => {
  if (input === undefined) return name
  const details = Option.getOrNull(Schema.decodeUnknownOption(ClaudeToolInputDetails)(input))
  const detail = details?.file_path ?? details?.path ?? details?.command ?? null
  return detail === null ? name : `${name} ${detail}`
}

const claudeToolContent = (content: Schema.Json | undefined): string => {
  if (Schema.is(Schema.String)(content)) return content
  if (!Array.isArray(content)) return jsonContent(content)
  const text = content.flatMap((part) => {
    const textPart = Option.getOrNull(Schema.decodeUnknownOption(ClaudeTextPart)(part))
    return textPart === null ? [] : [textPart.text]
  })
  return text.length > 0 ? text.join("\n") : jsonContent(content)
}

const parseJsonValue = <A>(value: A): Schema.Json =>
  Option.getOrElse(Schema.decodeUnknownOption(Schema.Json)(value), () => null)

const errorMessage = (event: ClaudeStreamEvent) => {
  const direct = Schema.is(Schema.String)(event.message)
    ? event.message
    : Schema.is(Schema.String)(event.error)
      ? event.error
      : null
  if (direct !== null) return direct
  return (
    Option.getOrNull(Schema.decodeUnknownOption(ClaudeErrorDetails)(event.error))?.message ?? null
  )
}

function modelDescriptor(id: string, displayName: string, quality: "fast" | "balanced" | "best") {
  return AgentModelDescriptor.make({
    id: AgentModelId.make(id),
    displayName,
    capabilities: ["walkthrough", "review-thread"],
    quality,
  })
}
