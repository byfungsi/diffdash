import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted, Stream } from "effect"
import { mkdtempSync, readFileSync } from "node:fs"
import { readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  AgentCapabilityPolicyUnsupported,
  AgentExecutionPolicy,
  AgentModelId,
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
import {
  ProcessExit,
  ProcessLine,
  ProcessResult,
  type ProcessEvent,
  type ProcessRequest,
  type ProcessRunner,
} from "@diffdash/process"
import {
  CLAUDE_AUTO_MODELS,
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_REVIEW_POLICY,
  CLAUDE_WALKTHROUGH_POLICY,
  makeClaudeProvider,
} from "./claude"

interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string | undefined
  readonly stdin: string | undefined
  readonly env: Readonly<Record<string, string>> | undefined
}

const fixtureEvents = (name: string): readonly ProcessEvent[] => {
  const lines = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
  return [
    ...lines.map((line) => ProcessLine.make({ source: "stdout", line })),
    ProcessExit.make({
      result: ProcessResult.make({
        command: "claude",
        args: [],
        cwd: "/workspace/project",
        stdout: lines.join("\n"),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        outputTruncated: false,
        exitCode: 0,
        signal: null,
      }),
    }),
  ]
}

const makeHarness = (
  options: {
    readonly reviewFixture?: string
    readonly walkthroughOutput?: string
    readonly captureMcpConfig?: (content: string) => void
  } = {},
) => {
  const calls: Call[] = []
  const processes: ProcessRunner = {
    run: (request) =>
      Effect.sync(() => {
        calls.push({
          command: request.command,
          args: request.args,
          cwd: request.cwd ?? undefined,
          stdin: request.stdin ?? undefined,
          env: Object.keys(request.env).length === 0 ? undefined : request.env,
        })
        return result(
          request,
          request.args[0] === "--version"
            ? "2.1.205 (Claude Code)"
            : (options.walkthroughOutput ?? "generated walkthrough"),
        )
      }),
    streamLines: (request) => {
      calls.push({
        command: request.command,
        args: request.args,
        cwd: request.cwd ?? undefined,
        stdin: request.stdin ?? undefined,
        env: Object.keys(request.env).length === 0 ? undefined : request.env,
      })
      const configIndex = request.args.indexOf("--mcp-config")
      const configPath = configIndex < 0 ? undefined : request.args[configIndex + 1]
      if (configPath !== undefined) options.captureMcpConfig?.(readFileSync(configPath, "utf8"))
      return Stream.fromIterable(
        fixtureEvents(options.reviewFixture ?? "claude-review-success.jsonl"),
      )
    },
  }
  return { calls, registration: makeClaudeProvider({ processes }) }
}

const result = (request: ProcessRequest, stdout: string): ProcessResult =>
  ProcessResult.make({
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    outputTruncated: false,
  })

const walkthroughRequest = () =>
  WalkthroughRequest.make({
    prompt: "Explain this repository.",
    model: CLAUDE_DEFAULT_MODEL,
    workingDirectory: tmpdir(),
    timeoutMs: 1_000,
    reasoningEffort: "low",
    policy: CLAUDE_WALKTHROUGH_POLICY,
  })

const allowedTool = McpToolName.make("getDiffHunk")
const reviewPolicy = AgentExecutionPolicy.make({
  ...CLAUDE_REVIEW_POLICY,
  allowedMcpTools: [allowedTool],
})
const reviewRequest = (): ReviewThreadRequest => ({
  stablePrompt: "Return the review response JSON object.",
  dynamicPrompt: "Review the current hunk.",
  model: CLAUDE_DEFAULT_MODEL,
  workingDirectory: "/workspace/project",
  revision: ReviewRevision.make("head-sanitized"),
  timeoutMs: 1_000,
  sessionId: AgentSessionId.make("prior-session-sanitized"),
  mcp: {
    scopeId: "scope-sanitized",
    endpoint: "http://127.0.0.1:9000/mcp",
    bearerToken: Redacted.make("sanitized-secret-token"),
    allowedTools: [allowedTool],
    call: () => Effect.die(new Error("Transport call is not used by the CLI provider")),
  },
  policy: reviewPolicy,
})

const requireWalkthrough = (registration: ReturnType<typeof makeClaudeProvider>) => {
  if (registration.walkthrough === undefined) throw new Error("Missing walkthrough capability")
  return registration.walkthrough
}

const requireReview = (registration: ReturnType<typeof makeClaudeProvider>) => {
  if (registration.reviewThread === undefined) throw new Error("Missing review capability")
  return registration.reviewThread
}

agentManifestConformance("Claude", { create: () => makeHarness().registration })

walkthroughConformance("Claude", {
  create: () => makeHarness().registration,
  request: walkthroughRequest,
  expectedFailure: () => {
    const harness = makeHarness({ walkthroughOutput: "" })
    return requireWalkthrough(harness.registration)
      .execute(walkthroughRequest())
      .pipe(Effect.flatMap(() => Effect.die("Expected walkthrough failure")))
  },
  temporaryFiles: () => Effect.succeed([]),
})

reviewConformance("Claude", {
  create: () => makeHarness().registration,
  request: reviewRequest,
})

agentSecurityConformance("Claude", {
  run: () =>
    requireReview(makeHarness().registration)
      .execute(reviewRequest())
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AgentProviderOperationError
            ? cause
            : AgentProviderOperationError.make({
                providerId: makeHarness().registration.manifest.descriptor.id,
                capability: "review-thread",
                reason: cause.reason,
              }),
        ),
      ),
  repositoryState: () => Effect.succeed("unchanged"),
  mcpToken: "sanitized-secret-token",
  sensitiveValues: ["private-value-sanitized"],
  maxArtifactLength: 64 * 1024,
  allowedTools: [allowedTool],
  observedTools: () => [allowedTool],
})

agentCancellationConformance("Claude", {
  createRun: () => {
    let acquired = false
    let released = false
    const root = mkdtempSync(join(tmpdir(), "diffdash-claude-test-"))
    const registration = makeClaudeProvider({
      processes: {
        run: (request) => Effect.succeed(result(request, "2.1.205")),
        streamLines: () =>
          Stream.acquireRelease(
            Effect.sync(() => void (acquired = true)),
            () => Effect.sync(() => void (released = true)),
          ).pipe(Stream.flatMap(() => Stream.never)),
      },
      tempDirectory: root,
    })
    return {
      run: requireReview(registration)
        .execute(reviewRequest())
        .pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            cause instanceof AgentProviderOperationError
              ? cause
              : AgentProviderOperationError.make({
                  providerId: registration.manifest.descriptor.id,
                  capability: "review-thread",
                  reason: cause.reason,
                }),
          ),
        ),
      cleanedUp: Effect.promise(async () => {
        const resources = await readdir(root)
        await rm(root, { force: true, recursive: true })
        return resources.length === 0 && (!acquired || released)
      }),
    }
  },
})

describe("Claude provider", () => {
  it.effect("uses one version probe implementation for prerequisites and both capabilities", () =>
    Effect.gen(function* () {
      const harness = makeHarness()
      yield* requireWalkthrough(harness.registration).probe
      yield* requireReview(harness.registration).probe
      expect(harness.calls.filter(({ args }) => args[0] === "--version")).toHaveLength(2)
      expect(harness.calls.find(({ args }) => args[0] === "--version")?.args).toEqual(["--version"])
    }),
  )

  it.effect("fails closed before review availability when a native policy control is absent", () =>
    Effect.gen(function* () {
      const harness = makeHarness()
      const registration = makeClaudeProvider({
        processes: {
          run: (request) => Effect.succeed(result(request, "2.1.205")),
          streamLines: () => Stream.empty,
        },
        permissionControls: {
          exactToolAllowlist: true,
          networkToolAllowlist: true,
          nonInteractivePermissionMode: true,
          sensitiveReadDenylist: false,
          shellToolDenylist: true,
          strictMcpConfiguration: true,
        },
      })
      const probe = yield* requireReview(registration).probe
      expect(probe).toBeInstanceOf(AgentCapabilityPolicyUnsupported)
      expect(harness.calls).toHaveLength(0)
    }),
  )

  it.effect("runs print mode with explicit non-mutating permissions", () =>
    Effect.gen(function* () {
      const harness = makeHarness()
      const output = yield* requireWalkthrough(harness.registration).execute(walkthroughRequest())
      expect(output.text).toBe("generated walkthrough")
      const call = harness.calls[0]
      expect(call?.args).toContain("dontAsk")
      expect(call?.args).toContain("--no-session-persistence")
      expect(call?.args).toContain("Read,Glob,Grep,WebFetch,WebSearch")
      expect(call?.args.join(" ")).toContain("Read(**/.env)")
      expect(call?.args.join(" ")).toContain("Bash")
      expect(call?.stdin).toBe("Explain this repository.")
    }),
  )

  it.effect("normalizes stream-json, usage, artifacts, scoped MCP, and continuation", () => {
    let mcpConfig = ""
    const harness = makeHarness({ captureMcpConfig: (content) => void (mcpConfig = content) })
    return Effect.gen(function* () {
      const output = yield* requireReview(harness.registration).execute(reviewRequest())
      expect(output.response.bodyMarkdown).toContain("preserves the expected behavior")
      expect(output.sessionId).toBe("claude-session-sanitized-78")
      expect(output.usage).toMatchObject({
        inputTokens: 220,
        outputTokens: 35,
        cacheReadTokens: 120,
        cacheWriteTokens: 20,
        costUsd: 0.0042,
      })
      expect(output.artifacts.map(({ type }) => type)).toEqual([
        "file-read",
        "mcp-tool-result",
        "provider-message",
      ])
      const call = harness.calls.find(({ args }) => args.includes("stream-json"))
      expect(call?.args).toContain("--resume")
      expect(call?.args).toContain("prior-session-sanitized")
      expect(call?.args.join(" ")).toContain("mcp__diffdash__getDiffHunk")
      expect(JSON.stringify(call?.args)).not.toContain("sanitized-secret-token")
      expect(call?.env).toEqual({ DIFFDASH_MCP_BEARER_TOKEN: "sanitized-secret-token" })
      expect(mcpConfig).toContain("Bearer ${DIFFDASH_MCP_BEARER_TOKEN}")
      expect(mcpConfig).not.toContain("sanitized-secret-token")
    })
  })

  it.effect("rejects malformed JSONL, invalid responses, and provider errors", () =>
    Effect.gen(function* () {
      for (const [fixture, reason] of [
        ["claude-review-malformed.jsonl", "invalid stream-json"],
        ["claude-review-invalid-response.jsonl", "invalid review response"],
        ["claude-review-error.jsonl", "authentication failed"],
      ] as const) {
        const error = yield* requireReview(makeHarness({ reviewFixture: fixture }).registration)
          .execute(reviewRequest())
          .pipe(Effect.flip)
        expect(error.reason).toContain(reason)
      }
    }),
  )

  it("owns defaults and all automatic quality candidates", () => {
    expect(CLAUDE_DEFAULT_MODEL).toBe(AgentModelId.make("claude-sonnet-5"))
    expect(CLAUDE_AUTO_MODELS).toEqual({
      best: "claude-opus-4-8",
      balanced: "claude-sonnet-5",
      fast: "claude-haiku-4-5",
    })
    expect(CLAUDE_WALKTHROUGH_POLICY).toMatchObject({
      repository: "local-working-copy",
      shell: "deny",
    })
    expect(CLAUDE_REVIEW_POLICY).toMatchObject({
      repository: "reviewed-revision",
      shell: "deny",
    })
  })
})
