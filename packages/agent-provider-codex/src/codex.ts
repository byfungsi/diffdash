import { Effect, Predicate, Redacted, Schema, Stream } from "effect"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"

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
  AgentProviderProbeError,
  AgentRuntimeRequirement,
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
import {
  nonNegativeNumberAt,
  parseProviderJsonlObject,
  parseProviderJsonText as parseJsonText,
  providerJsonContent as jsonContent,
  providerMetadata as metadata,
  recordAt,
  stringAt,
} from "@diffdash/agent-provider/provider-json"
import { makeNonMutatingAgentExecutionPolicy } from "@diffdash/agent-provider/policy"
import {
  normalizeProviderReviewThreadResponse as normalizeResponse,
  REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA as reviewResponseJsonSchema,
} from "@diffdash/agent-provider/review-output"
import {
  boundedProviderDiagnostic,
  makeAgentProviderOperationErrorFactory,
  probeAgentRuntime,
  projectAgentCapabilityProbe,
} from "@diffdash/agent-provider/runtime"
import { isScopedMcpToolSubset } from "@diffdash/agent-provider/security"
import { processRequest, type ProcessResult, type ProcessRunner } from "@diffdash/process"
import { makeTempFileScoped, makeTempOutputPathScoped } from "@diffdash/process/temp-resource"

const providerId = AgentProviderId.make("codex")
const executable = "codex"
const mcpTokenEnvironmentVariable = "DIFFDASH_MCP_BEARER_TOKEN"
const operationErrors = makeAgentProviderOperationErrorFactory({
  providerId,
  fallbackReason: "Codex execution failed",
})

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
export const CODEX_WALKTHROUGH_POLICY = makeCodexExecutionPolicy("local-working-copy")

/** Explicit base policy accepted by Codex review execution. */
export const CODEX_REVIEW_POLICY = makeCodexExecutionPolicy("reviewed-revision")

function makeCodexExecutionPolicy(repository: AgentExecutionPolicy["repository"]) {
  return makeNonMutatingAgentExecutionPolicy({
    network: "allow",
    repository,
    shell: "read-only",
  })
}

/** Host dependencies required to construct the Codex leaf provider. */
export interface CodexProviderDependencies {
  readonly processes: ProcessRunner
  readonly tempDirectory?: string
}

/** Creates the complete Codex SDK registration. */
export const makeCodexProvider = (
  dependencies: CodexProviderDependencies,
): AgentProviderRegistration => {
  const runtimeProbe = probeRuntime(dependencies.processes)
  return {
    manifest: CODEX_MANIFEST,
    walkthrough: {
      probe: projectAgentCapabilityProbe(runtimeProbe, "walkthrough"),
      execute: (request) => executeWalkthrough(dependencies, request),
    },
    reviewThread: {
      probe: projectAgentCapabilityProbe(runtimeProbe, "review-thread"),
      execute: (request) => executeReview(dependencies, request),
    },
  }
}

const probeRuntime = (processes: ProcessRunner) =>
  probeAgentRuntime({
    versionOutput: processes
      .run(processRequest(executable, ["--version"], { timeoutMs: 5_000 }))
      .pipe(Effect.map((result) => result.stdout)),
    unavailableReason: "Codex is not installed or available",
  })

/** Probes the Codex runtime once for prerequisites and either declared capability. */
export const probeCodexCapability = (
  processes: ProcessRunner,
  capability: AgentCapability,
): Effect.Effect<AgentCapabilityProbe, AgentProviderProbeError> =>
  projectAgentCapabilityProbe(probeRuntime(processes), capability)

const executeWalkthrough = (
  dependencies: CodexProviderDependencies,
  request: WalkthroughRequest,
): Effect.Effect<
  WalkthroughResult,
  AgentProviderOperationError | InvalidAgentProviderResponseError
> =>
  Effect.gen(function* () {
    yield* requirePolicy("walkthrough", request.policy, CODEX_WALKTHROUGH_POLICY)
    const tempDirectory = dependencies.tempDirectory ?? tmpdir()
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const outputPath = yield* makeTempOutputPathScoped({
          parentDirectory: tempDirectory,
          prefix: "codex-output-",
          fileName: "output.txt",
        }).pipe(Effect.mapError(operationErrors.fromCause("walkthrough")))
        const result = yield* dependencies.processes
          .run(
            processRequest(
              executable,
              makeWalkthroughArgs(request, outputPath, request.workingDirectory === tempDirectory),
              {
                cwd: request.workingDirectory,
                timeoutMs: request.timeoutMs,
                stdin: request.prompt,
              },
            ),
          )
          .pipe(Effect.mapError(operationErrors.fromCause("walkthrough")))
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
    )
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

const readWalkthroughOutput = (path: string, result: ProcessResult) =>
  Effect.tryPromise({
    try: async () => {
      try {
        const output = await readFile(path, "utf8")
        return output.trim().length > 0 ? output : result.stdout
      } catch {
        return result.stdout
      }
    },
    catch: operationErrors.fromCause("walkthrough"),
  })

interface PendingArtifact {
  readonly type: AgentArtifactCandidate["type"]
  readonly title: string
  readonly content: string
  readonly metadata: Readonly<Record<string, unknown>>
}

type CodexTurnLifecycle =
  | { readonly stage: "AwaitingThreadStart" }
  | { readonly stage: "AwaitingTurnStart"; readonly threadId: string }
  | { readonly stage: "TurnInProgress"; readonly threadId: string }
  | { readonly stage: "TurnCompleted"; readonly threadId: string }

interface CompletedAgentMessage {
  readonly sequence: number
  readonly text: string
}

interface CodexTurnState {
  lifecycle: CodexTurnLifecycle
  nextAgentMessageSequence: number
  usage: AgentUsage | null
  readonly agentMessages: CompletedAgentMessage[]
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
    yield* requirePolicy("review-thread", request.policy, CODEX_REVIEW_POLICY)
    if (!isScopedMcpToolSubset(request.mcp.allowedTools, request.policy.allowedMcpTools)) {
      return yield* operationErrors.fromReason(
        "review-thread",
        "Scoped MCP access includes tools outside the execution policy",
      )
    }

    return yield* withOutputSchemaPath(dependencies.tempDirectory, (outputSchemaPath) =>
      Effect.gen(function* () {
        const state: CodexTurnState = {
          lifecycle: { stage: "AwaitingThreadStart" },
          nextAgentMessageSequence: 0,
          usage: null,
          agentMessages: [],
          artifacts: [],
        }
        yield* dependencies.processes
          .streamLines(
            processRequest(executable, makeReviewArgs(request, outputSchemaPath), {
              cwd: request.workingDirectory,
              env: { [mcpTokenEnvironmentVariable]: revealScopedMcpToken(request.mcp) },
              stdin: `${request.stablePrompt}\n\n${request.dynamicPrompt}\n`,
              timeoutMs: request.timeoutMs,
            }),
          )
          .pipe(
            Stream.mapError(operationErrors.fromCause("review-thread")),
            Stream.runForEach((event) => {
              const { _tag: tag } = event
              return tag === "ProcessLine" && event.source === "stdout"
                ? consumeCodexLine(state, event.line)
                : Effect.void
            }),
          )

        if (state.lifecycle.stage !== "TurnCompleted") {
          return yield* operationErrors.fromReason(
            "review-thread",
            `Codex stream ended without a complete turn lifecycle (stopped at ${state.lifecycle.stage})`,
          )
        }
        const response = yield* decodeReviewResponse(selectFinalAgentMessage(state.agentMessages))
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
    if (type === null) {
      return yield* operationErrors.fromReason(
        "review-thread",
        "Codex emitted an event without a type",
      )
    }

    switch (type) {
      case "thread.started": {
        if (state.lifecycle.stage !== "AwaitingThreadStart") {
          return yield* invalidLifecycleEvent(state, type, "thread.started as the first event")
        }
        const threadId = nonBlankStringAt(event, "thread_id")
        if (threadId === null) {
          return yield* operationErrors.fromReason(
            "review-thread",
            "Codex thread.started event omitted thread_id",
          )
        }
        state.lifecycle = { stage: "AwaitingTurnStart", threadId }
        return
      }
      case "turn.started":
        if (state.lifecycle.stage !== "AwaitingTurnStart") {
          return yield* invalidLifecycleEvent(state, type, "thread.started")
        }
        state.lifecycle = { stage: "TurnInProgress", threadId: state.lifecycle.threadId }
        return
      case "turn.completed":
        if (state.lifecycle.stage !== "TurnInProgress") {
          return yield* invalidLifecycleEvent(state, type, "turn.started")
        }
        state.lifecycle = { stage: "TurnCompleted", threadId: state.lifecycle.threadId }
        state.usage = parseCodexUsage(recordAt(event, "usage"))
        return
      case "turn.failed":
        if (state.lifecycle.stage !== "TurnInProgress") {
          return yield* invalidLifecycleEvent(state, type, "turn.started")
        }
        return yield* operationErrors.fromReason(
          "review-thread",
          errorMessage(event) ?? `Codex emitted ${type}`,
        )
      case "error":
        return yield* operationErrors.fromReason(
          "review-thread",
          errorMessage(event) ?? `Codex emitted ${type}`,
        )
      case "item.completed": {
        if (state.lifecycle.stage !== "TurnInProgress") {
          return yield* invalidLifecycleEvent(state, type, "turn.started")
        }
        const item = recordAt(event, "item")
        if (item === null) {
          return yield* operationErrors.fromReason(
            "review-thread",
            "Codex item.completed omitted item",
          )
        }
        return yield* consumeCompletedItem(state, item)
      }
      case "item.started":
      case "item.updated": {
        if (state.lifecycle.stage !== "TurnInProgress") {
          return yield* invalidLifecycleEvent(state, type, "turn.started")
        }
        const item = recordAt(event, "item")
        if (item === null) {
          return yield* operationErrors.fromReason("review-thread", `Codex ${type} omitted item`)
        }
        if (stringAt(item, "type") === "file_change") {
          return yield* operationErrors.fromReason(
            "review-thread",
            `Codex emitted a file change in ${type} despite the read-only sandbox`,
          )
        }
        return
      }
      default:
        return
    }
  })

interface CodexCompletedItemBase {
  readonly item: Readonly<Record<string, unknown>>
  readonly itemId: string | null
  readonly itemType: string
}

interface CodexAgentMessageItem extends CodexCompletedItemBase {
  readonly _tag: "AgentMessage"
}

interface CodexCommandExecutionItem extends CodexCompletedItemBase {
  readonly _tag: "CommandExecution"
}

interface CodexMcpToolCallItem extends CodexCompletedItemBase {
  readonly _tag: "McpToolCall"
}

interface CodexFileChangeItem extends CodexCompletedItemBase {
  readonly _tag: "FileChange"
}

interface CodexWebSearchItem extends CodexCompletedItemBase {
  readonly _tag: "WebSearch"
}

interface CodexRepositorySearchItem extends CodexCompletedItemBase {
  readonly _tag: "RepositorySearch"
}

interface CodexUnknownCompletedItem extends CodexCompletedItemBase {
  readonly _tag: "Unknown"
}

type CodexCompletedItem =
  | CodexAgentMessageItem
  | CodexCommandExecutionItem
  | CodexMcpToolCallItem
  | CodexFileChangeItem
  | CodexWebSearchItem
  | CodexRepositorySearchItem
  | CodexUnknownCompletedItem

const codexWebSearchItemTypes = new Set(["web_search", "web_search_call", "web_search_result"])
const codexRepositorySearchItemTypes = new Set([
  "local_search",
  "repository_search",
  "workspace_search",
])
const codexGenericSearchItemTypes = new Set([
  "code_search",
  "file_search",
  "search",
  "search_result",
])
const codexWebSearchSemanticValues = new Set(["browser", "internet", "remote", "web"])
const codexRepositorySearchSemanticValues = new Set([
  "code",
  "file",
  "filesystem",
  "local",
  "repository",
  "workspace",
])

const consumeCompletedItem = (
  state: CodexTurnState,
  item: Readonly<Record<string, unknown>>,
): Effect.Effect<void, AgentProviderOperationError> =>
  Effect.gen(function* () {
    const completedItem = discriminateCompletedItem(item)
    const { _tag: itemTag } = completedItem
    switch (itemTag) {
      case "AgentMessage": {
        const adapted = yield* adaptAgentMessageItem(completedItem)
        state.agentMessages.push({
          sequence: state.nextAgentMessageSequence,
          text: adapted.text,
        })
        state.nextAgentMessageSequence += 1
        state.artifacts.push(adapted.artifact)
        return
      }
      case "CommandExecution":
        state.artifacts.push(adaptCommandExecutionItem(completedItem))
        return
      case "McpToolCall":
        state.artifacts.push(adaptMcpToolCallItem(completedItem))
        return
      case "FileChange":
        return yield* adaptFileChangeItem()
      case "WebSearch":
        state.artifacts.push(adaptWebSearchItem(completedItem))
        return
      case "RepositorySearch":
        state.artifacts.push(adaptRepositorySearchItem(completedItem))
        return
      case "Unknown":
        state.artifacts.push(adaptUnknownCompletedItem(completedItem))
        return
    }
  })

const discriminateCompletedItem = (item: Readonly<Record<string, unknown>>): CodexCompletedItem => {
  const itemId = nonBlankStringAt(item, "id")
  const itemType = nonBlankStringAt(item, "type") ?? "unknown"
  const common = { item, itemId, itemType }
  switch (itemType) {
    case "agent_message":
      return { _tag: "AgentMessage", ...common }
    case "command_execution":
      return { _tag: "CommandExecution", ...common }
    case "mcp_tool_call":
      return { _tag: "McpToolCall", ...common }
    case "file_change":
      return { _tag: "FileChange", ...common }
    default:
      if (isWebSearchItem(itemType, item)) return { _tag: "WebSearch", ...common }
      if (isRepositorySearchItem(itemType, item)) {
        return { _tag: "RepositorySearch", ...common }
      }
      return { _tag: "Unknown", ...common }
  }
}

const adaptAgentMessageItem = (
  completedItem: CodexAgentMessageItem,
): Effect.Effect<
  { readonly text: string; readonly artifact: PendingArtifact },
  AgentProviderOperationError
> => {
  const text = firstNonBlankStringAtPaths(completedItem.item, [
    ["text"],
    ["message", "text"],
    ["content", "text"],
    ["output", "text"],
  ])
  if (text === null) {
    return operationErrors.fromReason("review-thread", "Codex agent message omitted text")
  }
  return Effect.succeed({
    text,
    artifact: {
      type: "provider-message",
      title: "Codex assistant message",
      content: text,
      metadata: metadata({
        itemId: completedItem.itemId,
        status: extractItemStatus(completedItem.item),
      }),
    },
  })
}

const adaptCommandExecutionItem = (completedItem: CodexCommandExecutionItem): PendingArtifact => {
  const command =
    firstNonBlankStringAtPaths(completedItem.item, [
      ["command"],
      ["command", "text"],
      ["details", "command"],
    ]) ?? "command"
  const status = extractItemStatus(completedItem.item)
  const content =
    firstContentAtPaths(completedItem.item, [
      ["aggregated_output"],
      ["aggregatedOutput"],
      ["output"],
      ["result", "output"],
      ["result", "content"],
      ["error"],
    ]) ?? usefulItemFallback({ command, status }, completedItem.item)
  return {
    type: "shell-output",
    title: boundedArtifactTitle("Codex command", command),
    content,
    metadata: metadata({
      itemId: completedItem.itemId,
      command,
      status,
      exitCode: firstNumberAtPaths(completedItem.item, [
        ["exit_code"],
        ["exitCode"],
        ["result", "exit_code"],
        ["result", "exitCode"],
      ]),
    }),
  }
}

const adaptMcpToolCallItem = (completedItem: CodexMcpToolCallItem): PendingArtifact => {
  const server =
    firstNonBlankStringAtPaths(completedItem.item, [
      ["server"],
      ["mcp", "server"],
      ["details", "server"],
    ]) ?? "unknown"
  const tool =
    firstNonBlankStringAtPaths(completedItem.item, [
      ["tool"],
      ["mcp", "tool"],
      ["details", "tool"],
    ]) ?? "unknown"
  const status = extractItemStatus(completedItem.item)
  const content =
    firstContentAtPaths(completedItem.item, [
      ["result", "content"],
      ["result", "structured_content"],
      ["result", "structuredContent"],
      ["result"],
      ["output"],
      ["error", "message"],
      ["error"],
    ]) ?? usefulItemFallback({ status }, completedItem.item)
  return {
    type: server === "diffdash" ? "mcp-tool-result" : "unknown",
    title: boundedArtifactTitle("Codex MCP", `${server}/${tool}`),
    content,
    metadata: metadata({ itemId: completedItem.itemId, server, tool, status }),
  }
}

const adaptFileChangeItem = (): Effect.Effect<never, AgentProviderOperationError> =>
  operationErrors.fromReason(
    "review-thread",
    "Codex emitted a file change in item.completed despite the read-only sandbox",
  )

const adaptWebSearchItem = (completedItem: CodexWebSearchItem): PendingArtifact =>
  adaptSearchItem(completedItem, "web-result", "Codex web search")

const adaptRepositorySearchItem = (completedItem: CodexRepositorySearchItem): PendingArtifact =>
  adaptSearchItem(completedItem, "search-result", "Codex repository search")

const adaptSearchItem = (
  completedItem: CodexWebSearchItem | CodexRepositorySearchItem,
  type: "web-result" | "search-result",
  title: string,
): PendingArtifact => {
  const query = extractSearchQuery(completedItem.item)
  const url = extractSearchUrl(completedItem.item)
  const status = extractItemStatus(completedItem.item)
  const content =
    firstContentAtPaths(completedItem.item, [
      ["content"],
      ["result", "content"],
      ["response", "content"],
      ["data", "content"],
      ["results"],
      ["result", "results"],
      ["response", "results"],
      ["output"],
      ["result", "output"],
      ["error", "message"],
      ["error"],
    ]) ?? usefulItemFallback({ query, url, status }, completedItem.item)
  return {
    type,
    title: boundedArtifactTitle(title, query ?? url ?? status),
    content,
    metadata: metadata({
      itemId: completedItem.itemId,
      eventType: completedItem.itemType,
      query,
      url,
      status,
    }),
  }
}

const adaptUnknownCompletedItem = (completedItem: CodexUnknownCompletedItem): PendingArtifact => {
  const status = extractItemStatus(completedItem.item)
  return {
    type: "unknown",
    title: boundedArtifactTitle("Unknown Codex completed item", completedItem.itemType),
    content: jsonContent(completedItem.item),
    metadata: metadata({
      itemId: completedItem.itemId,
      eventType: completedItem.itemType,
      status,
    }),
  }
}

const isWebSearchItem = (itemType: string, item: Readonly<Record<string, unknown>>) =>
  codexWebSearchItemTypes.has(itemType) ||
  (codexGenericSearchItemTypes.has(itemType) &&
    searchSemanticValues(item).some((value) => codexWebSearchSemanticValues.has(value)))

const isRepositorySearchItem = (itemType: string, item: Readonly<Record<string, unknown>>) =>
  codexRepositorySearchItemTypes.has(itemType) ||
  (codexGenericSearchItemTypes.has(itemType) &&
    searchSemanticValues(item).some((value) => codexRepositorySearchSemanticValues.has(value)))

const searchSemanticValues = (item: Readonly<Record<string, unknown>>) =>
  [
    ["scope"],
    ["source"],
    ["kind"],
    ["search_type"],
    ["searchType"],
    ["search", "scope"],
    ["search", "source"],
    ["details", "scope"],
    ["details", "source"],
    ["action", "scope"],
  ]
    .map((path) => stringAtPath(item, path))
    .filter((value): value is string => value !== null)
    .map((value) => value.trim().toLowerCase())

const extractSearchQuery = (item: Readonly<Record<string, unknown>>) => {
  const query = firstNonBlankStringAtPaths(item, [
    ["query"],
    ["search_query"],
    ["searchQuery"],
    ["action", "query"],
    ["action", "search_query"],
    ["search", "query"],
    ["request", "query"],
    ["details", "query"],
    ["data", "query"],
    ["result", "query"],
    ["response", "query"],
  ])
  if (query !== null) return query
  const queries = firstStringArrayAtPaths(item, [
    ["queries"],
    ["action", "queries"],
    ["request", "queries"],
    ["details", "queries"],
  ])
  return queries.length === 0 ? null : queries.join("\n")
}

const extractSearchUrl = (item: Readonly<Record<string, unknown>>) =>
  firstNonBlankStringAtPaths(item, [
    ["url"],
    ["action", "url"],
    ["page", "url"],
    ["result", "url"],
    ["response", "url"],
    ["details", "url"],
    ["data", "url"],
  ])

const extractItemStatus = (item: Readonly<Record<string, unknown>>) =>
  firstNonBlankStringAtPaths(item, [
    ["status"],
    ["state", "status"],
    ["result", "status"],
    ["response", "status"],
    ["details", "status"],
    ["data", "status"],
  ])

const usefulItemFallback = (
  details: {
    readonly command?: string | null
    readonly query?: string | null
    readonly url?: string | null
    readonly status?: string | null
  },
  item: Readonly<Record<string, unknown>>,
) => {
  const summary = [
    details.command === null || details.command === undefined
      ? null
      : `Command: ${details.command}`,
    details.query === null || details.query === undefined ? null : `Query: ${details.query}`,
    details.url === null || details.url === undefined ? null : `URL: ${details.url}`,
    details.status === null || details.status === undefined ? null : `Status: ${details.status}`,
  ].filter((value): value is string => value !== null)
  return summary.length > 0 ? summary.join("\n") : jsonContent(item)
}

const firstContentAtPaths = (
  item: Readonly<Record<string, unknown>>,
  paths: readonly (readonly string[])[],
) => {
  for (const path of paths) {
    const value = valueAtPath(item, path)
    if (value === null || value === undefined) continue
    const content = jsonContent(value)
    if (content.trim().length > 0 && content !== "[]" && content !== "{}") return content
  }
  return null
}

const firstNonBlankStringAtPaths = (
  item: Readonly<Record<string, unknown>>,
  paths: readonly (readonly string[])[],
) => {
  for (const path of paths) {
    const value = stringAtPath(item, path)
    if (value !== null && value.trim().length > 0) return value
  }
  return null
}

const firstNumberAtPaths = (
  item: Readonly<Record<string, unknown>>,
  paths: readonly (readonly string[])[],
) => {
  for (const path of paths) {
    const value = valueAtPath(item, path)
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

const firstStringArrayAtPaths = (
  item: Readonly<Record<string, unknown>>,
  paths: readonly (readonly string[])[],
) => {
  for (const path of paths) {
    const value = valueAtPath(item, path)
    if (!Array.isArray(value)) continue
    const strings = value.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    )
    if (strings.length > 0) return strings
  }
  return []
}

const stringAtPath = (item: Readonly<Record<string, unknown>>, path: readonly string[]) => {
  const value = valueAtPath(item, path)
  return typeof value === "string" ? value : null
}

const valueAtPath = (item: Readonly<Record<string, unknown>>, path: readonly string[]): unknown => {
  let value: unknown = item
  for (const key of path) {
    if (!Predicate.isReadonlyRecord(value)) return undefined
    value = value[key]
  }
  return value
}

const nonBlankStringAt = (item: Readonly<Record<string, unknown>>, key: string) => {
  const value = stringAt(item, key)
  return value !== null && value.trim().length > 0 ? value : null
}

const boundedArtifactTitle = (prefix: string, detail: string | null) => {
  const title = detail === null ? prefix : `${prefix}: ${detail.replace(/\s+/gu, " ").trim()}`
  return title.length <= 200 ? title : `${title.slice(0, 197)}...`
}

const selectFinalAgentMessage = (messages: readonly CompletedAgentMessage[]) => {
  let selected: CompletedAgentMessage | null = null
  for (const message of messages) {
    if (selected === null || message.sequence > selected.sequence) selected = message
  }
  return selected?.text ?? null
}

const invalidLifecycleEvent = (state: CodexTurnState, eventType: string, expected: string) =>
  operationErrors.fromReason(
    "review-thread",
    `Codex emitted ${eventType} while lifecycle was ${state.lifecycle.stage}; expected ${expected}`,
  )

const parseJsonLine = (line: string) =>
  parseProviderJsonlObject(line).pipe(
    Effect.mapError((cause) =>
      operationErrors.fromReason("review-thread", `Codex emitted invalid JSONL: ${cause.reason}`),
    ),
  )

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
        reason: boundedProviderDiagnostic(
          `Codex returned an invalid review response: ${String(cause)}`,
        ),
      }),
    ),
  )
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

const withOutputSchemaPath = <A, E, R>(
  tempDirectory: string | undefined,
  use: (path: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | AgentProviderOperationError, R> =>
  Effect.scoped(
    makeTempFileScoped(JSON.stringify(reviewResponseJsonSchema), {
      ...(tempDirectory === undefined ? {} : { parentDirectory: tempDirectory }),
      prefix: "diffdash-codex-",
      fileName: "review-thread-response.schema.json",
    }).pipe(Effect.mapError(operationErrors.fromCause("review-thread")), Effect.flatMap(use)),
  )

const requirePolicy = (
  capability: AgentCapability,
  policy: AgentExecutionPolicy,
  expected: AgentExecutionPolicy,
) => {
  const valid = isAgentExecutionPolicyEnforced(policy, expected)
  return valid
    ? Effect.void
    : operationErrors.fromReason(capability, "Codex requires the explicit non-mutating policy")
}

const errorMessage = (event: Readonly<Record<string, unknown>>) => {
  const direct = stringAt(event, "message")
  if (direct !== null) return direct
  const error = recordAt(event, "error")
  return error === null ? null : stringAt(error, "message")
}

/** Converts a provider-owned model to its SDK identity. */
export const codexModelId = (model: string) => AgentModelId.make(model)

/** Converts host tool names to SDK identities for a scoped review request. */
export const codexMcpToolNames = (tools: readonly string[]) =>
  tools.map((tool) => McpToolName.make(tool))

/** Redacts a token at the host/provider boundary. */
export const codexMcpToken = (token: string) => Redacted.make(token)
