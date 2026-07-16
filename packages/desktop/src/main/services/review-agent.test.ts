import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Fiber, Layer, Redacted } from "effect"

import { AgentPromptVersion } from "@diffdash/domain/agent-run"
import { DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import {
  GitProviderId,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewLocator,
  HostedReviewNumber,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import { LocalReviewDetail, LocalReviewDiff } from "@diffdash/domain/local-review"
import { PullRequestDetail, PullRequestDiff, ReviewActor } from "@diffdash/domain/pull-request"
import {
  ReviewAgentArtifact,
  ReviewAgentTurnResult,
  ReviewAgentUsage,
  ReviewThreadAgentResponse,
} from "@diffdash/domain/review-agent"
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
import { AppSettings } from "@diffdash/settings/app-settings"
import { DatabaseService } from "@diffdash/persistence/database"
import { DiffDashMcpServer } from "./diffdash-mcp-server"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { ReviewAgentService } from "./review-agent"
import {
  ReviewAgentExecutionError,
  ReviewAgentProvider,
  type ReviewAgentProviderError,
} from "./review-agent-provider"
import { ReviewAgentProviderRegistry } from "./review-agent-provider-registry"
import { ReviewContextBuilder } from "./review-context-builder"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import { HostedReviewWorkspacePool } from "@diffdash/local-git/hosted-review-workspace-pool"
import { HostedReviewCheckoutSpec } from "@diffdash/git-provider"
import { ThreadMemoryStore } from "@diffdash/persistence/thread-memory-store"
import { GitProvider } from "./git-provider"

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

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-agent-service-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (
  databasePath: string,
  runTurn: Context.Tag.Service<ReviewAgentProvider>["runThreadTurn"],
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
  const provider = ReviewAgentProvider.of({
    id: "opencode",
    isAvailable: Effect.succeed(true),
    runThreadTurn: runTurn,
  })
  const registry = Layer.succeed(
    ReviewAgentProviderRegistry,
    ReviewAgentProviderRegistry.of({
      get: () => Effect.succeed(provider),
      resolve: () => Effect.succeed(provider),
    }),
  )
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
  const gitProvider = Layer.succeed(
    GitProvider,
    GitProvider.of({
      parseRemoteUrl: () => Effect.die("not used"),
      repositoryUrl: () => "https://github.com/fungsi/diffdash",
      fileUrl: () => "https://github.com/fungsi/diffdash/blob/head/file",
      searchRepositories: () => Effect.succeed([]),
      listSearchScopes: () => Effect.succeed([]),
      listRepositories: () => Effect.succeed([]),
      listPullRequests: () => Effect.succeed([]),
      listReviewRequests: () => Effect.succeed([]),
      getPullRequestDetail: () => Effect.die("not used"),
      refreshPullRequestDetail: () => Effect.die("not used"),
      getPullRequestDiff: () => Effect.die("not used"),
      hasApprovedPullRequest: () => Effect.succeed(false),
      approvePullRequest: () => Effect.void,
      isAvailable: Effect.succeed(true),
      hostedReviewCheckoutSpec: (owner, name, number, revision) => {
        const repository = HostedRepositoryLocator.make({
          providerId: GitProviderId.make("github"),
          namespace: RepositoryNamespace.make(owner),
          name: HostedRepositoryName.make(name),
        })
        return Effect.succeed(
          HostedReviewCheckoutSpec.make({
            repository,
            review: HostedReviewLocator.make({
              repository,
              number: HostedReviewNumber.make(number),
            }),
            remoteUrl: `https://github.com/${owner}/${name}.git`,
            fetchRef: `refs/pull/${number}/head`,
            revision,
          }),
        )
      },
      bootstrapBareRepository: () => Effect.void,
    }),
  )
  return ReviewAgentService.layer.pipe(
    Layer.provideMerge(persistence),
    Layer.provideMerge(
      Layer.succeed(
        AppSettings,
        AppSettings.of({
          get: Effect.succeed(DEFAULT_AI_SETTINGS),
          save: (settings) => Effect.succeed(settings),
        }),
      ),
    ),
    Layer.provideMerge(registry),
    Layer.provideMerge(mcp),
    Layer.provideMerge(worktrees),
    Layer.provideMerge(gitProvider),
    Layer.provideMerge(ReviewContextBuilder.layer),
  )
}

describe("ReviewAgentService", () => {
  it.scoped("leases an isolated PR worktree around MCP and provider execution", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const released = { count: 0, events: [] as string[], mcpPaths: [] as Array<string | null> }
      const providerResult = ReviewAgentTurnResult.make({
        response: ReviewThreadAgentResponse.make({ bodyMarkdown: "Reviewed exact head." }),
        artifacts: [],
        providerRunId: null,
        usage: null,
      })
      const layer = makeLayer(
        databasePath,
        (input) =>
          Effect.sync(() => {
            released.events.push("provider.run")
            expect(input.cwd).toBe("/workspace/pool")
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
            ReviewAgentTurnResult.make({
              response: ReviewThreadAgentResponse.make({
                bodyMarkdown: "The change is safe.",
                threadSummaryUpdate: "Reviewed the value update.",
              }),
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
              providerRunId: null,
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
          contentDigest: "sha256:test-artifact",
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
              Effect.fail<ReviewAgentProviderError>(
                ReviewAgentExecutionError.make({
                  provider: "opencode",
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
            providerRunId: null,
            usage: null,
            // SAFETY: This intentionally malformed fake crosses the provider boundary to test decoding.
          } as unknown as ReviewAgentTurnResult),
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
        () =>
          Effect.succeed(
            ReviewAgentTurnResult.make({
              response: ReviewThreadAgentResponse.make({ bodyMarkdown: "Recovered response." }),
              artifacts: [],
              providerRunId: null,
              usage: null,
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
            Effect.as(
              ReviewAgentTurnResult.make({
                response: ReviewThreadAgentResponse.make({ bodyMarkdown: "Only response." }),
                artifacts: [],
                providerRunId: null,
                usage: null,
              }),
            ),
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
