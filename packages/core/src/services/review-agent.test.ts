import { createHash } from "node:crypto"
import { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
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
  type AgentProviderRegistration,
  AgentRuntimeRequirement,
  AgentSessionId,
  AgentSessionSupport,
  AgentUsage,
  type ReviewThreadCapability,
} from "@diffdash/agent-provider"
import { AgentProviderRegistry } from "@diffdash/agent-provider/registry"
import { makeAgentProviderOperationErrorFactory } from "@diffdash/agent-provider/runtime"
import { AIAgentSelection, AIModelId, AIProviderId } from "@diffdash/domain/ai-settings"
import { AgentPromptVersion } from "@diffdash/domain/agent-run"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import {
  HostedRepositorySource,
  LocalRepositorySource,
  makeHostedRepositoryLocator,
} from "@diffdash/domain/git-provider"
import {
  LinkedCheckout,
  RepositoryCheckoutPath,
  UpsertRepositoryInput,
} from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  LocalReviewDetail,
  LocalReviewDiff,
  LocalReviewTarget,
} from "@diffdash/domain/local-review"
import {
  ReviewAgentArtifact,
  ReviewAgentProviderId,
  ReviewThreadAgentResponse,
  ReviewAgentUsage,
} from "@diffdash/domain/review-agent"
import {
  GitCommitSha,
  makeRepositoryComparisonReviewKey,
  RepositoryComparisonDetail,
  RepositoryComparisonDiff,
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import {
  HostedReviewSnapshot,
  LocalReviewSnapshot,
  RepositoryComparisonSnapshot,
  type ReviewSnapshot,
} from "@diffdash/domain/review-context"
import {
  ReviewFileId,
  ReviewFilePatchHash,
  ReviewDiffIdentity,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import {
  HostedReviewTarget,
  LineReviewAnchor,
  MarkdownBody,
  type ReviewThreadDetails,
  type ReviewThreadId,
} from "@diffdash/domain/review-thread"
import { WebUrl } from "@diffdash/domain/web-url"
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
  type PinnedRepositoryComparisonInput,
} from "@diffdash/local-git/hosted-review-workspace-pool"
import { AgentRunArtifactStore } from "@diffdash/persistence/agent-run-artifact-store"
import { FileDeltaId, StoredSnapshotId } from "@diffdash/persistence/snapshot-block-store"
import { makeDatabase } from "@diffdash/persistence/database"
import * as DatabaseNode from "@diffdash/persistence/database-node"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import {
  ReviewTurnMappingToken,
  ReviewTurnStore,
  ReviewTurnTargetError,
  type ReviewTurnWriteStep,
} from "@diffdash/persistence/review-turn-store"
import { describe, expect, it } from "@effect/vitest"
import { DiffDashMcpServer } from "@diffdash/mcp"
import type { DiffDashMcpToolHandlers } from "@diffdash/mcp/port"
import { Deferred, Effect, Fiber, Layer, Option, Redacted, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { AgentArtifactNormalizer, normalizeAgentArtifactType } from "./agent-artifact-normalizer"
import {
  type ReviewAgentRouteSelection,
  ReviewAgentFinalizeError,
  ReviewAgentProviderFailureError,
  ReviewAgentRouting,
  ReviewAgentService,
} from "./review-agent"
import { ReviewMcpHandlers } from "./review-mcp-handlers"
import { OperationSnapshotReader } from "./operation-snapshot-reader"
import {
  HostedReviewDescriptor,
  LocalReviewDescriptor,
  RepositoryComparisonReviewDescriptor,
} from "@diffdash/domain/review-context"

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

const hostedRepositoryInput = (path: string): UpsertRepositoryInput =>
  UpsertRepositoryInput.make({
    source: HostedRepositorySource.make({
      locator: makeHostedRepositoryLocator("github", "fungsi", "diffdash"),
    }),
    checkout: LinkedCheckout.make({
      remoteUrl: "git@github.com:fungsi/diffdash.git",
      path: RepositoryCheckoutPath.make(path),
    }),
    favorite: "preserve",
  })

const localRepositoryInput = (path: string): UpsertRepositoryInput =>
  UpsertRepositoryInput.make({
    source: LocalRepositorySource.make(),
    checkout: LinkedCheckout.make({
      remoteUrl: `file://${path}`,
      path: RepositoryCheckoutPath.make(path),
    }),
    favorite: "preserve",
  })
const opencodeProviderId = AgentProviderId.make("opencode")
const operationErrors = makeAgentProviderOperationErrorFactory({
  providerId: opencodeProviderId,
  fallbackReason: "OpenCode review test failed",
})
const baseRevision = ReviewRevision.make("base-sha")
const headRevision = ReviewRevision.make("head-sha")
const applicationInstanceId = ApplicationInstanceId.make("agent-test")
const processEpoch = CoreProcessEpoch.make("agent-test-epoch")
const snapshot = LocalReviewSnapshot.make({
  snapshotId: ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000001"),
  reviewKey,
  baseRevision,
  headRevision,
  detail: LocalReviewDetail.make({
    rootPath: RepositoryCheckoutPath.make("/workspace/diffdash"),
    repoName: "diffdash",
    branchName: RepositoryComparisonRef.make("feature/m5"),
    baseSha: baseRevision,
    headSha: headRevision,
    diffHash: ReviewDiffIdentity.make("diff-hash"),
    title: "Local changes",
    files: [],
    fetchedAt: "2026-07-12T00:00:00.000Z",
  }),
  diff: LocalReviewDiff.make({
    rootPath: RepositoryCheckoutPath.make("/workspace/diffdash"),
    baseSha: baseRevision,
    headSha: headRevision,
    diffHash: ReviewDiffIdentity.make("diff-hash"),
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
      url: WebUrl.make("https://github.com/fungsi/diffdash/pull/42"),
      draft: false,
      base: BranchRevision.make({
        name: BranchRevision.fields.name.make("main"),
        revision: baseRevision,
      }),
      head: BranchRevision.make({
        name: BranchRevision.fields.name.make("feature"),
        revision: headRevision,
      }),
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
const comparisonTarget = RepositoryComparisonTarget.make({
  kind: "repositoryComparison",
  repository: pullRequestLocator.repository,
  baseRef: RepositoryComparisonRef.make("v1.0.0"),
  headRef: RepositoryComparisonRef.make("v1.1.0"),
  baseSha: GitCommitSha.make("a".repeat(40)),
  headSha: GitCommitSha.make("b".repeat(40)),
  mergeBaseSha: GitCommitSha.make("c".repeat(40)),
})
const comparisonSnapshot = RepositoryComparisonSnapshot.make({
  snapshotId: ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000003"),
  reviewKey: makeRepositoryComparisonReviewKey(comparisonTarget),
  baseRevision: ReviewRevision.make(comparisonTarget.mergeBaseSha),
  headRevision: ReviewRevision.make(comparisonTarget.headSha),
  detail: RepositoryComparisonDetail.make({
    target: comparisonTarget,
    title: "v1.0.0...v1.1.0",
    files: [],
    fetchedAt: "2026-08-05T00:00:00.000Z",
  }),
  diff: RepositoryComparisonDiff.make({
    target: comparisonTarget,
    diff,
    fetchedAt: "2026-08-05T00:00:00.000Z",
  }),
  parsedDiff: parseUnifiedDiff(diff),
})
const lineAnchor = LineReviewAnchor.make({
  fileId: ReviewFileId.make("file-agent"),
  filePath: RepositoryRelativePath.make("src/a.ts"),
  oldPath: null,
  hunkId: ReviewHunkId.make("hunk-agent"),
  hunkFingerprint: ReviewHunkFingerprint.make("fingerprint-agent"),
  hunkHeader: "@@ -1 +1 @@",
  side: "new",
  lineNumber: 1,
  lineContent: "const value = 2",
})

type ProviderReviewThreadOutput =
  ReturnType<ReviewThreadCapability["execute"]> extends Effect.Effect<
    infer Output,
    infer _Error,
    infer _Requirements
  >
    ? Output
    : never

type ReviewTurnExecutor = (request: {
  readonly workingDirectory: string
  readonly model: AgentModelId
  readonly sessionId: AgentSessionId | null
  readonly policy: AgentExecutionPolicy
}) => Effect.Effect<ProviderReviewThreadOutput, AgentProviderOperationError>

const makeProviderResult = (input: {
  readonly bodyMarkdown: string
  readonly threadSummary?: string
  readonly artifacts?: readonly ReviewAgentArtifact[]
  readonly usage?: ReviewAgentUsage
  readonly sessionId?: string
}) =>
  ({
    response: ReviewThreadAgentResponse.make({
      bodyMarkdown: input.bodyMarkdown,
      ...(input.threadSummary === undefined ? {} : { threadSummaryUpdate: input.threadSummary }),
      referencedAnchors: [],
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
  }) satisfies ProviderReviewThreadOutput

const turnIdentity = (details: ReviewThreadDetails, reviewSnapshot: ReviewSnapshot) => {
  const currentAnchor = details.thread.activeAnchor
  if (currentAnchor === null) throw new Error("Test review thread requires an active anchor")
  if (
    !(reviewSnapshot instanceof HostedReviewSnapshot) &&
    !(reviewSnapshot instanceof LocalReviewSnapshot) &&
    !(reviewSnapshot instanceof RepositoryComparisonSnapshot)
  ) {
    throw new Error("Test review turn requires a supported snapshot")
  }
  return {
    applicationInstanceId,
    processEpoch,
    snapshotId: reviewSnapshot.snapshotId,
    repoId: details.thread.repoId,
    target:
      reviewSnapshot instanceof HostedReviewSnapshot
        ? HostedReviewTarget.make({
            kind: "hosted",
            review: reviewSnapshot.detail.summary.locator,
          })
        : reviewSnapshot instanceof RepositoryComparisonSnapshot
          ? reviewSnapshot.detail.target
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

const unusedMcpHandler = () =>
  Effect.succeed({ status: "unavailable" as const, reason: "Unused test MCP handler" })

const unusedMcpHandlers: DiffDashMcpToolHandlers = {
  execute: () => unusedMcpHandler(),
}

const RunInspectionRows = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    provider: Schema.String,
    status: Schema.Literals(["running", "completed", "failed", "cancelled", "interrupted"]),
    usage_json: Schema.NullOr(Schema.fromJsonString(ReviewAgentUsage)),
    error: Schema.NullOr(Schema.String),
  }),
)

const MemoryInspection = Schema.Struct({
  summary: Schema.String,
  summarized_through_sequence: Schema.Int,
})

const inspectRuns = (threadId: ReviewThreadId) =>
  Effect.gen(function* () {
    const database = makeDatabase(yield* SqlClient.SqlClient)
    const rows = yield* database.all(
      `SELECT id, provider, status, usage_json, error FROM agent_runs
       WHERE thread_id = ? ORDER BY started_at DESC, id ASC`,
      [threadId],
    )
    return yield* Schema.decodeUnknownEffect(RunInspectionRows)(rows)
  })

const inspectMemory = (threadId: ReviewThreadId) =>
  Effect.gen(function* () {
    const database = makeDatabase(yield* SqlClient.SqlClient)
    const row = yield* database.get(
      `SELECT summary, summarized_through_sequence FROM thread_memory WHERE thread_id = ?`,
      [threadId],
    )
    return yield* Effect.fromOption(row).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MemoryInspection)),
    )
  })

const makeReviewRegistration = (
  providerId: AgentProviderId,
  modelId: AgentModelId,
  execute: ReviewTurnExecutor,
): AgentProviderRegistration => ({
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
    execute,
  },
})

const makeLayer = (
  databasePath: string,
  runTurn: ReviewTurnExecutor,
  released: {
    count: number
    events?: string[]
    mcpPaths?: Array<string | null>
    comparisonInputs?: PinnedRepositoryComparisonInput[]
    workspaceFailure?: HostedReviewWorkspacePoolError
    turnFailure?: ReviewTurnWriteStep
    fallbackRunTurn?: ReviewTurnExecutor
  },
  routeSelection: ReviewAgentRouteSelection = {
    selection: AIAgentSelection.cases.Automatic.make({ quality: "balanced" }),
  },
  includeProvider = true,
) => {
  const database = DatabaseNode.layer(databasePath)
  const persistence = Layer.mergeAll(
    RepositoryStore.layer,
    ReviewThreadStore.layer,
    AgentRunArtifactStore.layer,
    ReviewTurnStore.layerWith({
      afterWrite: (step) => {
        if (released.turnFailure === step) throw new Error(`fault:${step}`)
      },
    }),
  ).pipe(Layer.provideMerge(database))
  const providerId = AgentProviderId.make("opencode")
  const modelId = AgentModelId.make("openai/gpt-5.3-codex-spark")
  const registration = makeReviewRegistration(providerId, modelId, runTurn)
  const fallbackProviderId = AgentProviderId.make("fallback")
  const fallbackRegistration =
    released.fallbackRunTurn === undefined
      ? null
      : makeReviewRegistration(
          fallbackProviderId,
          AgentModelId.make("fallback-balanced"),
          released.fallbackRunTurn,
        )
  const registrations = includeProvider
    ? [registration, ...(fallbackRegistration === null ? [] : [fallbackRegistration])]
    : []
  const registry = AgentProviderRegistry.layer(registrations, {
    walkthrough: [],
    reviewThread: includeProvider
      ? [providerId, ...(fallbackRegistration === null ? [] : [fallbackProviderId])]
      : [],
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
  const mcpHandlers = Layer.succeed(
    ReviewMcpHandlers,
    ReviewMcpHandlers.of({ make: () => unusedMcpHandlers }),
  )
  const worktrees = Layer.succeed(
    HostedReviewWorkspacePool,
    HostedReviewWorkspacePool.of({
      pinComparison: () =>
        Effect.die(new Error("Unexpected comparison pinning in review-agent test")),
      readComparisonDiff: () =>
        Effect.die(new Error("Unexpected comparison diff read in review-agent test")),
      useComparison: (input, run) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            released.comparisonInputs?.push(input)
            released.events?.push("comparison.acquire")
            return RepositoryCheckoutPath.make("/workspace/comparison")
          }),
          run,
          () => Effect.sync(() => released.events?.push("comparison.release")),
        ),
      use: (_input, run, onProgress) =>
        released.workspaceFailure === undefined
          ? Effect.acquireUseRelease(
              Effect.gen(function* () {
                yield* onProgress?.("reserving-workspace") ?? Effect.void
                released.events?.push("worktree.acquire")
                yield* onProgress?.("creating-repository") ?? Effect.void
                yield* onProgress?.("fetching-review-revision") ?? Effect.void
                yield* onProgress?.("checking-out-revision") ?? Effect.void
                return {
                  localPath: RepositoryCheckoutPath.make("/workspace/pool"),
                  headSha: GitCommitSha.make("a".repeat(40)),
                  slotId: "slot",
                }
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
  const snapshotReader = Layer.succeed(
    OperationSnapshotReader,
    OperationSnapshotReader.of({
      open: (identity) => {
        const selected =
          identity.snapshotId === pullRequestSnapshot.snapshotId
            ? pullRequestSnapshot
            : identity.snapshotId === comparisonSnapshot.snapshotId
              ? comparisonSnapshot
              : snapshot
        const descriptor =
          selected instanceof HostedReviewSnapshot
            ? HostedReviewDescriptor.make({
                review: selected.detail.summary.locator,
                title: selected.detail.summary.title,
                authorUsername: selected.detail.summary.author.username,
                state: selected.detail.summary.state,
                draft: selected.detail.summary.draft,
                baseRef: selected.detail.summary.base.name,
                headRef: selected.detail.summary.head.name,
                url: selected.detail.summary.url,
              })
            : selected instanceof RepositoryComparisonSnapshot
              ? RepositoryComparisonReviewDescriptor.make({
                  target: selected.detail.target,
                  title: selected.detail.title,
                  fetchedAt: selected.detail.fetchedAt,
                })
              : LocalReviewDescriptor.make({
                  target: LocalReviewTarget.make({
                    kind: "local",
                    rootPath: selected.detail.rootPath,
                    comparison: selected.detail.comparison,
                  }),
                  repoName: selected.detail.repoName,
                  branchName: selected.detail.branchName,
                  title: selected.detail.title,
                  fetchedAt: selected.detail.fetchedAt,
                })
        const file = {
          ordinal: 0,
          deltaId: FileDeltaId.make("delta:agent"),
          fileId: lineAnchor.fileId,
          path: lineAnchor.filePath,
          oldPath: null,
          additions: 1,
          deletions: 1,
          status: "modified" as const,
          visibility: { _tag: "Visible" as const },
          patchHash:
            selected.parsedDiff.files[0]?.patchHash ?? ReviewFilePatchHash.make("patch:agent"),
          hunkCount: 1,
        }
        const hunk = {
          deltaId: file.deltaId,
          id: lineAnchor.hunkId,
          ordinal: 0,
          fingerprint: lineAnchor.hunkFingerprint,
          header: lineAnchor.hunkHeader,
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lineCount: 2,
        }
        const bytes = new TextEncoder().encode("-const value = 1\n+const value = 2\n")
        return Effect.succeed({
          snapshot: {
            id: StoredSnapshotId.make(identity.snapshotId),
            projectId: identity.projectId,
            reviewKey: selected.reviewKey,
            baseRevision: selected.baseRevision,
            headRevision: selected.headRevision,
            semanticIdentity: "agent-test",
            descriptor,
            source: {
              kind: "exactGit" as const,
              repositoryIdentity: "agent-test",
              baseObject: selected.baseRevision,
              headObject: selected.headRevision,
              diffPolicyIdentity: "canonical:v1",
            },
            createdAtMs: 0,
          },
          inventory: (offset: number) => Effect.succeed(offset === 0 ? [file] : []),
          findFile: () => Effect.succeed(file),
          findHunk: () => Effect.succeed(hunk),
          hunks: (_fileId: ReviewFileId, offset: number) =>
            Effect.succeed(offset === 0 ? [hunk] : []),
          readFile: () => Effect.succeed({ file, hunks: [hunk], bytes }),
          readHunk: () => Effect.succeed({ file, hunk, bytes }),
        })
      },
    }),
  )
  return ReviewAgentService.layer.pipe(
    Layer.provideMerge(persistence),
    Layer.provideMerge(registry),
    Layer.provideMerge(routing),
    Layer.provideMerge(gitRegistry),
    Layer.provideMerge(mcp),
    Layer.provideMerge(mcpHandlers),
    Layer.provideMerge(worktrees),
    Layer.provideMerge(snapshotReader),
    Layer.provideMerge(AgentArtifactNormalizer.layer),
  )
}

const unavailableGitOperation = <A>() =>
  Effect.die(new Error("Unused test Git provider operation")) as Effect.Effect<A>

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
    getReviewDiffSource: () => unavailableGitOperation(),
    getReviewDiff: () => unavailableGitOperation(),
    getReviewDecision: () => unavailableGitOperation(),
    submitReviewDecision: () => unavailableGitOperation(),
    repositoryUrl: () => Effect.succeed(WebUrl.make("https://git.test/repository")),
    fileUrl: () => Effect.succeed(WebUrl.make("https://git.test/file")),
    bootstrapBareRepository: () => Effect.void,
    checkoutSpec: (review, revision) =>
      Effect.succeed(
        HostedReviewCheckoutSpec.make({
          repository: review.repository,
          review,
          remoteUrl: `https://git.test/${review.repository.namespace}/${review.repository.name}.git`,
          fetchRef: RepositoryComparisonRef.make(`refs/reviews/${review.number}/head`),
          revision,
        }),
      ),
  }
}

describe("ReviewAgentService", () => {
  it.effect("durably accepts before starting scoped provider work", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const providerStarted = yield* Deferred.make<void>()
      const releaseProvider = yield* Deferred.make<void>()
      const layer = makeLayer(
        databasePath,
        () =>
          Deferred.succeed(providerStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseProvider)),
            Effect.as(makeProviderResult({ bodyMarkdown: "Accepted then completed." })),
          ),
        { count: 0 },
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository(
          hostedRepositoryInput("/workspace/user-checkout"),
        )
        const created = yield* (yield* ReviewThreadStore).create({
          repoId: repo.id,
          reviewKey: pullRequestSnapshot.reviewKey,
          prNumber: 42,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Accept this operation."),
        })
        const service = yield* ReviewAgentService
        const accepted = yield* service.acceptThreadTurn({
          threadId: created.thread.id,
          ...turnIdentity(created, pullRequestSnapshot),
          cwd: repo.localPath,
          walkthrough: Option.none(),
        })

        expect(
          Option.getOrThrow(yield* (yield* ReviewTurnStore).getOperation(accepted.operation.id)),
        ).toMatchObject({ _tag: "Running", id: accepted.operation.id })
        expect(yield* Deferred.isDone(providerStarted)).toBe(false)

        const worker = yield* accepted.worker.pipe(Effect.forkChild)
        yield* Deferred.await(providerStarted)
        yield* Deferred.succeed(releaseProvider, undefined)
        yield* Fiber.join(worker)
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("leases an isolated PR worktree around MCP and provider execution", () =>
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
        const repo = yield* (yield* RepositoryStore).upsertRepository(
          hostedRepositoryInput("/workspace/user-checkout"),
        )
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
          cwd: repo.localPath,
          walkthrough: Option.none(),
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

  it.effect("runs repository-comparison agents in the pinned head workspace", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const released = {
        count: 0,
        events: [] as string[],
        mcpPaths: [] as Array<string | null>,
        comparisonInputs: [] as PinnedRepositoryComparisonInput[],
      }
      const layer = makeLayer(
        databasePath,
        (input) =>
          Effect.sync(() => {
            expect(input.workingDirectory).toBe("/workspace/comparison")
          }).pipe(Effect.as(makeProviderResult({ bodyMarkdown: "Reviewed pinned comparison." }))),
        released,
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository(
          hostedRepositoryInput("/workspace/user-checkout"),
        )
        const created = yield* (yield* ReviewThreadStore).create({
          repoId: repo.id,
          reviewKey: comparisonSnapshot.reviewKey,
          prNumber: null,
          baseRevision: comparisonSnapshot.baseRevision,
          headRevision: comparisonSnapshot.headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Inspect the immutable comparison."),
        })
        yield* (yield* ReviewAgentService).runThreadTurn({
          threadId: created.thread.id,
          ...turnIdentity(created, comparisonSnapshot),
          cwd: repo.localPath,
          walkthrough: Option.none(),
        })
      }).pipe(Effect.provide(layer))

      expect(released.comparisonInputs).toEqual([
        expect.objectContaining({
          sourcePath: "/workspace/user-checkout",
          baseSha: comparisonTarget.baseSha,
          headSha: comparisonTarget.headSha,
          mergeBaseSha: comparisonTarget.mergeBaseSha,
        }),
      ])
      expect(released.mcpPaths).toEqual(["/workspace/comparison"])
      expect(released.events).toEqual([
        "comparison.acquire",
        "mcp.acquire",
        "mcp.release",
        "comparison.release",
      ])
    }),
  )

  it.effect(
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
              Effect.andThen(Deferred.succeed(providerStarted, undefined)),
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.sync(() => released.events.push("provider.finalized"))),
            ),
          released,
        )

        yield* Effect.gen(function* () {
          const repo = yield* (yield* RepositoryStore).upsertRepository(
            hostedRepositoryInput("/workspace/user-checkout"),
          )
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
              cwd: repo.localPath,
              walkthrough: Option.none(),
            })
            .pipe(Effect.forkChild)
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

  it.effect("FUN-72 AC: persists a complete run, reply, memory, and scoped MCP lifetime", () =>
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
                  provider: ReviewAgentProviderId.make("opencode"),
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
        const repo = yield* (yield* RepositoryStore).upsertRepository(
          localRepositoryInput("/workspace/diffdash"),
        )
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
          cwd: repo.localPath,
          walkthrough: Option.none(),
        })
        const runs = yield* inspectRuns(created.thread.id)
        const artifacts = yield* (yield* AgentRunArtifactStore).listForThread(created.thread.id)
        const memory = yield* inspectMemory(created.thread.id)

        expect(completed.messages).toHaveLength(2)
        expect(completed.messages[1]).toMatchObject({
          _tag: "Completed",
          bodyMarkdown: "The change is safe.",
        })
        expect(runs[0]).toMatchObject({ status: "completed", usage_json: usage })
        expect(artifacts).toHaveLength(1)
        expect(artifacts[0]?.artifact).toMatchObject({
          type: "mcp_tool_result",
          contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        })
        expect(memory).toMatchObject({
          summary: "Reviewed the value update.",
          summarized_through_sequence: 2,
        })
      }).pipe(Effect.provide(layer))

      expect(released.count).toBe(1)
    }),
  )

  it.effect("returns a distinct finalize error without compensating a rolled-back completion", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const released = { count: 0, turnFailure: "complete.run" as ReviewTurnWriteStep }
      const layer = makeLayer(
        databasePath,
        () => Effect.succeed(makeProviderResult({ bodyMarkdown: "Do not split this result." })),
        released,
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository(
          localRepositoryInput("/workspace/diffdash"),
        )
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
            cwd: repo.localPath,
            walkthrough: Option.none(),
          })
          .pipe(Effect.flip)
        const details = yield* (yield* ReviewThreadStore).get(created.thread.id)
        const runs = yield* inspectRuns(created.thread.id)

        expect(error).toBeInstanceOf(ReviewAgentFinalizeError)
        expect(error).toMatchObject({ operation: "completeTurn" })
        expect(details.messages.at(-1)?._tag).toBe("Pending")
        expect(runs).toHaveLength(1)
        expect(runs[0]?.status).toBe("running")
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect(
    "returns a distinct finalize error when transactional failure persistence rolls back",
    () =>
      Effect.gen(function* () {
        const databasePath = yield* makeTempDatabasePath
        const released = { count: 0, turnFailure: "fail.run" as ReviewTurnWriteStep }
        const layer = makeLayer(
          databasePath,
          () =>
            Effect.fail(
              operationErrors.fromCause("review-thread")(
                Object.assign(new Error("Provider failed"), {
                  reason: "Provider failed before finalization",
                }),
              ),
            ),
          released,
        )

        yield* Effect.gen(function* () {
          const repo = yield* (yield* RepositoryStore).upsertRepository(
            localRepositoryInput("/workspace/diffdash"),
          )
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
              cwd: repo.localPath,
              walkthrough: Option.none(),
            })
            .pipe(Effect.flip)
          const details = yield* (yield* ReviewThreadStore).get(created.thread.id)
          const runs = yield* inspectRuns(created.thread.id)

          expect(error).toBeInstanceOf(ReviewAgentFinalizeError)
          expect(error).toMatchObject({ operation: "failTurn" })
          expect(details.messages.at(-1)?._tag).toBe("Pending")
          expect(runs[0]?.status).toBe("running")
        }).pipe(Effect.provide(layer))
      }),
  )

  it.effect("falls back after an automatic provider execution failure", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      let fallbackCalls = 0
      const released = {
        count: 0,
        fallbackRunTurn: () =>
          Effect.sync(() => {
            fallbackCalls += 1
            return makeProviderResult({ bodyMarkdown: "Fallback response." })
          }),
      }
      const layer = makeLayer(
        databasePath,
        () =>
          Effect.fail(
            operationErrors.fromReason("review-thread", "Primary automatic provider failed"),
          ),
        released,
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository(
          localRepositoryInput("/workspace/diffdash"),
        )
        const created = yield* (yield* ReviewThreadStore).create({
          repoId: repo.id,
          reviewKey,
          prNumber: null,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Use the next available provider."),
        })
        const completed = yield* (yield* ReviewAgentService).runThreadTurn({
          threadId: created.thread.id,
          ...turnIdentity(created, snapshot),
          cwd: repo.localPath,
          walkthrough: Option.none(),
        })
        const runs = yield* inspectRuns(created.thread.id)

        expect(completed.messages.map(({ _tag }) => _tag)).toEqual(["User", "Failed", "Completed"])
        expect(completed.messages.at(-1)).toMatchObject({
          _tag: "Completed",
          bodyMarkdown: "Fallback response.",
        })
        expect(runs).toHaveLength(2)
        expect(runs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ provider: "opencode", status: "failed" }),
            expect.objectContaining({ provider: "fallback", status: "completed" }),
          ]),
        )
      }).pipe(Effect.provide(layer))

      expect(fallbackCalls).toBe(1)
      expect(released.count).toBe(2)
    }),
  )

  it.effect("keeps explicit provider execution failures fail-closed", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      let fallbackCalls = 0
      let selectedModel: AgentModelId | null = null
      const released = {
        count: 0,
        fallbackRunTurn: () =>
          Effect.sync(() => {
            fallbackCalls += 1
            return makeProviderResult({ bodyMarkdown: "Must not run." })
          }),
      }
      const layer = makeLayer(
        databasePath,
        (request) =>
          Effect.sync(() => void (selectedModel = request.model)).pipe(
            Effect.andThen(
              Effect.fail(operationErrors.fromReason("review-thread", "Explicit provider failed")),
            ),
          ),
        released,
        {
          selection: AIAgentSelection.cases.Pinned.make({
            providerId: AIProviderId.make("opencode"),
            modelId: null,
          }),
        },
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository(
          localRepositoryInput("/workspace/diffdash"),
        )
        const created = yield* (yield* ReviewThreadStore).create({
          repoId: repo.id,
          reviewKey,
          prNumber: null,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Do not change providers."),
        })
        const error = yield* (yield* ReviewAgentService)
          .runThreadTurn({
            threadId: created.thread.id,
            ...turnIdentity(created, snapshot),
            cwd: repo.localPath,
            walkthrough: Option.none(),
          })
          .pipe(Effect.flip)
        const runs = yield* inspectRuns(created.thread.id)

        expect(error).toBeInstanceOf(ReviewAgentProviderFailureError)
        expect(runs).toEqual([expect.objectContaining({ provider: "opencode", status: "failed" })])
      }).pipe(Effect.provide(layer))

      expect(fallbackCalls).toBe(0)
      expect(selectedModel).toBe("openai/gpt-5.3-codex-spark")
      expect(released.count).toBe(1)
    }),
  )

  it.effect("FUN-72 AC: records a retryable failed message and failed run", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const released = { count: 0, events: [] as string[] }
      const layer = makeLayer(
        databasePath,
        () =>
          Effect.sync(() => released.events.push("provider.run")).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                operationErrors.fromReason(
                  "review-thread",
                  `${"x".repeat(700)}
Authorization: Bearer persisted-bearer-secret refresh_token=persisted-refresh-secret
Failed to authenticate. OAuth session expired and could not be refreshed.`,
                ),
              ),
            ),
            Effect.ensuring(Effect.sync(() => released.events.push("provider.finalized"))),
          ),
        released,
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository(
          hostedRepositoryInput("/workspace/user-checkout"),
        )
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
            cwd: repo.localPath,
            walkthrough: Option.none(),
          })
          .pipe(Effect.flip)
        const details = yield* (yield* ReviewThreadStore).get(created.thread.id)
        const runs = yield* inspectRuns(created.thread.id)

        const failedMessage = details.messages[1]
        if (failedMessage?._tag !== "Failed") throw new Error("Expected failed agent response")
        expect(failedMessage.failure).toMatchObject({
          _tag: "Provider",
          details: {
            providerId: "opencode",
            category: "authentication",
          },
        })
        expect(runs[0]).toMatchObject({ status: "failed", usage_json: null })
        const persistedDiagnostic = String(runs[0]?.error)
        expect(persistedDiagnostic).toBe(
          "The local review agent could not complete this response. Retry to try again.",
        )
        expect(persistedDiagnostic).not.toContain("persisted-bearer-secret")
        expect(persistedDiagnostic).not.toContain("persisted-refresh-secret")
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

  it.effect("bounds and redacts hosted workspace failures before persistence or display", () =>
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
        const repo = yield* (yield* RepositoryStore).upsertRepository(
          hostedRepositoryInput("/workspace/user-checkout"),
        )
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
            cwd: repo.localPath,
            walkthrough: Option.none(),
          })
          .pipe(Effect.flip)
        const details = yield* (yield* ReviewThreadStore).get(created.thread.id)
        const runs = yield* inspectRuns(created.thread.id)
        const persistedDiagnostic = String(runs[0]?.error)

        expect(persistedDiagnostic).toBe(
          "The local review agent could not complete this response. Retry to try again.",
        )
        expect(details.messages[1]).toMatchObject({
          _tag: "Failed",
          failure: { _tag: "Internal" },
        })
        expect(persistedDiagnostic).not.toContain("workspace-basic-secret")
        expect(persistedDiagnostic).not.toContain("workspace-id-secret")
        expect(error.reason).not.toContain("workspace-basic-secret")
        expect(error.reason).not.toContain("workspace-id-secret")
      }).pipe(Effect.provide(layer))

      expect(released.count).toBe(0)
    }),
  )

  it.effect("rejects provider preflight without creating a detached failed message or run", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const released = { count: 0 }
      const layer = makeLayer(
        databasePath,
        () => Effect.succeed(makeProviderResult({ bodyMarkdown: "Unexpected response." })),
        released,
        {
          selection: AIAgentSelection.cases.Pinned.make({
            providerId: AIProviderId.make("opencode"),
            modelId: AIModelId.make("removed-model"),
          }),
        },
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository(
          localRepositoryInput("/workspace/diffdash"),
        )
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
            cwd: repo.localPath,
            walkthrough: Option.none(),
          })
          .pipe(Effect.flip)

        const details = yield* (yield* ReviewThreadStore).get(created.thread.id)
        const runs = yield* inspectRuns(created.thread.id)
        expect(error).toBeInstanceOf(ReviewAgentProviderFailureError)
        if (error instanceof ReviewAgentProviderFailureError) {
          expect(error.failure).toMatchObject({
            providerId: "opencode",
            category: "model-unavailable",
          })
        }
        expect(details.messages).toHaveLength(1)
        expect(runs).toEqual([])
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("reports an empty automatic provider route as typed configuration guidance", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const released = { count: 0 }
      const layer = makeLayer(
        databasePath,
        () => Effect.succeed(makeProviderResult({ bodyMarkdown: "Unexpected response." })),
        released,
        {
          selection: AIAgentSelection.cases.Automatic.make({ quality: "balanced" }),
        },
        false,
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository(
          localRepositoryInput("/workspace/diffdash"),
        )
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
            cwd: repo.localPath,
            walkthrough: Option.none(),
          })
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(ReviewAgentProviderFailureError)
        if (error instanceof ReviewAgentProviderFailureError) {
          expect(error.failure).toMatchObject({
            providerId: "unavailable",
            category: "configuration",
          })
        }
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("FUN-72 AC: validates the provider result before persisting completion", () =>
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
          } as unknown as ProviderReviewThreadOutput),
        released,
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository(
          localRepositoryInput("/workspace/diffdash"),
        )
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
            cwd: repo.localPath,
            walkthrough: Option.none(),
          })
          .pipe(Effect.flip)
        const details = yield* (yield* ReviewThreadStore).get(created.thread.id)

        expect(error).toBeInstanceOf(ReviewAgentProviderFailureError)
        if (error instanceof ReviewAgentProviderFailureError) {
          expect(error.failure).toMatchObject({
            providerId: "opencode",
            category: "invalid-response",
          })
        }
        expect(details.messages[1]).toMatchObject({
          _tag: "Failed",
          failure: {
            _tag: "Provider",
            details: { providerId: "opencode", category: "invalid-response" },
          },
        })
      }).pipe(Effect.provide(layer))

      expect(released.count).toBe(1)
    }),
  )

  it.effect("recovers an interrupted pending run before starting its replacement", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const released = { count: 0 }
      const layer = makeLayer(
        databasePath,
        () => Effect.succeed(makeProviderResult({ bodyMarkdown: "Recovered response." })),
        released,
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository(
          localRepositoryInput("/workspace/diffdash"),
        )
        const threads = yield* ReviewThreadStore
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
          provider: ReviewAgentProviderId.make("opencode"),
          model: "openai/gpt-5.3-codex-spark",
          promptVersion: AgentPromptVersion.make("review-thread-v3"),
        })
        yield* turns.recoverInterruptedTurns

        const completed = yield* (yield* ReviewAgentService).runThreadTurn({
          threadId: created.thread.id,
          ...turnIdentity(created, snapshot),
          cwd: repo.localPath,
          walkthrough: Option.none(),
        })
        const persistedRuns = yield* inspectRuns(created.thread.id)

        expect(completed.messages).toHaveLength(3)
        expect(completed.messages[1]).toMatchObject({
          _tag: "Failed",
          failure: { _tag: "Internal" },
        })
        expect(completed.messages[2]).toMatchObject({
          _tag: "Completed",
          bodyMarkdown: "Recovered response.",
        })
        expect(new Set(persistedRuns.map(({ status }) => status))).toEqual(
          new Set(["completed", "interrupted"]),
        )
        expect(persistedRuns.find(({ id }) => id === interruptedTurn.run.id)?.error).toBeNull()
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("rejects wrong hosted, local, and repository targets before provider execution", () =>
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
        const repo = yield* (yield* RepositoryStore).upsertRepository(
          hostedRepositoryInput("/workspace/user-checkout"),
        )
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
            target: LocalReviewTarget.make({
              kind: "local",
              rootPath: RepositoryCheckoutPath.make("/workspace/diffdash"),
            }),
          },
          { ...identity, repoId: ReviewProjectId.make("github:fungsi/other") },
        ]
        for (const invalid of wrongTargets) {
          const error = yield* (yield* ReviewAgentService)
            .runThreadTurn({
              threadId: created.thread.id,
              ...invalid,
              cwd: repo.localPath,
              walkthrough: Option.none(),
            })
            .pipe(Effect.flip)
          expect(error).toBeInstanceOf(ReviewTurnTargetError)
        }
        expect(providerCalls).toBe(0)
        expect((yield* (yield* ReviewThreadStore).get(created.thread.id)).messages).toHaveLength(1)
        expect(yield* inspectRuns(created.thread.id)).toEqual([])
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("rejects a concurrent turn before creating a second run or message", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const providerStarted = yield* Deferred.make<void>()
      const releaseProvider = yield* Deferred.make<void>()
      const released = { count: 0 }
      const layer = makeLayer(
        databasePath,
        () =>
          Deferred.succeed(providerStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseProvider)),
            Effect.as(makeProviderResult({ bodyMarkdown: "Only response." })),
          ),
        released,
      )

      yield* Effect.gen(function* () {
        const repo = yield* (yield* RepositoryStore).upsertRepository(
          localRepositoryInput("/workspace/diffdash"),
        )
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
          cwd: repo.localPath,
          walkthrough: Option.none(),
        } as const
        const firstTurn = yield* service.runThreadTurn(input).pipe(Effect.forkChild)
        yield* Deferred.await(providerStarted)

        const concurrentError = yield* service.runThreadTurn(input).pipe(Effect.flip)
        yield* Deferred.succeed(releaseProvider, undefined)
        const completed = yield* Fiber.join(firstTurn)
        const runs = yield* inspectRuns(created.thread.id)

        expect(concurrentError.reason).toBe("A review agent turn is already running.")
        expect(runs).toHaveLength(1)
        expect(completed.messages).toHaveLength(2)
        expect(completed.messages[1]).toMatchObject({
          _tag: "Completed",
          bodyMarkdown: "Only response.",
        })
      }).pipe(Effect.provide(layer))
    }),
  )
})
