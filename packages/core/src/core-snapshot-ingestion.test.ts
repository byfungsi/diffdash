import { mkdtempSync, rmSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import {
  GitProviderId,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewLocator,
  HostedReviewNumber,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import {
  ReviewDiffIdentity,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
  makeReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import {
  REVIEW_DIFF_MAX_CHUNK_BYTES,
  HostedReviewDiffSourceTarget,
  ReviewDiffAcquisition,
  ReviewDiffGeneration,
  ReviewDiffSourceFacts,
  ReviewDiffSourceOffer,
  UnifiedBytesMethod,
  type ReviewDiffSource,
} from "@diffdash/git-provider"
import * as DatabaseNode from "@diffdash/persistence/database-node"
import { ResourceCatalog, ResourceRootId } from "@diffdash/persistence/resource-catalog"
import {
  FileDeltaIdentity,
  makeFileDeltaId,
  SnapshotBlockStore,
  StoredSnapshotId,
} from "@diffdash/persistence/snapshot-block-store"
import {
  IncrementalUnifiedDiffParser,
  type IncrementalDiffBatch,
} from "@diffdash/review-data-worker"
import { Deferred, Effect, Fiber, Layer, Result, Stream } from "effect"

import {
  CoreSnapshotIngestion,
  coreSnapshotIngestionLayer,
  type CoreSnapshotIngestionOptions,
} from "./core-snapshot-ingestion"
import { CoreReviewDataWorker } from "./review-data-worker-coordinator"

const encoder = new TextEncoder()
const revision = ReviewRevision.make("head-revision")
const baseRevision = ReviewRevision.make("base-revision")
const semanticIdentity = ReviewDiffIdentity.make("diff:v1:incremental-snapshot")
const generation = ReviewDiffGeneration.make("snapshot-generation")
const acquisition = ReviewDiffAcquisition.make({ generation, expectedRevision: revision })
const review = HostedReviewLocator.make({
  repository: HostedRepositoryLocator.make({
    providerId: GitProviderId.make("fixture"),
    namespace: RepositoryNamespace.make("diffdash"),
    name: HostedRepositoryName.make("snapshot-ingestion"),
  }),
  number: HostedReviewNumber.make(218),
})
const reviewKey = ReviewKey.make("fixture:diffdash/snapshot-ingestion#218")
const snapshotId = makeReviewSnapshotId({
  reviewKey,
  baseRevision,
  headRevision: revision,
  diffIdentity: semanticIdentity,
})
const rootId = ResourceRootId.make("snapshot-ingestion-root")
const exactIdentity = FileDeltaIdentity.make({
  oldContentId: "blob:old",
  newContentId: "blob:new",
  oldMode: "100644",
  newMode: "100644",
  status: "modified",
  diffOptions: "--no-ext-diff --unified=3",
  diffPolicyIdentity: "canonical-diff:v1",
  identityVersion: 1,
})
const defaultOptions: CoreSnapshotIngestionOptions = {
  managedQuotaBytes: 4 * 1024 * 1024,
  reservationLifetimeMs: 60_000,
}

const tempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-snapshot-ingestion-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const source = (bytes: Uint8Array, closed: { count: number }): ReviewDiffSource => ({
  offer: ReviewDiffSourceOffer.make({
    target: HostedReviewDiffSourceTarget.make({ review, reviewKey }),
    expectedRevision: revision,
    semanticIdentity,
    methods: [UnifiedBytesMethod.make({ maxChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES })],
    facts: ReviewDiffSourceFacts.make({
      origin: "local",
      revisionKind: "immutableGit",
      reproducible: true,
      complete: true,
      declaredBytes: bytes.byteLength,
    }),
  }),
  unifiedBytes: () => Stream.die("Fake Core worker consumes fixture bytes directly"),
  filePage: () => Effect.die("unused"),
  materializedGit: () => Effect.die("unused"),
  bufferedBytes: () => Effect.die("unused"),
  close: Effect.sync(() => {
    closed.count += 1
  }),
})

const input = (reviewSource: ReviewDiffSource) => ({
  source: reviewSource,
  acquisition,
  manifest: {
    projectId: ReviewProjectId.make("project:snapshot-ingestion"),
    snapshotId,
    reviewKey,
    baseRevision,
    headRevision: revision,
    semanticIdentity,
    storageSource: {
      kind: "exactGit" as const,
      repositoryIdentity: "fixture:diffdash/snapshot-ingestion",
      baseObject: "base-object",
      headObject: "head-object",
      diffPolicyIdentity: exactIdentity.diffPolicyIdentity,
    },
  },
  fileDeltaKeys: { resolve: () => Effect.succeed(exactIdentity) },
})

const makeLayer = (
  directory: string,
  bytes: Uint8Array,
  options: CoreSnapshotIngestionOptions = defaultOptions,
  afterBatches: Effect.Effect<void> = Effect.void,
) => {
  const rootPath = join(directory, "managed")
  const database = DatabaseNode.layer(join(directory, "database.sqlite"))
  const persistence = Layer.merge(
    SnapshotBlockStore.layer({ rootId, rootPath }),
    ResourceCatalog.layer,
  ).pipe(Layer.provideMerge(database))
  const worker = Layer.succeed(CoreReviewDataWorker, {
    process: (_source, _acquisition, onBatch) =>
      Effect.gen(function* () {
        for (const batch of oneEventBatches(bytes)) yield* onBatch(batch)
        yield* afterBatches
      }),
  })
  return {
    layer: coreSnapshotIngestionLayer(options).pipe(
      Layer.provideMerge(worker),
      Layer.provideMerge(persistence),
    ),
    rootPath,
  }
}

describe("CoreSnapshotIngestion", () => {
  it.effect("persists closed hunks from arbitrary bounded batches and publishes last", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      const patch = encoder.encode(
        "diff --git a/src/a.ts b/src/a.ts\nindex 111..222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      )
      const closed = { count: 0 }
      const harness = makeLayer(directory, patch)

      yield* Effect.gen(function* () {
        const resources = yield* ResourceCatalog
        const ingestion = yield* CoreSnapshotIngestion
        const store = yield* SnapshotBlockStore
        yield* Effect.promise(() => mkdir(harness.rootPath, { recursive: true }))
        yield* resources.registerRoot({ id: rootId, path: harness.rootPath, createdAtMs: 0 })

        const result = yield* ingestion.ingest(input(source(patch, closed)))
        expect(result.snapshotId).toBe(snapshotId)
        expect(result.files).toHaveLength(1)
        expect(result.files[0]?.hunkCount).toBe(1)
        expect(result.files[0]?.patchHash).toMatch(/^file-patch:v2:/)

        const snapshot = yield* store.getSnapshot(StoredSnapshotId.make(snapshotId))
        expect(snapshot.files).toHaveLength(1)
        expect(snapshot.blockIds).toHaveLength(2)
        expect(snapshot.checkpoints).toHaveLength(2)
        const blocks = yield* store.visibleBlocks(makeFileDeltaId(exactIdentity))
        expect(blocks).toHaveLength(2)
        const contents = yield* Effect.forEach(blocks, (block) =>
          store
            .readManagedRange(block.resource_id, 0, block.byte_count)
            .pipe(Effect.map((range) => new TextDecoder().decode(range.bytes))),
        )
        expect(contents.join("")).toBe(
          "diff --git a/src/a.ts b/src/a.ts\nindex 111..222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        )
      }).pipe(Effect.provide(harness.layer))

      expect(closed.count).toBe(1)
    }),
  )

  it.effect("rejects an oversized complete hunk without publishing a snapshot", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      const patch = encoder.encode(
        `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-${"a".repeat(40)}\n+new\n`,
      )
      const harness = makeLayer(directory, patch, { ...defaultOptions, maximumBlockBytes: 32 })
      const closed = { count: 0 }

      yield* Effect.gen(function* () {
        const resources = yield* ResourceCatalog
        const ingestion = yield* CoreSnapshotIngestion
        const store = yield* SnapshotBlockStore
        yield* Effect.promise(() => mkdir(harness.rootPath, { recursive: true }))
        yield* resources.registerRoot({ id: rootId, path: harness.rootPath, createdAtMs: 0 })

        const result = yield* Effect.result(ingestion.ingest(input(source(patch, closed))))
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure._tag).toBe("CoreSnapshotIngestionError")
        expect(
          Result.isFailure(
            yield* Effect.result(store.getSnapshot(StoredSnapshotId.make(snapshotId))),
          ),
        ).toBe(true)
        expect(yield* store.visibleBlocks(makeFileDeltaId(exactIdentity))).toHaveLength(0)
      }).pipe(Effect.provide(harness.layer))

      expect(closed.count).toBe(1)
    }),
  )

  it.effect("closes the source and leaves no manifest when ingestion is interrupted", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      const patch = encoder.encode(
        "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      )
      const batchesConsumed = yield* Deferred.make<void>()
      const harness = makeLayer(
        directory,
        patch,
        defaultOptions,
        Deferred.succeed(batchesConsumed, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const closed = { count: 0 }

      yield* Effect.gen(function* () {
        const resources = yield* ResourceCatalog
        const ingestion = yield* CoreSnapshotIngestion
        const store = yield* SnapshotBlockStore
        yield* Effect.promise(() => mkdir(harness.rootPath, { recursive: true }))
        yield* resources.registerRoot({ id: rootId, path: harness.rootPath, createdAtMs: 0 })

        const fiber = yield* ingestion.ingest(input(source(patch, closed))).pipe(Effect.forkScoped)
        yield* Deferred.await(batchesConsumed)
        yield* Fiber.interrupt(fiber)

        expect(
          Result.isFailure(
            yield* Effect.result(store.getSnapshot(StoredSnapshotId.make(snapshotId))),
          ),
        ).toBe(true)
        expect(yield* store.visibleBlocks(makeFileDeltaId(exactIdentity))).toHaveLength(2)
      }).pipe(Effect.provide(harness.layer), Effect.scoped)

      expect(closed.count).toBe(1)
    }),
  )
})

const oneEventBatches = (bytes: Uint8Array): ReadonlyArray<IncrementalDiffBatch> => {
  const parser = new IncrementalUnifiedDiffParser()
  const accepted = parser.accept(bytes)
  if (accepted._tag === "Failure") throw accepted.error
  const finished = parser.finish()
  if (finished._tag === "Failure") throw finished.error
  return [...accepted.batches, ...finished.batches]
    .flatMap(({ events }) => events)
    .map((event) => ({
      events: [event],
      byteCount: encoder.encode(JSON.stringify(event)).byteLength,
    }))
}
