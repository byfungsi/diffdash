import { mkdtempSync } from "node:fs"
import { readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "@effect/vitest"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { Effect, Redacted, Stream } from "effect"

import {
  AgentExecutionPolicy,
  AgentProviderOperationError,
  AgentSessionId,
  McpToolName,
  ReviewRevision,
  type ReviewThreadRequest,
  WalkthroughRequest,
} from "@diffdash/agent-provider"
import {
  agentCancellationConformance,
  agentManifestConformance,
  agentSecurityConformance,
  reviewConformance,
  walkthroughConformance,
} from "@diffdash/agent-provider/testing"
import { CliError, type CliResult, type CliRunOptions } from "@diffdash/process/cli"
import {
  type CliStreamEvent,
  type CliStreamOptions,
  type CliStreamRunner,
} from "@diffdash/process/cli-stream"
import {
  makeOpenCodeProvider,
  makeOpenCodeServerConfig,
  OPENCODE_AUTO_MODELS,
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_REVIEW_POLICY,
  OPENCODE_WALKTHROUGH_POLICY,
  resolveOpenCodeExecutable,
} from "./opencode"

interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly options: CliRunOptions | CliStreamOptions | undefined
  readonly prompt: string | null
}

interface HarnessOptions {
  readonly fixture?: "opencode-review-success.json" | "opencode-review-patch.json"
  readonly walkthroughOutput?: string
  readonly priorSessionId?: string
  readonly neverPrompt?: boolean
}

const makeHarness = (options: HarnessOptions = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "diffdash-opencode-test-"))
  harnessDirectories.add(directory)
  const calls: Call[] = []
  let serverAcquired = false
  let serverReleased = false
  let createdSessions = 0
  let reusedSessions = 0
  let abortedSessions = 0
  const cli = {
    run: (command: string, args: readonly string[], runOptions?: CliRunOptions) =>
      Effect.tryPromise({
        try: async () => {
          const fileIndex = args.indexOf("--file")
          const promptPath = fileIndex < 0 ? undefined : args[fileIndex + 1]
          calls.push({
            command,
            args: [...args],
            options: runOptions,
            prompt: promptPath === undefined ? null : await readFile(promptPath, "utf8"),
          })
          return cliResult(
            command,
            args,
            args[0] === "--version"
              ? "opencode 1.17.16"
              : (options.walkthroughOutput ?? "generated walkthrough"),
          )
        },
        catch: (cause) =>
          CliError.make({
            command,
            args: [...args],
            cwd: runOptions?.cwd ?? null,
            exitCode: null,
            stderr: String(cause),
            cause,
          }),
      }),
  }
  const cliStream: CliStreamRunner = {
    stream: (command: string, args: readonly string[], streamOptions?: CliStreamOptions) => {
      calls.push({ command, args: [...args], options: streamOptions, prompt: null })
      return Stream.acquireRelease(
        Effect.sync(() => void (serverAcquired = true)),
        () => Effect.sync(() => void (serverReleased = true)),
      ).pipe(
        Stream.flatMap(() =>
          Stream.concat(
            Stream.fromIterable<CliStreamEvent>([
              {
                _tag: "CliLine",
                source: "stdout",
                line: "opencode server listening on http://127.0.0.1:43210",
              },
            ]),
            Stream.never,
          ),
        ),
      )
    },
  }
  const createClient = () => {
    const session = {
      create: async () => {
        createdSessions += 1
        return { data: { id: "opencode-session-new" } }
      },
      get: async ({ sessionID }: { readonly sessionID: string }) => {
        reusedSessions += 1
        return { data: { id: sessionID } }
      },
      prompt: async (_input: unknown, requestOptions: { readonly signal: AbortSignal }) => {
        if (options.neverPrompt) {
          await new Promise<never>((_resolve, reject) => {
            requestOptions.signal.addEventListener("abort", () =>
              reject(requestOptions.signal.reason),
            )
          })
        }
        const fixture = await readFile(
          new URL(
            `./fixtures/${options.fixture ?? "opencode-review-success.json"}`,
            import.meta.url,
          ),
          "utf8",
        )
        return { data: JSON.parse(fixture) as unknown }
      },
      abort: async () => {
        abortedSessions += 1
        return { data: true }
      },
    }
    // SAFETY: The provider exercises only this session subset; each method returns the SDK shape it reads.
    return { session } as unknown as OpencodeClient
  }
  const registration = makeOpenCodeProvider({
    cli,
    cliStream,
    tempDirectory: directory,
    executablePath: "opencode",
    createClient,
  })
  return {
    calls,
    directory,
    registration,
    state: () => ({
      serverAcquired,
      serverReleased,
      createdSessions,
      reusedSessions,
      abortedSessions,
    }),
  }
}

const harnessDirectories = new Set<string>()

afterAll(async () => {
  await Promise.all(
    [...harnessDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

const cliResult = (command: string, args: readonly string[], stdout: string): CliResult => ({
  command,
  args,
  cwd: null,
  exitCode: 0,
  stdout,
  stderr: "",
})

const allowedTool = McpToolName.make("getDiffHunk")
const reviewPolicy = AgentExecutionPolicy.make({
  ...OPENCODE_REVIEW_POLICY,
  allowedMcpTools: [allowedTool],
})

const walkthroughRequest = (directory = tmpdir()) =>
  WalkthroughRequest.make({
    prompt: "Explain this repository.",
    model: OPENCODE_DEFAULT_MODEL,
    workingDirectory: directory,
    timeoutMs: 1_000,
    reasoningEffort: "low",
    policy: OPENCODE_WALKTHROUGH_POLICY,
  })

const reviewRequest = (sessionId: AgentSessionId | null = null): ReviewThreadRequest => ({
  stablePrompt: "Return the review response JSON object.",
  dynamicPrompt: "Review the current hunk.",
  model: OPENCODE_DEFAULT_MODEL,
  workingDirectory: "/workspace/project",
  revision: ReviewRevision.make("head-sanitized"),
  timeoutMs: 1_000,
  sessionId,
  mcp: {
    scopeId: "thread-sanitized",
    endpoint: "http://127.0.0.1:9000/mcp",
    bearerToken: Redacted.make("sanitized-secret-token"),
    allowedTools: [allowedTool],
    call: () => Effect.die(new Error("OpenCode uses the scoped MCP transport")),
  },
  policy: reviewPolicy,
})

const requireWalkthrough = (registration: ReturnType<typeof makeOpenCodeProvider>) => {
  if (registration.walkthrough === undefined) throw new Error("Missing walkthrough capability")
  return registration.walkthrough
}

const requireReview = (registration: ReturnType<typeof makeOpenCodeProvider>) => {
  if (registration.reviewThread === undefined) throw new Error("Missing review capability")
  return registration.reviewThread
}

const temporaryFiles = (directory: string) =>
  Effect.promise(async () =>
    (await readdir(directory)).filter((name) => name.startsWith("opencode-prompt-")),
  )

agentManifestConformance("OpenCode", { create: () => makeHarness().registration })

const walkthroughHarness = makeHarness()
walkthroughConformance("OpenCode", {
  create: () => walkthroughHarness.registration,
  request: () => walkthroughRequest(walkthroughHarness.directory),
  expectedFailure: () => {
    const harness = makeHarness({ walkthroughOutput: "" })
    return requireWalkthrough(harness.registration)
      .execute(walkthroughRequest(harness.directory))
      .pipe(Effect.flatMap(() => Effect.die("Expected walkthrough failure")))
  },
  temporaryFiles: () => temporaryFiles(walkthroughHarness.directory),
})

reviewConformance("OpenCode", {
  create: () => makeHarness().registration,
  request: () => reviewRequest(AgentSessionId.make("prior-session")),
})

agentSecurityConformance("OpenCode", {
  run: () => {
    const harness = makeHarness()
    return requireReview(harness.registration)
      .execute(reviewRequest())
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AgentProviderOperationError
            ? cause
            : AgentProviderOperationError.make({
                providerId: harness.registration.manifest.descriptor.id,
                capability: "review-thread",
                reason: cause.reason,
              }),
        ),
      )
  },
  repositoryState: () => Effect.succeed("unchanged"),
  mcpToken: "sanitized-secret-token",
  sensitiveValues: ["must-not-cross-boundary"],
  maxArtifactLength: 64 * 1024,
  allowedTools: [allowedTool],
  observedTools: () => [allowedTool],
})

agentCancellationConformance("OpenCode", {
  createRun: () => {
    const harness = makeHarness({ neverPrompt: true })
    return {
      run: requireReview(harness.registration)
        .execute(reviewRequest())
        .pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            cause instanceof AgentProviderOperationError
              ? cause
              : AgentProviderOperationError.make({
                  providerId: harness.registration.manifest.descriptor.id,
                  capability: "review-thread",
                  reason: cause.reason,
                }),
          ),
        ),
      cleanedUp: Effect.promise(async () => {
        const state = harness.state()
        await rm(harness.directory, { force: true, recursive: true })
        return !state.serverAcquired || (state.serverReleased && state.abortedSessions === 1)
      }),
    }
  },
})

describe("OpenCode provider", () => {
  it.effect("uses one executable and SDK probe for both capabilities", () =>
    Effect.gen(function* () {
      const harness = makeHarness()
      yield* requireWalkthrough(harness.registration).probe
      yield* requireReview(harness.registration).probe
      expect(harness.calls.filter(({ args }) => args[0] === "--version")).toHaveLength(2)
      expect(harness.calls.find(({ args }) => args[0] === "--version")?.command).toBe("opencode")
      yield* Effect.promise(() => rm(harness.directory, { force: true, recursive: true }))
    }),
  )

  it.effect("applies non-mutating CLI config and always removes the walkthrough prompt", () =>
    Effect.gen(function* () {
      const harness = makeHarness()
      const result = yield* requireWalkthrough(harness.registration).execute(
        walkthroughRequest(harness.directory),
      )
      expect(result.text).toBe("generated walkthrough")
      expect(yield* temporaryFiles(harness.directory)).toEqual([])
      const call = harness.calls.find(({ args }) => args[0] === "run")
      expect(call?.prompt).toBe("Explain this repository.")
      expect(call?.args).toContain("minimal")
      const config = JSON.parse(call?.options?.env?.OPENCODE_CONFIG_CONTENT ?? "{}") as unknown
      expect(config).toMatchObject({
        share: "disabled",
        permission: { "*": "deny", edit: "deny", bash: "deny" },
      })
      yield* Effect.promise(() => rm(harness.directory, { force: true, recursive: true }))
    }),
  )

  it.effect("maps usage and artifacts, allowlists SDK metadata, and disposes the server", () =>
    Effect.gen(function* () {
      const harness = makeHarness()
      const result = yield* requireReview(harness.registration).execute(reviewRequest())
      expect(result.response.bodyMarkdown).toBe("The changed hunk is correct.")
      expect(result.sessionId).toBe("opencode-session-new")
      expect(result.usage).toMatchObject({ inputTokens: 240, outputTokens: 42, costUsd: 0.004 })
      expect(result.artifacts.map(({ type }) => type)).toEqual([
        "file-read",
        "mcp-tool-result",
        "provider-message",
      ])
      expect(result.artifacts[0]?.metadata).toMatchObject({ path: "src/main.ts" })
      expect(JSON.stringify(result)).not.toContain("privateSdkPayload")
      expect(JSON.stringify(result)).not.toContain("must-not-cross-boundary")
      expect(harness.state()).toMatchObject({
        serverAcquired: true,
        serverReleased: true,
        createdSessions: 1,
        reusedSessions: 0,
        abortedSessions: 1,
      })
      yield* Effect.promise(() => rm(harness.directory, { force: true, recursive: true }))
    }),
  )

  it.effect("reuses a prior session and rejects patch parts", () =>
    Effect.gen(function* () {
      const reused = makeHarness()
      const result = yield* requireReview(reused.registration).execute(
        reviewRequest(AgentSessionId.make("prior-session")),
      )
      expect(result.sessionId).toBe("prior-session")
      expect(reused.state()).toMatchObject({
        createdSessions: 0,
        reusedSessions: 1,
        abortedSessions: 1,
      })

      const patch = makeHarness({ fixture: "opencode-review-patch.json" })
      const error = yield* requireReview(patch.registration)
        .execute(reviewRequest())
        .pipe(Effect.flip)
      expect(error.reason).toContain("emitted a patch")
      expect(patch.state().serverReleased).toBe(true)
      yield* Effect.promise(() =>
        Promise.all([
          rm(reused.directory, { force: true, recursive: true }),
          rm(patch.directory, { force: true, recursive: true }),
        ]).then(() => undefined),
      )
    }),
  )

  it("owns defaults, automatic tiers, executable resolution, and scoped server config", () => {
    expect(OPENCODE_DEFAULT_MODEL).toBe("openai/gpt-5.3-codex-spark")
    expect(OPENCODE_AUTO_MODELS.balanced).toEqual([
      "anthropic/claude-sonnet-5",
      "openai/gpt-5.3-codex-spark",
    ])
    expect(resolveOpenCodeExecutable({ envPath: "", home: "/missing" })).toBeNull()
    const config = makeOpenCodeServerConfig(
      "http://127.0.0.1:9000/mcp",
      Redacted.make("scoped-token"),
    )
    expect(config.permission).toMatchObject({ "*": "deny", edit: "deny", bash: "deny" })
    expect(config.mcp?.diffdash).toMatchObject({
      url: "http://127.0.0.1:9000/mcp",
      headers: { Authorization: "Bearer scoped-token" },
    })
  })
})
