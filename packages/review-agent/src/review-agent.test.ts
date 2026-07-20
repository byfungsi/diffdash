import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
import {
  LocalReviewDetail,
  LocalReviewDiff,
  LocalReviewTarget,
} from "@diffdash/domain/local-review"
import { ReviewAgentArtifact, ReviewAgentUsage } from "@diffdash/domain/review-agent"
import {
  HostedReviewSnapshot,
  LocalReviewSnapshot,
  type ReviewSnapshot,
} from "@diffdash/domain/review-context"
import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewRevision,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import {
  HostedReviewTarget,
  LineReviewAnchor,
  MarkdownBody,
  type ReviewThreadDetails,
} from "@diffdash/domain/review-thread"
import {
  GitProviderCapabilities,
  BranchRevision,
  GitProviderDescriptor,
  GitProviderId,
  GitProviderKind,
  type GitProviderRegistration,
  GitProviderRegistry,
  GitProviderTerminology,
  HostedReviewCheckoutSpec,
  HostedReviewDetail,
  HostedReviewDiff,
  HostedReviewSummary,
  ProviderActor,
  makeHostedReviewLocator,
} from "@diffdash/git-provider"
import {
  HostedReviewWorkspacePool,
  HostedReviewWorkspacePoolError,
} from "@diffdash/local-git/hosted-review-workspace-pool"
import { AgentRunArtifactStore } from "@diffdash/persistence/agent-run-artifact-store"
import { AgentRunStore } from "@diffdash/persistence/agent-run-store"
import { DatabaseService } from "@diffdash/persistence/database"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import { ThreadMemoryStore } from "@diffdash/persistence/thread-memory-store"
import {
  ReviewTurnMappingToken,
  ReviewTurnStore,
  ReviewTurnTargetError,
  type ReviewTurnWriteStep,
} from "@diffdash/persistence/review-turn-store"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Redacted } from "effect"
import { AgentArtifactNormalizer, normalizeAgentArtifactType } from "./agent-artifact-normalizer"
import { DiffDashMcpServer } from "./diffdash-mcp-server"
import {
  type ReviewAgentRouteSelection,
  ReviewAgentFinalizeError,
  ReviewAgentRouting,
  ReviewAgentService,
} from "./review-agent"
import { ReviewContextBuilder } from "./review-context-builder"

const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-const value = 1
+const value = 2`
const reviewKey = ReviewKey.make(
  `local:${createHash("sha256").update("/workspace/diffdash").digest("hex")}`,
)
const baseRevision = ReviewRevision.make("base-sha")
const headRevision = ReviewRevision.make("head-sha")
const snapshot = LocalReviewSnapshot.make({
  snapshotId: ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000001"),
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
const pullRequestLocator = makeHostedReviewLocator("github", "fungsi", "diffdash", 42)
const pullRequestSnapshot = HostedReviewSnapshot.make({
  snapshotId: ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000002"),
  reviewKey: ReviewKey.make("github:fungsi/diffdash#42"),
  baseRevision,
  headRevision,
  detail: HostedReviewDetail.make({
    summary: HostedReviewSummary.make({
      locator: pullRequestLocator,
      title: "Feature",
      body: null,
      author: ProviderActor.make({
        id: null,
        username: "reviewer",
        displayName: null,
        avatarUrl: null,
      }),
      state: "OPEN",
      decision: "none",
      url: "https://github.com/fungsi/diffdash/pull/42",
      draft: false,
      base: BranchRevision.make({ name: "main", revision: baseRevision }),
      head: BranchRevision.make({ name: "feature", revision: headRevision }),
      createdAt: null,
      updatedAt: null,
    }),
    files: [],
    commits: [],
  }),
  diff: HostedReviewDiff.make({
    locator: pullRequestLocator,
    headRevision,
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

const turnIdentity = (details: ReviewThreadDetails, reviewSnapshot: ReviewSnapshot) => {
  const currentAnchor = details.thread.currentAnchor
  if (currentAnchor === null) throw new Error("Test review thread requires an active anchor")
  return {
    repoId: details.thread.repoId,
    target:
      reviewSnapshot instanceof HostedReviewSnapshot
        ? HostedReviewTarget.make({
            kind: "hosted",
            review: reviewSnapshot.detail.summary.locator,
          })
        : LocalReviewTarget.make({
            kind: "local",
            rootPath: reviewSnapshot.detail.rootPath,
            comparison: reviewSnapshot.detail.comparison,
          }),
    mapping: ReviewTurnMappingToken.make({
      threadId: details.thread.id,
      repoId: details.thread.repoId,
      reviewKey: details.thread.reviewKey,
      baseRevision: details.thread.currentBaseRevision,
      headRevision: details.thread.currentHeadRevision,
      currentAnchor,
    }),
  }
}

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
  released: {
    count: number
    events?: string[]
    mcpPaths?: Array<string | null>
    workspaceFailure?: HostedReviewWorkspacePoolError
    turnFailure?: ReviewTurnWriteStep
  },
  routeSelection: ReviewAgentRouteSelection = {
    route: { mode: "auto" },
    models: {},
    autoQuality: "balanced",
  },
) => {
  const database = DatabaseService.layer(databasePath)
  const persistence = Layer.mergeAll(
    RepositoryStore.layer,
    ReviewThreadStore.layer,
    AgentRunStore.layer,
    AgentRunArtifactStore.layer,
    ThreadMemoryStore.layer,
    ReviewTurnStore.layerWith({
      afterWrite: (step) => {
        if (released.turnFailure === step) throw new Error(`fault:${step}`)
      },
    }),
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
      get: Effect.succeed(routeSelection),
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
        released.workspaceFailure === undefined
          ? Effect.acquireUseRelease(
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
            )
          : Effect.fail(released.workspaceFailure),
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
    repositoryUrl: () => Effect.succeed("https://git.test/repository"),
    fileUrl: () => Effect.succeed("https://git.test/file"),
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
          ...turnIdentity(created, pullRequestSnapshot),
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

  it.scoped(
    "finalizes an interrupted provider before revoking MCP and releasing its workspace",
    () =>
      Effect.gen(function* () {
        const databasePath = yield* makeTempDatabasePath
        const providerStarted = yield* Deferred.make<void>()
        const released = { count: 0, events: [] as string[] }
        const layer = makeLayer(
          databasePath,
          () =>
            Effect.sync(() => released.events.push("provider.run")).pipe(
              Effect.zipRight(Deferred.succeed(providerStarted, undefined)),
              Effect.zipRight(Effect.never),
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
            bodyMarkdown: MarkdownBody.make("Interrupt this provider."),
          })
          const turn = yield* (yield* ReviewAgentService)
            .runThreadTurn({
              threadId: created.thread.id,
              ...turnIdentity(created, pullRequestSnapshot),
              snapshot: pullRequestSnapshot,
              cwd: repo.localPath,
              walkthrough: null,
            })
            .pipe(Effect.fork)
          yield* Deferred.await(providerStarted)
          yield* Fiber.interrupt(turn)
        }).pipe(Effect.provide(layer))

        expect(released.events).toEqual([
          "worktree.acquire",
          "mcp.acquire",
          "provider.run",
          "provider.finalized",
          "mcp.release",
          "worktree.release",
        ])
        expect(released.count).toBe(1)
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
          ...turnIdentity(created, snapshot),
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

  it.scoped("returns a distinct finalize error without compensating a rolled-back completion", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const released = { count: 0, turnFailure: "complete.run" as ReviewTurnWriteStep }
      const layer = makeLayer(
        databasePath,
        () => Effect.succeed(makeProviderResult({ bodyMarkdown: "Do not split this result." })),
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
          bodyMarkdown: MarkdownBody.make("Finalize atomically."),
        })
        const error = yield* (yield* ReviewAgentService)
          .runThreadTurn({
            threadId: created.thread.id,
            ...turnIdentity(created, snapshot),
            snapshot,
            cwd: repo.localPath,
            walkthrough: null,
          })
          .pipe(Effect.flip)
        const details = yield* (yield* ReviewThreadStore).get(created.thread.id)
        const runs = yield* (yield* AgentRunStore).listForThread(created.thread.id)

        expect(error).toBeInstanceOf(ReviewAgentFinalizeError)
        expect(error).toMatchObject({ operation: "completeTurn" })
        expect(details.messages.at(-1)?.status).toBe("pending")
        expect(runs).toHaveLength(1)
        expect(runs[0]?.status).toBe("running")
      }).pipe(Effect.provide(layer))
    }),
  )

  it.scoped(
    "returns a distinct finalize error when transactional failure persistence rolls back",
    () =>
      Effect.gen(function* () {
        const databasePath = yield* makeTempDatabasePath
        const released = { count: 0, turnFailure: "fail.run" as ReviewTurnWriteStep }
        const layer = makeLayer(
          databasePath,
          () =>
            Effect.fail(
              AgentProviderOperationError.make({
                providerId: AgentProviderId.make("opencode"),
                capability: "review-thread",
                reason: "Provider failed before finalization",
                cause: new Error("Provider failed"),
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
            bodyMarkdown: MarkdownBody.make("Fail atomically."),
          })
          const error = yield* (yield* ReviewAgentService)
            .runThreadTurn({
              threadId: created.thread.id,
              ...turnIdentity(created, snapshot),
              snapshot,
              cwd: repo.localPath,
              walkthrough: null,
            })
            .pipe(Effect.flip)
          const details = yield* (yield* ReviewThreadStore).get(created.thread.id)
          const runs = yield* (yield* AgentRunStore).listForThread(created.thread.id)

          expect(error).toBeInstanceOf(ReviewAgentFinalizeError)
          expect(error).toMatchObject({ operation: "failTurn" })
          expect(details.messages.at(-1)?.status).toBe("pending")
          expect(runs[0]?.status).toBe("running")
        }).pipe(Effect.provide(layer))
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
                  reason: `${"x".repeat(700)}
Authorization: Bearer persisted-bearer-secret refresh_token=persisted-refresh-secret`,
                  cause: new Error("Provider failed"),
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
        const error = yield* (yield* ReviewAgentService)
          .runThreadTurn({
            threadId: created.thread.id,
            ...turnIdentity(created, pullRequestSnapshot),
            snapshot: pullRequestSnapshot,
            cwd: repo.localPath,
            walkthrough: null,
          })
          .pipe(Effect.flip)
        const details = yield* (yield* ReviewThreadStore).get(created.thread.id)
        const runs = yield* (yield* AgentRunStore).listForThread(created.thread.id)

        expect(details.messages[1]).toMatchObject({ author: "agent", status: "failed" })
        expect(runs[0]).toMatchObject({ status: "failed", usage: null })
        const persistedMessage = String(details.messages[1]?.bodyMarkdown)
        expect(persistedMessage).toContain("Authorization: [redacted]")
        expect(persistedMessage).toContain("refresh_token=[redacted]")
        expect(persistedMessage).not.toContain("persisted-bearer-secret")
        expect(persistedMessage).not.toContain("persisted-refresh-secret")
        expect(persistedMessage).not.toContain("\n")
        expect(runs[0]?.error).toBe(persistedMessage)
        expect(error.reason).not.toContain("persisted-bearer-secret")
        expect(error.reason).not.toContain("persisted-refresh-secret")
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

  it.scoped("bounds and redacts hosted workspace failures before persistence or display", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const workspaceFailure = HostedReviewWorkspacePoolError.make({
        code: "git",
        operation: "git.run",
        reason: `${"x".repeat(700)}
Authorization: Basic workspace-basic-secret id_token=workspace-id-secret`,
        cause: new Error("Workspace preparation failed"),
      })
      const released = { count: 0, workspaceFailure }
      const layer = makeLayer(
        databasePath,
        () => Effect.succeed(makeProviderResult({ bodyMarkdown: "Unexpected response." })),
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
          bodyMarkdown: MarkdownBody.make("Prepare this workspace."),
        })
        const error = yield* (yield* ReviewAgentService)
          .runThreadTurn({
            threadId: created.thread.id,
            ...turnIdentity(created, pullRequestSnapshot),
            snapshot: pullRequestSnapshot,
            cwd: repo.localPath,
            walkthrough: null,
          })
          .pipe(Effect.flip)
        const details = yield* (yield* ReviewThreadStore).get(created.thread.id)
        const runs = yield* (yield* AgentRunStore).listForThread(created.thread.id)
        const persistedMessage = String(details.messages[1]?.bodyMarkdown)

        expect(persistedMessage).toHaveLength(600)
        expect(persistedMessage).toContain("Authorization: [redacted]")
        expect(persistedMessage).toContain("id_token=[redacted]")
        expect(persistedMessage).not.toContain("workspace-basic-secret")
        expect(persistedMessage).not.toContain("workspace-id-secret")
        expect(persistedMessage).not.toContain("\n")
        expect(runs[0]?.error).toBe(persistedMessage)
        expect(error.reason).toBe(persistedMessage)
      }).pipe(Effect.provide(layer))

      expect(released.count).toBe(0)
    }),
  )

  it.scoped("rejects provider preflight without creating a detached failed message or run", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const released = { count: 0 }
      const layer = makeLayer(
        databasePath,
        () => Effect.succeed(makeProviderResult({ bodyMarkdown: "Unexpected response." })),
        released,
        {
          route: { mode: "provider", providerId: AgentProviderId.make("opencode") },
          models: { opencode: "removed-model" },
          autoQuality: "balanced",
        },
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
          bodyMarkdown: MarkdownBody.make("Explain this line."),
        })

        const error = yield* (yield* ReviewAgentService)
          .runThreadTurn({
            threadId: created.thread.id,
            ...turnIdentity(created, snapshot),
            snapshot,
            cwd: repo.localPath,
            walkthrough: null,
          })
          .pipe(Effect.flip)

        const details = yield* (yield* ReviewThreadStore).get(created.thread.id)
        const runs = yield* (yield* AgentRunStore).listForThread(created.thread.id)
        expect(error.reason).toContain("No review-thread model is configured")
        expect(details.messages).toHaveLength(1)
        expect(runs).toEqual([])
      }).pipe(Effect.provide(layer))
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
            ...turnIdentity(created, snapshot),
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
        const turns = yield* ReviewTurnStore
        const created = yield* threads.create({
          repoId: repo.id,
          reviewKey,
          prNumber: null,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Recover this interrupted turn."),
        })
        const identity = turnIdentity(created, snapshot)
        const targetInput = {
          threadId: created.thread.id,
          target: identity.target,
          repoId: identity.repoId,
          reviewKey: created.thread.reviewKey,
          baseRevision: created.thread.currentBaseRevision,
          headRevision: created.thread.currentHeadRevision,
        }
        const mapping = yield* turns.validateTarget(targetInput)
        const interruptedTurn = yield* turns.beginTurn({
          ...targetInput,
          mapping,
          provider: "opencode",
          model: "openai/gpt-5.3-codex-spark",
          promptVersion: AgentPromptVersion.make("review-thread-v3"),
        })
        yield* turns.recoverInterruptedTurns

        const completed = yield* (yield* ReviewAgentService).runThreadTurn({
          threadId: created.thread.id,
          ...turnIdentity(created, snapshot),
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
        expect(persistedRuns.find(({ id }) => id === interruptedTurn.run.id)?.error).toBe(
          "The previous local agent run was interrupted. Retry to try again.",
        )
      }).pipe(Effect.provide(layer))
    }),
  )

  it.scoped("rejects wrong hosted, local, and repository targets before provider execution", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      let providerCalls = 0
      const released = { count: 0 }
      const layer = makeLayer(
        databasePath,
        () =>
          Effect.sync(() => {
            providerCalls += 1
            return makeProviderResult({ bodyMarkdown: "Must not run." })
          }),
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
          bodyMarkdown: MarkdownBody.make("Reject wrong targets."),
        })
        const identity = turnIdentity(created, pullRequestSnapshot)
        const wrongTargets = [
          {
            ...identity,
            target: HostedReviewTarget.make({
              kind: "hosted",
              review: makeHostedReviewLocator("github", "fungsi", "other", 42),
            }),
          },
          {
            ...identity,
            target: LocalReviewTarget.make({ kind: "local", rootPath: "/workspace/diffdash" }),
          },
          { ...identity, repoId: "github:fungsi/other" },
        ]
        for (const invalid of wrongTargets) {
          const error = yield* (yield* ReviewAgentService)
            .runThreadTurn({
              threadId: created.thread.id,
              ...invalid,
              snapshot: pullRequestSnapshot,
              cwd: repo.localPath,
              walkthrough: null,
            })
            .pipe(Effect.flip)
          expect(error).toBeInstanceOf(ReviewTurnTargetError)
        }
        expect(providerCalls).toBe(0)
        expect((yield* (yield* ReviewThreadStore).get(created.thread.id)).messages).toHaveLength(1)
        expect(yield* (yield* AgentRunStore).listForThread(created.thread.id)).toEqual([])
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
          ...turnIdentity(created, snapshot),
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

        expect(concurrentError.reason).toBe("A review agent turn is already running.")
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
