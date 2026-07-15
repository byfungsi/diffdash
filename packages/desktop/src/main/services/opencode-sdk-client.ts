import { createServer } from "node:net"
import {
  type Config,
  createOpencodeClient,
  type OpencodeClient,
  type Part,
} from "@opencode-ai/sdk/v2"
import { Context, Deferred, Effect, Exit, Layer, Redacted, Schema, Stream } from "effect"

import {
  REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA,
  type ReviewAgentProviderRunId,
} from "../../shared/review-agent"
import { defaultExecutablePath } from "./cli"
import { type CliStreamRunner, CliStreamService } from "./cli-stream"
import type { DiffDashMcpRunAccess } from "./diffdash-mcp-server"
import { resolveExecutableInPath } from "./prerequisites"
import type { OpenCodeReviewPermissionConfig } from "./review-agent-permissions"

/** Input passed to the isolated OpenCode SDK boundary for one review turn. */
export interface OpenCodeSdkTurnInput {
  readonly cwd: string | null
  readonly model: string
  readonly stablePromptPrefix: string
  readonly dynamicPromptSuffix: string
  readonly threadId: string
  readonly reviewKey: string
  readonly providerRunId: ReviewAgentProviderRunId | null
  readonly permissionConfig: OpenCodeReviewPermissionConfig["sdkConfig"]
  readonly mcp: DiffDashMcpRunAccess
}

/** Message text returned by OpenCode and retained as a provider artifact. */
export interface OpenCodeSdkTextPart {
  readonly type: "text"
  readonly id: string
  readonly messageId: string
  readonly text: string
}

/** Completed or failed OpenCode tool output returned for normalization. */
export interface OpenCodeSdkToolPart {
  readonly type: "tool"
  readonly id: string
  readonly messageId: string
  readonly tool: string
  readonly status: "completed" | "error"
  readonly title: string
  readonly content: string
  readonly metadata: Readonly<Record<string, unknown>>
}

/** A patch part is surfaced so the read-only provider can fail closed. */
export interface OpenCodeSdkPatchPart {
  readonly type: "patch"
  readonly id: string
  readonly messageId: string
  readonly hash: string
  readonly files: readonly string[]
}

/** Provider parts relevant to DiffDash response and artifact handling. */
export type OpenCodeSdkPart = OpenCodeSdkTextPart | OpenCodeSdkToolPart | OpenCodeSdkPatchPart

/** Successful response from one OpenCode SDK session prompt. */
export interface OpenCodeSdkTurnOutput {
  readonly sessionId: string
  readonly messageId: string
  readonly modelId: string
  readonly providerId: string
  readonly structured: unknown
  readonly parts: readonly OpenCodeSdkPart[]
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
    readonly costUsd: number
  }
}

/** A bounded failure while locating, starting, or calling the OpenCode SDK. */
export class OpenCodeSdkClientError extends Schema.TaggedError<OpenCodeSdkClientError>()(
  "OpenCodeSdkClientError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Fakeable boundary around the installed OpenCode executable and SDK client/server. */
export class OpenCodeSdkClient extends Context.Tag("@diffdash/OpenCodeSdkClient")<
  OpenCodeSdkClient,
  {
    readonly isAvailable: Effect.Effect<boolean, OpenCodeSdkClientError>
    readonly runTurn: (
      input: OpenCodeSdkTurnInput,
    ) => Effect.Effect<OpenCodeSdkTurnOutput, OpenCodeSdkClientError>
  }
>() {
  static readonly layer = Layer.effect(
    OpenCodeSdkClient,
    Effect.gen(function* () {
      const cli = yield* CliStreamService
      return OpenCodeSdkClient.of({
        isAvailable: Effect.sync(() => resolveOpenCodeExecutable() !== null),
        runTurn: Effect.fn("OpenCodeSdkClient.runTurn")((input) => runOpenCodeTurn(cli, input)),
      })
    }),
  )
}

/** Options used to resolve OpenCode without relying on a shell. */
export interface ResolveOpenCodeExecutableOptions {
  readonly envPath?: string
  readonly home?: string
  readonly pathExt?: string
  readonly platform?: NodeJS.Platform
}

/** Resolves OpenCode through the same normalized PATH used for GUI-launched commands. */
export const resolveOpenCodeExecutable = (
  options: ResolveOpenCodeExecutableOptions = {},
): string | null => {
  const normalizedPath = defaultExecutablePath(
    options.envPath ?? process.env.PATH ?? "",
    options.home ?? process.env.HOME ?? "",
  )
  return resolveExecutableInPath("opencode", {
    envPath: normalizedPath,
    ...(options.pathExt === undefined ? {} : { pathExt: options.pathExt }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  })
}

/** Builds ephemeral server config containing read-only permissions and scoped MCP access. */
export const makeOpenCodeServerConfig = (
  permissionConfig: OpenCodeReviewPermissionConfig["sdkConfig"],
  mcp: DiffDashMcpRunAccess,
): Config => ({
  permission: clonePermissionConfig(permissionConfig.permission),
  share: "disabled",
  mcp: {
    diffdash: {
      type: "remote",
      url: mcp.url,
      enabled: true,
      oauth: false,
      headers: {
        Authorization: `Bearer ${Redacted.value(mcp.bearerToken)}`,
      },
    },
  },
})

function runOpenCodeTurn(cli: CliStreamRunner, input: OpenCodeSdkTurnInput) {
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* startOpenCode(
        cli,
        makeOpenCodeServerConfig(input.permissionConfig, input.mcp),
      )
      return yield* callSession(client, input)
    }),
  )
}

const startOpenCode = (cli: CliStreamRunner, config: Config) =>
  Effect.gen(function* () {
    const port = yield* Effect.tryPromise({
      try: availableLoopbackPort,
      catch: (cause) => sdkError("server.port", cause),
    })
    const ready = yield* Deferred.make<string, OpenCodeSdkClientError>()
    const process = cli
      .stream("opencode", ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
        env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      })
      .pipe(
        Stream.runForEach((event) => {
          const { _tag: tag } = event
          if (tag !== "CliLine" || event.source !== "stdout") return Effect.void
          const match = /^opencode server listening.*on\s+(https?:\/\/[^\s]+)/u.exec(event.line)
          return match?.[1] === undefined
            ? Effect.void
            : Deferred.succeed(ready, match[1]).pipe(Effect.asVoid)
        }),
        Effect.mapError((cause) => sdkError("server.process", cause)),
        Effect.onExit((exit) =>
          Deferred.fail(
            ready,
            sdkError(
              "server.exit",
              new Error(
                `OpenCode server stopped before use: ${Exit.isFailure(exit) ? "failed" : "completed"}`,
              ),
            ),
          ).pipe(Effect.ignore),
        ),
      )
    yield* process.pipe(Effect.forkScoped)
    const timeout = Effect.sleep("5 seconds").pipe(
      Effect.zipRight(
        Effect.fail(sdkError("server.start", new Error("Timed out waiting for OpenCode server"))),
      ),
    )
    const url = yield* Deferred.await(ready).pipe(Effect.raceFirst(timeout))
    return createOpencodeClient({ baseUrl: url })
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

const callSession = (client: OpencodeClient, input: OpenCodeSdkTurnInput) =>
  Effect.tryPromise({
    try: async (signal) => {
      const model = parseModel(input.model)
      const directory = input.cwd ?? undefined
      const sessionId =
        input.providerRunId === null
          ? await createSession(client, input, model, directory, signal)
          : await reuseSession(client, input.providerRunId, directory, signal)
      const response = await client.session.prompt(
        {
          sessionID: sessionId,
          ...(directory === undefined ? {} : { directory }),
          model,
          system: input.stablePromptPrefix,
          format: {
            type: "json_schema",
            schema: REVIEW_THREAD_AGENT_RESPONSE_JSON_SCHEMA,
            retryCount: 2,
          },
          parts: [{ type: "text", text: input.dynamicPromptSuffix }],
        },
        { throwOnError: true, signal },
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
        usage: {
          inputTokens: message.info.tokens.input,
          outputTokens: message.info.tokens.output,
          cacheReadTokens: message.info.tokens.cache.read,
          cacheWriteTokens: message.info.tokens.cache.write,
          costUsd: message.info.cost,
        },
      } satisfies OpenCodeSdkTurnOutput
    },
    catch: (cause) => sdkError("session.prompt", cause),
  })

const createSession = async (
  client: OpencodeClient,
  input: OpenCodeSdkTurnInput,
  model: { readonly providerID: string; readonly modelID: string },
  directory: string | undefined,
  signal: AbortSignal,
) => {
  const response = await client.session.create(
    {
      ...(directory === undefined ? {} : { directory }),
      title: `DiffDash review thread ${input.threadId}`,
      model: { id: model.modelID, providerID: model.providerID },
      metadata: {
        diffdashThreadId: input.threadId,
        diffdashReviewKey: input.reviewKey,
      },
    },
    { throwOnError: true, signal },
  )
  return response.data.id
}

const reuseSession = async (
  client: OpencodeClient,
  sessionId: ReviewAgentProviderRunId,
  directory: string | undefined,
  signal: AbortSignal,
) => {
  const response = await client.session.get(
    {
      sessionID: sessionId,
      ...(directory === undefined ? {} : { directory }),
    },
    { throwOnError: true, signal },
  )
  return response.data.id
}

const parseModel = (model: string) => {
  const separator = model.indexOf("/")
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error("OpenCode model must use the provider/model format")
  }
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  }
}

const toBoundaryPart = (part: Part): readonly OpenCodeSdkPart[] => {
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
            metadata: part.state.metadata,
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
            metadata: part.state.metadata ?? {},
          },
        ]
      }
      return []
    case "patch":
      return [
        {
          type: "patch",
          id: part.id,
          messageId: part.messageID,
          hash: part.hash,
          files: part.files,
        },
      ]
    default:
      return []
  }
}

const clonePermissionConfig = (
  permissions: OpenCodeReviewPermissionConfig["sdkConfig"]["permission"],
): NonNullable<Config["permission"]> =>
  Object.fromEntries(
    Object.entries(permissions).map(([name, rule]) => [
      name,
      typeof rule === "string" ? rule : { ...rule },
    ]),
  )

const sdkError = (operation: string, cause: unknown) =>
  OpenCodeSdkClientError.make({
    operation,
    reason: cause instanceof Error ? cause.message : `OpenCode SDK ${operation} failed`,
    cause,
  })
