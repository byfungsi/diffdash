import { Effect, Redacted, Schema, Stream } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  AgentArtifactCandidate,
  AgentCapabilityDeclaration,
  AgentCapabilityManifest,
  AgentCapabilityPolicyUnsupported,
  AgentCapabilityReady,
  AgentCapabilityUnavailable,
  AgentExecutionPolicy,
  AgentModelDescriptor,
  AgentModelId,
  AgentProviderDefaults,
  AgentProviderDescriptor,
  AgentProviderId,
  AgentProviderManifest,
  AgentProviderOperationError,
  type AgentProviderProbeError,
  AgentRuntimeRequirement,
  AgentSessionId,
  AgentSessionSupport,
  AgentUsage,
  InvalidAgentProviderResponseError,
  isAgentExecutionPolicyEnforced,
  McpToolName,
  type AgentCapability,
  type AgentCapabilityProbe,
  type AgentProviderRegistration,
  type ReviewThreadRequest,
  ReviewThreadResponse,
  ReviewThreadResult,
  type WalkthroughRequest,
  WalkthroughResult,
  revealScopedMcpToken,
} from "@diffdash/agent-provider"
import type { CliRunner } from "@diffdash/process/cli"
import type { CliStreamRunner } from "@diffdash/process/cli-stream"

const providerId = AgentProviderId.make("claude")
const executable = "claude"
const mcpTokenEnvironmentVariable = "DIFFDASH_MCP_BEARER_TOKEN"
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

/** Stable Claude provider identity. */
export const CLAUDE_PROVIDER_ID = providerId

/** Claude model selected for new installations. */
export const CLAUDE_DEFAULT_MODEL = AgentModelId.make("claude-sonnet-5")

/** Claude models and quality metadata owned by this provider. */
export const CLAUDE_MODELS = [
  modelDescriptor("claude-opus-4-8", "Opus 4.8", "best"),
  modelDescriptor("claude-sonnet-5", "Sonnet 5.0", "balanced"),
  modelDescriptor("claude-haiku-4-5", "Haiku 4.5", "fast"),
] as const

/** Claude candidates used by automatic quality routing. */
export const CLAUDE_AUTO_MODELS = {
  best: AgentModelId.make("claude-opus-4-8"),
  balanced: CLAUDE_DEFAULT_MODEL,
  fast: AgentModelId.make("claude-haiku-4-5"),
} as const

/** Static Claude provider contribution. */
export const CLAUDE_MANIFEST = AgentProviderManifest.make({
  descriptor: AgentProviderDescriptor.make({
    id: providerId,
    displayName: "Claude",
    description: "Local Anthropic Claude Code CLI integration.",
    homepage: "https://docs.anthropic.com/en/docs/claude-code",
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
export const CLAUDE_WALKTHROUGH_POLICY = AgentExecutionPolicy.make({
  network: "allow",
  sensitiveFiles: "deny",
  repository: "local-working-copy",
  shell: "deny",
  fileMutation: "deny",
  gitMutation: "deny",
  providerPublishing: "deny",
  allowedMcpTools: [],
})

/** Explicit non-mutating policy accepted by Claude review execution. */
export const CLAUDE_REVIEW_POLICY = AgentExecutionPolicy.make({
  network: "allow",
  sensitiveFiles: "deny",
  repository: "reviewed-revision",
  shell: "deny",
  fileMutation: "deny",
  gitMutation: "deny",
  providerPublishing: "deny",
  allowedMcpTools: [],
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
  readonly cli: CliRunner
  readonly cliStream: CliStreamRunner
  readonly tempDirectory?: string
  readonly permissionControls?: ClaudePermissionControls
}

/** Creates the complete Claude SDK registration. */
export const makeClaudeProvider = (
  dependencies: ClaudeProviderDependencies,
): AgentProviderRegistration => {
  const runtimeProbe = probeClaudeRuntime(dependencies.cli)
  const controls = dependencies.permissionControls ?? defaultPermissionControls
  return {
    manifest: CLAUDE_MANIFEST,
    walkthrough: {
      probe: capabilityProbe(runtimeProbe, "walkthrough", controls),
      execute: (request) => executeWalkthrough(dependencies, request),
    },
    reviewThread: {
      probe: capabilityProbe(runtimeProbe, "review-thread", controls),
      execute: (request) => executeReview(dependencies, request),
    },
  }
}

interface RuntimeProbeResult {
  readonly ready: boolean
  readonly version: string | null
  readonly reason: string
}

const probeClaudeRuntime = (
  cli: CliRunner,
): Effect.Effect<RuntimeProbeResult, AgentProviderProbeError> =>
  cli.run(executable, ["--version"], { timeoutMs: 5_000 }).pipe(
    Effect.map((result) => ({ ready: true, version: parseVersion(result.stdout), reason: "" })),
    Effect.catchAll((cause) =>
      Effect.succeed({
        ready: false,
        version: null,
        reason: boundedReason(cause, "Claude is not installed or available"),
      }),
    ),
  )

const capabilityProbe = (
  runtimeProbe: Effect.Effect<RuntimeProbeResult, AgentProviderProbeError>,
  capability: AgentCapability,
  controls: ClaudePermissionControls,
): Effect.Effect<AgentCapabilityProbe, AgentProviderProbeError> =>
  runtimeProbe.pipe(
    Effect.map((result): AgentCapabilityProbe => {
      if (!result.ready) {
        return AgentCapabilityUnavailable.make({ capability, reason: result.reason })
      }
      const unsupported = policyEnforcementFailure(controls)
      return unsupported === null
        ? AgentCapabilityReady.make({ capability, runtimeVersion: result.version })
        : AgentCapabilityPolicyUnsupported.make({ capability, reason: unsupported })
    }),
  )

/** Probes Claude prerequisites and policy enforcement for one declared capability. */
export const probeClaudeCapability = (
  cli: CliRunner,
  capability: AgentCapability,
  controls: ClaudePermissionControls = defaultPermissionControls,
): Effect.Effect<AgentCapabilityProbe, AgentProviderProbeError> =>
  capabilityProbe(probeClaudeRuntime(cli), capability, controls)

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
    const result = yield* dependencies.cli
      .run(executable, makeWalkthroughArgs(request), {
        cwd: request.workingDirectory,
        timeoutMs: request.timeoutMs,
        stdin: request.prompt,
      })
      .pipe(Effect.mapError(operationError("walkthrough")))
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

interface ToolUse {
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
}

interface PendingArtifact {
  readonly type: AgentArtifactCandidate["type"]
  readonly title: string
  readonly content: string
  readonly metadata: Readonly<Record<string, unknown>>
}

interface ClaudeTurnState {
  sessionId: string | null
  finalResponse: unknown
  sawResult: boolean
  usage: AgentUsage | null
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
    if (!request.mcp.allowedTools.every((tool) => request.policy.allowedMcpTools.includes(tool))) {
      return yield* operationErrorValue(
        "review-thread",
        "Scoped MCP access includes tools outside the execution policy",
      )
    }
    return yield* withMcpConfigPath(
      dependencies.tempDirectory ?? tmpdir(),
      request,
      (mcpConfigPath) =>
        Effect.gen(function* () {
          const state: ClaudeTurnState = {
            sessionId: null,
            finalResponse: null,
            sawResult: false,
            usage: null,
            toolUses: new Map(),
            artifacts: [],
          }
          yield* dependencies.cliStream
            .stream(executable, makeReviewArgs(request, mcpConfigPath), {
              cwd: request.workingDirectory,
              env: { [mcpTokenEnvironmentVariable]: revealScopedMcpToken(request.mcp) },
              stdin: `${request.stablePrompt}\n\n${request.dynamicPrompt}\n`,
              timeoutMs: request.timeoutMs,
            })
            .pipe(
              Stream.mapError(operationError("review-thread")),
              Stream.runForEach((event) => {
                const { _tag: tag } = event
                return tag === "CliLine" && event.source === "stdout"
                  ? consumeClaudeLine(state, event.line)
                  : Effect.void
              }),
            )
          if (!state.sawResult) {
            return yield* operationErrorValue(
              "review-thread",
              "Claude stream ended without a result event",
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
      case "result":
        state.sawResult = true
        if (event.is_error === true || stringAt(event, "subtype") === "error") {
          return yield* operationErrorValue(
            "review-thread",
            stringAt(event, "result") ?? "Claude result reported an error",
          )
        }
        state.finalResponse = parseResult(event.structured_output ?? event.result)
        state.usage = parseClaudeUsage(recordAt(event, "usage"), numberAt(event, "total_cost_usd"))
        return
      case "error":
        return yield* operationErrorValue(
          "review-thread",
          errorMessage(event) ?? "Claude emitted an error event",
        )
      case "system":
        if (stringAt(event, "subtype") === "error") {
          return yield* operationErrorValue(
            "review-thread",
            errorMessage(event) ?? "Claude system error",
          )
        }
        return
      default:
        return
    }
  })

const consumeAssistant = (
  state: ClaudeTurnState,
  event: Readonly<Record<string, unknown>>,
): Effect.Effect<void, AgentProviderOperationError> =>
  Effect.gen(function* () {
    const message = recordAt(event, "message")
    if (message === null) return yield* protocolError("Claude assistant event omitted message")
    const usage = recordAt(message, "usage")
    if (usage !== null) state.usage = parseClaudeUsage(usage, state.usage?.costUsd ?? null)
    for (const block of arrayAt(message, "content")) {
      if (!isRecord(block)) continue
      const blockType = stringAt(block, "type")
      if (blockType === "text") {
        const text = stringAt(block, "text")
        if (text !== null && text.length > 0) {
          state.artifacts.push({
            type: "provider-message",
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
        state.toolUses.set(id, { name, input: recordAt(block, "input") ?? {} })
      }
    }
  })

const consumeToolResults = (state: ClaudeTurnState, event: Readonly<Record<string, unknown>>) => {
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

const artifactTypeForClaudeTool = (name: string): AgentArtifactCandidate["type"] => {
  if (name.startsWith("mcp__diffdash__")) return "mcp-tool-result"
  if (name === "Read") return "file-read"
  if (name === "Glob" || name === "Grep") return "search-result"
  if (name === "Bash") return "shell-output"
  if (name === "WebFetch" || name === "WebSearch") return "web-result"
  return "unknown"
}

const parseClaudeUsage = (
  usage: Readonly<Record<string, unknown>> | null,
  costUsd: number | null,
): AgentUsage | null =>
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
        inputTokens: nonNegativeNumberAt(usage, "input_tokens"),
        outputTokens: nonNegativeNumberAt(usage, "output_tokens"),
        cacheReadTokens: nonNegativeNumberAt(usage, "cache_read_input_tokens"),
        cacheWriteTokens: nonNegativeNumberAt(usage, "cache_creation_input_tokens"),
        costUsd: costUsd === null || costUsd >= 0 ? costUsd : null,
      })

const withMcpConfigPath = <A, E, R>(
  tempDirectory: string,
  request: ReviewThreadRequest,
  use: (path: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | AgentProviderOperationError, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        await mkdir(tempDirectory, { recursive: true })
        const directory = await mkdtemp(join(tempDirectory, "diffdash-claude-"))
        const path = join(directory, "mcp.json")
        await writeFile(path, JSON.stringify(makeMcpConfig(request)), { mode: 0o600 })
        return { directory, path }
      },
      catch: operationError("review-thread"),
    }),
    ({ path }) => use(path),
    ({ directory }) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
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
  value: unknown,
): Effect.Effect<ReviewThreadResponse, InvalidAgentProviderResponseError> =>
  Schema.decodeUnknown(ReviewThreadResponse)(normalizeResponse(value)).pipe(
    Effect.mapError((cause) =>
      InvalidAgentProviderResponseError.make({
        providerId,
        capability: "review-thread",
        reason: `Claude returned an invalid review response: ${String(cause)}`,
      }),
    ),
  )

const normalizeResponse = (value: unknown): unknown => {
  if (!isRecord(value)) return value
  const locations = value.referencedLocations ?? value.referencedAnchors ?? []
  return {
    bodyMarkdown: value.bodyMarkdown,
    threadSummary: value.threadSummary ?? value.threadSummaryUpdate ?? null,
    referencedLocations: Array.isArray(locations)
      ? locations.map((location) =>
          typeof location === "string" ? location : JSON.stringify(location),
        )
      : locations,
  }
}

const reviewAnchorJsonSchema = (
  tag: "review" | "file" | "hunk" | "line",
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
) => ({
  type: "object",
  additionalProperties: false,
  required: ["_tag", ...Object.keys(properties)],
  properties: { _tag: { type: "string", enum: [tag] }, ...properties },
})

const reviewResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["bodyMarkdown", "threadSummaryUpdate", "referencedAnchors"],
  properties: {
    bodyMarkdown: { type: "string", minLength: 1 },
    threadSummaryUpdate: { type: ["string", "null"], minLength: 1 },
    referencedAnchors: {
      type: ["array", "null"],
      items: {
        anyOf: [
          reviewAnchorJsonSchema("review", {}),
          reviewAnchorJsonSchema("file", {
            fileId: { type: "string", minLength: 1 },
            filePath: { type: "string" },
            oldPath: { type: ["string", "null"] },
          }),
          reviewAnchorJsonSchema("hunk", {
            fileId: { type: "string", minLength: 1 },
            filePath: { type: "string" },
            oldPath: { type: ["string", "null"] },
            hunkId: { type: "string", minLength: 1 },
            hunkFingerprint: { type: "string", minLength: 1 },
            header: { type: "string" },
            oldStart: { type: "number" },
            oldLines: { type: "number" },
            newStart: { type: "number" },
            newLines: { type: "number" },
          }),
          reviewAnchorJsonSchema("line", {
            fileId: { type: "string", minLength: 1 },
            filePath: { type: "string" },
            oldPath: { type: ["string", "null"] },
            hunkId: { type: "string", minLength: 1 },
            hunkFingerprint: { type: "string", minLength: 1 },
            hunkHeader: { type: "string" },
            side: { type: "string", enum: ["old", "new"] },
            lineNumber: { type: "number" },
            lineContent: { type: "string" },
          }),
        ],
      },
    },
  },
} as const

const requirePolicy = (
  capability: AgentCapability,
  policy: AgentExecutionPolicy,
  expected: AgentExecutionPolicy,
) => {
  const valid = isAgentExecutionPolicyEnforced(policy, expected)
  return valid
    ? Effect.void
    : operationErrorValue(capability, "Claude requires the explicit non-mutating policy")
}

const requireControls = (
  capability: AgentCapability,
  controls: ClaudePermissionControls | undefined,
) => {
  const reason = policyEnforcementFailure(controls ?? defaultPermissionControls)
  return reason === null ? Effect.void : operationErrorValue(capability, reason)
}

const reasoningEffortArgs = (effort: WalkthroughRequest["reasoningEffort"]) => [
  "--effort",
  effort === "minimal" ? "low" : effort,
]

const parseJsonLine = (line: string) =>
  Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) throw new Error("event is not a JSON object")
      return parsed
    },
    catch: (cause) =>
      operationErrorValue(
        "review-thread",
        `Claude emitted invalid stream-json: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  })

const operationError = (capability: AgentCapability) => (cause: unknown) =>
  AgentProviderOperationError.make({
    providerId,
    capability,
    reason: boundedReason(cause, "Claude execution failed"),
    cause,
  })

const operationErrorValue = (capability: AgentCapability, reason: string) =>
  AgentProviderOperationError.make({ providerId, capability, reason })

const protocolError = (reason: string) => operationErrorValue("review-thread", reason)

const boundedReason = (cause: unknown, fallback: string) => {
  if (isRecord(cause) && typeof cause.stderr === "string" && cause.stderr.trim().length > 0) {
    return redactDiagnostic(cause.stderr)
  }
  return cause instanceof Error && cause.message.trim().length > 0
    ? redactDiagnostic(cause.message)
    : fallback
}

const redactDiagnostic = (value: string) =>
  value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [redacted]")
    .replace(/DIFFDASH_MCP_BEARER_TOKEN=[^\s]+/giu, "DIFFDASH_MCP_BEARER_TOKEN=[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-600)

const parseVersion = (output: string) => {
  const value = output.trim()
  if (value.length === 0) return null
  const match = /(?:^|\s)v?(\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?)(?:\s|$)/u.exec(value)
  return match?.[1] ?? value.slice(0, 100)
}

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

const errorMessage = (event: Readonly<Record<string, unknown>>) => {
  const direct = stringAt(event, "message") ?? stringAt(event, "error")
  if (direct !== null) return direct
  const error = recordAt(event, "error")
  return error === null ? null : stringAt(error, "message")
}

function modelDescriptor(id: string, displayName: string, quality: "fast" | "balanced" | "best") {
  return AgentModelDescriptor.make({
    id: AgentModelId.make(id),
    displayName,
    capabilities: ["walkthrough", "review-thread"],
    quality,
  })
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringAt = (record: Readonly<Record<string, unknown>>, key: string) =>
  typeof record[key] === "string" ? record[key] : null

const numberAt = (record: Readonly<Record<string, unknown>>, key: string) =>
  typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : null

const nonNegativeNumberAt = (record: Readonly<Record<string, unknown>>, key: string) => {
  const value = numberAt(record, key)
  return value !== null && value >= 0 ? value : null
}

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

/** Converts a provider-owned model to its SDK identity. */
export const claudeModelId = (model: string) => AgentModelId.make(model)

/** Converts host tool names to SDK identities for a scoped review request. */
export const claudeMcpToolNames = (tools: readonly string[]) =>
  tools.map((tool) => McpToolName.make(tool))

/** Redacts a token at the host/provider boundary. */
export const claudeMcpToken = (token: string) => Redacted.make(token)
