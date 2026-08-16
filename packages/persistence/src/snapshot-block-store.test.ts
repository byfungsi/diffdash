import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import { ReviewFilePatchHash, ReviewProjectId } from "@diffdash/domain/review-identity"
import { LocalReviewDescriptor } from "@diffdash/domain/review-context"
import { LocalReviewTarget, WorkingTreeComparison } from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"

import * as DatabaseNode from "./database-node"
import {
  CatalogResourceId,
  ResourceCatalog,
  ResourceLeaseId,
  ResourceRecoveryToken,
  ResourceReservationId,
  ResourceRootId,
} from "./resource-catalog"
import {
  DiffBlockId,
  FileDeltaIdentity,
  makeFileDeltaId,
  SnapshotBlockStore,
  StoredSnapshotId,
  type SnapshotBlockStoreOptions,
} from "./snapshot-block-store"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-snapshot-blocks-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const options = (directory: string): SnapshotBlockStoreOptions => ({
  rootId: ResourceRootId.make("snapshot-root"),
  rootPath: join(directory, "managed"),
})

const makeLayer = (directory: string) => {
  const database = DatabaseNode.layer(join(directory, "database.sqlite"))
  return Layer.merge(SnapshotBlockStore.layer(options(directory)), ResourceCatalog.layer).pipe(
    Layer.provideMerge(database),
  )
}

const identity = FileDeltaIdentity.make({
  oldContentId: "blob:old",
  newContentId: "blob:new",
  oldMode: "100644",
  newMode: "100644",
  status: "modified",
  diffOptions: "--no-ext-diff --unified=3",
  diffPolicyIdentity: "canonical-diff:v1",
  identityVersion: 1,
})

const bytes = new TextEncoder().encode(" context\n-old\n+new\n")
const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
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

const registerRootAndDelta = Effect.fn("SnapshotBlockStoreTest.registerRootAndDelta")(function* (
  directory: string,
) {
  const catalog = yield* ResourceCatalog
  const store = yield* SnapshotBlockStore
  yield* Effect.promise(() =>
    import("node:fs/promises").then(({ mkdir }) =>
      mkdir(options(directory).rootPath, { recursive: true }),
    ),
  )
  yield* catalog.registerRoot({
    id: options(directory).rootId,
    path: options(directory).rootPath,
    createdAtMs: 1,
  })
  const deltaId = yield* store.registerFileDelta({
    identity,
    hunks: [
      {
        id: "hunk:one",
        ordinal: 0,
        fingerprint: "hunk-content:one",
        header: "@@ -1 +1 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lineCount: 3,
      },
    ],
  })
  return { catalog, store, deltaId }
})

const prepare = Effect.fn("SnapshotBlockStoreTest.prepare")(function* (
  store: SnapshotBlockStore["Service"],
  deltaId: ReturnType<typeof makeFileDeltaId>,
  suffix: string,
) {
  const id = DiffBlockId.make(`block:${suffix}`)
  expect(
    yield* store.prepareBlock({
      id,
      deltaId,
      hunkId: "hunk:one",
      ordinal: Number(suffix),
      firstLine: Number(suffix) * 3,
      lineCount: 3,
      byteCount: bytes.byteLength,
      checksum,
      reservationId: ResourceReservationId.make(`reservation:${suffix}`),
      nowMs: 10,
      expiresAtMs: 1_000,
      quotaBytes: 1024 * 1024,
    }),
  ).toEqual({ kind: "prepared", id })
  return id
})

const publish = Effect.fn("SnapshotBlockStoreTest.publish")(function* (
  store: SnapshotBlockStore["Service"],
  snapshotId: string,
  deltaId: ReturnType<typeof makeFileDeltaId>,
  blockId: DiffBlockId,
) {
  yield* store.publishSnapshot({
    id: StoredSnapshotId.make(snapshotId),
    projectId: ReviewProjectId.make("project:snapshot-block-store"),
    reviewKey: "github:fungsi/diffdash#234",
    baseRevision: "base",
    headRevision: "head",
    semanticIdentity: `semantic:${snapshotId}`,
    descriptor,
    source: {
      kind: "exactGit",
      repositoryIdentity: "github:fungsi/diffdash",
      baseObject: "base-object",
      headObject: "head-object",
      diffPolicyIdentity: identity.diffPolicyIdentity,
    },
    files: [
      {
        ordinal: 0,
        deltaId,
        fileId: "file:src/app.ts",
        path: "src/app.ts",
        oldPath: null,
        additions: 1,
        deletions: 1,
        status: "modified",
        visibility: { _tag: "Visible" },
        patchHash: ReviewFilePatchHash.make("file-patch:test"),
        hunkCount: 1,
      },
    ],
    blockIds: [blockId],
    checkpoints: [
      {
        ordinal: 0,
        fileOrdinal: 0,
        hunkOrdinal: 0,
        blockId,
        byteOffset: 0,
        lineOffset: 0,
      },
    ],
    createdAtMs: 20,
  })
})

describe("SnapshotBlockStore", () => {
  it("keys deltas by every exact content, mode, status, option, policy, and version input", () => {
    const baseline = makeFileDeltaId(identity)
    const alternatives = [
      { ...identity, oldContentId: "blob:other-old" },
      { ...identity, newContentId: "blob:other-new" },
      { ...identity, oldMode: "100755" },
      { ...identity, newMode: "100755" },
      { ...identity, status: "renamed" as const },
      { ...identity, diffOptions: "--unified=10" },
      { ...identity, diffPolicyIdentity: "canonical-diff:v2" },
      { ...identity, identityVersion: 2 },
    ].map((value) => makeFileDeltaId(FileDeltaIdentity.make(value)))

    expect(new Set([baseline, ...alternatives])).toHaveLength(alternatives.length + 1)
  })

  it.effect("drops a reservation recovered before any managed bytes were staged", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      yield* Effect.gen(function* () {
        const { catalog, deltaId, store } = yield* registerRootAndDelta(directory)
        const blockId = yield* prepare(store, deltaId, "0")

        expect(yield* store.visibleBlocks(deltaId)).toEqual([])
        yield* store.recoverWrites()
        expect(yield* store.visibleBlocks(deltaId)).toEqual([])
        expect(
          Result.isFailure(
            yield* Effect.result(
              catalog.get(
                CatalogResourceId.make(
                  `snapshot-block:${createHash("sha256").update(blockId).digest("hex")}`,
                ),
              ),
            ),
          ),
        ).toBe(true)
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("recovers a synced temporary block and publishes it only after finalization", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      yield* Effect.gen(function* () {
        const { deltaId, store } = yield* registerRootAndDelta(directory)
        const blockId = yield* prepare(store, deltaId, "0")
        yield* store.stageBlock(blockId, bytes)

        expect(yield* store.visibleBlocks(deltaId)).toEqual([])
        yield* store.recoverWrites()
        expect(yield* store.visibleBlocks(deltaId)).toEqual([
          expect.objectContaining({ id: blockId, checksum, byte_count: bytes.byteLength }),
        ])
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("recovers a promoted block whose visibility transaction did not commit", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      yield* Effect.gen(function* () {
        const { deltaId, store } = yield* registerRootAndDelta(directory)
        const blockId = yield* prepare(store, deltaId, "0")
        yield* store.stageBlock(blockId, bytes)
        yield* store.promoteBlock(blockId)

        expect(yield* store.visibleBlocks(deltaId)).toEqual([])
        yield* store.recoverWrites()
        expect(yield* store.visibleBlocks(deltaId)).toHaveLength(1)
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("keeps a finalized checksummed block visible after restart recovery", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      yield* Effect.gen(function* () {
        const { deltaId, store } = yield* registerRootAndDelta(directory)
        const blockId = yield* prepare(store, deltaId, "0")
        yield* store.stageBlock(blockId, bytes)
        yield* store.promoteBlock(blockId)
        yield* store.finalizeBlock(blockId)
        yield* store.recoverWrites()

        const [block] = yield* store.visibleBlocks(deltaId)
        expect(block).toMatchObject({ id: blockId, line_count: 3, first_line: 0 })
        expect(readFileSync(join(options(directory).rootPath, block?.final_path ?? ""))).toEqual(
          Buffer.from(bytes),
        )
        yield* publish(store, "snapshot:metadata", deltaId, blockId)
        expect(yield* store.getSnapshot(StoredSnapshotId.make("snapshot:metadata"))).toMatchObject({
          source: {
            kind: "exactGit",
            repositoryIdentity: "github:fungsi/diffdash",
            baseObject: "base-object",
            headObject: "head-object",
            diffPolicyIdentity: identity.diffPolicyIdentity,
          },
          descriptor,
          blockIds: [blockId],
          checkpoints: [{ blockId, byteOffset: 0, lineOffset: 0 }],
        })
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("retains a managed spool as manifest authority until that snapshot is deleted", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      yield* Effect.gen(function* () {
        const { catalog, store } = yield* registerRootAndDelta(directory)
        const resourceId = CatalogResourceId.make("snapshot-spool:remote")
        yield* catalog.register({
          id: resourceId,
          parentId: null,
          kind: "snapshot-spool",
          policyClass: "cache",
          state: "ready",
          generation: 1,
          location: {
            kind: "filesystem",
            rootId: options(directory).rootId,
            relativePath: "snapshot-spools/remote.patch",
          },
          bytes: 128,
          nowMs: 10,
          checksum: checksum,
          validation: "sha256",
        })
        yield* store.publishSnapshot({
          id: StoredSnapshotId.make("snapshot:remote"),
          projectId: ReviewProjectId.make("project:snapshot-block-store"),
          reviewKey: "github:fungsi/diffdash#234",
          baseRevision: "base",
          headRevision: "head",
          semanticIdentity: "semantic:remote",
          descriptor,
          source: { kind: "managedSpool", resourceId },
          files: [],
          blockIds: [],
          checkpoints: [],
          createdAtMs: 20,
        })

        expect(yield* store.getSnapshot(StoredSnapshotId.make("snapshot:remote"))).toMatchObject({
          source: { kind: "managedSpool", resourceId },
        })
        expect(
          (yield* store.deleteSnapshot(StoredSnapshotId.make("snapshot:remote")))
            .collectibleResourceIds,
        ).toEqual([resourceId])
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("rejects lazy-output work that outruns the shared managed quota", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      yield* Effect.gen(function* () {
        const { deltaId, store } = yield* registerRootAndDelta(directory)
        expect(
          yield* store.prepareBlock({
            id: DiffBlockId.make("block:quota"),
            deltaId,
            hunkId: "hunk:one",
            ordinal: 0,
            firstLine: 0,
            lineCount: 3,
            byteCount: bytes.byteLength,
            checksum,
            reservationId: ResourceReservationId.make("reservation:quota"),
            nowMs: 10,
            expiresAtMs: 1_000,
            quotaBytes: bytes.byteLength - 1,
          }),
        ).toEqual({
          kind: "quotaExceeded",
          requiredBytes: bytes.byteLength,
          availableBytes: bytes.byteLength - 1,
        })
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("preserves shared bytes until the last manifest and live handle are gone", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      yield* Effect.gen(function* () {
        const { catalog, deltaId, store } = yield* registerRootAndDelta(directory)
        const blockId = yield* prepare(store, deltaId, "0")
        yield* store.stageBlock(blockId, bytes)
        yield* store.promoteBlock(blockId)
        yield* store.finalizeBlock(blockId)
        yield* publish(store, "snapshot:one", deltaId, blockId)
        yield* publish(store, "snapshot:two", deltaId, blockId)
        const [block] = yield* store.visibleBlocks(deltaId)
        const path = join(options(directory).rootPath, block?.final_path ?? "")

        expect(
          (yield* store.deleteSnapshot(StoredSnapshotId.make("snapshot:one")))
            .collectibleResourceIds,
        ).toEqual([])
        expect(existsSync(path)).toBe(true)

        const deleted = yield* store.deleteSnapshot(StoredSnapshotId.make("snapshot:two"))
        expect(deleted.collectibleResourceIds).toHaveLength(1)
        const resourceId = deleted.collectibleResourceIds[0]
        if (resourceId === undefined) return
        yield* catalog.acquireLease({
          id: ResourceLeaseId.make("lease:block-reader"),
          resourceId,
          ownerKind: "snapshotReader",
          ownerId: "reader:one",
          applicationInstanceId: "app:one",
          processEpoch: "epoch:one",
          acquiredAtMs: 20,
          renewedAtMs: 20,
          expiresAtMs: 100,
          purpose: "open block handle",
        })
        expect(
          Result.isFailure(
            yield* Effect.result(
              store.beginCollection(resourceId, ResourceRecoveryToken.make("collect:block"), 30),
            ),
          ),
        ).toBe(true)
        expect(existsSync(path)).toBe(true)

        yield* catalog.expireOwnership({
          applicationInstanceId: "app:one",
          processEpoch: "epoch:one",
        })
        const token = ResourceRecoveryToken.make("collect:block")
        yield* store.beginCollection(resourceId, token, 31)
        yield* store.quarantineCollection(resourceId, token, 32)
        expect(existsSync(path)).toBe(false)
        yield* store.completeCollection(resourceId, token, 33)
        expect(yield* store.visibleBlocks(deltaId)).toEqual([])
        expect(yield* catalog.get(resourceId)).toMatchObject({ state: "deleted", bytes: 0 })
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("resumes collection after intent and a quarantine rename before SQLite advances", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      yield* Effect.gen(function* () {
        const { deltaId, store } = yield* registerRootAndDelta(directory)
        const blockId = yield* prepare(store, deltaId, "0")
        yield* store.stageBlock(blockId, bytes)
        yield* store.promoteBlock(blockId)
        yield* store.finalizeBlock(blockId)
        yield* publish(store, "snapshot:recover-collection", deltaId, blockId)
        const [block] = yield* store.visibleBlocks(deltaId)
        const [resourceId] = (yield* store.deleteSnapshot(
          StoredSnapshotId.make("snapshot:recover-collection"),
        )).collectibleResourceIds
        if (resourceId === undefined) return
        const token = ResourceRecoveryToken.make("collect:recover")
        yield* store.beginCollection(resourceId, token, 30)
        const original = join(options(directory).rootPath, block?.final_path ?? "")
        const trashDirectory = join(options(directory).rootPath, ".snapshot-trash")
        const quarantined = join(trashDirectory, createHash("sha256").update(token).digest("hex"))
        mkdirSync(trashDirectory, { recursive: true })
        renameSync(original, quarantined)

        yield* store.recoverCollections(31)
        yield* store.recoverCollections(32)
        expect(yield* store.visibleBlocks(deltaId)).toEqual([])
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("resumes collection after intent commits before filesystem mutation", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      yield* Effect.gen(function* () {
        const { deltaId, store } = yield* registerRootAndDelta(directory)
        const blockId = yield* prepare(store, deltaId, "0")
        yield* store.stageBlock(blockId, bytes)
        yield* store.promoteBlock(blockId)
        yield* store.finalizeBlock(blockId)
        yield* publish(store, "snapshot:intent-only", deltaId, blockId)
        const [resourceId] = (yield* store.deleteSnapshot(
          StoredSnapshotId.make("snapshot:intent-only"),
        )).collectibleResourceIds
        if (resourceId === undefined) return
        yield* store.beginCollection(resourceId, ResourceRecoveryToken.make("collect:intent"), 30)

        yield* store.recoverCollections(31)
        expect(yield* store.visibleBlocks(deltaId)).toEqual([])
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("resumes collection after quarantined bytes were already deleted", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      yield* Effect.gen(function* () {
        const { deltaId, store } = yield* registerRootAndDelta(directory)
        const blockId = yield* prepare(store, deltaId, "0")
        yield* store.stageBlock(blockId, bytes)
        yield* store.promoteBlock(blockId)
        yield* store.finalizeBlock(blockId)
        yield* publish(store, "snapshot:deleted-before-commit", deltaId, blockId)
        const [resourceId] = (yield* store.deleteSnapshot(
          StoredSnapshotId.make("snapshot:deleted-before-commit"),
        )).collectibleResourceIds
        if (resourceId === undefined) return
        const token = ResourceRecoveryToken.make("collect:deleted-before-commit")
        yield* store.beginCollection(resourceId, token, 30)
        yield* store.quarantineCollection(resourceId, token, 31)
        rmSync(
          join(
            options(directory).rootPath,
            ".snapshot-trash",
            createHash("sha256").update(token).digest("hex"),
          ),
        )

        yield* store.recoverCollections(32)
        expect(yield* store.visibleBlocks(deltaId)).toEqual([])
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )
})
