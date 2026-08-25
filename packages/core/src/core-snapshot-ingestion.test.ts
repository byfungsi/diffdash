import { createHash } from "node:crypto"
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
import { LocalReviewDescriptor } from "@diffdash/domain/review-context"
import { LocalReviewTarget, WorkingTreeComparison } from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
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
  REVIEW_DIFF_MAX_BATCH_BYTES,
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
const descriptor = LocalReviewDescriptor.make({
  target: LocalReviewTarget.make({
    kind: "local",
    rootPath: RepositoryCheckoutPath.make("/tmp/diffdash"),
    comparison: WorkingTreeComparison.make({}),
  }),
  repoName: "diffdash",
  branchName: null,
  title: "Local changes",
  fetchedAt: "2026-08-16T00:00:00.000Z",
})

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
    descriptor,
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
  metrics: { maximumBatchBytes: number } = { maximumBatchBytes: 0 },
  transformBatch: (batch: IncrementalDiffBatch) => IncrementalDiffBatch = (batch) => batch,
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
        yield* relayParserBatches(bytes, onBatch, metrics, transformBatch)
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
  it.effect("uses streamed status for an added file beyond the first hundred entries", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      const patch = encoder.encode(
        Array.from({ length: 103 }, (_, index) => {
          const path = `src/file-${index + 1}.ts`
          return index === 102
            ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+added\n`
            : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`
        }).join(""),
      )
      const closed = { count: 0 }
      const harness = makeLayer(directory, patch)

      yield* Effect.gen(function* () {
        const resources = yield* ResourceCatalog
        const ingestion = yield* CoreSnapshotIngestion
        const store = yield* SnapshotBlockStore
        yield* Effect.promise(() => mkdir(harness.rootPath, { recursive: true }))
        yield* resources.registerRoot({ id: rootId, path: harness.rootPath, createdAtMs: 0 })

        const result = yield* ingestion.ingest({
          ...input(source(patch, closed)),
          fileDeltaKeys: {
            resolve: ({ ordinal, status }) =>
              Effect.succeed(
                FileDeltaIdentity.make({
                  ...exactIdentity,
                  oldContentId: `blob:old:${ordinal}`,
                  newContentId: `blob:new:${ordinal}`,
                  status,
                }),
              ),
          },
        })
        const snapshot = yield* store.getSnapshot(StoredSnapshotId.make(snapshotId))

        expect(result.fileCount).toBe(103)
        expect(snapshot.files[102]).toMatchObject({
          path: "src/file-103.ts",
          status: "added",
        })
      }).pipe(Effect.provide(harness.layer))
      expect(closed.count).toBe(1)
    }),
  )

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
        expect(result.fileCount).toBe(1)

        const snapshot = yield* store.getSnapshot(StoredSnapshotId.make(snapshotId))
        expect(snapshot.files).toHaveLength(1)
        expect(snapshot.files[0]?.hunkCount).toBe(1)
        expect(snapshot.files[0]?.patchHash).toMatch(/^file-patch:v2:/)
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

  it.effect(
    "streams one multi-megabyte hunk into bounded range-readable blocks",
    () =>
      Effect.gen(function* () {
        const directory = yield* tempDirectory
        const lineCount = 24_000
        const patch = largeSingleHunk(lineCount, 131)
        const maximumBlockBytes = 128 * 1024
        const metrics = { maximumBatchBytes: 0 }
        const harness = makeLayer(
          directory,
          patch,
          { ...defaultOptions, maximumBlockBytes },
          Effect.void,
          metrics,
        )
        const closed = { count: 0 }

        yield* Effect.gen(function* () {
          const resources = yield* ResourceCatalog
          const ingestion = yield* CoreSnapshotIngestion
          const store = yield* SnapshotBlockStore
          yield* Effect.promise(() => mkdir(harness.rootPath, { recursive: true }))
          yield* resources.registerRoot({ id: rootId, path: harness.rootPath, createdAtMs: 0 })

          yield* ingestion.ingest(input(source(patch, closed)))

          const deltaId = makeFileDeltaId(exactIdentity)
          const snapshot = yield* store.getSnapshot(StoredSnapshotId.make(snapshotId))
          expect(snapshot.files[0]).toMatchObject({ additions: lineCount, hunkCount: 1 })
          const blocks = yield* store.visibleBlocks(deltaId)
          const hunkId = blocks.find(({ hunk_id }) => hunk_id !== null)?.hunk_id
          if (hunkId === null || hunkId === undefined)
            throw new Error("Expected final hunk identity on durable blocks")
          const hunk = yield* store.findFileHunk(deltaId, hunkId)
          expect(patch.byteLength).toBeGreaterThan(3 * 1024 * 1024)
          expect(blocks.length).toBeGreaterThan(20)
          expect(snapshot.blockIds).toEqual(blocks.map(({ id }) => id))
          expect(snapshot.checkpoints.map(({ blockId }) => blockId)).toEqual(snapshot.blockIds)
          expect(hunk.lineCount).toBe(lineCount)
          expect(blocks.every(({ byte_count }) => byte_count <= maximumBlockBytes)).toBe(true)
          expect(blocks.every(({ hunk_id }, index) => index === 0 || hunk_id === hunk.id)).toBe(
            true,
          )
          expect(metrics.maximumBatchBytes).toBeLessThanOrEqual(REVIEW_DIFF_MAX_BATCH_BYTES)

          const reconstructed = createHash("sha256")
          let reconstructedBytes = 0
          for (const block of blocks) {
            for (let offset = 0; offset < block.byte_count; offset += 31 * 1024) {
              const range = yield* store.readManagedRange(block.resource_id, offset, 31 * 1024)
              expect(range.bytes.byteLength).toBeLessThanOrEqual(31 * 1024)
              reconstructed.update(range.bytes)
              reconstructedBytes += range.bytes.byteLength
            }
          }
          expect(reconstructedBytes).toBe(patch.byteLength)
          expect(reconstructed.digest("hex")).toBe(createHash("sha256").update(patch).digest("hex"))
        }).pipe(Effect.provide(harness.layer))

        expect(closed.count).toBe(1)
      }),
    30_000,
  )

  it.effect("rejects one indivisible line above the configured block bound", () =>
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

  it.effect("validates worker batches again at the ingestion boundary", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      const patch = encoder.encode(
        "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      )
      const harness = makeLayer(
        directory,
        patch,
        defaultOptions,
        Effect.void,
        { maximumBatchBytes: 0 },
        (batch) => ({ ...batch, byteCount: batch.byteCount + 1 }),
      )
      const closed = { count: 0 }

      yield* Effect.gen(function* () {
        const resources = yield* ResourceCatalog
        const ingestion = yield* CoreSnapshotIngestion
        yield* Effect.promise(() => mkdir(harness.rootPath, { recursive: true }))
        yield* resources.registerRoot({ id: rootId, path: harness.rootPath, createdAtMs: 0 })

        const result = yield* Effect.result(ingestion.ingest(input(source(patch, closed))))
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result))
          expect(result.failure._tag).toBe("CoreReviewDataWorkerBatchError")
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

const relayParserBatches = Effect.fn("CoreSnapshotIngestionTest.relayParserBatches")(function* (
  bytes: Uint8Array,
  onBatch: (batch: IncrementalDiffBatch) => Effect.Effect<void>,
  metrics: { maximumBatchBytes: number },
  transformBatch: (batch: IncrementalDiffBatch) => IncrementalDiffBatch,
) {
  const parser = new IncrementalUnifiedDiffParser()
  for (let offset = 0; offset < bytes.byteLength; offset += 17 * 1024) {
    const accepted = parser.accept(bytes.slice(offset, offset + 17 * 1024))
    if (accepted._tag === "Failure") return yield* Effect.die(accepted.error)
    for (const batch of accepted.batches) {
      metrics.maximumBatchBytes = Math.max(metrics.maximumBatchBytes, batch.byteCount)
      yield* onBatch(transformBatch(batch))
    }
  }
  const finished = parser.finish()
  if (finished._tag === "Failure") return yield* Effect.die(finished.error)
  for (const batch of finished.batches) {
    metrics.maximumBatchBytes = Math.max(metrics.maximumBatchBytes, batch.byteCount)
    yield* onBatch(transformBatch(batch))
  }
  return undefined
})

const largeSingleHunk = (lineCount: number, contentBytes: number): Uint8Array => {
  const prefix = encoder.encode(
    `diff --git a/src/large.ts b/src/large.ts\n--- a/src/large.ts\n+++ b/src/large.ts\n@@ -0,0 +1,${lineCount} @@\n`,
  )
  const line = encoder.encode(`+${"x".repeat(contentBytes)}\n`)
  const bytes = new Uint8Array(prefix.byteLength + line.byteLength * lineCount)
  bytes.set(prefix)
  for (let offset = prefix.byteLength; offset < bytes.byteLength; offset += line.byteLength)
    bytes.set(line, offset)
  return bytes
}
