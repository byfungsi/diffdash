import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  CoreRpcPayloadBytes,
  HostRequestId,
} from "@diffdash/core-rpc"
import {
  ReviewFileId,
  ReviewFilePatchHash,
  ReviewHunkId,
  ReviewKey,
  ReviewProjectId,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import * as DatabaseNode from "@diffdash/persistence/database-node"
import {
  CatalogResourceId,
  ResourceCatalog,
  ResourceReservationId,
  ResourceRootId,
} from "@diffdash/persistence/resource-catalog"
import {
  DiffBlockId,
  type FileDeltaId,
  FileDeltaIdentity,
  SnapshotBlockStore,
  StoredSnapshotId,
  type SnapshotBlockStoreOptions,
} from "@diffdash/persistence/snapshot-block-store"
import { Deferred, Effect, Fiber, Layer, Result, Schema } from "effect"

import {
  SnapshotGitRangeSource,
  SnapshotProjectAuthority,
  SnapshotRepository,
  SnapshotRepositoryIdentity,
  SnapshotRepositorySessionId,
  snapshotRepositoryLayer,
  type LazySnapshotBlock,
  type SnapshotRepositoryOptions,
} from "./snapshot-repository"
import { testReviewDescriptor } from "../test-review-descriptor"
import { OperationSnapshotReader, operationSnapshotReaderLayer } from "./operation-snapshot-reader"

const encoder = new TextEncoder()
const projectId = ReviewProjectId.make("project:one")
const reviewKey = ReviewKey.make("github:fungsi/diffdash#235")
const snapshotOne = ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000001")
const snapshotTwo = ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000002")
const rootId = ResourceRootId.make("snapshot-repository-root")

const identity = (
  snapshotId: ReviewSnapshotId,
  session = "session:one",
  request = "h:range",
): SnapshotRepositoryIdentity => ({
  applicationInstanceId: ApplicationInstanceId.make("app:one"),
  processEpoch: CoreProcessEpoch.make("epoch:one"),
  requestId: HostRequestId.make(request),
  projectId,
  reviewKey,
  snapshotId,
  sessionId: SnapshotRepositorySessionId.make(session),
})

const options: SnapshotRepositoryOptions = {
  maximumResponseBytes: CoreRpcPayloadBytes.make(16),
  maximumBlockBytes: 32,
  maximumLazyBlocks: 32,
  maximumLazyConcurrency: 1,
  managedQuotaBytes: 1024 * 1024,
  reservationLifetimeMs: 10_000,
  leaseLifetimeMs: 1_000,
}

const storeOptions = (directory: string): SnapshotBlockStoreOptions => ({
  rootId,
  rootPath: join(directory, "managed"),
})

const tempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-snapshot-repository-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const makeLayer = (
  directory: string,
  generateFile: SnapshotGitRangeSource["Service"]["generateFile"] = () =>
    Effect.die("Unexpected exact-Git generation"),
) => {
  const database = DatabaseNode.layer(join(directory, "database.sqlite"))
  const persistence = Layer.merge(
    SnapshotBlockStore.layer(storeOptions(directory)),
    ResourceCatalog.layer,
  ).pipe(Layer.provideMerge(database))
  const dependencies = Layer.mergeAll(
    persistence,
    Layer.succeed(SnapshotGitRangeSource, { generateFile }),
    Layer.succeed(SnapshotProjectAuthority, { contains: () => Effect.succeed(true) }),
  )
  return Layer.merge(
    snapshotRepositoryLayer(options),
    operationSnapshotReaderLayer({
      leaseLifetimeMs: 1_000,
      maximumHunkBytes: 1_024,
      maximumFileBytes: 4_096,
    }),
  ).pipe(Layer.provideMerge(dependencies))
}

const deltaIdentity = FileDeltaIdentity.make({
  oldContentId: "blob:old",
  newContentId: "blob:new",
  oldMode: "100644",
  newMode: "100644",
  status: "modified",
  diffOptions: "--unified=3",
  diffPolicyIdentity: "canonical:v1",
  identityVersion: 1,
})

const setup = Effect.fn("SnapshotRepositoryTest.setup")(function* (directory: string) {
  const store = yield* SnapshotBlockStore
  const resources = yield* ResourceCatalog
  yield* Effect.promise(() => mkdir(storeOptions(directory).rootPath, { recursive: true }))
  yield* resources.registerRoot({
    id: rootId,
    path: storeOptions(directory).rootPath,
    createdAtMs: 0,
  })
  const deltaId = yield* store.registerFileDelta({
    identity: deltaIdentity,
    hunks: [
      {
        id: "hunk:one",
        ordinal: 0,
        fingerprint: "fingerprint:one",
        header: "@@ -1 +1 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lineCount: 2,
      },
    ],
  })
  return { store, resources, deltaId }
})

const addBlock = Effect.fn("SnapshotRepositoryTest.addBlock")(function* (
  store: SnapshotBlockStore["Service"],
  deltaId: FileDeltaId,
  ordinal: number,
  firstLine: number,
  text: string,
) {
  const bytes = encoder.encode(text)
  const id = DiffBlockId.make(`block:${ordinal}`)
  const prepared = yield* store.prepareBlock({
    id,
    deltaId,
    hunkId: "hunk:one",
    ordinal,
    firstLine,
    lineCount: 2,
    byteCount: bytes.byteLength,
    checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    reservationId: ResourceReservationId.make(`reservation:${ordinal}`),
    nowMs: 1,
    expiresAtMs: 1_000,
    quotaBytes: 1024 * 1024,
  })
  expect(prepared.kind).toBe("prepared")
  yield* store.stageBlock(id, bytes)
  yield* store.promoteBlock(id)
  yield* store.finalizeBlock(id)
  return id
})

const publish = Effect.fn("SnapshotRepositoryTest.publish")(function* (
  store: SnapshotBlockStore["Service"],
  snapshotId: ReviewSnapshotId,
  deltaId: Parameters<SnapshotBlockStore["Service"]["visibleBlocks"]>[0],
  blockIds: ReadonlyArray<DiffBlockId>,
  source: "managedSpool" | "exactGit",
  fileCount = 1,
) {
  const resourceId = CatalogResourceId.make(`spool:${snapshotId}`)
  if (source === "managedSpool") {
    const resources = yield* ResourceCatalog
    yield* resources.register({
      id: resourceId,
      parentId: null,
      kind: "snapshot-spool",
      policyClass: "cache",
      state: "ready",
      generation: 1,
      location: { kind: "filesystem", rootId, relativePath: `spools/${snapshotId}.patch` },
      bytes: 1,
      nowMs: 1,
      checksum: null,
      validation: null,
    })
  }
  yield* store.publishSnapshot({
    id: StoredSnapshotId.make(snapshotId),
    projectId,
    reviewKey,
    baseRevision: "base",
    headRevision: "head",
    semanticIdentity: "semantic:one",
    descriptor: testReviewDescriptor,
    source:
      source === "managedSpool"
        ? { kind: "managedSpool", resourceId }
        : {
            kind: "exactGit",
            repositoryIdentity: "repo:one",
            baseObject: "base",
            headObject: "head",
            diffPolicyIdentity: "canonical:v1",
          },
    files: Array.from({ length: fileCount }, (_, ordinal) => ({
      ordinal,
      deltaId,
      fileId: `file:${ordinal}`,
      path: `src/${ordinal}.ts`,
      oldPath: null,
      additions: 1,
      deletions: 1,
      status: "modified" as const,
      visibility: { _tag: "Visible" as const },
      patchHash: ReviewFilePatchHash.make(`file-patch:${ordinal}`),
      hunkCount: 1,
    })),
    blockIds,
    checkpoints: [],
    createdAtMs: 2,
  })
})

describe("SnapshotRepository", () => {
  it.effect("keeps operation leases independent from the foreground session", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      yield* Effect.gen(function* () {
        const { deltaId, resources, store } = yield* setup(directory)
        const block = yield* addBlock(store, deltaId, 0, 0, "-old\n+new\n")
        yield* publish(store, snapshotOne, deltaId, [block], "managedSpool")
        const repository = yield* SnapshotRepository
        const foreground = identity(snapshotOne)
        yield* repository.openSession(foreground)

        yield* Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* OperationSnapshotReader
            const operation = yield* reader.open({
              applicationInstanceId: ApplicationInstanceId.make("app:one"),
              processEpoch: CoreProcessEpoch.make("epoch:one"),
              operationId: "walkthrough:one",
              projectId,
              reviewKey,
              snapshotId: snapshotOne,
            })
            const hunk = yield* operation.readHunk(
              ReviewFileId.make("file:0"),
              Schema.decodeSync(ReviewHunkId)("hunk:one"),
            )
            expect(new TextDecoder().decode(hunk.bytes)).toBe("-old\n+new\n")
            expect(yield* operation.hunks(ReviewFileId.make("file:0"), 0, 1)).toMatchObject([
              { id: "hunk:one", ordinal: 0 },
            ])
            const excessive = yield* Effect.result(
              operation.hunks(ReviewFileId.make("file:0"), 0, 257),
            )
            expect(Result.isFailure(excessive)).toBe(true)
            if (Result.isFailure(excessive)) {
              expect(excessive.failure).toMatchObject({
                operation: "hunks",
                reason: "rangeLimit",
              })
            }
            const spool = yield* resources.get(CatalogResourceId.make(`spool:${snapshotOne}`))
            expect(spool.leases).toMatchObject([
              { ownerKind: "durableOperation", ownerId: "walkthrough:one" },
            ])
          }),
        )

        const page = yield* repository.inventory(foreground, 0, 1)
        expect(page.files).toHaveLength(1)
        const spool = yield* resources.get(CatalogResourceId.make(`spool:${snapshotOne}`))
        expect(spool.leases).toEqual([])
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("returns identical semantic ranges from spool and exact-Git manifests", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      yield* Effect.gen(function* () {
        const { deltaId, store } = yield* setup(directory)
        const first = yield* addBlock(store, deltaId, 0, 0, " first\n+one\n")
        const second = yield* addBlock(store, deltaId, 1, 2, " second\n+two\n")
        yield* publish(store, snapshotOne, deltaId, [first, second], "managedSpool")
        yield* publish(store, snapshotTwo, deltaId, [first, second], "exactGit")
        const repository = yield* SnapshotRepository
        const spoolIdentity = identity(snapshotOne, "session:spool", "h:spool")
        yield* repository.openSession(spoolIdentity)
        const spool = yield* repository.readRange(spoolIdentity, ReviewFileId.make("file:0"), 0)
        const gitIdentity = identity(snapshotTwo, "session:git", "h:git")
        yield* repository.openSession(gitIdentity)
        const git = yield* repository.readRange(gitIdentity, ReviewFileId.make("file:0"), 0)
        expect(git.blocks).toEqual(spool.blocks)
        expect(git.blocks).toHaveLength(1)
        expect(git.complete).toBe(false)
        expect(git.byteCount).toBeLessThanOrEqual(options.maximumResponseBytes)
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("finds the final file through its index without allocating the inventory", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      yield* Effect.gen(function* () {
        const { deltaId, store } = yield* setup(directory)
        yield* publish(store, snapshotOne, deltaId, [], "exactGit", 5_000)
        const repository = yield* SnapshotRepository
        const address = identity(snapshotOne)
        yield* repository.openSession(address)
        const file = yield* repository.findFile(address, ReviewFileId.make("file:4999"))
        expect(file).toMatchObject({ ordinal: 4_999, path: "src/4999.ts" })
        const page = yield* repository.inventory(address, 4_990, 10)
        expect(page.files).toHaveLength(10)
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("keeps an enormous file navigable by legal bounded blocks", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      yield* Effect.gen(function* () {
        const { deltaId, store } = yield* setup(directory)
        const ids: DiffBlockId[] = []
        for (let ordinal = 0; ordinal < 100; ordinal += 1)
          ids.push(yield* addBlock(store, deltaId, ordinal, ordinal * 2, ` ${ordinal}\n+x\n`))
        yield* publish(store, snapshotOne, deltaId, ids, "exactGit")
        const repository = yield* SnapshotRepository
        const address = identity(snapshotOne)
        yield* repository.openSession(address)
        const target = yield* repository.resolveTarget(
          address,
          ReviewFileId.make("file:0"),
          null,
          198,
        )
        const range = yield* repository.readRange(address, ReviewFileId.make("file:0"), 198)
        expect(target.blockOrdinal).toBe(99)
        expect(range.blocks.map(({ ordinal }) => ordinal)).toEqual([99])
        expect(range.byteCount).toBeLessThanOrEqual(options.maximumResponseBytes)
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("prevents a superseded lazy wait from publishing", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const generated: LazySnapshotBlock[] = [
        { hunkId: null, ordinal: 0, firstLine: 0, lineCount: 1, bytes: encoder.encode("+x\n") },
      ]
      const generateFile: SnapshotGitRangeSource["Service"]["generateFile"] = () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(generated),
        )
      yield* Effect.gen(function* () {
        const { deltaId, store } = yield* setup(directory)
        yield* publish(store, snapshotOne, deltaId, [], "exactGit")
        yield* publish(store, snapshotTwo, deltaId, [], "exactGit")
        const repository = yield* SnapshotRepository
        const first = identity(snapshotOne, "session:first", "h:first")
        yield* repository.openSession(first)
        const waiting = yield* repository
          .waitForRange(first, ReviewFileId.make("file:0"), 0)
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* repository.openSession(identity(snapshotTwo, "session:second", "h:second"))
        yield* Deferred.succeed(release, undefined)
        expect(Result.isFailure(yield* Effect.result(Fiber.join(waiting)))).toBe(true)
        expect(yield* store.visibleBlocks(deltaId)).toEqual([])
      }).pipe(Effect.provide(makeLayer(directory, generateFile)))
    }),
  )

  it.effect("prevents a superseded range read from returning or publishing", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const generated: LazySnapshotBlock[] = [
        {
          hunkId: null,
          ordinal: 0,
          firstLine: 0,
          lineCount: 1,
          bytes: encoder.encode("+x\n"),
        },
      ]
      const generateFile: SnapshotGitRangeSource["Service"]["generateFile"] = () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(generated),
        )
      yield* Effect.gen(function* () {
        const { deltaId, store } = yield* setup(directory)
        yield* publish(store, snapshotOne, deltaId, [], "exactGit")
        yield* publish(store, snapshotTwo, deltaId, [], "exactGit")
        const repository = yield* SnapshotRepository
        const first = identity(snapshotOne, "session:first", "h:first")
        yield* repository.openSession(first)
        const reading = yield* repository
          .readRange(first, ReviewFileId.make("file:0"), 0)
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* repository.openSession(identity(snapshotTwo, "session:second", "h:second"))
        yield* Deferred.succeed(release, undefined)
        expect(Result.isFailure(yield* Effect.result(Fiber.join(reading)))).toBe(true)
        expect(yield* store.visibleBlocks(deltaId)).toEqual([])
      }).pipe(Effect.provide(makeLayer(directory, generateFile)))
    }),
  )

  it.effect("releases block leases and rejects stale identity dimensions", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      yield* Effect.gen(function* () {
        const { deltaId, resources, store } = yield* setup(directory)
        const blockId = yield* addBlock(store, deltaId, 0, 0, " line\n+x\n")
        yield* publish(store, snapshotOne, deltaId, [blockId], "exactGit")
        const repository = yield* SnapshotRepository
        const address = identity(snapshotOne)
        yield* repository.openSession(address)
        yield* repository.readRange(address, ReviewFileId.make("file:0"), 0)
        const [block] = yield* store.visibleBlocks(deltaId)
        if (block === undefined) return
        expect((yield* resources.get(block.resource_id)).leases).toEqual([])
        for (const rejected of [
          { ...address, applicationInstanceId: ApplicationInstanceId.make("app:other") },
          { ...address, processEpoch: CoreProcessEpoch.make("epoch:other") },
          { ...address, projectId: ReviewProjectId.make("project:other") },
          { ...address, reviewKey: ReviewKey.make("review:other") },
          { ...address, snapshotId: snapshotTwo },
          { ...address, sessionId: SnapshotRepositorySessionId.make("session:other") },
        ]) {
          const result = yield* Effect.result(
            repository.findFile(rejected, ReviewFileId.make("file:0")),
          )
          expect(Result.isFailure(result)).toBe(true)
        }
        expect(
          Schema.is(SnapshotRepositoryIdentity)({ ...address, requestId: "invalid-request" }),
        ).toBe(false)
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )
})
