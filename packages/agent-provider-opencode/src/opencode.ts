import { createServer } from "node:net"
import { delimiter, join } from "node:path"

import {
  type Config,
  createOpencodeClient,
  type OpencodeClient,
  type Part,
} from "@opencode-ai/sdk/v2"
import { Deferred, Effect, Exit, Option, Redacted, Schema, Stream } from "effect"

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
  ReviewThreadResponse,
  ReviewThreadResult,
  type WalkthroughRequest,
  WalkthroughResult,
} from "@diffdash/agent-provider"
import { parseProviderJsonText } from "@diffdash/agent-provider/provider-json"
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
import { processRequest, type ProcessRunner } from "@diffdash/process"
import {
  defaultExecutablePath,
  findExecutableInPath,
  type ExecutablePath,
} from "@diffdash/process/executable"
import { makeTempFileScoped } from "@diffdash/process/temp-resource"

const providerId = AgentProviderId.make("opencode")
const executable = "opencode"
const operationErrors = makeAgentProviderOperationErrorFactory({
  providerId,
  fallbackReason: "OpenCode execution failed",
})
const walkthroughMessage =
  "Generate a DiffDash walkthrough from the attached prompt file. Return JSON only."

/** Stable OpenCode provider identity. */
export const OPENCODE_PROVIDER_ID = providerId

/** OpenCode model selected for new installations. */
export const OPENCODE_DEFAULT_MODEL = AgentModelId.make("openai/gpt-5.3-codex-spark")

/** OpenCode models and quality metadata owned by this provider. */
export const OPENCODE_MODELS = [
  modelDescriptor("openai/gpt-5.5", "GPT 5.5", "best"),
  modelDescriptor("openai/gpt-5.3-codex-spark", "GPT 5.3 Codex Spark", "balanced"),
  modelDescriptor("openai/gpt-5.4-mini", "GPT 5.4 Mini", "fast"),
  modelDescriptor("anthropic/claude-opus-4-8", "Claude Opus 4.8", "best"),
  modelDescriptor("anthropic/claude-sonnet-5", "Claude Sonnet 5.0", "balanced"),
  modelDescriptor("anthropic/claude-haiku-4-5", "Claude Haiku 4.5", "fast"),
] as const

/** OpenCode candidates used by automatic quality routing, in fallback order. */
export const OPENCODE_AUTO_MODELS = {
  best: [AgentModelId.make("anthropic/claude-opus-4-8"), AgentModelId.make("openai/gpt-5.5")],
  balanced: [
    AgentModelId.make("anthropic/claude-sonnet-5"),
    AgentModelId.make("openai/gpt-5.3-codex-spark"),
  ],
  fast: [AgentModelId.make("anthropic/claude-haiku-4-5"), AgentModelId.make("openai/gpt-5.4-mini")],
} as const

/** Static OpenCode provider contribution. */
export const OPENCODE_MANIFEST = AgentProviderManifest.make({
  descriptor: AgentProviderDescriptor.make({
    id: providerId,
    displayName: "OpenCode",
    description: "Local OpenCode CLI and SDK integration.",
    homepage: "https://opencode.ai",
  }),
  models: [...OPENCODE_MODELS],
  defaults: AgentProviderDefaults.make({
    walkthroughModel: OPENCODE_DEFAULT_MODEL,
    reviewThreadModel: OPENCODE_DEFAULT_MODEL,
  }),
  requirements: [
    AgentRuntimeRequirement.make({
      name: executable,
      versionRange: null,
      installHint: "Install OpenCode and configure a model provider before using DiffDash.",
    }),
    AgentRuntimeRequirement.make({
      name: "@opencode-ai/sdk",
      versionRange: "1.17.16",
      installHint: null,
    }),
  ],
  capabilities: AgentCapabilityManifest.make({
    walkthrough: AgentCapabilityDeclaration.make({ supported: true, autoPriority: 30 }),
    reviewThread: AgentCapabilityDeclaration.make({ supported: true, autoPriority: 30 }),
  }),
  session: AgentSessionSupport.make({ mode: "resume" }),
})

/** Explicit non-mutating policy accepted by OpenCode walkthrough execution. */
export const OPENCODE_WALKTHROUGH_POLICY = makeNonMutatingAgentExecutionPolicy({
  network: "allow",
  repository: "local-working-copy",
  shell: "deny",
})

/** Explicit non-mutating policy accepted by OpenCode review execution. */
export const OPENCODE_REVIEW_POLICY = makeNonMutatingAgentExecutionPolicy({
  network: "allow",
  repository: "reviewed-revision",
  shell: "deny",
})

/** OpenCode-native permission action. */
export type OpenCodePermissionAction = "allow" | "deny"

/** OpenCode-native permission rule. */
export type OpenCodePermissionRule =
  | OpenCodePermissionAction
  | Readonly<Record<string, OpenCodePermissionAction>>

/** OpenCode-native controls enforcing DiffDash's non-mutating execution policy. */
export const OPENCODE_PERMISSION_RULES: Readonly<Record<string, OpenCodePermissionRule>> = {
  "*": "deny",
  read: {
    "*": "allow",
    "*.env": "deny",
    "*.env.*": "deny",
    "*.env.example": "allow",
  },
  glob: "allow",
  grep: "allow",
  webfetch: "allow",
  websearch: "allow",
  "diffdash_*": "allow",
  edit: "deny",
  bash: "deny",
  external_directory: "deny",
}

/** Host dependencies required to construct the OpenCode leaf provider. */
export interface OpenCodeProviderDependencies {
  readonly processes: ProcessRunner
  readonly tempDirectory?: string
  readonly executablePath?: string
  readonly createClient?: (baseUrl: string) => OpencodeClient
}

/** Options used to resolve OpenCode without relying on a shell. */
export interface ResolveOpenCodeExecutableOptions {
  readonly envPath?: string
  readonly home?: string
  readonly pathExt?: string
  readonly platform?: NodeJS.Platform
}

/** Resolves OpenCode through the GUI-safe PATH plus the OpenCode installer directory. */
export const resolveOpenCodeExecutable = (
  options: ResolveOpenCodeExecutableOptions = {},
): Effect.Effect<Option.Option<ExecutablePath>> => {
  const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? ""
  const guiPath = defaultExecutablePath(options.envPath ?? process.env.PATH ?? "", home)
  const openCodeBin = home.length > 0 ? join(home, ".opencode", "bin") : ""
  const normalizedPath =
    openCodeBin.length === 0 ? guiPath : [openCodeBin, guiPath].filter(Boolean).join(delimiter)
  return findExecutableInPath(executable, {
    envPath: normalizedPath,
    ...(options.pathExt === undefined ? {} : { pathExt: options.pathExt }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  })
}

/** Creates the complete OpenCode SDK registration. */
export const makeOpenCodeProvider = (
  dependencies: OpenCodeProviderDependencies,
): AgentProviderRegistration => {
  const runtimeProbe = probeOpenCodeRuntime(dependencies)
  return {
    manifest: OPENCODE_MANIFEST,
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

const probeOpenCodeRuntime = (dependencies: OpenCodeProviderDependencies) =>
  probeAgentRuntime({
    versionOutput: Effect.gen(function* () {
      const path = yield* resolveRuntimeExecutable(dependencies, "walkthrough")
      return yield* dependencies.processes
        .run(processRequest(path, ["--version"], { timeoutMs: 5_000 }))
        .pipe(Effect.map((result) => result.stdout))
    }),
    unavailableReason: "OpenCode is not installed or available",
  })

const executeWalkthrough = (
  dependencies: OpenCodeProviderDependencies,
  request: WalkthroughRequest,
): Effect.Effect<
  WalkthroughResult,
  AgentProviderOperationError | InvalidAgentProviderResponseError
> =>
  Effect.gen(function* () {
    yield* requirePolicy("walkthrough", request.policy, OPENCODE_WALKTHROUGH_POLICY)
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const promptPath = yield* writePromptFile(dependencies.tempDirectory, request.prompt)
        const executablePath = yield* resolveRuntimeExecutable(dependencies, "walkthrough")
        return yield* dependencies.processes
          .run(
            processRequest(executablePath, makeWalkthroughArgs(request, promptPath), {
              cwd: request.workingDirectory,
              timeoutMs: request.timeoutMs,
              env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(makeBaseServerConfig()) },
            }),
          )
          .pipe(
            Effect.mapError(operationErrors.fromCause("walkthrough")),
            Effect.flatMap((result) => {
              const text = result.stdout.trim()
              return text.length === 0
                ? InvalidAgentProviderResponseError.make({
                    providerId,
                    capability: "walkthrough",
                    reason: "OpenCode completed without generated text",
                  })
                : Effect.succeed(WalkthroughResult.make({ text }))
            }),
          )
      }),
    )
  })

const makeWalkthroughArgs = (request: WalkthroughRequest, promptPath: string) => [
  "run",
  "--model",
  request.model,
  "--file",
  promptPath,
  "--variant",
  request.reasoningEffort === "low" ? "minimal" : request.reasoningEffort,
  walkthroughMessage,
]

const writePromptFile = (directory: string | undefined, prompt: string) =>
  makeTempFileScoped(prompt, {
    ...(directory === undefined ? {} : { parentDirectory: directory }),
    prefix: "opencode-prompt-",
    fileName: "prompt.txt",
  }).pipe(Effect.mapError(operationErrors.fromCause("walkthrough")))

const executeReview = (
  dependencies: OpenCodeProviderDependencies,
  request: ReviewThreadRequest,
): Effect.Effect<
  ReviewThreadResult,
  AgentProviderOperationError | InvalidAgentProviderResponseError
> =>
  Effect.gen(function* () {
    yield* requirePolicy("review-thread", request.policy, OPENCODE_REVIEW_POLICY)
    if (!isScopedMcpToolSubset(request.mcp.allowedTools, request.policy.allowedMcpTools)) {
      return yield* operationErrors.fromReason(
        "review-thread",
        "Scoped MCP access includes tools outside the execution policy",
      )
    }
    const output = yield* runOpenCodeTurn(dependencies, request)
    if (output.parts.some((part) => part.type === "patch")) {
      return yield* operationErrors.fromReason(
        "review-thread",
        "OpenCode emitted a patch despite non-mutating permissions",
      )
    }
    const response = yield* decodeReviewResponse(output)
    return ReviewThreadResult.make({
      response,
      usage: output.usage,
      artifacts: output.parts.flatMap(toArtifactCandidate),
      sessionId: AgentSessionId.make(output.sessionId),
    })
  })

interface OpenCodeTextPart {
  readonly type: "text"
  readonly id: string
  readonly messageId: string
  readonly text: string
}

interface OpenCodeToolPart {
  readonly type: "tool"
  readonly id: string
  readonly messageId: string
  readonly tool: string
  readonly status: "completed" | "error"
  readonly title: string
  readonly content: string
  readonly metadata: Readonly<Record<string, unknown>>
}

interface OpenCodePatchPart {
  readonly type: "patch"
  readonly id: string
  readonly messageId: string
}

type OpenCodePart = OpenCodeTextPart | OpenCodeToolPart | OpenCodePatchPart

interface OpenCodeTurnOutput {
  readonly sessionId: string
  readonly messageId: string
  readonly modelId: string
  readonly providerId: string
  readonly structured: unknown
  readonly parts: readonly OpenCodePart[]
  readonly usage: AgentUsage
}

const runOpenCodeTurn = (
  dependencies: OpenCodeProviderDependencies,
  request: ReviewThreadRequest,
): Effect.Effect<OpenCodeTurnOutput, AgentProviderOperationError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* startOpenCode(dependencies, makeReviewServerConfig(request))
      return yield* callSession(client, request)
    }),
  )

const startOpenCode = (dependencies: OpenCodeProviderDependencies, config: Config) =>
  Effect.gen(function* () {
    const port = yield* Effect.tryPromise({
      try: availableLoopbackPort,
      catch: operationErrors.fromCause("review-thread"),
    })
    const ready = yield* Deferred.make<string, AgentProviderOperationError>()
    const executablePath = yield* resolveRuntimeExecutable(dependencies, "review-thread")
    const process = dependencies.processes
      .streamLines(
        processRequest(executablePath, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
          env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          const { _tag: tag } = event
          if (tag !== "ProcessLine" || event.source !== "stdout") return Effect.void
          const match = /^opencode server listening.*on\s+(https?:\/\/[^\s]+)/u.exec(event.line)
          return match?.[1] === undefined
            ? Effect.void
            : Deferred.succeed(ready, match[1]).pipe(Effect.asVoid)
        }),
        Effect.mapError(operationErrors.fromCause("review-thread")),
        Effect.onExit((exit) =>
          Deferred.fail(
            ready,
            operationErrors.fromReason(
              "review-thread",
              `OpenCode server stopped before use: ${Exit.isFailure(exit) ? "failed" : "completed"}`,
            ),
          ).pipe(Effect.ignore),
        ),
      )
    yield* process.pipe(Effect.forkScoped)
    const timeout = Effect.sleep("5 seconds").pipe(
      Effect.zipRight(
        operationErrors.fromReason("review-thread", "Timed out waiting for OpenCode server"),
      ),
    )
    const url = yield* Deferred.await(ready).pipe(Effect.raceFirst(timeout))
    return (dependencies.createClient ?? ((baseUrl) => createOpencodeClient({ baseUrl })))(url)
  })

const availableLoopbackPort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    const onError = (cause: Error) => reject(cause)
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("Unable to allocate an OpenCode loopback port"))
        return
      }
      server.off("error", onError)
      server.close()
      resolve(address.port)
    })
  })

const callSession = (client: OpencodeClient, request: ReviewThreadRequest) =>
  Effect.tryPromise({
    try: async (signal) => {
      const model = parseModel(request.model)
      const sessionId =
        request.sessionId === null
          ? await createSession(client, request, model, signal)
          : await reuseSession(client, request.sessionId, request.workingDirectory, signal)
      const response = await client.session
        .prompt(
          {
            sessionID: sessionId,
            directory: request.workingDirectory,
            model,
            system: request.stablePrompt,
            format: { type: "json_schema", schema: reviewResponseJsonSchema, retryCount: 2 },
            parts: [{ type: "text", text: request.dynamicPrompt }],
          },
          { throwOnError: true, signal },
        )
        .finally(() =>
          client.session
            .abort(
              { sessionID: sessionId, directory: request.workingDirectory },
              { throwOnError: true },
            )
            .catch(() => undefined),
        )
      const message = response.data
      if (message.info.error !== undefined) {
        throw new Error(
          `OpenCode assistant failed: ${message.info.error.name}: ${message.info.error.data.message}`,
        )
      }
      return {
        sessionId,
        messageId: message.info.id,
        modelId: message.info.modelID,
        providerId: message.info.providerID,
        structured: message.info.structured,
        parts: message.parts.flatMap(toBoundaryPart),
        usage: AgentUsage.make({
          inputTokens: nonNegative(message.info.tokens.input),
          outputTokens: nonNegative(message.info.tokens.output),
          cacheReadTokens: nonNegative(message.info.tokens.cache.read),
          cacheWriteTokens: nonNegative(message.info.tokens.cache.write),
          costUsd: nonNegative(message.info.cost),
        }),
      } satisfies OpenCodeTurnOutput
    },
    catch: operationErrors.fromCause("review-thread"),
  })

const createSession = async (
  client: OpencodeClient,
  request: ReviewThreadRequest,
  model: { readonly providerID: string; readonly modelID: string },
  signal: AbortSignal,
) => {
  const response = await client.session.create(
    {
      directory: request.workingDirectory,
      title: `DiffDash review ${request.mcp.scopeId}`,
      model: { id: model.modelID, providerID: model.providerID },
      metadata: {
        diffdashScopeId: request.mcp.scopeId,
        diffdashRevision: request.revision,
      },
    },
    { throwOnError: true, signal },
  )
  return response.data.id
}

const reuseSession = async (
  client: OpencodeClient,
  sessionId: AgentSessionId,
  directory: string,
  signal: AbortSignal,
) => {
  const response = await client.session.get(
    { sessionID: sessionId, directory },
    { throwOnError: true, signal },
  )
  return response.data.id
}

const makeBaseServerConfig = (): Config => ({
  permission: clonePermissionRules(),
  share: "disabled",
})

/** Builds ephemeral server config with non-mutating permissions and scoped MCP access. */
export const makeOpenCodeServerConfig = (
  endpoint: string,
  bearerToken: Redacted.Redacted<string>,
): Config => ({
  ...makeBaseServerConfig(),
  mcp: {
    diffdash: {
      type: "remote",
      url: endpoint,
      enabled: true,
      oauth: false,
      headers: { Authorization: `Bearer ${Redacted.value(bearerToken)}` },
    },
  },
})

const makeReviewServerConfig = (request: ReviewThreadRequest) =>
  makeOpenCodeServerConfig(request.mcp.endpoint, request.mcp.bearerToken)

const clonePermissionRules = (): NonNullable<Config["permission"]> =>
  Object.fromEntries(
    Object.entries(OPENCODE_PERMISSION_RULES).map(([name, rule]) => [
      name,
      typeof rule === "string" ? rule : { ...rule },
    ]),
  )

const parseModel = (model: AgentModelId) => {
  const separator = model.indexOf("/")
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error("OpenCode model must use the provider/model format")
  }
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
}

const toBoundaryPart = (part: Part): readonly OpenCodePart[] => {
  switch (part.type) {
    case "text":
      return part.text.length === 0
        ? []
        : [{ type: "text", id: part.id, messageId: part.messageID, text: part.text }]
    case "tool":
      if (part.state.status === "completed") {
        return [
          {
            type: "tool",
            id: part.id,
            messageId: part.messageID,
            tool: part.tool,
            status: "completed",
            title: part.state.title,
            content: part.state.output,
            metadata: allowlistedMetadata(part.state.metadata),
          },
        ]
      }
      if (part.state.status === "error") {
        return [
          {
            type: "tool",
            id: part.id,
            messageId: part.messageID,
            tool: part.tool,
            status: "error",
            title: `${part.tool} failed`,
            content: part.state.error,
            metadata: allowlistedMetadata(part.state.metadata ?? {}),
          },
        ]
      }
      return []
    case "patch":
      return [{ type: "patch", id: part.id, messageId: part.messageID }]
    default:
      return []
  }
}

const allowedMetadataKeys = new Set([
  "path",
  "file",
  "line",
  "query",
  "url",
  "command",
  "exitCode",
  "server",
  "tool",
  "status",
])

const allowlistedMetadata = (metadata: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(metadata).filter(([key]) => allowedMetadataKeys.has(key)))

const toArtifactCandidate = (part: OpenCodePart): readonly AgentArtifactCandidate[] => {
  if (part.type === "patch") return []
  const commonMetadata = { messageId: part.messageId, partId: part.id }
  if (part.type === "text") {
    return [
      AgentArtifactCandidate.make({
        type: "provider-message",
        title: "OpenCode assistant message",
        content: part.text,
        metadata: commonMetadata,
      }),
    ]
  }
  return [
    AgentArtifactCandidate.make({
      type: artifactTypeForTool(part.tool),
      title: part.title,
      content: part.content,
      metadata: {
        ...commonMetadata,
        tool: part.tool,
        status: part.status,
        ...part.metadata,
      },
    }),
  ]
}

const artifactTypeForTool = (toolName: string): AgentArtifactCandidate["type"] => {
  const tool = toolName.toLowerCase()
  if (tool.startsWith("diffdash_")) return "mcp-tool-result"
  if (tool === "read") return "file-read"
  if (tool === "glob" || tool === "grep" || tool === "list") return "search-result"
  if (tool === "bash" || tool === "shell") return "shell-output"
  if (tool === "webfetch" || tool === "websearch") return "web-result"
  return "unknown"
}

const decodeReviewResponse = (
  output: OpenCodeTurnOutput,
): Effect.Effect<ReviewThreadResponse, InvalidAgentProviderResponseError> => {
  const candidate =
    output.structured === undefined ? parseTextResponse(output.parts) : output.structured
  return Schema.decodeUnknown(ReviewThreadResponse)(normalizeResponse(candidate)).pipe(
    Effect.mapError((cause) =>
      InvalidAgentProviderResponseError.make({
        providerId,
        capability: "review-thread",
        reason: boundedProviderDiagnostic(
          `OpenCode returned an invalid review response: ${String(cause)}`,
        ),
      }),
    ),
  )
}

const parseTextResponse = (parts: readonly OpenCodePart[]): unknown => {
  const text = parts
    .filter((part): part is OpenCodeTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
  return parseProviderJsonText(text)
}

const requirePolicy = (
  capability: AgentCapability,
  policy: AgentExecutionPolicy,
  expected: AgentExecutionPolicy,
) => {
  const valid = isAgentExecutionPolicyEnforced(policy, expected)
  return valid
    ? Effect.void
    : operationErrors.fromReason(capability, "OpenCode requires the explicit non-mutating policy")
}

const resolveRuntimeExecutable = (
  dependencies: OpenCodeProviderDependencies,
  capability: AgentCapability,
): Effect.Effect<string, AgentProviderOperationError> =>
  dependencies.executablePath === undefined
    ? resolveOpenCodeExecutable().pipe(
        Effect.flatMap((resolved) =>
          Option.match(resolved, {
            onNone: () =>
              operationErrors.fromReason(capability, "OpenCode is not installed or available"),
            onSome: (path) => Effect.succeed(path),
          }),
        ),
      )
    : Effect.succeed(dependencies.executablePath)

function modelDescriptor(id: string, displayName: string, quality: "fast" | "balanced" | "best") {
  return AgentModelDescriptor.make({
    id: AgentModelId.make(id),
    displayName,
    capabilities: ["walkthrough", "review-thread"],
    quality,
  })
}

const nonNegative = (value: number) => (Number.isFinite(value) && value >= 0 ? value : null)

/** Converts a provider-owned model to its SDK identity. */
export const openCodeModelId = (modelId: string) => AgentModelId.make(modelId)

/** Converts host tool names to SDK identities for a scoped review request. */
export const openCodeMcpToolNames = (tools: readonly string[]) =>
  tools.map((tool) => McpToolName.make(tool))
