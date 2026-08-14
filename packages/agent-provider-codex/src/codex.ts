import { Effect, Match, Option, Schema, Stream } from "effect"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

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
  AgentSessionSupport,
  AgentUsage,
  InvalidAgentProviderResponseError,
  isAgentExecutionPolicyEnforced,
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
  normalizeReviewThreadAgentResponse as normalizeResponse,
  REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA as reviewResponseJsonSchema,
  ReviewThreadAgentResponse,
} from "@diffdash/domain/review-agent"
import {
  parseProviderJsonText as parseJsonText,
  providerJsonContent as jsonContent,
} from "@diffdash/agent-provider/provider-json"
import { makeNonMutatingAgentExecutionPolicy } from "@diffdash/agent-provider/policy"
import {
  boundedProviderDiagnostic,
  makeAgentProviderOperationErrorFactory,
  probeAgentRuntime,
  projectAgentCapabilityProbe,
} from "@diffdash/agent-provider/runtime"
import { isScopedMcpToolSubset } from "@diffdash/agent-provider/security"
import { processRequest, type ProcessResult, type ProcessRunner } from "@diffdash/process"
import {
  defaultExecutablePath,
  findExecutableInPath,
  type ExecutablePath,
} from "@diffdash/process/executable"
import type { TempResourceOperations } from "@diffdash/process/temp-resource"

const providerId = AgentProviderId.make("codex")
const executable = "codex"
const mcpTokenEnvironmentVariable = "DIFFDASH_MCP_BEARER_TOKEN"
const operationErrors = makeAgentProviderOperationErrorFactory({
  providerId,
  fallbackReason: "Codex execution failed",
})

/** Codex model selected for new installations. */
export const CODEX_DEFAULT_MODEL = AgentModelId.make("gpt-5.6-terra")

/** Codex models and quality metadata owned by this provider. */
export const CODEX_MODELS = [
  AgentModelDescriptor.make({
    id: AgentModelId.make("gpt-5.6-sol"),
    displayName: "GPT 5.6 Sol",
    capabilities: ["walkthrough", "review-thread"],
    quality: "best",
  }),
  AgentModelDescriptor.make({
    id: CODEX_DEFAULT_MODEL,
    displayName: "GPT 5.6 Terra",
    capabilities: ["walkthrough", "review-thread"],
    quality: "balanced",
  }),
  AgentModelDescriptor.make({
    id: AgentModelId.make("gpt-5.6-luna"),
    displayName: "GPT 5.6 Luna",
    capabilities: ["walkthrough", "review-thread"],
    quality: "fast",
  }),
] as const

/** Static Codex provider contribution. */
export const CODEX_MANIFEST = AgentProviderManifest.make({
  descriptor: AgentProviderDescriptor.make({
    id: providerId,
    displayName: "Codex",
    description: "Local OpenAI Codex CLI integration.",
    homepage: WebUrl.make("https://developers.openai.com/codex/cli"),
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
  readonly tempResources: TempResourceOperations
  readonly tempDirectory?: string
  readonly executablePath?: string
}

/** Options used to resolve Codex without relying on an interactive shell. */
export interface ResolveCodexExecutableOptions {
  readonly envPath?: string
  readonly home?: string
  readonly pathExt?: string
  readonly platform?: NodeJS.Platform
}

/** Resolves Codex through Bun's user install directory before the GUI-safe PATH. */
export const resolveCodexExecutable = (
  options: ResolveCodexExecutableOptions = {},
): Effect.Effect<Option.Option<ExecutablePath>> => {
  const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? ""
  const guiPath = defaultExecutablePath(options.envPath ?? process.env.PATH ?? "", home)
  const bunBin = home.length > 0 ? join(home, ".bun", "bin") : ""
  const normalizedPath = bunBin.length === 0 ? guiPath : [bunBin, guiPath].join(delimiter)
  return findExecutableInPath(executable, {
    envPath: normalizedPath,
    ...(options.pathExt === undefined ? {} : { pathExt: options.pathExt }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  })
}

/** Creates the complete Codex SDK registration. */
export const makeCodexProvider = (
  dependencies: CodexProviderDependencies,
): AgentProviderRegistration => {
  const runtimeProbe = probeRuntime(dependencies)
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

const probeRuntime = (dependencies: CodexProviderDependencies) =>
  probeAgentRuntime({
    versionOutput: Effect.gen(function* () {
      const executablePath = yield* resolveRuntimeExecutable(dependencies, "walkthrough")
      return yield* dependencies.processes
        .run(processRequest(executablePath, ["--version"], { timeoutMs: 5_000 }))
        .pipe(Effect.map((result) => result.stdout))
    }),
    unavailableReason: "Codex is not installed or available",
  })

const executeWalkthrough = (
  dependencies: CodexProviderDependencies,
  request: WalkthroughRequest,
): Effect.Effect<
  WalkthroughResult,
  AgentProviderOperationError | InvalidAgentProviderResponseError
> =>
  Effect.gen(function* () {
    yield* requirePolicy("walkthrough", request.policy, CODEX_WALKTHROUGH_POLICY)
    const executablePath = yield* resolveRuntimeExecutable(dependencies, "walkthrough")
    const tempDirectory = dependencies.tempDirectory ?? tmpdir()
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const outputPath = yield* dependencies.tempResources
          .makeTempOutputPathScoped({
            parentDirectory: tempDirectory,
            prefix: "codex-output-",
            fileName: "output.txt",
          })
          .pipe(Effect.mapError(operationErrors.fromCause("walkthrough")))
        const result = yield* dependencies.processes
          .run(
            processRequest(
              executablePath,
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
  readonly metadata: AgentArtifactCandidate["metadata"]
}

const CodexJsonObject = Schema.StructWithRest(Schema.Struct({}), [
  Schema.Record(Schema.String, Schema.Json),
])

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const CodexNonBlankString = Schema.String.check(
  Schema.makeFilter((value) => value.trim().length > 0),
)

const CodexUsage = Schema.Struct({
  input_tokens: Schema.optionalKey(NonNegativeFinite),
  output_tokens: Schema.optionalKey(NonNegativeFinite),
  cached_input_tokens: Schema.optionalKey(NonNegativeFinite),
})
type CodexUsage = typeof CodexUsage.Type

const CodexCommandDetails = Schema.Struct({ text: Schema.optionalKey(CodexNonBlankString) })

const CodexItemSection = Schema.StructWithRest(
  Schema.Struct({
    text: Schema.optionalKey(CodexNonBlankString),
    command: Schema.optionalKey(Schema.Union([CodexNonBlankString, CodexCommandDetails])),
    content: Schema.optionalKey(Schema.Json),
    output: Schema.optionalKey(Schema.Json),
    status: Schema.optionalKey(CodexNonBlankString),
    server: Schema.optionalKey(CodexNonBlankString),
    tool: Schema.optionalKey(CodexNonBlankString),
    scope: Schema.optionalKey(CodexNonBlankString),
    source: Schema.optionalKey(CodexNonBlankString),
    kind: Schema.optionalKey(CodexNonBlankString),
    query: Schema.optionalKey(CodexNonBlankString),
    search_query: Schema.optionalKey(CodexNonBlankString),
    searchQuery: Schema.optionalKey(CodexNonBlankString),
    queries: Schema.optionalKey(Schema.Array(CodexNonBlankString)),
    url: Schema.optionalKey(CodexNonBlankString),
    results: Schema.optionalKey(Schema.Json),
    structured_content: Schema.optionalKey(Schema.Json),
    structuredContent: Schema.optionalKey(Schema.Json),
    exit_code: Schema.optionalKey(Schema.Finite),
    exitCode: Schema.optionalKey(Schema.Finite),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
)
type CodexItemSection = typeof CodexItemSection.Type

const CodexItem = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.optionalKey(CodexNonBlankString),
    type: Schema.optionalKey(CodexNonBlankString),
    text: Schema.optionalKey(CodexNonBlankString),
    command: Schema.optionalKey(Schema.Union([CodexNonBlankString, CodexCommandDetails])),
    aggregated_output: Schema.optionalKey(Schema.Json),
    aggregatedOutput: Schema.optionalKey(Schema.Json),
    output: Schema.optionalKey(Schema.Json),
    content: Schema.optionalKey(Schema.Json),
    results: Schema.optionalKey(Schema.Json),
    error: Schema.optionalKey(Schema.Json),
    status: Schema.optionalKey(CodexNonBlankString),
    server: Schema.optionalKey(CodexNonBlankString),
    tool: Schema.optionalKey(CodexNonBlankString),
    scope: Schema.optionalKey(CodexNonBlankString),
    source: Schema.optionalKey(CodexNonBlankString),
    kind: Schema.optionalKey(CodexNonBlankString),
    search_type: Schema.optionalKey(CodexNonBlankString),
    searchType: Schema.optionalKey(CodexNonBlankString),
    query: Schema.optionalKey(CodexNonBlankString),
    search_query: Schema.optionalKey(CodexNonBlankString),
    searchQuery: Schema.optionalKey(CodexNonBlankString),
    queries: Schema.optionalKey(Schema.Array(CodexNonBlankString)),
    url: Schema.optionalKey(CodexNonBlankString),
    exit_code: Schema.optionalKey(Schema.Finite),
    exitCode: Schema.optionalKey(Schema.Finite),
    action: Schema.optionalKey(CodexItemSection),
    search: Schema.optionalKey(CodexItemSection),
    details: Schema.optionalKey(CodexItemSection),
    request: Schema.optionalKey(CodexItemSection),
    result: Schema.optionalKey(CodexItemSection),
    response: Schema.optionalKey(CodexItemSection),
    data: Schema.optionalKey(CodexItemSection),
    state: Schema.optionalKey(CodexItemSection),
    page: Schema.optionalKey(CodexItemSection),
    mcp: Schema.optionalKey(CodexItemSection),
    message: Schema.optionalKey(CodexItemSection),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
)
type CodexItem = typeof CodexItem.Type

const CodexProtocolEvent = Schema.Struct({
  type: Schema.optionalKey(CodexNonBlankString),
  thread_id: Schema.optionalKey(CodexNonBlankString),
  item: Schema.optionalKey(CodexItem),
  usage: Schema.optionalKey(CodexUsage),
  message: Schema.optionalKey(CodexNonBlankString),
  error: Schema.optionalKey(Schema.Json),
})
type CodexProtocolEvent = typeof CodexProtocolEvent.Type

const CodexJsonFromString = Schema.fromJsonString(Schema.Json)
const CodexErrorDetails = Schema.Struct({ message: Schema.String })

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
        "policy-violation",
      )
    }
    const executablePath = yield* resolveRuntimeExecutable(dependencies, "review-thread")

    return yield* withOutputSchemaPath(
      dependencies.tempResources,
      dependencies.tempDirectory,
      (outputSchemaPath) =>
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
              processRequest(executablePath, makeReviewArgs(request, outputSchemaPath), {
                cwd: request.workingDirectory,
                env: { [mcpTokenEnvironmentVariable]: revealScopedMcpToken(request.mcp) },
                stdin: `${request.stablePrompt}\n\n${request.dynamicPrompt}\n`,
                timeoutMs: request.timeoutMs,
              }),
            )
            .pipe(
              Stream.mapError(operationErrors.fromCause("review-thread")),
              Stream.runForEach((event) => {
                return Match.value(event).pipe(
                  Match.when({ _tag: "ProcessLine", source: "stdout" }, (line) =>
                    consumeCodexLine(state, line.line),
                  ),
                  Match.orElse(() => Effect.void),
                )
              }),
            )

          if (state.lifecycle.stage !== "TurnCompleted") {
            return yield* operationErrors.fromReason(
              "review-thread",
              `Codex stream ended without a complete turn lifecycle (stopped at ${state.lifecycle.stage})`,
              "invalid-response",
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
    const type = event.type ?? null
    if (type === null) {
      return yield* operationErrors.fromReason(
        "review-thread",
        "Codex emitted an event without a type",
        "invalid-response",
      )
    }

    switch (type) {
      case "thread.started": {
        if (state.lifecycle.stage !== "AwaitingThreadStart") {
          return yield* invalidLifecycleEvent(state, type, "thread.started as the first event")
        }
        const threadId =
          event.thread_id === undefined || event.thread_id.trim().length === 0
            ? null
            : event.thread_id
        if (threadId === null) {
          return yield* operationErrors.fromReason(
            "review-thread",
            "Codex thread.started event omitted thread_id",
            "invalid-response",
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
        state.usage = toAgentUsage(event.usage ?? null)
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
        const item = event.item ?? null
        if (item === null) {
          return yield* operationErrors.fromReason(
            "review-thread",
            "Codex item.completed omitted item",
            "invalid-response",
          )
        }
        return yield* consumeCompletedItem(state, item)
      }
      case "item.started":
      case "item.updated": {
        if (state.lifecycle.stage !== "TurnInProgress") {
          return yield* invalidLifecycleEvent(state, type, "turn.started")
        }
        const item = event.item ?? null
        if (item === null) {
          return yield* operationErrors.fromReason(
            "review-thread",
            `Codex ${type} omitted item`,
            "invalid-response",
          )
        }
        if (item.type === "file_change") {
          return yield* operationErrors.fromReason(
            "review-thread",
            `Codex emitted a file change in ${type} despite the read-only sandbox`,
            "policy-violation",
          )
        }
        return
      }
      default:
        return
    }
  })

interface CodexCompletedItemBase {
  readonly item: CodexItem
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
  item: CodexItem,
): Effect.Effect<void, AgentProviderOperationError> =>
  Effect.gen(function* () {
    const completedItem = discriminateCompletedItem(item)
    yield* Match.value(completedItem).pipe(
      Match.when({ _tag: "AgentMessage" }, (agentMessage) =>
        Effect.gen(function* () {
          const adapted = yield* adaptAgentMessageItem(agentMessage)
          state.agentMessages.push({
            sequence: state.nextAgentMessageSequence,
            text: adapted.text,
          })
          state.nextAgentMessageSequence += 1
          state.artifacts.push(adapted.artifact)
        }),
      ),
      Match.when({ _tag: "CommandExecution" }, (commandExecution) =>
        Effect.sync(() => {
          state.artifacts.push(adaptCommandExecutionItem(commandExecution))
        }),
      ),
      Match.when({ _tag: "McpToolCall" }, (mcpToolCall) =>
        Effect.sync(() => {
          state.artifacts.push(adaptMcpToolCallItem(mcpToolCall))
        }),
      ),
      Match.when({ _tag: "FileChange" }, () => adaptFileChangeItem()),
      Match.when({ _tag: "WebSearch" }, (webSearch) =>
        Effect.sync(() => {
          state.artifacts.push(adaptWebSearchItem(webSearch))
        }),
      ),
      Match.when({ _tag: "RepositorySearch" }, (repositorySearch) =>
        Effect.sync(() => {
          state.artifacts.push(adaptRepositorySearchItem(repositorySearch))
        }),
      ),
      Match.when({ _tag: "Unknown" }, (unknown) =>
        Effect.sync(() => {
          state.artifacts.push(adaptUnknownCompletedItem(unknown))
        }),
      ),
      Match.exhaustive,
    )
  })

const discriminateCompletedItem = (item: CodexItem): CodexCompletedItem => {
  const itemId = item.id ?? null
  const itemType = item.type ?? "unknown"
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
  const content = Option.getOrNull(
    Schema.decodeUnknownOption(CodexItemSection)(completedItem.item.content),
  )
  const output = Option.getOrNull(
    Schema.decodeUnknownOption(CodexItemSection)(completedItem.item.output),
  )
  const text =
    completedItem.item.text ??
    completedItem.item.message?.text ??
    content?.text ??
    output?.text ??
    null
  if (text === null) {
    return operationErrors.fromReason(
      "review-thread",
      "Codex agent message omitted text",
      "invalid-response",
    )
  }
  const status = extractItemStatus(completedItem.item)
  return Effect.succeed({
    text,
    artifact: {
      type: "provider-message",
      title: "Codex assistant message",
      content: text,
      metadata: {
        ...(completedItem.itemId === null ? {} : { itemId: completedItem.itemId }),
        ...(status === null ? {} : { status }),
      },
    },
  })
}

const adaptCommandExecutionItem = (completedItem: CodexCommandExecutionItem): PendingArtifact => {
  const command =
    commandText(completedItem.item.command) ??
    commandText(completedItem.item.details?.command) ??
    "command"
  const status = extractItemStatus(completedItem.item)
  const exitCode =
    completedItem.item.exit_code ??
    completedItem.item.exitCode ??
    completedItem.item.result?.exit_code ??
    completedItem.item.result?.exitCode ??
    null
  const content =
    firstCodexContent([
      completedItem.item.aggregated_output,
      completedItem.item.aggregatedOutput,
      completedItem.item.output,
      completedItem.item.result?.output,
      completedItem.item.result?.content,
      completedItem.item.error,
    ]) ?? usefulItemFallback({ command, status }, completedItem.item)
  return {
    type: "shell-output",
    title: boundedArtifactTitle("Codex command", command),
    content,
    metadata: {
      ...(completedItem.itemId === null ? {} : { itemId: completedItem.itemId }),
      command,
      ...(status === null ? {} : { status }),
      ...(exitCode === null ? {} : { exitCode }),
    },
  }
}

const adaptMcpToolCallItem = (completedItem: CodexMcpToolCallItem): PendingArtifact => {
  const server =
    completedItem.item.server ??
    completedItem.item.mcp?.server ??
    completedItem.item.details?.server ??
    "unknown"
  const tool =
    completedItem.item.tool ??
    completedItem.item.mcp?.tool ??
    completedItem.item.details?.tool ??
    "unknown"
  const status = extractItemStatus(completedItem.item)
  const content =
    firstCodexContent([
      completedItem.item.result?.content,
      completedItem.item.result?.structured_content,
      completedItem.item.result?.structuredContent,
      completedItem.item.result,
      completedItem.item.output,
      Option.getOrNull(Schema.decodeUnknownOption(CodexErrorDetails)(completedItem.item.error))
        ?.message,
      completedItem.item.error,
    ]) ?? usefulItemFallback({ status }, completedItem.item)
  return {
    type: server === "diffdash" ? "mcp-tool-result" : "unknown",
    title: boundedArtifactTitle("Codex MCP", `${server}/${tool}`),
    content,
    metadata: {
      ...(completedItem.itemId === null ? {} : { itemId: completedItem.itemId }),
      server,
      tool,
      ...(status === null ? {} : { status }),
    },
  }
}

const adaptFileChangeItem = (): Effect.Effect<never, AgentProviderOperationError> =>
  operationErrors.fromReason(
    "review-thread",
    "Codex emitted a file change in item.completed despite the read-only sandbox",
    "policy-violation",
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
    firstCodexContent([
      completedItem.item.content,
      completedItem.item.result?.content,
      completedItem.item.response?.content,
      completedItem.item.data?.content,
      completedItem.item.results,
      completedItem.item.result?.results,
      completedItem.item.response?.results,
      completedItem.item.output,
      completedItem.item.result?.output,
      Option.getOrNull(Schema.decodeUnknownOption(CodexErrorDetails)(completedItem.item.error))
        ?.message,
      completedItem.item.error,
    ]) ?? usefulItemFallback({ query, url, status }, completedItem.item)
  return {
    type,
    title: boundedArtifactTitle(title, query ?? url ?? status),
    content,
    metadata: {
      ...(completedItem.itemId === null ? {} : { itemId: completedItem.itemId }),
      eventType: completedItem.itemType,
      ...(query === null ? {} : { query }),
      ...(url === null ? {} : { url }),
      ...(status === null ? {} : { status }),
    },
  }
}

const adaptUnknownCompletedItem = (completedItem: CodexUnknownCompletedItem): PendingArtifact => {
  const status = extractItemStatus(completedItem.item)
  return {
    type: "unknown",
    title: boundedArtifactTitle("Unknown Codex completed item", completedItem.itemType),
    content: jsonContent(completedItem.item),
    metadata: {
      ...(completedItem.itemId === null ? {} : { itemId: completedItem.itemId }),
      eventType: completedItem.itemType,
      ...(status === null ? {} : { status }),
    },
  }
}

const isWebSearchItem = (itemType: string, item: CodexItem) =>
  codexWebSearchItemTypes.has(itemType) ||
  (codexGenericSearchItemTypes.has(itemType) &&
    searchSemanticValues(item).some((value) => codexWebSearchSemanticValues.has(value)))

const isRepositorySearchItem = (itemType: string, item: CodexItem) =>
  codexRepositorySearchItemTypes.has(itemType) ||
  (codexGenericSearchItemTypes.has(itemType) &&
    searchSemanticValues(item).some((value) => codexRepositorySearchSemanticValues.has(value)))

const searchSemanticValues = (item: CodexItem) =>
  [
    item.scope,
    item.source,
    item.kind,
    item.search_type,
    item.searchType,
    item.search?.scope,
    item.search?.source,
    item.details?.scope,
    item.details?.source,
    item.action?.scope,
  ]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.trim().toLowerCase())

const extractSearchQuery = (item: CodexItem) => {
  const query =
    item.query ??
    item.search_query ??
    item.searchQuery ??
    item.action?.query ??
    item.action?.search_query ??
    item.search?.query ??
    item.request?.query ??
    item.details?.query ??
    item.data?.query ??
    item.result?.query ??
    item.response?.query
  if (query !== undefined) return query
  const queries =
    [item.queries, item.action?.queries, item.request?.queries, item.details?.queries].find(
      (candidate) => candidate !== undefined && candidate.length > 0,
    ) ?? []
  return queries.length === 0 ? null : queries.join("\n")
}

const extractSearchUrl = (item: CodexItem) =>
  item.url ??
  item.action?.url ??
  item.page?.url ??
  item.result?.url ??
  item.response?.url ??
  item.details?.url ??
  item.data?.url ??
  null

const extractItemStatus = (item: CodexItem) =>
  item.status ??
  item.state?.status ??
  item.result?.status ??
  item.response?.status ??
  item.details?.status ??
  item.data?.status ??
  null

const usefulItemFallback = (
  details: {
    readonly command?: string | null
    readonly query?: string | null
    readonly url?: string | null
    readonly status?: string | null
  },
  item: CodexItem,
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

const firstCodexContent = <A>(values: readonly A[]) => {
  for (const value of values) {
    if (value === null || value === undefined) continue
    const content = jsonContent(value)
    if (content.trim().length > 0 && content !== "[]" && content !== "{}") return content
  }
  return null
}

const commandText = (command: string | typeof CodexCommandDetails.Type | undefined) =>
  Schema.is(Schema.String)(command) ? command : (command?.text ?? null)

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
    "invalid-response",
  )

const parseJsonLine = (line: string) =>
  Schema.decodeUnknownEffect(CodexJsonFromString)(line).pipe(
    Effect.mapError((cause) =>
      operationErrors.fromReason(
        "review-thread",
        `Codex emitted invalid JSONL: ${String(cause)}`,
        "invalid-response",
      ),
    ),
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(CodexJsonObject)(value).pipe(
        Effect.mapError(() =>
          operationErrors.fromReason(
            "review-thread",
            "Codex emitted invalid JSONL: event is not a JSON object",
            "invalid-response",
          ),
        ),
      ),
    ),
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(CodexProtocolEvent)(value).pipe(
        Effect.mapError((cause) =>
          operationErrors.fromReason(
            "review-thread",
            `Codex emitted a JSON value outside the Codex protocol: ${String(cause)}`,
            "invalid-response",
          ),
        ),
      ),
    ),
  )

const decodeReviewResponse = (
  finalMessage: string | null,
): Effect.Effect<ReviewThreadAgentResponse, InvalidAgentProviderResponseError> => {
  const parsed = finalMessage === null ? null : parseJsonValue(parseJsonText(finalMessage))
  const candidate = normalizeResponse(parsed)
  return Schema.decodeUnknownEffect(ReviewThreadAgentResponse)(candidate).pipe(
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

const parseJsonValue = <A>(value: A): Schema.Json =>
  Option.getOrElse(Schema.decodeUnknownOption(Schema.Json)(value), () => null)

const toAgentUsage = (usage: CodexUsage | null): AgentUsage | null =>
  usage === null
    ? null
    : AgentUsage.make({
        inputTokens: usage.input_tokens ?? null,
        outputTokens: usage.output_tokens ?? null,
        cacheReadTokens: usage.cached_input_tokens ?? null,
        cacheWriteTokens: null,
        costUsd: null,
      })

const withOutputSchemaPath = <A, E, R>(
  tempResources: TempResourceOperations,
  tempDirectory: string | undefined,
  use: (path: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | AgentProviderOperationError, R> =>
  Effect.scoped(
    tempResources
      .makeTempFileScoped(JSON.stringify(reviewResponseJsonSchema), {
        ...(tempDirectory === undefined ? {} : { parentDirectory: tempDirectory }),
        prefix: "diffdash-codex-",
        fileName: "review-thread-response.schema.json",
      })
      .pipe(Effect.mapError(operationErrors.fromCause("review-thread")), Effect.flatMap(use)),
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
        "Codex requires the explicit non-mutating policy",
        "policy-violation",
      )
}

const resolveRuntimeExecutable = (
  dependencies: CodexProviderDependencies,
  capability: AgentCapability,
): Effect.Effect<string, AgentProviderOperationError> =>
  dependencies.executablePath === undefined
    ? resolveCodexExecutable().pipe(
        Effect.flatMap((resolved) =>
          Option.match(resolved, {
            onNone: () =>
              operationErrors.fromReason(
                capability,
                "Codex is not installed or available",
                "configuration",
              ),
            onSome: (path) => Effect.succeed(path),
          }),
        ),
      )
    : Effect.succeed(dependencies.executablePath)

const errorMessage = (event: CodexProtocolEvent) => {
  if (event.message !== undefined) return event.message
  return (
    Option.getOrNull(Schema.decodeUnknownOption(CodexErrorDetails)(event.error))?.message ?? null
  )
}
