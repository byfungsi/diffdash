import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import {
  BranchRevision,
  GitProviderId,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedRepositorySource,
  HostedReviewDetail,
  HostedReviewLocator,
  HostedReviewNumber,
  HostedReviewSummary,
  ProviderActor,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import { WebUrl } from "@diffdash/domain/web-url"
import {
  LastCommitComparison,
  LocalReviewTarget,
  WorkingTreeComparison,
} from "@diffdash/domain/local-review"
import { RemoteOnly, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import {
  GitCommitSha,
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import {
  ReviewDiffIdentity,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  HostedReviewDiffSourceTarget,
  HostedReviewCheckoutSpec,
  REVIEW_DIFF_MAX_CHUNK_BYTES,
  ReviewDiffByteCompletion,
  ReviewDiffAvailabilityFailure,
  ReviewDiffGenerationTracker,
  ReviewDiffSourceFacts,
  ReviewDiffSourceOffer,
  UnifiedBytesMethod,
  type ReviewDiffSource,
} from "@diffdash/git-provider"
import { GitService } from "@diffdash/local-git/local-git"
import {
  HostedReviewWorkspacePool,
  HostedReviewWorkspacePoolError,
} from "@diffdash/local-git/hosted-review-workspace-pool"
import * as DatabaseNode from "@diffdash/persistence/database-node"
import { ResourceCatalog, ResourceRootId } from "@diffdash/persistence/resource-catalog"
import { ProcessExit, ProcessResult, ProcessService, type ProcessRequest } from "@diffdash/process"
import { Effect, Layer, Stream } from "effect"

import {
  CoreSnapshotAcquisition,
  coreSnapshotAcquisitionLayer,
  parseExactGitIdentities,
} from "./core-snapshot-acquisition"
import {
  makeFilesystemResourceAdapter,
  makeResourceCollection,
  ResourceCollection,
} from "./resource-collection"
import { CoreSnapshotIngestion } from "./core-snapshot-ingestion"
import { GitProvider } from "./services/git-provider"
import { RepositoryComparisonSource } from "./services/repository-comparison-source"
import { RepositoryLinker } from "./services/repository-linker"

const encoder = new TextEncoder()
const oldObject = "1".repeat(40)
const newObject = "2".repeat(40)
const baseRevision = ReviewRevision.make("a".repeat(40))
const headRevision = ReviewRevision.make("b".repeat(40))
const patch = `diff --git a/src/file.ts b/src/file.ts\nindex ${oldObject}..${newObject} 100644\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-old\n+new\n`
const patchBytes = encoder.encode(patch)
const rootId = ResourceRootId.make("snapshot-acquisition-test")
const projectId = ReviewProjectId.make("project:snapshot-acquisition")
const repository = HostedRepositoryLocator.make({
  providerId: GitProviderId.make("fixture"),
  namespace: RepositoryNamespace.make("diffdash"),
  name: HostedRepositoryName.make("acquisition"),
})
const review = HostedReviewLocator.make({ repository, number: HostedReviewNumber.make(218) })
const checkout = RepositoryCheckoutPath.make("/fixture/repository")
const project = Repo.make({
  id: projectId,
  source: HostedRepositorySource.make({ locator: repository }),
  checkout: RemoteOnly.make({ remoteUrl: "https://example.test/diffdash/acquisition.git" }),
  isFavorite: false,
  lastOpenedAt: null,
  lastSyncedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
})

const detail = HostedReviewDetail.make({
  summary: HostedReviewSummary.make({
    locator: review,
    title: "Stream a review",
    body: null,
    author: ProviderActor.make({
      id: null,
      username: "fixture",
      displayName: null,
      avatarUrl: null,
    }),
    state: "open",
    decision: "none",
    url: WebUrl.make("https://example.test/review/218"),
    draft: false,
    base: BranchRevision.make({
      name: RepositoryComparisonRef.make("main"),
      revision: baseRevision,
    }),
    head: BranchRevision.make({
      name: RepositoryComparisonRef.make("feature"),
      revision: headRevision,
    }),
    createdAt: null,
    updatedAt: null,
  }),
  files: [],
  commits: [],
})

const hostedSource = (closed: { count: number }): ReviewDiffSource => {
  const generation = new ReviewDiffGenerationTracker()
  const semanticIdentity = ReviewDiffIdentity.make("hosted-source:v1")
  return {
    offer: ReviewDiffSourceOffer.make({
      target: HostedReviewDiffSourceTarget.make({
        review,
        reviewKey: ReviewKey.make("hosted#218"),
      }),
      expectedRevision: headRevision,
      semanticIdentity,
      methods: [UnifiedBytesMethod.make({ maxChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES })],
      facts: ReviewDiffSourceFacts.make({
        origin: "remote",
        revisionKind: "mutable",
        reproducible: false,
        complete: true,
        declaredBytes: null,
      }),
    }),
    unifiedBytes: (acquisition) =>
      Stream.unwrap(
        generation.begin(acquisition.generation).pipe(
          Effect.as(
            Stream.make(
              { bytes: patchBytes },
              ReviewDiffByteCompletion.make({
                generation: acquisition.generation,
                revision: headRevision,
                semanticIdentity,
                totalBytes: patchBytes.byteLength,
              }),
            ),
          ),
        ),
      ),
    close: Effect.sync(() => {
      closed.count += 1
    }),
  }
}

const refusedHostedSource = (closed: { count: number }): ReviewDiffSource => {
  const source = hostedSource(closed)
  return {
    ...source,
    unifiedBytes: (acquisition) =>
      Stream.fail(
        ReviewDiffAvailabilityFailure.make({
          generation: acquisition.generation,
          method: "unifiedBytes",
          message: "Provider refused to generate the complete diff",
          category: "providerGenerationLimit",
          diagnosticCode: "http-406",
        }),
      ),
  }
}

const processResult = (request: ProcessRequest, stdout: string): ProcessResult =>
  ProcessResult.make({
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    outputTruncated: false,
    exitCode: 0,
    signal: null,
  })

const processLayer = Layer.succeed(ProcessService, {
  run: (request) => {
    const args = request.args
    if (args.includes("--raw")) {
      return Effect.succeed(
        processResult(request, `:100644 100644 ${oldObject} ${newObject} M\tsrc/file.ts\n`),
      )
    }
    if (args.includes("--numstat"))
      return Effect.succeed(processResult(request, "1\t1\tsrc/file.ts\n"))
    if (args.includes("--git-common-dir"))
      return Effect.succeed(processResult(request, "/repo/.git\n"))
    if (args.includes(`${baseRevision}^{commit}`))
      return Effect.succeed(processResult(request, `${baseRevision}\n`))
    if (args.includes(`${headRevision}^{commit}`))
      return Effect.succeed(processResult(request, `${headRevision}\n`))
    if (args.includes("HEAD")) return Effect.succeed(processResult(request, `${headRevision}\n`))
    return Effect.die(`Unexpected process request: ${args.join(" ")}`)
  },
  streamLines: () => Stream.die("unused"),
  streamBytes: (request) =>
    Stream.make(
      { _tag: "ProcessByteChunk" as const, bytes: patchBytes },
      ProcessExit.make({ result: processResult(request, "") }),
    ),
})

const ingestionLayer = Layer.succeed(CoreSnapshotIngestion, {
  ingest: (input) =>
    input.source.unifiedBytes(input.acquisition).pipe(
      Stream.runDrain,
      Effect.ensuring(input.source.close.pipe(Effect.ignore)),
      Effect.as({
        projectId: input.manifest.projectId,
        snapshotId: input.manifest.snapshotId,
        reviewKey: input.manifest.reviewKey,
        fileCount: 1,
      }),
    ),
})

const gitLayer = Layer.succeed(GitService, {
  detectRepository: () => Effect.die("unused"),
  detectRoot: () => Effect.die("unused"),
  currentBranch: () => Effect.succeed(RepositoryComparisonRef.make("feature")),
  listRemotes: () => Effect.die("unused"),
  listWorktrees: () => Effect.die("unused"),
  applyWorkspacePatch: () => Effect.die("unused"),
  workingTreeChanges: () => Effect.succeed([]),
  workingTreeFileLineChanges: () => Effect.succeed([]),
  resolveBranchComparison: () => Effect.die("unused"),
  resolveRevisionRangeComparison: () => Effect.die("unused"),
  resolveLastCommit: () => Effect.die("unused"),
  validateLocalReviewTarget: Effect.succeed,
})

const repositoriesLayer = Layer.succeed(RepositoryLinker, {
  list: () => Effect.die("unused"),
  setFavorite: () => Effect.die("unused"),
  findHosted: () => Effect.die("unused"),
  ensureHosted: () => Effect.succeed(project),
  ensureLocal: () => Effect.succeed(project),
  openProject: () => Effect.die("unused"),
  forget: () => Effect.die("unused"),
  install: () => Effect.die("unused"),
  link: () => Effect.die("unused"),
  repairIdentities: () => Effect.die("unused"),
})

const providerLayer = (source: ReviewDiffSource) =>
  Layer.succeed(GitProvider, {
    listProviders: Effect.die("unused"),
    diagnoseProviders: Effect.die("unused"),
    parseRemoteUrl: () => Effect.die("unused"),
    resolveRepository: () => Effect.die("unused"),
    repositoryUrl: () => Effect.die("unused"),
    fileUrl: () => Effect.die("unused"),
    searchRepositories: () => Effect.die("unused"),
    listSearchScopes: () => Effect.die("unused"),
    listHostedReviews: () => Effect.die("unused"),
    listAssignedReviews: () => Effect.die("unused"),
    getHostedReviewDetail: () => Effect.succeed(detail),
    getReviewDiffSource: () => Effect.succeed(source),
    getReviewDecision: () => Effect.die("unused"),
    submitReviewDecision: () => Effect.die("unused"),
    hostedReviewCheckoutSpec: () =>
      Effect.succeed(
        HostedReviewCheckoutSpec.make({
          repository,
          review,
          remoteUrl: "https://example.test/diffdash/acquisition.git",
          fetchRef: RepositoryComparisonRef.make("refs/pull/218/head"),
          revision: headRevision,
        }),
      ),
    bootstrapBareRepository: () => Effect.void,
    isAvailable: () => Effect.die("unused"),
  })

const comparisonTarget = RepositoryComparisonTarget.make({
  kind: "repositoryComparison",
  repository,
  baseRef: RepositoryComparisonRef.make("main"),
  headRef: RepositoryComparisonRef.make("feature"),
  baseSha: GitCommitSha.make(baseRevision),
  headSha: GitCommitSha.make(headRevision),
  mergeBaseSha: GitCommitSha.make(baseRevision),
})

const comparisonLayer = Layer.succeed(RepositoryComparisonSource, {
  resolve: () => Effect.die("unused"),
  repository: () => Effect.succeed(project),
  useWorkspace: (_target, run) => run(checkout),
})

const hostedWorkspaceLayer = Layer.succeed(HostedReviewWorkspacePool, {
  use: () => Effect.die("unused"),
  pinComparison: () =>
    Effect.succeed({
      baseSha: GitCommitSha.make(baseRevision),
      headSha: GitCommitSha.make(headRevision),
      mergeBaseSha: GitCommitSha.make(baseRevision),
    }),
  readComparisonDiff: () => Effect.die("unused"),
  useComparison: (_input, run) => run(checkout),
  useRevision: (_input, run) => run(checkout),
})

const testDirectory = Effect.acquireRelease(
  Effect.sync(() => {
    const directory = mkdtempSync(join(tmpdir(), "diffdash-acquisition-"))
    mkdirSync(join(directory, "managed", "spools"), { recursive: true })
    return directory
  }),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const acquisitionLayer = (
  directory: string,
  source: ReviewDiffSource,
  options?: {
    readonly managedQuotaBytes?: number
    readonly workspaceLayer?: Layer.Layer<HostedReviewWorkspacePool>
  },
) => {
  const resourceLayer = ResourceCatalog.layer.pipe(
    Layer.provide(DatabaseNode.layer(join(directory, "database.sqlite"))),
  )
  const collectionLayer = Layer.effect(
    ResourceCollection,
    Effect.gen(function* () {
      const noOpAdapter = { quarantine: () => Effect.void, delete: () => Effect.void }
      return makeResourceCollection(yield* ResourceCatalog, {
        filesystem: makeFilesystemResourceAdapter(new Map([[rootId, join(directory, "managed")]])),
        gitRef: noOpAdapter,
        updaterPartial: noOpAdapter,
      })
    }),
  ).pipe(Layer.provideMerge(resourceLayer))
  return coreSnapshotAcquisitionLayer({
    rootId,
    rootPath: join(directory, "managed"),
    managedQuotaBytes: options?.managedQuotaBytes ?? 4 * 1024 * 1024,
    reservationLifetimeMs: 60_000,
  }).pipe(
    Layer.provideMerge(ingestionLayer),
    Layer.provideMerge(providerLayer(source)),
    Layer.provideMerge(gitLayer),
    Layer.provideMerge(processLayer),
    Layer.provideMerge(comparisonLayer),
    Layer.provideMerge(repositoriesLayer),
    Layer.provideMerge(resourceLayer),
    Layer.provideMerge(collectionLayer),
    Layer.provideMerge(options?.workspaceLayer ?? hostedWorkspaceLayer),
  )
}

describe("CoreSnapshotAcquisition", () => {
  it("preserves renamed binary identities for paths containing tabs and newlines", () => {
    const oldPath = "src/old\tname.bin"
    const newPath = "src/new\nname.bin"
    const raw = `:100644 100755 ${oldObject} ${newObject} R100\0${oldPath}\0${newPath}\0`
    const numstat = `-\t-\t\0${oldPath}\0${newPath}\0`

    const identities = parseExactGitIdentities(raw, numstat, "policy:v1", "semantic:v1")
    const renamed = identities.get(`${oldPath}\0${newPath}`)

    expect(renamed).toBeDefined()
    expect(renamed?.oldPath).toBe(oldPath)
    expect(renamed?.newPath).toBe(newPath)
    expect(renamed?.identity).toMatchObject({
      oldContentId: `git:${oldObject}`,
      newContentId: `git:${newObject}`,
      oldMode: "100644",
      newMode: "100755",
      status: "binary",
      diffPolicyIdentity: "policy:v1",
    })
  })

  it.effect("acquires hosted metadata and streams a managed spool through durable ingestion", () =>
    Effect.gen(function* () {
      const directory = yield* testDirectory
      const closed = { count: 0 }
      const layer = acquisitionLayer(directory, hostedSource(closed))
      yield* Effect.gen(function* () {
        const acquisition = yield* CoreSnapshotAcquisition
        const resources = yield* ResourceCatalog
        yield* resources.registerRoot({
          id: rootId,
          path: join(directory, "managed"),
          createdAtMs: 0,
        })
        const [manifest, concurrentManifest] = yield* Effect.all(
          [acquisition.acquireHosted(review), acquisition.acquireHosted(review)],
          { concurrency: "unbounded" },
        )
        expect(concurrentManifest).toEqual(manifest)
        expect(yield* acquisition.acquireHosted(review)).toEqual(manifest)
        expect(manifest.projectId).toBe(projectId)
        expect(manifest.fileCount).toBe(1)
        expect(manifest.detail).toEqual({ summary: detail.summary })
        expect(manifest).not.toHaveProperty("files")
        const spool = (yield* resources.list()).find(({ kind }) => kind === "snapshot-spool")
        expect(spool?.state).toBe("ready")
        expect(spool?.bytes).toBe(patchBytes.byteLength)
        const location = spool?.location
        if (location?.kind !== "filesystem") throw new Error("Expected spool file")
        expect(readFileSync(join(directory, "managed", location.relativePath))).toEqual(
          Buffer.from(patchBytes),
        )
      }).pipe(Effect.provide(layer))
      expect(closed.count).toBe(1)
    }),
  )

  it.effect("falls back to an exact Git stream after a provider generation-limit refusal", () =>
    Effect.gen(function* () {
      const directory = yield* testDirectory
      const closed = { count: 0 }
      yield* Effect.gen(function* () {
        const acquisition = yield* CoreSnapshotAcquisition
        const resources = yield* ResourceCatalog
        yield* resources.registerRoot({
          id: rootId,
          path: join(directory, "managed"),
          createdAtMs: 0,
        })

        const manifest = yield* acquisition.acquireHosted(review)

        expect(manifest.projectId).toBe(projectId)
        expect(manifest.fileCount).toBe(1)
        expect(closed.count).toBe(1)
        expect((yield* resources.list()).some(({ state }) => state === "writing")).toBe(false)
      }).pipe(Effect.provide(acquisitionLayer(directory, refusedHostedSource(closed))))
    }),
  )

  it.effect("classifies managed spool quota exhaustion as a cache-full review failure", () =>
    Effect.gen(function* () {
      const directory = yield* testDirectory
      const closed = { count: 0 }
      const failure = yield* Effect.gen(function* () {
        const acquisition = yield* CoreSnapshotAcquisition
        const resources = yield* ResourceCatalog
        yield* resources.registerRoot({
          id: rootId,
          path: join(directory, "managed"),
          createdAtMs: 0,
        })
        return yield* acquisition.acquireHosted(review).pipe(Effect.flip)
      }).pipe(
        Effect.provide(
          acquisitionLayer(directory, hostedSource(closed), {
            managedQuotaBytes: patchBytes.byteLength - 1,
          }),
        ),
      )

      expect(failure).toMatchObject({
        _tag: "ReviewContextError",
        category: "cacheFull",
      })
      expect(closed.count).toBe(1)
    }),
  )

  it.effect("classifies revision movement during exact Git fallback as review changed", () =>
    Effect.gen(function* () {
      const directory = yield* testDirectory
      const closed = { count: 0 }
      const revisionChangedWorkspaceLayer = Layer.succeed(HostedReviewWorkspacePool, {
        use: () => Effect.die("unused"),
        pinComparison: () => Effect.die("unused"),
        readComparisonDiff: () => Effect.die("unused"),
        useComparison: () => Effect.die("unused"),
        useRevision: () =>
          Effect.fail(
            HostedReviewWorkspacePoolError.make({
              code: "revision-changed",
              operation: "useRevision",
              reason: "The fetched review revision changed",
              cause: new Error("revision changed"),
            }),
          ),
      })
      const failure = yield* Effect.gen(function* () {
        const acquisition = yield* CoreSnapshotAcquisition
        const resources = yield* ResourceCatalog
        yield* resources.registerRoot({
          id: rootId,
          path: join(directory, "managed"),
          createdAtMs: 0,
        })
        return yield* acquisition.acquireHosted(review).pipe(Effect.flip)
      }).pipe(
        Effect.provide(
          acquisitionLayer(directory, refusedHostedSource(closed), {
            workspaceLayer: revisionChangedWorkspaceLayer,
          }),
        ),
      )

      expect(failure).toMatchObject({
        _tag: "ReviewContextError",
        category: "reviewChanged",
      })
      expect(closed.count).toBe(1)
    }),
  )

  it.effect("acquires a local immutable source without constructing a complete snapshot", () =>
    Effect.gen(function* () {
      const directory = yield* testDirectory
      const target = LocalReviewTarget.make({
        kind: "local",
        rootPath: checkout,
        comparison: LastCommitComparison.make({ baseSha: baseRevision, headSha: headRevision }),
      })
      yield* Effect.gen(function* () {
        const acquisition = yield* CoreSnapshotAcquisition
        const [manifest, concurrentManifest] = yield* Effect.all(
          [acquisition.acquireLocal(target), acquisition.acquireLocal(target)],
          { concurrency: "unbounded" },
        )
        expect(concurrentManifest).toEqual(manifest)
        expect(manifest.projectId).toBe(projectId)
        expect(manifest.detail.diffHash).toBeTruthy()
        expect(manifest.detail.title).toBe("Last commit")
        expect(manifest.detail).not.toHaveProperty("files")
        expect(manifest).not.toHaveProperty("files")
      }).pipe(Effect.provide(acquisitionLayer(directory, hostedSource({ count: 0 }))))
    }),
  )

  it.effect("catalogs and collects only producer-declared mutable review staging", () =>
    Effect.gen(function* () {
      const directory = yield* testDirectory
      const target = LocalReviewTarget.make({
        kind: "local",
        rootPath: checkout,
        comparison: WorkingTreeComparison.make({}),
      })
      yield* Effect.gen(function* () {
        const acquisition = yield* CoreSnapshotAcquisition
        const resources = yield* ResourceCatalog
        yield* resources.registerRoot({
          id: rootId,
          path: join(directory, "managed"),
          createdAtMs: 0,
        })

        yield* acquisition.acquireLocal(target)

        const staging = (yield* resources.list()).filter(({ kind }) => kind === "reviewStaging")
        expect(staging).toHaveLength(1)
        expect(staging[0]).toMatchObject({
          policyClass: "temporary",
          state: "deleted",
          bytes: 0,
          validation: "verified-local-review-staging-v1",
        })
      }).pipe(Effect.provide(acquisitionLayer(directory, hostedSource({ count: 0 }))))
    }),
  )

  it.effect("acquires an exact repository comparison through its pinned workspace", () =>
    Effect.gen(function* () {
      const directory = yield* testDirectory
      yield* Effect.gen(function* () {
        const acquisition = yield* CoreSnapshotAcquisition
        const manifest = yield* acquisition.acquireComparison(comparisonTarget)
        expect(manifest.projectId).toBe(projectId)
        expect(manifest.detail.target).toBe(comparisonTarget)
        expect(manifest.detail.title).toBe("main...feature")
        expect(manifest.detail).not.toHaveProperty("files")
        expect(manifest).not.toHaveProperty("files")
      }).pipe(Effect.provide(acquisitionLayer(directory, hostedSource({ count: 0 }))))
    }),
  )
})
