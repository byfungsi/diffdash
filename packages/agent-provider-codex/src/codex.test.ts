import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted, Stream } from "effect"
import { readdir, readFile, rm, writeFile } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  AgentExecutionPolicy,
  AgentModelId,
  AgentProviderOperationError,
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
  ProcessSpawnError,
  type ProcessEvent,
  type ProcessRequest,
  type ProcessRunner,
} from "@diffdash/process"
import {
  CODEX_AUTO_MODELS,
  CODEX_DEFAULT_MODEL,
  CODEX_REVIEW_POLICY,
  CODEX_WALKTHROUGH_POLICY,
  makeCodexProvider,
} from "./codex"

interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string | undefined
  readonly stdin: string | undefined
  readonly env: Readonly<Record<string, string>> | undefined
}

const fixtureEvents = async (name: string): Promise<readonly ProcessEvent[]> => {
  const lines = (await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))
    .trim()
    .split("\n")
  return [
    ...lines.map((line) => ProcessLine.make({ source: "stdout", line })),
    ProcessExit.make({
      result: ProcessResult.make({
        command: "codex",
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
  options: { readonly reviewFixture?: string; readonly walkthroughOutput?: string } = {},
) => {
  const calls: Call[] = []
  const processes: ProcessRunner = {
    run: (request) =>
      Effect.tryPromise({
        try: async () => {
          calls.push({
            command: request.command,
            args: request.args,
            cwd: request.cwd ?? undefined,
            stdin: request.stdin ?? undefined,
            env: Object.keys(request.env).length === 0 ? undefined : request.env,
          })
          if (request.args[0] === "--version") {
            return result(request, "codex-cli 1.2.3")
          }
          const outputIndex = request.args.indexOf("--output-last-message")
          const outputPath = outputIndex < 0 ? undefined : request.args[outputIndex + 1]
          if (outputPath !== undefined) {
            await writeFile(outputPath, options.walkthroughOutput ?? "generated walkthrough")
          }
          return result(request, "")
        },
        catch: (cause) => processSpawnError(request, cause),
      }),
    streamLines: (request) => {
      calls.push({
        command: request.command,
        args: request.args,
        cwd: request.cwd ?? undefined,
        stdin: request.stdin ?? undefined,
        env: Object.keys(request.env).length === 0 ? undefined : request.env,
      })
      return Stream.fromIterableEffect(
        Effect.promise(() => fixtureEvents(options.reviewFixture ?? "codex-review-success.jsonl")),
      )
    },
  }
  return { calls, registration: makeCodexProvider({ processes, tempDirectory: tmpdir() }) }
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

const processSpawnError = (request: ProcessRequest, cause: unknown) =>
  ProcessSpawnError.make({
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    outputTruncated: false,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  })

const walkthroughRequest = () =>
  WalkthroughRequest.make({
    prompt: "Explain this repository.",
    model: CODEX_DEFAULT_MODEL,
    workingDirectory: tmpdir(),
    timeoutMs: 1_000,
    reasoningEffort: "low",
    policy: CODEX_WALKTHROUGH_POLICY,
  })

const allowedTool = McpToolName.make("getDiffHunk")
const reviewPolicy = AgentExecutionPolicy.make({
  ...CODEX_REVIEW_POLICY,
  allowedMcpTools: [allowedTool],
})
const reviewRequest = (): ReviewThreadRequest => ({
  stablePrompt: "Return the review response JSON object.",
  dynamicPrompt: "Review the current hunk.",
  model: CODEX_DEFAULT_MODEL,
  workingDirectory: "/workspace/project",
  revision: ReviewRevision.make("head-sanitized"),
  timeoutMs: 1_000,
  sessionId: null,
  mcp: {
    scopeId: "scope-sanitized",
    endpoint: "http://127.0.0.1:9000/mcp",
    bearerToken: Redacted.make("sanitized-secret-token"),
    allowedTools: [allowedTool],
    call: () => Effect.die(new Error("Transport call is not used by the CLI provider")),
  },
  policy: reviewPolicy,
})

const requireWalkthrough = (registration: ReturnType<typeof makeCodexProvider>) => {
  if (registration.walkthrough === undefined) throw new Error("Missing walkthrough capability")
  return registration.walkthrough
}

const requireReview = (registration: ReturnType<typeof makeCodexProvider>) => {
  if (registration.reviewThread === undefined) throw new Error("Missing review capability")
  return registration.reviewThread
}

const codexTemporaryFiles = () =>
  Effect.promise(async () =>
    (await readdir(tmpdir())).filter((name) => name.startsWith("codex-output-")),
  )

agentManifestConformance("Codex", { create: () => makeHarness().registration })

walkthroughConformance("Codex", {
  create: () => makeHarness().registration,
  request: walkthroughRequest,
  expectedFailure: () => {
    const harness = makeHarness({ walkthroughOutput: "" })
    return requireWalkthrough(harness.registration)
      .execute(walkthroughRequest())
      .pipe(Effect.flatMap(() => Effect.die("Expected walkthrough failure")))
  },
  temporaryFiles: codexTemporaryFiles,
})

reviewConformance("Codex", {
  create: () => makeHarness().registration,
  request: reviewRequest,
})

agentSecurityConformance("Codex", {
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
  sensitiveValues: ["private-value-sanitized"],
  maxArtifactLength: 64 * 1024,
  allowedTools: [allowedTool],
  observedTools: () => [allowedTool],
})

agentCancellationConformance("Codex", {
  createRun: () => {
    let acquired = false
    let released = false
    const cancellationTempDirectory = mkdtempSync(join(tmpdir(), "diffdash-codex-test-"))
    const harness = makeHarness()
    const registration = makeCodexProvider({
      processes: {
        run:
          harness.registration.walkthrough === undefined
            ? () => Effect.die(new Error("unreachable"))
            : (request) => Effect.succeed(result(request, "codex-cli 1.2.3")),
        streamLines: () =>
          Stream.acquireRelease(
            Effect.sync(() => void (acquired = true)),
            () => Effect.sync(() => void (released = true)),
          ).pipe(Stream.flatMap(() => Stream.never)),
      },
      tempDirectory: cancellationTempDirectory,
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
        const resources = await readdir(cancellationTempDirectory)
        await rm(cancellationTempDirectory, { force: true, recursive: true })
        return resources.length === 0 && (!acquired || released)
      }),
    }
  },
})

describe("Codex provider", () => {
  it.effect("uses one version probe implementation for both capabilities", () =>
    Effect.gen(function* () {
      const harness = makeHarness()
      yield* requireWalkthrough(harness.registration).probe
      yield* requireReview(harness.registration).probe
      expect(harness.calls.filter(({ args }) => args[0] === "--version")).toHaveLength(2)
      expect(harness.calls.find(({ args }) => args[0] === "--version")?.args).toEqual(["--version"])
    }),
  )

  it.effect("builds an explicit read-only walkthrough command and cleans its output file", () =>
    Effect.gen(function* () {
      const harness = makeHarness()
      const before = yield* codexTemporaryFiles()
      const output = yield* requireWalkthrough(harness.registration).execute(walkthroughRequest())
      expect(output.text).toBe("generated walkthrough")
      expect(yield* codexTemporaryFiles()).toEqual(before)
      const call = harness.calls.find(({ args }) => args.includes("--output-last-message"))
      expect(call?.args).toContain("read-only")
      expect(call?.args).toContain("never")
      expect(call?.args).toContain("--ephemeral")
      expect(call?.args).toContain("--skip-git-repo-check")
      expect(call?.args).toContain('model_reasoning_effort="low"')
    }),
  )

  it.effect("normalizes review JSONL, usage, artifacts, and ignores prior sessions", () =>
    Effect.gen(function* () {
      const harness = makeHarness()
      const output = yield* requireReview(harness.registration).execute(reviewRequest())
      expect(output.response.bodyMarkdown).toBe("The changed hunk is correct.")
      expect(output.sessionId).toBeNull()
      expect(output.usage).toMatchObject({
        inputTokens: 240,
        outputTokens: 42,
        cacheReadTokens: 120,
      })
      expect(output.artifacts.map(({ type }) => type)).toEqual([
        "shell-output",
        "mcp-tool-result",
        "provider-message",
      ])
      const call = harness.calls.find(({ args }) => args.includes("--json"))
      expect(call?.args).not.toContain("resume")
      expect(JSON.stringify(call?.args)).not.toContain("sanitized-secret-token")
      expect(call?.env).toEqual({ DIFFDASH_MCP_BEARER_TOKEN: "sanitized-secret-token" })
    }),
  )

  it.effect("adapts current, sparse, and nested Codex web and repository search items", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ reviewFixture: "codex-review-search-variants.jsonl" })
      const output = yield* requireReview(harness.registration).execute(reviewRequest())

      expect(output.response.bodyMarkdown).toBe("The changed hunk is correct.")
      expect(output.artifacts.map(({ type }) => type)).toEqual([
        "web-result",
        "web-result",
        "web-result",
        "web-result",
        "search-result",
        "unknown",
        "provider-message",
      ])

      const fullWeb = output.artifacts.find(({ metadata }) => metadata.itemId === "web-full")
      expect(fullWeb).toMatchObject({
        type: "web-result",
        metadata: {
          eventType: "web_search",
          itemId: "web-full",
          query: "Codex JSONL protocol",
          status: "completed",
          url: "https://developers.openai.com/codex/non-interactive-mode",
        },
      })
      expect(fullWeb?.content).toContain("JSONL event documentation")

      const queryOnly = output.artifacts.find(
        ({ metadata }) => metadata.itemId === "web-query-only",
      )
      expect(queryOnly?.content).toBe("Query: Codex item variants")
      const statusOnly = output.artifacts.find(
        ({ metadata }) => metadata.itemId === "web-status-only",
      )
      expect(statusOnly?.content).toBe("Status: completed")

      const nested = output.artifacts.find(({ metadata }) => metadata.itemId === "web-nested")
      expect(nested).toMatchObject({
        type: "web-result",
        content: '{"summary":"Nested web result"}',
        metadata: {
          eventType: "web_search_call",
          itemId: "web-nested",
          query: "Codex exec JSONL\nCodex web search item",
          status: "completed",
          url: "https://example.com/codex",
        },
      })

      const repository = output.artifacts.find(
        ({ metadata }) => metadata.itemId === "repository-search",
      )
      expect(repository).toMatchObject({
        type: "search-result",
        metadata: {
          eventType: "search",
          itemId: "repository-search",
          query: "provider-result-adapter",
          status: "completed",
        },
      })
      expect(repository?.content).toContain("provider-result-adapter.ts")

      const ambiguous = output.artifacts.find(
        ({ metadata }) => metadata.itemId === "ambiguous-search",
      )
      expect(ambiguous).toMatchObject({
        type: "unknown",
        metadata: { eventType: "search", itemId: "ambiguous-search", status: "completed" },
      })
      expect(ambiguous?.content).toContain("Must remain unknown")
    }),
  )

  it.effect("preserves unknown completed items while tolerating additive top-level events", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ reviewFixture: "codex-review-unknown-events.jsonl" })
      const output = yield* requireReview(harness.registration).execute(reviewRequest())

      expect(output.response.bodyMarkdown).toBe("The changed hunk is correct.")
      expect(output.artifacts.map(({ type }) => type)).toEqual(["unknown", "provider-message"])
      expect(output.artifacts[0]).toMatchObject({
        title: "Unknown Codex completed item: future_completed_item",
        metadata: {
          eventType: "future_completed_item",
          itemId: "future-1",
          status: "completed",
        },
      })
      expect(output.artifacts[0]?.content).toContain("Retain this future payload")
    }),
  )

  it.effect("selects the last completed agent message as the deterministic final response", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ reviewFixture: "codex-review-multiple-messages.jsonl" })
      const output = yield* requireReview(harness.registration).execute(reviewRequest())

      expect(output.response.bodyMarkdown).toBe("The final structured response wins.")
      expect(output.artifacts.map(({ content }) => content)).toEqual([
        "I am checking the changed hunk.",
        '{"bodyMarkdown":"The final structured response wins.","threadSummaryUpdate":null,"referencedAnchors":null}',
      ])
    }),
  )

  it.effect("rejects missing and reordered Codex lifecycle events", () =>
    Effect.gen(function* () {
      for (const [fixture, reason] of [
        ["codex-review-lifecycle-missing.jsonl", "without a complete turn lifecycle"],
        ["codex-review-lifecycle-reordered.jsonl", "expected thread.started"],
      ] as const) {
        const harness = makeHarness({ reviewFixture: fixture })
        const error = yield* requireReview(harness.registration)
          .execute(reviewRequest())
          .pipe(Effect.flip)
        expect(error).toBeInstanceOf(AgentProviderOperationError)
        expect(error.reason).toContain(reason)
      }
    }),
  )

  it.effect("rejects malformed JSONL, invalid responses, provider errors, and file changes", () =>
    Effect.gen(function* () {
      for (const [fixture, reason] of [
        ["codex-review-malformed.jsonl", "invalid JSONL"],
        ["codex-review-non-object.jsonl", "event is not a JSON object"],
        ["codex-review-invalid-response.jsonl", "invalid review response"],
        ["codex-review-error.jsonl", "model request failed"],
        ["codex-review-file-change.jsonl", "file change"],
        ["codex-review-file-change-updated.jsonl", "file change"],
        ["codex-review-file-change-completed.jsonl", "file change"],
      ] as const) {
        const harness = makeHarness({ reviewFixture: fixture })
        const error = yield* requireReview(harness.registration)
          .execute(reviewRequest())
          .pipe(Effect.flip)
        expect(error.reason).toContain(reason)
      }
    }),
  )

  it("owns defaults and all automatic quality candidates", () => {
    expect(CODEX_DEFAULT_MODEL).toBe(AgentModelId.make("gpt-5.3-codex-spark"))
    expect(CODEX_AUTO_MODELS).toEqual({
      best: "gpt-5.5",
      balanced: "gpt-5.3-codex-spark",
      fast: "gpt-5.4-mini",
    })
    expect(CODEX_WALKTHROUGH_POLICY).toMatchObject({
      repository: "local-working-copy",
      shell: "read-only",
    })
    expect(CODEX_REVIEW_POLICY).toMatchObject({
      repository: "reviewed-revision",
      shell: "read-only",
    })
  })
})
