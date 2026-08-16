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
  ReviewKey,
  ReviewProjectId,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import * as DatabaseNode from "@diffdash/persistence/database-node"
import {
  ResourceCatalog,
  ResourceReservationId,
  ResourceRootId,
} from "@diffdash/persistence/resource-catalog"
import {
  DiffBlockId,
  FileDeltaIdentity,
  SnapshotBlockStore,
  StoredSnapshotId,
  type SnapshotBlockStoreOptions,
} from "@diffdash/persistence/snapshot-block-store"
import { Deferred, Effect, Fiber, Layer, Result } from "effect"

import {
  SnapshotGitRangeSource,
  SnapshotProjectAuthority,
  SnapshotRepository,
  type SnapshotRepositoryIdentity,
  SnapshotRepositorySessionId,
  snapshotRepositoryLayer,
  type SnapshotRepositoryOptions,
} from "./snapshot-repository"
import {
  SnapshotSearch,
  snapshotSearchLayer,
  type SnapshotSearchInput,
  type SnapshotSearchProvisional,
} from "./snapshot-search"
import { testReviewDescriptor } from "../test-review-descriptor"

const encoder = new TextEncoder()
const rootId = ResourceRootId.make("snapshot-search-root")
const projectId = ReviewProjectId.make("project:search")
const reviewKey = ReviewKey.make("github:fungsi/diffdash#236")
const snapshotId = ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000236")

const repositoryOptions: SnapshotRepositoryOptions = {
  maximumResponseBytes: CoreRpcPayloadBytes.make(1024 * 1024),
  maximumBlockBytes: 1024 * 1024,
  maximumLazyBlocks: 64,
  maximumLazyConcurrency: 1,
  managedQuotaBytes: 16 * 1024 * 1024,
  reservationLifetimeMs: 10_000,
  leaseLifetimeMs: 1_000,
}

const identity = (): SnapshotRepositoryIdentity => ({
  applicationInstanceId: ApplicationInstanceId.make("app:search"),
  processEpoch: CoreProcessEpoch.make("epoch:search"),
  requestId: HostRequestId.make("h:search-test"),
  projectId,
  reviewKey,
  snapshotId,
  sessionId: SnapshotRepositorySessionId.make("session:search"),
})

const input = (query: string, limit = 10): SnapshotSearchInput => ({
  identity: identity(),
  query,
  anchorFileId: null,
  direction: "next",
  cursor: null,
  limit,
})

const tempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-snapshot-search-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const storeOptions = (directory: string): SnapshotBlockStoreOptions => ({
  rootId,
  rootPath: join(directory, "managed"),
})

const makeLayer = (directory: string, maximumExcerptBytes = 48) => {
  const database = DatabaseNode.layer(join(directory, "database.sqlite"))
  const persistence = Layer.merge(
    SnapshotBlockStore.layer(storeOptions(directory)),
    ResourceCatalog.layer,
  ).pipe(Layer.provideMerge(database))
  const repositoryDependencies = Layer.mergeAll(
    persistence,
    Layer.succeed(SnapshotGitRangeSource, {
      generateFile: () => Effect.die("Unexpected lazy generation"),
    }),
    Layer.succeed(SnapshotProjectAuthority, { contains: () => Effect.succeed(true) }),
  )
  const repository = snapshotRepositoryLayer(repositoryOptions).pipe(
    Layer.provideMerge(repositoryDependencies),
  )
  return snapshotSearchLayer({ maximumPageMatches: 20, maximumExcerptBytes }).pipe(
    Layer.provideMerge(repository),
  )
}

interface FixtureFile {
  readonly path: string
  readonly blocks: ReadonlyArray<string>
}

const publishFixture = Effect.fn("SnapshotSearchTest.publishFixture")(function* (
  directory: string,
  files: ReadonlyArray<FixtureFile>,
) {
  const store = yield* SnapshotBlockStore
  const resources = yield* ResourceCatalog
  yield* Effect.promise(() => mkdir(storeOptions(directory).rootPath, { recursive: true }))
  yield* resources.registerRoot({
    id: rootId,
    path: storeOptions(directory).rootPath,
    createdAtMs: 0,
  })
  const placements = []
  const blockIds: DiffBlockId[] = []
  for (const [fileOrdinal, file] of files.entries()) {
    const lineCount = file.blocks.reduce((count, block) => count + patchLineCount(block), 0)
    const deltaId = yield* store.registerFileDelta({
      identity: FileDeltaIdentity.make({
        oldContentId: `blob:old:${fileOrdinal}`,
        newContentId: `blob:new:${fileOrdinal}`,
        oldMode: "100644",
        newMode: "100644",
        status: "modified",
        diffOptions: "--unified=3",
        diffPolicyIdentity: "canonical:v1",
        identityVersion: 1,
      }),
      hunks: [
        {
          id: `hunk:${fileOrdinal}`,
          ordinal: 0,
          fingerprint: `fingerprint:${fileOrdinal}`,
          header: `@@ -1,${lineCount} +1,${lineCount} @@`,
          oldStart: 1,
          oldLines: lineCount,
          newStart: 1,
          newLines: lineCount,
          lineCount,
        },
      ],
    })
    let firstLine = 0
    for (const [blockOrdinal, text] of file.blocks.entries()) {
      const bytes = encoder.encode(text)
      const blockId = DiffBlockId.make(`block:${fileOrdinal}:${blockOrdinal}`)
      const blockLineCount = patchLineCount(text)
      yield* store.prepareBlock({
        id: blockId,
        deltaId,
        hunkId: `hunk:${fileOrdinal}`,
        ordinal: blockOrdinal,
        firstLine,
        lineCount: blockLineCount,
        byteCount: bytes.byteLength,
        checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        reservationId: ResourceReservationId.make(`reservation:${fileOrdinal}:${blockOrdinal}`),
        nowMs: 1,
        expiresAtMs: 1_000,
        quotaBytes: 16 * 1024 * 1024,
      })
      yield* store.stageBlock(blockId, bytes)
      yield* store.promoteBlock(blockId)
      yield* store.finalizeBlock(blockId)
      blockIds.push(blockId)
      firstLine += blockLineCount
    }
    placements.push({
      ordinal: fileOrdinal,
      deltaId,
      fileId: `file:${fileOrdinal}`,
      path: file.path,
      oldPath: null,
      additions: lineCount,
      deletions: 0,
      status: "modified" as const,
      visibility: { _tag: "Visible" as const },
      patchHash: ReviewFilePatchHash.make(`file-patch:${fileOrdinal}`),
      hunkCount: file.blocks.length,
    })
  }
  yield* store.publishSnapshot({
    id: StoredSnapshotId.make(snapshotId),
    projectId,
    reviewKey,
    baseRevision: "base",
    headRevision: "head",
    semanticIdentity: "semantic:search",
    descriptor: testReviewDescriptor,
    source: {
      kind: "exactGit",
      repositoryIdentity: "repo:search",
      baseObject: "base",
      headObject: "head",
      diffPolicyIdentity: "canonical:v1",
    },
    files: placements,
    blockIds,
    checkpoints: [],
    createdAtMs: 2,
  })
  const repository = yield* SnapshotRepository
  yield* repository.openSession(identity())
})

const patchLineCount = (text: string): number => {
  const lines = text.split("\n")
  return lines.at(-1) === "" ? lines.length - 1 : lines.length
}

describe("SnapshotSearch", () => {
  it.effect("keeps broad nearly-every-line results bounded while finalizing an exact total", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      yield* Effect.gen(function* () {
        const blocks = Array.from({ length: 20 }, (_unusedBlock, block) =>
          Array.from({ length: 50 }, (_unusedLine, line) => `+needle ${block}:${line}\n`).join(""),
        )
        yield* publishFixture(directory, [{ path: "src/broad.ts", blocks }])
        const search = yield* SnapshotSearch
        const progress: SnapshotSearchProvisional[] = []
        const result = yield* search.scan(input("needle", 3), (update) =>
          Effect.sync(() => void progress.push(update)),
        )
        expect(result.totalMatches).toBe(1_000)
        expect(result.matches).toHaveLength(3)
        expect(progress).toHaveLength(20)
        expect(progress.every((update) => update.matches.length <= 3)).toBe(true)
        expect(progress.map(({ lowerBoundMatches }) => lowerBoundMatches)).toEqual(
          Array.from({ length: 20 }, (_, index) => (index + 1) * 50),
        )
        expect(
          progress.every(
            ({ nextCursor, previousCursor }) => nextCursor === null && previousCursor === null,
          ),
        ).toBe(true)
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("rotates at an anchor and navigates both directions with semantic cursors", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      yield* Effect.gen(function* () {
        yield* publishFixture(directory, [
          { path: "src/zero.ts", blocks: ["+needle zero\n"] },
          { path: "src/one.ts", blocks: ["+needle one\n"] },
          { path: "src/two.ts", blocks: ["+needle two\n"] },
        ])
        const search = yield* SnapshotSearch
        const first = yield* search.scan(
          { ...input("needle", 1), anchorFileId: ReviewFileId.make("file:1") },
          () => Effect.void,
        )
        expect(first.matches.map(({ fileId }) => fileId)).toEqual(["file:1"])
        expect(first.totalMatches).toBe(3)
        expect(first.nextCursor).not.toBeNull()
        if (first.nextCursor === null) return
        const second = yield* search.scan(
          {
            ...input("needle", 1),
            anchorFileId: ReviewFileId.make("file:1"),
            cursor: first.nextCursor,
          },
          () => Effect.void,
        )
        expect(second.matches.map(({ fileId }) => fileId)).toEqual(["file:2"])
        expect(second.previousCursor).not.toBeNull()
        if (second.previousCursor === null) return
        const backward = yield* search.scan(
          {
            ...input("needle", 1),
            anchorFileId: ReviewFileId.make("file:1"),
            direction: "previous",
            cursor: second.previousCursor,
          },
          () => Effect.void,
        )
        expect(backward.matches.map(({ fileId }) => fileId)).toEqual(["file:1"])
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("searches content only with non-overlap and UTF-16 Unicode offsets", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      yield* Effect.gen(function* () {
        yield* publishFixture(directory, [
          {
            path: "src/unicode.ts",
            blocks: ["+🙂 café 🙂\n+aaaa\n\\ needle metadata\n+Needle\n"],
          },
        ])
        const search = yield* SnapshotSearch
        const unicode = yield* search.scan(input("🙂"), () => Effect.void)
        expect(unicode.matches.map(({ start, end }) => [start, end])).toEqual([
          [0, 2],
          [8, 10],
        ])
        expect(unicode.matches.map(({ newLineNumber }) => newLineNumber)).toEqual([1, 1])
        const overlap = yield* search.scan(input("aa"), () => Effect.void)
        expect(overlap.matches.map(({ start }) => start)).toEqual([0, 2])
        const metadata = yield* search.scan(input("needle"), () => Effect.void)
        expect(metadata.totalMatches).toBe(0)
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )

  it.effect("caps each excerpt independently without splitting Unicode code points", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      yield* Effect.gen(function* () {
        yield* publishFixture(directory, [
          { path: "src/excerpt.ts", blocks: ["+🙂🙂🙂needle🙂🙂🙂\n"] },
        ])
        const search = yield* SnapshotSearch
        const result = yield* search.scan(input("needle"), () => Effect.void)
        const excerpt = result.matches[0]?.excerpt
        expect(excerpt?.utf8Bytes).toBeLessThanOrEqual(14)
        expect(excerpt?.text.slice(excerpt.start, excerpt.end)).toBe("needle")
        expect(excerpt?.omittedBefore).toBe(true)
        expect(excerpt?.omittedAfter).toBe(true)
      }).pipe(Effect.provide(makeLayer(directory, 14)))
    }),
  )

  it.effect("releases cancellation and lets a changed query supersede blocked work", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      yield* Effect.gen(function* () {
        yield* publishFixture(directory, [
          { path: "src/cancel.ts", blocks: ["+first\n", "+second\n"] },
        ])
        const search = yield* SnapshotSearch
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const first = yield* search
          .scan(input("first"), () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const replacement = yield* search.scan(input("second"), () => Effect.void)
        expect(replacement.totalMatches).toBe(1)
        yield* Deferred.succeed(release, undefined)
        expect(Result.isFailure(yield* Effect.result(Fiber.join(first)))).toBe(true)

        const cancelledEntered = yield* Deferred.make<void>()
        const cancelled = yield* search
          .scan(input("first"), () =>
            Deferred.succeed(cancelledEntered, undefined).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(cancelledEntered)
        yield* Fiber.interrupt(cancelled)
        const repository = yield* SnapshotRepository
        expect(yield* repository.closeSession(identity())).toBe(true)
      }).pipe(Effect.provide(makeLayer(directory)))
    }),
  )
})
