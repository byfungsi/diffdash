import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Redacted } from "effect"
import {
  AgentArtifactCandidate,
  AgentCapabilityDeclaration,
  AgentCapabilityManifest,
  AgentCapabilityReady,
  type AgentExecutionPolicy,
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
  ReviewThreadResponse,
  ReviewThreadResult,
} from "@diffdash/agent-provider"
import { AgentProviderRegistry } from "@diffdash/agent-provider/registry"

import { AgentPromptVersion } from "@diffdash/domain/agent-run"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { LocalReviewDetail, LocalReviewDiff } from "@diffdash/domain/local-review"
import { PullRequestDetail, PullRequestDiff, ReviewActor } from "@diffdash/domain/pull-request"
import { ReviewAgentArtifact, ReviewAgentUsage } from "@diffdash/domain/review-agent"
import { LocalReviewSnapshot, PullRequestReviewSnapshot } from "@diffdash/domain/review-context"
import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import { LineReviewAnchor, MarkdownBody } from "@diffdash/domain/review-thread"
import { AgentRunArtifactStore } from "@diffdash/persistence/agent-run-artifact-store"
import { AgentRunStore } from "@diffdash/persistence/agent-run-store"
import { DatabaseService } from "@diffdash/persistence/database"
import { DiffDashMcpServer } from "./diffdash-mcp-server"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { ReviewAgentService } from "./review-agent"
import { ReviewAgentRouting } from "./review-agent"
import { ReviewContextBuilder } from "./review-context-builder"
import { AgentArtifactNormalizer } from "./agent-artifact-normalizer"
import { normalizeAgentArtifactType } from "./agent-artifact-normalizer"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import { HostedReviewWorkspacePool } from "@diffdash/local-git/hosted-review-workspace-pool"
import {
  GitProviderCapabilities,
  GitProviderDescriptor,
  GitProviderId,
  GitProviderKind,
  GitProviderRegistry,
  GitProviderTerminology,
  HostedReviewCheckoutSpec,
  type GitProviderRegistration,
} from "@diffdash/git-provider"
import { ThreadMemoryStore } from "@diffdash/persistence/thread-memory-store"

const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-const value = 1
+const value = 2`
const reviewKey = ReviewKey.make("local:/workspace/diffdash")
const baseRevision = ReviewRevision.make("base-sha")
const headRevision = ReviewRevision.make("head-sha")
const snapshot = LocalReviewSnapshot.make({
  reviewKey,
  baseRevision,
  headRevision,
  detail: LocalReviewDetail.make({
    rootPath: "/workspace/diffdash",
    repoName: "diffdash",
    branchName: "feature/m5",
    baseSha: baseRevision,
    headSha: headRevision,
    diffHash: "diff-hash",
    title: "Local changes",
    files: [],
    fetchedAt: "2026-07-12T00:00:00.000Z",
  }),
  diff: LocalReviewDiff.make({
    rootPath: "/workspace/diffdash",
    baseSha: baseRevision,
    headSha: headRevision,
    diffHash: "diff-hash",
    diff,
    fetchedAt: "2026-07-12T00:00:00.000Z",
  }),
  parsedDiff: parseUnifiedDiff(diff),
})
const pullRequestSnapshot = PullRequestReviewSnapshot.make({
  reviewKey: ReviewKey.make("github:fungsi/diffdash#42"),
  baseRevision,
  headRevision,
  detail: PullRequestDetail.make({
    repoOwner: "fungsi",
    repoName: "diffdash",
    number: 42,
    title: "Feature",
    body: null,
    author: ReviewActor.make({ login: "reviewer" }),
    state: "OPEN",
    url: "https://github.com/fungsi/diffdash/pull/42",
    isDraft: false,
    baseRefName: "main",
    baseRefOid: baseRevision,
    headRefName: "feature",
    headRefOid: headRevision,
    createdAt: null,
    updatedAt: null,
    files: [],
    commits: [],
  }),
  diff: PullRequestDiff.make({
    repoOwner: "fungsi",
    repoName: "diffdash",
    number: 42,
    headRefOid: headRevision,
    diff,
    fetchedAt: "2026-07-12T00:00:00.000Z",
  }),
  parsedDiff: parseUnifiedDiff(diff),
})
const lineAnchor = LineReviewAnchor.make({
  fileId: ReviewFileId.make("file-agent"),
  filePath: "src/a.ts",
  oldPath: null,
  hunkId: ReviewHunkId.make("hunk-agent"),
  hunkFingerprint: ReviewHunkFingerprint.make("fingerprint-agent"),
  hunkHeader: "@@ -1 +1 @@",
  side: "new",
  lineNumber: 1,
  lineContent: "const value = 2",
})

const makeProviderResult = (input: {
  readonly bodyMarkdown: string
  readonly threadSummary?: string
  readonly artifacts?: readonly ReviewAgentArtifact[]
  readonly usage?: ReviewAgentUsage
  readonly sessionId?: string
}) =>
  ReviewThreadResult.make({
    response: ReviewThreadResponse.make({
      bodyMarkdown: input.bodyMarkdown,
      threadSummary: input.threadSummary ?? null,
      referencedLocations: [],
    }),
    artifacts: (input.artifacts ?? []).map((artifact) =>
      AgentArtifactCandidate.make({
        type: providerArtifactType(artifact.type),
        title: artifact.title,
        content: artifact.content,
        metadata: artifact.metadata,
      }),
    ),
    usage:
      input.usage === undefined
        ? null
        : AgentUsage.make({
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            cacheReadTokens: input.usage.cacheReadTokens,
            cacheWriteTokens: input.usage.cacheWriteTokens,
            costUsd: input.usage.costUsd,
          }),
    sessionId: input.sessionId === undefined ? null : AgentSessionId.make(input.sessionId),
  })

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-agent-service-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const providerArtifactType = (
  type: ReviewAgentArtifact["type"],
): AgentArtifactCandidate["type"] => {
  const candidateTypes = [
    "file-read",
    "search-result",
    "shell-output",
    "web-result",
    "diff-context",
    "mcp-tool-result",
    "provider-message",
    "unknown",
  ] as const
  const candidate = candidateTypes.find((value) => normalizeAgentArtifactType(value) === type)
  if (candidate === undefined) throw new Error(`Missing provider artifact type for ${type}`)
  return candidate
}

const makeLayer = (
  databasePath: string,
  runTurn: (request: {
    readonly workingDirectory: string
    readonly sessionId: AgentSessionId | null
    readonly policy: AgentExecutionPolicy
  }) => Effect.Effect<ReviewThreadResult, AgentProviderOperationError>,
  released: { count: number; events?: string[]; mcpPaths?: Array<string | null> },
) => {
  const database = DatabaseService.layer(databasePath)
  const persistence = Layer.mergeAll(
    RepositoryStore.layer,
    ReviewThreadStore.layer,
    AgentRunStore.layer,
    AgentRunArtifactStore.layer,
    ThreadMemoryStore.layer,
  ).pipe(Layer.provide(database))
  const providerId = AgentProviderId.make("opencode")
  const modelId = AgentModelId.make("openai/gpt-5.3-codex-spark")
  const registration = {
    manifest: AgentProviderManifest.make({
      descriptor: AgentProviderDescriptor.make({
        id: providerId,
        displayName: "OpenCode",
        description: "Test provider",
        homepage: null,
      }),
      models: [
        AgentModelDescriptor.make({
          id: modelId,
          displayName: "Test model",
          capabilities: ["review-thread"],
          quality: "balanced",
        }),
      ],
      defaults: AgentProviderDefaults.make({ walkthroughModel: null, reviewThreadModel: modelId }),
      requirements: [
        AgentRuntimeRequirement.make({ name: "opencode", versionRange: null, installHint: null }),
      ],
      capabilities: AgentCapabilityManifest.make({
        walkthrough: AgentCapabilityDeclaration.make({ supported: false, autoPriority: null }),
        reviewThread: AgentCapabilityDeclaration.make({ supported: true, autoPriority: 1 }),
      }),
      session: AgentSessionSupport.make({ mode: "resume" }),
    }),
    reviewThread: {
      probe: Effect.succeed(
        AgentCapabilityReady.make({ capability: "review-thread", runtimeVersion: "test" }),
      ),
      execute: runTurn,
    },
  }
  const registry = AgentProviderRegistry.layer([registration], {
    walkthrough: [],
    reviewThread: [providerId],
  })
  const routing = Layer.succeed(
    ReviewAgentRouting,
    ReviewAgentRouting.of({
      get: Effect.succeed({ route: { mode: "auto" }, models: {}, autoQuality: "balanced" }),
    }),
  )
  const gitRegistry = GitProviderRegistry.layer([testGitProvider()])
  const mcp = Layer.succeed(
    DiffDashMcpServer,
    DiffDashMcpServer.of({
      acquireRun: (context) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            released.events?.push("mcp.acquire")
            released.mcpPaths?.push(context.localPath)
            return {
              url: "http://127.0.0.1:9000/mcp",
              bearerToken: Redacted.make("test-token"),
            }
          }),
          () =>
            Effect.sync(() => {
              released.count += 1
              released.events?.push("mcp.release")
            }),
        ),
    }),
  )
  const worktrees = Layer.succeed(
    HostedReviewWorkspacePool,
    HostedReviewWorkspacePool.of({
      use: (_input, run, onProgress) =>
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            yield* onProgress?.("reserving-workspace") ?? Effect.void
            released.events?.push("worktree.acquire")
            yield* onProgress?.("creating-repository") ?? Effect.void
            yield* onProgress?.("fetching-review-revision") ?? Effect.void
            yield* onProgress?.("checking-out-revision") ?? Effect.void
            return { localPath: "/workspace/pool", headSha: "head-sha", slotId: "slot" }
          }),
          run,
          () =>
            Effect.gen(function* () {
              yield* onProgress?.("restoring-workspace") ?? Effect.void
              released.events?.push("worktree.release")
            }),
        ),
    }),
  )
  return ReviewAgentService.layer.pipe(
    Layer.provideMerge(persistence),
    Layer.provideMerge(registry),
    Layer.provideMerge(routing),
    Layer.provideMerge(gitRegistry),
    Layer.provideMerge(mcp),
    Layer.provideMerge(worktrees),
    Layer.provideMerge(ReviewContextBuilder.layer),
    Layer.provideMerge(AgentArtifactNormalizer.layer),
  )
}

const unavailableGitOperation = <A>() =>
  Effect.dieMessage("Unused test Git provider operation") as Effect.Effect<A>

const testGitProvider = (): GitProviderRegistration => {
  const id = GitProviderId.make("github")
  return {
    descriptor: GitProviderDescriptor.make({
      id,
      kind: GitProviderKind.make("test"),
      displayName: "Test Git",
      host: "git.test",
      capabilities: GitProviderCapabilities.make({
        repositorySearch: false,
        searchScopes: false,
        assignedReviews: false,
        reviewDecisions: false,
        fileUrls: false,
        remoteWorkspaceBootstrap: true,
      }),
      terminology: GitProviderTerminology.make({
        repositorySingular: "repository",
        repositoryPlural: "repositories",
        reviewSingular: "review",
        reviewPlural: "reviews",
      }),
    }),
    publishingTools: ["gh", "glab"],
    diagnose: unavailableGitOperation(),
    parseRemote: () => unavailableGitOperation(),
    searchRepositories: () => unavailableGitOperation(),
    listReviews: () => unavailableGitOperation(),
    getReview: () => unavailableGitOperation(),
    getReviewDiff: () => unavailableGitOperation(),
    getReviewDecision: () => unavailableGitOperation(),
    submitReviewDecision: () => unavailableGitOperation(),
    repositoryUrl: () => "https://git.test/repository",
    fileUrl: () => "https://git.test/file",
    bootstrapBareRepository: () => Effect.void,
    checkoutSpec: () => unavailableGitOperation(),
    checkoutSpecAtRevision: (review, revision) =>
      Effect.succeed(
        HostedReviewCheckoutSpec.make({
          repository: review.repository,
          review,
          remoteUrl: `https://git.test/${review.repository.namespace}/${review.repository.name}.git`,
          fetchRef: `refs/reviews/${review.number}/head`,
          revision,
        }),
      ),
  }
}

describe("ReviewAgentService", () => {
  it.scoped("leases an isolated PR worktree around MCP and provider execution", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const released = { count: 0, events: [] as string[], mcpPaths: [] as Array<string | null> }
      const providerResult = makeProviderResult({ bodyMarkdown: "Reviewed exact head." })
      const layer = makeLayer(
        databasePath,
        (input) =>
          Effect.sync(() => {
            released.events.push("provider.run")
            expect(input.workingDirectory).toBe("/workspace/pool")
            expect(input.policy.providerPublishingTools).toEqual(["gh", "glab"])
          }).pipe(
            Effect.as(providerResult),
            Effect.ensuring(Effect.sync(() => released.events.push("provider.finalized"))),
          ),
        released,
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository({
          provider: "github",
          owner: "fungsi",
          name: "diffdash",
          remoteUrl: "git@github.com:fungsi/diffdash.git",
          localPath: "/workspace/user-checkout",
        })
        const created = yield* (yield* ReviewThreadStore).create({
          repoId: repo.id,
          reviewKey: pullRequestSnapshot.reviewKey,
          prNumber: 42,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Inspect the surrounding code."),
        })
        yield* (yield* ReviewAgentService).runThreadTurn({
          threadId: created.thread.id,
          snapshot: pullRequestSnapshot,
          cwd: repo.localPath,
          walkthrough: null,
          onProgress: (stage) => Effect.sync(() => released.events.push(`progress.${stage}`)),
        })
      }).pipe(Effect.provide(layer))

      expect(released.mcpPaths).toEqual(["/workspace/pool"])
      expect(released.events).toEqual([
        "progress.preparing-context",
        "progress.reserving-workspace",
        "worktree.acquire",
        "progress.creating-repository",
        "progress.fetching-review-revision",
        "progress.checking-out-revision",
        "progress.starting-agent",
        "mcp.acquire",
        "progress.reviewing",
        "provider.run",
        "provider.finalized",
        "mcp.release",
        "progress.restoring-workspace",
        "worktree.release",
      ])
    }),
  )

  it.scoped("FUN-72 AC: persists a complete run, reply, memory, and scoped MCP lifetime", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const released = { count: 0 }
      const usage = ReviewAgentUsage.make({
        inputTokens: 80,
        outputTokens: 24,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: 0.002,
      })
      const layer = makeLayer(
        databasePath,
        () =>
          Effect.succeed(
            makeProviderResult({
              bodyMarkdown: "The change is safe.",
              threadSummary: "Reviewed the value update.",
              artifacts: [
                ReviewAgentArtifact.make({
                  type: "mcp_tool_result",
                  provider: "opencode",
                  title: "Diff hunk",
                  content: "@@ -1 +1 @@",
                  contentDigest: "sha256:test-artifact",
                  metadata: { tool: "getDiffHunk" },
                  truncated: false,
                  originalSize: 13,
                }),
              ],
              usage,
            }),
          ),
        released,
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository({
          provider: "local",
          owner: "local",
          name: "diffdash",
          remoteUrl: "file:///workspace/diffdash",
          localPath: "/workspace/diffdash",
        })
        const created = yield* (yield* ReviewThreadStore).create({
          repoId: repo.id,
          reviewKey,
          prNumber: null,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Is this safe?"),
        })
        const completed = yield* (yield* ReviewAgentService).runThreadTurn({
          threadId: created.thread.id,
          snapshot,
          cwd: repo.localPath,
          walkthrough: null,
        })
        const runs = yield* (yield* AgentRunStore).listForThread(created.thread.id)
        const artifacts = yield* (yield* AgentRunArtifactStore).listForThread(created.thread.id)
        const memory = yield* (yield* ThreadMemoryStore).get(created.thread.id)

        expect(completed.messages).toHaveLength(2)
        expect(completed.messages[1]).toMatchObject({
          author: "agent",
          bodyMarkdown: "The change is safe.",
          status: "complete",
        })
        expect(runs[0]).toMatchObject({ status: "completed", usage })
        expect(artifacts).toHaveLength(1)
        expect(artifacts[0]?.artifact).toMatchObject({
          type: "mcp_tool_result",
          contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        })
        expect(memory).toMatchObject({
          summary: "Reviewed the value update.",
          summarizedThroughSequence: 2,
        })
      }).pipe(Effect.provide(layer))

      expect(released.count).toBe(1)
    }),
  )

  it.scoped("FUN-72 AC: records a retryable failed message and failed run", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const released = { count: 0, events: [] as string[] }
      const layer = makeLayer(
        databasePath,
        () =>
          Effect.sync(() => released.events.push("provider.run")).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                AgentProviderOperationError.make({
                  providerId: AgentProviderId.make("opencode"),
                  capability: "review-thread",
                  reason: "sanitized provider failure",
                  cause: new Error("sanitized provider failure"),
                }),
              ),
            ),
            Effect.ensuring(Effect.sync(() => released.events.push("provider.finalized"))),
          ),
        released,
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository({
          provider: "github",
          owner: "fungsi",
          name: "diffdash",
          remoteUrl: "git@github.com:fungsi/diffdash.git",
          localPath: "/workspace/user-checkout",
        })
        const created = yield* (yield* ReviewThreadStore).create({
          repoId: repo.id,
          reviewKey: pullRequestSnapshot.reviewKey,
          prNumber: 42,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Please retry this."),
        })
        yield* (yield* ReviewAgentService)
          .runThreadTurn({
            threadId: created.thread.id,
            snapshot: pullRequestSnapshot,
            cwd: repo.localPath,
            walkthrough: null,
          })
          .pipe(Effect.flip)
        const details = yield* (yield* ReviewThreadStore).get(created.thread.id)
        const runs = yield* (yield* AgentRunStore).listForThread(created.thread.id)

        expect(details.messages[1]).toMatchObject({ author: "agent", status: "failed" })
        expect(runs[0]).toMatchObject({ status: "failed", usage: null })
      }).pipe(Effect.provide(layer))

      expect(released.count).toBe(1)
      expect(released.events).toEqual([
        "worktree.acquire",
        "mcp.acquire",
        "provider.run",
        "provider.finalized",
        "mcp.release",
        "worktree.release",
      ])
    }),
  )

  it.scoped("FUN-72 AC: validates the provider result before persisting completion", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const released = { count: 0 }
      const layer = makeLayer(
        databasePath,
        () =>
          Effect.succeed({
            response: { bodyMarkdown: "" },
            artifacts: [],
            sessionId: null,
            usage: null,
            // SAFETY: This intentionally malformed fake crosses the provider boundary to test decoding.
          } as unknown as ReviewThreadResult),
        released,
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository({
          provider: "local",
          owner: "local",
          name: "diffdash",
          remoteUrl: "file:///workspace/diffdash",
          localPath: "/workspace/diffdash",
        })
        const created = yield* (yield* ReviewThreadStore).create({
          repoId: repo.id,
          reviewKey,
          prNumber: null,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Validate this response."),
        })
        const error = yield* (yield* ReviewAgentService)
          .runThreadTurn({
            threadId: created.thread.id,
            snapshot,
            cwd: repo.localPath,
            walkthrough: null,
          })
          .pipe(Effect.flip)
        const details = yield* (yield* ReviewThreadStore).get(created.thread.id)

        expect(error.reason).toContain("bodyMarkdown")
        expect(details.messages[1]).toMatchObject({ author: "agent", status: "failed" })
      }).pipe(Effect.provide(layer))

      expect(released.count).toBe(1)
    }),
  )

  it.scoped("recovers an interrupted pending run before starting its replacement", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const released = { count: 0 }
      const layer = makeLayer(
        databasePath,
        () => Effect.succeed(makeProviderResult({ bodyMarkdown: "Recovered response." })),
        released,
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository({
          provider: "local",
          owner: "local",
          name: "diffdash",
          remoteUrl: "file:///workspace/diffdash",
          localPath: "/workspace/diffdash",
        })
        const threads = yield* ReviewThreadStore
        const runs = yield* AgentRunStore
        const created = yield* threads.create({
          repoId: repo.id,
          reviewKey,
          prNumber: null,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Recover this interrupted turn."),
        })
        const interruptedRun = yield* runs.start({
          threadId: created.thread.id,
          provider: "opencode",
          model: "openai/gpt-5.3-codex-spark",
          promptVersion: AgentPromptVersion.make("review-thread-v3"),
        })
        yield* threads.createPendingAgentMessage({
          threadId: created.thread.id,
          agentRunId: interruptedRun.id,
        })

        const completed = yield* (yield* ReviewAgentService).runThreadTurn({
          threadId: created.thread.id,
          snapshot,
          cwd: repo.localPath,
          walkthrough: null,
        })
        const persistedRuns = yield* runs.listForThread(created.thread.id)

        expect(completed.messages).toHaveLength(3)
        expect(completed.messages[1]).toMatchObject({
          author: "agent",
          status: "failed",
          bodyMarkdown: "The previous local agent run was interrupted. Retry to try again.",
        })
        expect(completed.messages[2]).toMatchObject({
          author: "agent",
          status: "complete",
          bodyMarkdown: "Recovered response.",
        })
        expect(new Set(persistedRuns.map(({ status }) => status))).toEqual(
          new Set(["completed", "failed"]),
        )
        expect(persistedRuns.find(({ id }) => id === interruptedRun.id)?.error).toBe(
          "The previous local agent run was interrupted.",
        )
      }).pipe(Effect.provide(layer))
    }),
  )

  it.scoped("rejects a concurrent turn before creating a second run or message", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const providerStarted = yield* Deferred.make<void>()
      const releaseProvider = yield* Deferred.make<void>()
      const released = { count: 0 }
      const layer = makeLayer(
        databasePath,
        () =>
          Deferred.succeed(providerStarted, undefined).pipe(
            Effect.zipRight(Deferred.await(releaseProvider)),
            Effect.as(makeProviderResult({ bodyMarkdown: "Only response." })),
          ),
        released,
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository({
          provider: "local",
          owner: "local",
          name: "diffdash",
          remoteUrl: "file:///workspace/diffdash",
          localPath: "/workspace/diffdash",
        })
        const created = yield* (yield* ReviewThreadStore).create({
          repoId: repo.id,
          reviewKey,
          prNumber: null,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Run this once."),
        })
        const service = yield* ReviewAgentService
        const input = {
          threadId: created.thread.id,
          snapshot,
          cwd: repo.localPath,
          walkthrough: null,
        } as const
        const firstTurn = yield* service.runThreadTurn(input).pipe(Effect.fork)
        yield* Deferred.await(providerStarted)

        const concurrentError = yield* service.runThreadTurn(input).pipe(Effect.flip)
        yield* Deferred.succeed(releaseProvider, undefined)
        const completed = yield* Fiber.join(firstTurn)
        const runs = yield* (yield* AgentRunStore).listForThread(created.thread.id)

        expect(concurrentError.reason).toBe("A review agent turn is already running")
        expect(runs).toHaveLength(1)
        expect(completed.messages).toHaveLength(2)
        expect(completed.messages[1]).toMatchObject({
          status: "complete",
          bodyMarkdown: "Only response.",
        })
      }).pipe(Effect.provide(layer))
    }),
  )
})
