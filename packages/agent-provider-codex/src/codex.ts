import { Effect, Redacted, Schema, Stream } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  AgentArtifactCandidate,
  AgentCapabilityDeclaration,
  AgentCapabilityManifest,
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
  AgentProviderProbeError,
  AgentRuntimeRequirement,
  AgentSessionSupport,
  AgentUsage,
  InvalidAgentProviderResponseError,
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
import type { CliResult, CliRunner } from "@diffdash/process/cli"
import type { CliStreamRunner } from "@diffdash/process/cli-stream"

const providerId = AgentProviderId.make("codex")
const executable = "codex"
const mcpTokenEnvironmentVariable = "DIFFDASH_MCP_BEARER_TOKEN"

/** Stable Codex provider identity. */
export const CODEX_PROVIDER_ID = providerId

/** Codex model selected for new installations. */
export const CODEX_DEFAULT_MODEL = AgentModelId.make("gpt-5.3-codex-spark")

/** Codex models and quality metadata owned by this provider. */
export const CODEX_MODELS = [
  AgentModelDescriptor.make({
    id: AgentModelId.make("gpt-5.5"),
    displayName: "GPT 5.5",
    capabilities: ["walkthrough", "review-thread"],
    quality: "best",
  }),
  AgentModelDescriptor.make({
    id: CODEX_DEFAULT_MODEL,
    displayName: "GPT 5.3 Codex Spark",
    capabilities: ["walkthrough", "review-thread"],
    quality: "balanced",
  }),
  AgentModelDescriptor.make({
    id: AgentModelId.make("gpt-5.4-mini"),
    displayName: "GPT 5.4 Mini",
    capabilities: ["walkthrough", "review-thread"],
    quality: "fast",
  }),
] as const

/** Codex candidates used by automatic quality routing. */
export const CODEX_AUTO_MODELS = {
  best: AgentModelId.make("gpt-5.5"),
  balanced: CODEX_DEFAULT_MODEL,
  fast: AgentModelId.make("gpt-5.4-mini"),
} as const

/** Static Codex provider contribution. */
export const CODEX_MANIFEST = AgentProviderManifest.make({
  descriptor: AgentProviderDescriptor.make({
    id: providerId,
    displayName: "Codex",
    description: "Local OpenAI Codex CLI integration.",
    homepage: "https://developers.openai.com/codex/cli",
  }),
  models: [...CODEX_MODELS],
  defaults: AgentProviderDefaults.make({
    walkthroughModel: CODEX_DEFAULT_MODEL,
    reviewThreadModel: CODEX_DEFAULT_MODEL,
  }),
  requirements: [
    AgentRuntimeRequirement.make({
      name: executable,
      versionRange: null,
      installHint: "Install the Codex CLI and authenticate it before using DiffDash.",
    }),
  ],
  capabilities: AgentCapabilityManifest.make({
    walkthrough: AgentCapabilityDeclaration.make({ supported: true, autoPriority: 20 }),
    reviewThread: AgentCapabilityDeclaration.make({ supported: true, autoPriority: 20 }),
  }),
  session: AgentSessionSupport.make({ mode: "none" }),
})

/** Explicit policy accepted by Codex walkthrough execution. */
export const CODEX_WALKTHROUGH_POLICY = AgentExecutionPolicy.make({
  network: "allow",
  sensitiveFiles: "deny",
  repository: "local-working-copy",
  shell: "read-only",
  fileMutation: "deny",
  gitMutation: "deny",
  providerPublishing: "deny",
  allowedMcpTools: [],
})

/** Explicit base policy accepted by Codex review execution. */
export const CODEX_REVIEW_POLICY = AgentExecutionPolicy.make({
  network: "allow",
  sensitiveFiles: "deny",
  repository: "reviewed-revision",
  shell: "read-only",
  fileMutation: "deny",
  gitMutation: "deny",
  providerPublishing: "deny",
  allowedMcpTools: [],
})

/** Host dependencies required to construct the Codex leaf provider. */
export interface CodexProviderDependencies {
  readonly cli: CliRunner
  readonly cliStream: CliStreamRunner
  readonly tempDirectory?: string
}

/** Creates the complete Codex SDK registration. */
export const makeCodexProvider = (
  dependencies: CodexProviderDependencies,
): AgentProviderRegistration => {
  return {
    manifest: CODEX_MANIFEST,
    walkthrough: {
      probe: probeCodexCapability(dependencies.cli, "walkthrough"),
      execute: (request) => executeWalkthrough(dependencies, request),
    },
    reviewThread: {
      probe: probeCodexCapability(dependencies.cli, "review-thread"),
      execute: (request) => executeReview(dependencies, request),
    },
  }
}

interface RuntimeProbeResult {
  readonly ready: boolean
  readonly version: string | null
  readonly reason: string
}

const probeRuntime = (cli: CliRunner): Effect.Effect<RuntimeProbeResult, AgentProviderProbeError> =>
  cli.run(executable, ["--version"], { timeoutMs: 5_000 }).pipe(
    Effect.map((result) => ({
      ready: true,
      version: parseVersion(result.stdout),
      reason: "",
    })),
    Effect.catchAll((cause) =>
      Effect.succeed({
        ready: false,
        version: null,
        reason: boundedReason(cause, "Codex is not installed or available"),
      }),
    ),
  )

/** Probes the Codex runtime once for prerequisites and either declared capability. */
export const probeCodexCapability = (
  cli: CliRunner,
  capability: AgentCapability,
): Effect.Effect<AgentCapabilityProbe, AgentProviderProbeError> =>
  probeRuntime(cli).pipe(
    Effect.map(
      (result): AgentCapabilityProbe =>
        result.ready
          ? AgentCapabilityReady.make({ capability, runtimeVersion: result.version })
          : AgentCapabilityUnavailable.make({ capability, reason: result.reason }),
    ),
  )

const parseVersion = (output: string) => {
  const value = output.trim()
  if (value.length === 0) return null
  const match = /(?:^|\s)v?(\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?)(?:\s|$)/u.exec(value)
  return match?.[1] ?? value.slice(0, 100)
}

const executeWalkthrough = (
  dependencies: CodexProviderDependencies,
  request: WalkthroughRequest,
): Effect.Effect<
  WalkthroughResult,
  AgentProviderOperationError | InvalidAgentProviderResponseError
> =>
  Effect.gen(function* () {
    yield* requirePolicy("walkthrough", request.policy, "local-working-copy")
    const tempDirectory = dependencies.tempDirectory ?? tmpdir()
    return yield* Effect.acquireUseRelease(
      createWalkthroughOutputPath(tempDirectory),
      (outputPath) =>
        Effect.gen(function* () {
          const result = yield* dependencies.cli
            .run(
              executable,
              makeWalkthroughArgs(request, outputPath, request.workingDirectory === tempDirectory),
              {
                cwd: request.workingDirectory,
                timeoutMs: request.timeoutMs,
                stdin: request.prompt,
              },
            )
            .pipe(Effect.mapError(operationError("walkthrough")))
          const output = yield* readWalkthroughOutput(outputPath, result)
          if (output.trim().length === 0) {
            return yield* InvalidAgentProviderResponseError.make({
              providerId,
              capability: "walkthrough",
              reason: "Codex completed without generated text",
            })
          }
          return WalkthroughResult.make({ text: output })
        }),
      (outputPath) => Effect.promise(() => rm(outputPath, { force: true })),
    )
  })

const createWalkthroughOutputPath = (directory: string) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(directory, { recursive: true })
      return join(directory, `codex-output-${randomUUID()}.txt`)
    },
    catch: operationError("walkthrough"),
  })

const makeWalkthroughArgs = (
  request: WalkthroughRequest,
  outputPath: string,
  skipGitRepositoryCheck: boolean,
) => [
  "--ask-for-approval",
  "never",
  "--sandbox",
  "read-only",
  "exec",
  "--ephemeral",
  ...(skipGitRepositoryCheck ? ["--skip-git-repo-check"] : []),
  "--ignore-user-config",
  "--ignore-rules",
  "--strict-config",
  "--model",
  request.model,
  "-c",
  `model_reasoning_effort=${JSON.stringify(request.reasoningEffort)}`,
  "--output-last-message",
  outputPath,
  "-",
]

const readWalkthroughOutput = (path: string, result: CliResult) =>
  Effect.tryPromise({
    try: async () => {
      try {
        const output = await readFile(path, "utf8")
        return output.trim().length > 0 ? output : result.stdout
      } catch {
        return result.stdout
      }
    },
    catch: operationError("walkthrough"),
  })

interface PendingArtifact {
  readonly type: AgentArtifactCandidate["type"]
  readonly title: string
  readonly content: string
  readonly metadata: Readonly<Record<string, unknown>>
}

interface CodexTurnState {
  turnStarted: boolean
  turnCompleted: boolean
  finalMessage: string | null
  usage: AgentUsage | null
  readonly artifacts: PendingArtifact[]
}

const executeReview = (
  dependencies: CodexProviderDependencies,
  request: ReviewThreadRequest,
): Effect.Effect<
  ReviewThreadResult,
  AgentProviderOperationError | InvalidAgentProviderResponseError
> =>
  Effect.gen(function* () {
    yield* requirePolicy("review-thread", request.policy, "reviewed-revision")
    if (!request.mcp.allowedTools.every((tool) => request.policy.allowedMcpTools.includes(tool))) {
      return yield* operationErrorValue(
        "review-thread",
        "Scoped MCP access includes tools outside the execution policy",
      )
    }

    return yield* withOutputSchemaPath(dependencies.tempDirectory ?? tmpdir(), (outputSchemaPath) =>
      Effect.gen(function* () {
        const state: CodexTurnState = {
          turnStarted: false,
          turnCompleted: false,
          finalMessage: null,
          usage: null,
          artifacts: [],
        }
        yield* dependencies.cliStream
          .stream(executable, makeReviewArgs(request, outputSchemaPath), {
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
                ? consumeCodexLine(state, event.line)
                : Effect.void
            }),
          )

        if (!state.turnStarted || !state.turnCompleted) {
          return yield* operationErrorValue(
            "review-thread",
            "Codex stream ended without a complete turn lifecycle",
          )
        }
        const response = yield* decodeReviewResponse(state.finalMessage)
        return ReviewThreadResult.make({
          response,
          usage: state.usage,
          artifacts: state.artifacts.map((artifact) => AgentArtifactCandidate.make(artifact)),
          sessionId: null,
        })
      }),
    )
  })

const makeReviewArgs = (request: ReviewThreadRequest, outputSchemaPath: string) => [
  "--ask-for-approval",
  "never",
  "--sandbox",
  "read-only",
  "-c",
  `mcp_servers.diffdash.url=${JSON.stringify(request.mcp.endpoint)}`,
  "-c",
  `mcp_servers.diffdash.bearer_token_env_var=${JSON.stringify(mcpTokenEnvironmentVariable)}`,
  "-c",
  "mcp_servers.diffdash.default_tools_approval_mode=auto",
  "exec",
  "--json",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--strict-config",
  "--model",
  request.model,
  "--output-schema",
  outputSchemaPath,
  "-",
]

const consumeCodexLine = (
  state: CodexTurnState,
  line: string,
): Effect.Effect<void, AgentProviderOperationError> =>
  Effect.gen(function* () {
    if (line.trim().length === 0) return
    const event = yield* parseJsonLine(line)
    const type = stringAt(event, "type")
    if (type === null) return yield* protocolError("Codex emitted an event without a type")

    switch (type) {
      case "thread.started":
        if (!stringAt(event, "thread_id")) {
          return yield* protocolError("Codex thread.started event omitted thread_id")
        }
        return
      case "turn.started":
        state.turnStarted = true
        return
      case "turn.completed":
        state.turnCompleted = true
        state.usage = parseCodexUsage(recordAt(event, "usage"))
        return
      case "turn.failed":
      case "error":
        return yield* operationErrorValue(
          "review-thread",
          errorMessage(event) ?? `Codex emitted ${type}`,
        )
      case "item.completed": {
        const item = recordAt(event, "item")
        if (item === null) return yield* protocolError("Codex item.completed omitted item")
        return yield* consumeCompletedItem(state, item)
      }
      case "item.started": {
        const item = recordAt(event, "item")
        if (item !== null && stringAt(item, "type") === "file_change") {
          return yield* protocolError("Codex attempted a file change despite the read-only sandbox")
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
): Effect.Effect<void, AgentProviderOperationError> =>
  Effect.gen(function* () {
    const itemType = stringAt(item, "type")
    const itemId = stringAt(item, "id")
    switch (itemType) {
      case "agent_message": {
        const text = stringAt(item, "text")
        if (text === null) return yield* protocolError("Codex agent message omitted text")
        state.finalMessage = text
        state.artifacts.push({
          type: "provider-message",
          title: "Codex assistant message",
          content: text,
          metadata: metadata({ itemId, status: stringAt(item, "status") }),
        })
        return
      }
      case "command_execution": {
        const command = stringAt(item, "command") ?? "command"
        state.artifacts.push({
          type: "shell-output",
          title: `Codex command: ${command}`,
          content: stringAt(item, "aggregated_output") ?? stringAt(item, "output") ?? "",
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
        state.artifacts.push({
          type: server === "diffdash" ? "mcp-tool-result" : "unknown",
          title: `Codex MCP: ${server}/${tool}`,
          content: jsonContent(item.result ?? item.output ?? item.error ?? null),
          metadata: metadata({ itemId, server, tool, status: stringAt(item, "status") }),
        })
        return
      }
      case "file_change":
        return yield* protocolError("Codex emitted a file change despite the read-only sandbox")
      default:
        return
    }
  })

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
        `Codex emitted invalid JSONL: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  })

const decodeReviewResponse = (
  finalMessage: string | null,
): Effect.Effect<ReviewThreadResponse, InvalidAgentProviderResponseError> => {
  const parsed = finalMessage === null ? null : parseJsonText(finalMessage)
  const candidate = normalizeResponse(parsed)
  return Schema.decodeUnknown(ReviewThreadResponse)(candidate).pipe(
    Effect.mapError((cause) =>
      InvalidAgentProviderResponseError.make({
        providerId,
        capability: "review-thread",
        reason: `Codex returned an invalid review response: ${String(cause)}`,
      }),
    ),
  )
}

const normalizeResponse = (value: unknown): unknown => {
  if (!isRecord(value)) return value
  const bodyMarkdown = value.bodyMarkdown
  const threadSummary = value.threadSummary ?? value.threadSummaryUpdate ?? null
  const locations = value.referencedLocations ?? value.referencedAnchors ?? []
  return {
    bodyMarkdown,
    threadSummary,
    referencedLocations: Array.isArray(locations)
      ? locations.map((location) =>
          typeof location === "string" ? location : JSON.stringify(location),
        )
      : locations,
  }
}

const parseCodexUsage = (usage: Readonly<Record<string, unknown>> | null): AgentUsage | null =>
  usage === null
    ? null
    : AgentUsage.make({
        inputTokens: nonNegativeNumberAt(usage, "input_tokens"),
        outputTokens: nonNegativeNumberAt(usage, "output_tokens"),
        cacheReadTokens: nonNegativeNumberAt(usage, "cached_input_tokens"),
        cacheWriteTokens: null,
        costUsd: null,
      })

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

const withOutputSchemaPath = <A, E, R>(
  tempDirectory: string,
  use: (path: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | AgentProviderOperationError, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        await mkdir(tempDirectory, { recursive: true })
        const directory = await mkdtemp(join(tempDirectory, "diffdash-codex-"))
        const path = join(directory, "review-thread-response.schema.json")
        await writeFile(path, JSON.stringify(reviewResponseJsonSchema), { mode: 0o600 })
        return { directory, path }
      },
      catch: operationError("review-thread"),
    }),
    ({ path }) => use(path),
    ({ directory }) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  )

const requirePolicy = (
  capability: AgentCapability,
  policy: AgentExecutionPolicy,
  repository: AgentExecutionPolicy["repository"],
) => {
  const valid =
    policy.sensitiveFiles === "deny" &&
    policy.repository === repository &&
    policy.shell === "read-only" &&
    policy.fileMutation === "deny" &&
    policy.gitMutation === "deny" &&
    policy.providerPublishing === "deny"
  return valid
    ? Effect.void
    : operationErrorValue(capability, "Codex requires the explicit non-mutating policy")
}

const operationError = (capability: AgentCapability) => (cause: unknown) =>
  AgentProviderOperationError.make({
    providerId,
    capability,
    reason: boundedReason(cause, "Codex execution failed"),
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

const errorMessage = (event: Readonly<Record<string, unknown>>) => {
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

const nonNegativeNumberAt = (record: Readonly<Record<string, unknown>>, key: string) => {
  const value = numberAt(record, key)
  return value !== null && value >= 0 ? value : null
}

const recordAt = (record: Readonly<Record<string, unknown>>, key: string) => {
  const value = record[key]
  return isRecord(value) ? value : null
}

const metadata = (values: Readonly<Record<string, string | number | null>>) =>
  Object.fromEntries(Object.entries(values).filter((entry) => entry[1] !== null))

const jsonContent = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))

/** Converts a provider-owned model to its SDK identity. */
export const codexModelId = (model: string) => AgentModelId.make(model)

/** Converts host tool names to SDK identities for a scoped review request. */
export const codexMcpToolNames = (tools: readonly string[]) =>
  tools.map((tool) => McpToolName.make(tool))

/** Redacts a token at the host/provider boundary. */
export const codexMcpToken = (token: string) => Redacted.make(token)
