import { createHash } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { DiffFileStatus } from "@diffdash/domain/diff"
import { type Database, makeDatabase, toError } from "./database"
import {
  CatalogResourceId,
  ResourceRecoveryToken,
  ResourceReservationId,
  ResourceRootId,
} from "./resource-catalog"

const BoundedId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
)
const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

/** Stable identity of an immutable review snapshot manifest. */
export const StoredSnapshotId = BoundedId.pipe(Schema.brand("StoredSnapshotId"))
/** Stable identity of an immutable review snapshot manifest. */
export type StoredSnapshotId = typeof StoredSnapshotId.Type

/** Stable identity of one exact changed-file pair and diff policy. */
export const FileDeltaId = BoundedId.pipe(Schema.brand("FileDeltaId"))
/** Stable identity of one exact changed-file pair and diff policy. */
export type FileDeltaId = typeof FileDeltaId.Type

/** Stable identity of one checksummed diff block. */
export const DiffBlockId = BoundedId.pipe(Schema.brand("DiffBlockId"))
/** Stable identity of one checksummed diff block. */
export type DiffBlockId = typeof DiffBlockId.Type

/** Every input that affects exact file-delta identity. Empty modes represent absent modes. */
export const FileDeltaIdentity = Schema.Struct({
  oldContentId: Schema.String,
  newContentId: Schema.String,
  oldMode: Schema.String,
  newMode: Schema.String,
  status: DiffFileStatus,
  diffOptions: Schema.String,
  diffPolicyIdentity: Schema.String,
  identityVersion: PositiveInt,
})
/** Every input that affects exact file-delta identity. */
export type FileDeltaIdentity = typeof FileDeltaIdentity.Type

/** Derives an unambiguous identity from the complete exact file-delta key. */
export const makeFileDeltaId = (identity: FileDeltaIdentity): FileDeltaId => {
  const hash = createHash("sha256")
  for (const value of [
    identity.oldContentId,
    identity.newContentId,
    identity.oldMode,
    identity.newMode,
    identity.status,
    identity.diffOptions,
    identity.diffPolicyIdentity,
    String(identity.identityVersion),
  ]) {
    hash.update(String(Buffer.byteLength(value)))
    hash.update(":")
    hash.update(value)
  }
  return FileDeltaId.make(`delta:v${identity.identityVersion}:${hash.digest("hex")}`)
}

/** Source facts retained by an immutable snapshot. */
export type SnapshotStorageSource =
  | { readonly kind: "managedSpool"; readonly resourceId: CatalogResourceId }
  | {
      readonly kind: "exactGit"
      readonly repositoryIdentity: string
      readonly baseObject: string
      readonly headObject: string
      readonly diffPolicyIdentity: string
    }

/** One snapshot-owned file ordering placement. */
export interface SnapshotFilePlacement {
  readonly ordinal: number
  readonly deltaId: FileDeltaId
  readonly fileId: string
  readonly path: string
  readonly oldPath: string | null
  readonly additions: number
  readonly deletions: number
}

/** Sparse seek metadata into a snapshot's ordered block sequence. */
export interface SnapshotCheckpoint {
  readonly ordinal: number
  readonly fileOrdinal: number
  readonly hunkOrdinal: number
  readonly blockId: DiffBlockId
  readonly byteOffset: number
  readonly lineOffset: number
}

/** Complete SQLite-authoritative snapshot manifest publication input. */
export interface PublishSnapshotInput {
  readonly id: StoredSnapshotId
  readonly reviewKey: string
  readonly baseRevision: string
  readonly headRevision: string
  readonly semanticIdentity: string
  readonly source: SnapshotStorageSource
  readonly files: ReadonlyArray<SnapshotFilePlacement>
  readonly blockIds: ReadonlyArray<DiffBlockId>
  readonly checkpoints: ReadonlyArray<SnapshotCheckpoint>
  readonly createdAtMs: number
}

/** Hunk metadata stored once with an exact shared file delta. */
export interface StoredHunkInput {
  readonly id: string
  readonly ordinal: number
  readonly fingerprint: string
  readonly header: string
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lineCount: number
}

/** Ordered canonical hunk metadata loaded without diff content bytes. */
export interface StoredHunk extends StoredHunkInput {
  readonly deltaId: FileDeltaId
}

/** Input for registering one exact file delta before blocks are written. */
export interface RegisterFileDeltaInput {
  readonly identity: FileDeltaIdentity
  readonly hunks: ReadonlyArray<StoredHunkInput>
}

/** Reserve-ahead input for one independently checksummed block file. */
export interface PrepareDiffBlockInput {
  readonly id: DiffBlockId
  readonly deltaId: FileDeltaId
  readonly hunkId: string | null
  readonly ordinal: number
  readonly firstLine: number
  readonly lineCount: number
  readonly byteCount: number
  readonly checksum: string
  readonly reservationId: ResourceReservationId
  readonly nowMs: number
  readonly expiresAtMs: number
  readonly quotaBytes: number
}

/** Parsed metadata for a transactionally visible closed block. */
export const VisibleDiffBlock = Schema.Struct({
  id: DiffBlockId,
  delta_id: FileDeltaId,
  hunk_id: Schema.NullOr(Schema.String),
  ordinal: NonNegativeInt,
  first_line: NonNegativeInt,
  line_count: PositiveInt,
  byte_count: PositiveInt,
  checksum: Schema.String,
  resource_id: CatalogResourceId,
  final_path: Schema.String,
})
/** Parsed metadata for a transactionally visible closed block. */
export type VisibleDiffBlock = typeof VisibleDiffBlock.Type

/** Result of reserving rolling output capacity. */
export type PrepareDiffBlockResult =
  | { readonly kind: "prepared"; readonly id: DiffBlockId }
  | {
      readonly kind: "quotaExceeded"
      readonly requiredBytes: number
      readonly availableBytes: number
    }

/** Resource IDs no longer reachable after one manifest deletion. */
export interface DeleteSnapshotResult {
  readonly collectibleResourceIds: ReadonlyArray<CatalogResourceId>
}

/** Parsed snapshot manifest, ordering, and sparse checkpoints loaded from SQLite. */
export interface StoredSnapshot {
  readonly id: StoredSnapshotId
  readonly reviewKey: string
  readonly baseRevision: string
  readonly headRevision: string
  readonly semanticIdentity: string
  readonly source: SnapshotStorageSource
  readonly files: ReadonlyArray<SnapshotFilePlacement>
  readonly blockIds: ReadonlyArray<DiffBlockId>
  readonly checkpoints: ReadonlyArray<SnapshotCheckpoint>
  readonly createdAtMs: number
}

/** Snapshot identity and source facts loaded without file or block collections. */
export type StoredSnapshotHeader = Omit<StoredSnapshot, "files" | "blockIds" | "checkpoints">

/** One bounded managed-file read. */
export interface ManagedRangeRead {
  readonly resourceId: CatalogResourceId
  readonly bytes: Uint8Array
  readonly offset: number
  readonly totalBytes: number
}

const SnapshotBlockStoreOperation = Schema.Literals([
  "registerFileDelta",
  "prepareBlock",
  "stageBlock",
  "promoteBlock",
  "finalizeBlock",
  "recoverWrites",
  "publishSnapshot",
  "getSnapshot",
  "getSnapshotHeader",
  "listSnapshotFiles",
  "findSnapshotFile",
  "findFileHunk",
  "visibleBlocks",
  "readManagedRange",
  "deleteSnapshot",
  "beginCollection",
  "quarantineCollection",
  "completeCollection",
  "recoverCollections",
])

/** Typed SQLite or managed-filesystem failure at the snapshot block boundary. */
export class SnapshotBlockStoreError extends Schema.TaggedError<SnapshotBlockStoreError>()(
  "SnapshotBlockStoreError",
  {
    operation: SnapshotBlockStoreOperation,
    cause: Schema.ErrorInstance(),
  },
) {}

/** Registered managed-file root selected by the Core composition boundary. */
export interface SnapshotBlockStoreOptions {
  readonly rootId: ResourceRootId
  readonly rootPath: string
}

/** SQLite authority for immutable manifests and sparse managed block files. */
export class SnapshotBlockStore extends Context.Service<
  SnapshotBlockStore,
  {
    readonly registerFileDelta: (
      input: RegisterFileDeltaInput,
    ) => Effect.Effect<FileDeltaId, SnapshotBlockStoreError>
    readonly prepareBlock: (
      input: PrepareDiffBlockInput,
    ) => Effect.Effect<PrepareDiffBlockResult, SnapshotBlockStoreError>
    readonly stageBlock: (
      id: DiffBlockId,
      bytes: Uint8Array,
    ) => Effect.Effect<void, SnapshotBlockStoreError>
    readonly promoteBlock: (id: DiffBlockId) => Effect.Effect<void, SnapshotBlockStoreError>
    readonly finalizeBlock: (id: DiffBlockId) => Effect.Effect<void, SnapshotBlockStoreError>
    readonly recoverWrites: () => Effect.Effect<void, SnapshotBlockStoreError>
    readonly publishSnapshot: (
      input: PublishSnapshotInput,
    ) => Effect.Effect<void, SnapshotBlockStoreError>
    readonly getSnapshot: (
      id: StoredSnapshotId,
    ) => Effect.Effect<StoredSnapshot, SnapshotBlockStoreError>
    readonly getSnapshotHeader: (
      id: StoredSnapshotId,
    ) => Effect.Effect<StoredSnapshotHeader, SnapshotBlockStoreError>
    readonly listSnapshotFiles: (
      id: StoredSnapshotId,
      offset: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<SnapshotFilePlacement>, SnapshotBlockStoreError>
    readonly findSnapshotFile: (
      id: StoredSnapshotId,
      fileId: string,
    ) => Effect.Effect<SnapshotFilePlacement, SnapshotBlockStoreError>
    readonly findFileHunk: (
      deltaId: FileDeltaId,
      hunkId: string,
    ) => Effect.Effect<StoredHunk, SnapshotBlockStoreError>
    readonly visibleBlocks: (
      deltaId: FileDeltaId,
    ) => Effect.Effect<ReadonlyArray<VisibleDiffBlock>, SnapshotBlockStoreError>
    readonly readManagedRange: (
      resourceId: CatalogResourceId,
      offset: number,
      length: number,
    ) => Effect.Effect<ManagedRangeRead, SnapshotBlockStoreError>
    readonly deleteSnapshot: (
      id: StoredSnapshotId,
    ) => Effect.Effect<DeleteSnapshotResult, SnapshotBlockStoreError>
    readonly beginCollection: (
      resourceId: CatalogResourceId,
      token: ResourceRecoveryToken,
      nowMs: number,
    ) => Effect.Effect<void, SnapshotBlockStoreError>
    readonly quarantineCollection: (
      resourceId: CatalogResourceId,
      token: ResourceRecoveryToken,
      nowMs: number,
    ) => Effect.Effect<void, SnapshotBlockStoreError>
    readonly completeCollection: (
      resourceId: CatalogResourceId,
      token: ResourceRecoveryToken,
      nowMs: number,
    ) => Effect.Effect<void, SnapshotBlockStoreError>
    readonly recoverCollections: (nowMs: number) => Effect.Effect<void, SnapshotBlockStoreError>
  }
>()("@diffdash/SnapshotBlockStore") {
  /** Builds the store for one pre-registered managed filesystem root. */
  static layer(options: SnapshotBlockStoreOptions) {
    return Layer.effect(
      SnapshotBlockStore,
      Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const paths = managedPaths(options)

        const getSnapshotHeader = Effect.fn("SnapshotBlockStore.getSnapshotHeader")(function* (
          id: StoredSnapshotId,
        ) {
          const rawManifest = yield* database.get(
            "SELECT * FROM review_snapshot_manifests WHERE id = ?",
            [id],
          )
          const manifest = yield* Effect.fromOption(
            rawManifest,
            () => new Error(`Missing snapshot manifest ${id}`),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SnapshotManifestRow)))
          return {
            id: manifest.id,
            reviewKey: manifest.review_key,
            baseRevision: manifest.base_revision,
            headRevision: manifest.head_revision,
            semanticIdentity: manifest.semantic_identity,
            source: decodeSource(manifest),
            createdAtMs: manifest.created_at_ms,
          }
        }, mapError("getSnapshotHeader"))

        const finalizeBlock = Effect.fn("SnapshotBlockStore.finalizeBlock")(function* (
          id: DiffBlockId,
        ) {
          const block = yield* loadPendingBlock(database, id)
          yield* verifyFile(paths.resolve(block.final_path), block.byte_count, block.checksum)
          yield* database.transaction(
            Effect.gen(function* () {
              yield* database.run(
                `UPDATE resource_reservations SET state = 'consumed', consumed_at_ms = ?
                 WHERE id = ? AND state = 'active'`,
                [block.created_at_ms, block.reservation_id],
              )
              yield* database.run(
                `UPDATE resources SET state = 'ready', bytes = ?, reserved_bytes = 0,
                   checksum = ?, validation = 'sha256', updated_at_ms = ?, last_used_at_ms = ?
                 WHERE id = ? AND state = 'writing'`,
                [
                  block.byte_count,
                  block.checksum,
                  block.created_at_ms,
                  block.created_at_ms,
                  block.resource_id,
                ],
              )
              yield* database.run(
                "UPDATE review_diff_blocks SET state = 'ready' WHERE id = ? AND state = 'pending'",
                [id],
              )
            }),
          )
        }, mapError("finalizeBlock"))

        const quarantineCollection = Effect.fn("SnapshotBlockStore.quarantineCollection")(
          function* (resourceId: CatalogResourceId, token: ResourceRecoveryToken, nowMs: number) {
            const resource = yield* loadCollectingResource(database, resourceId, token)
            if (resource.root_id !== options.rootId)
              return yield* Effect.fail(new Error("Resource belongs to another managed root"))
            if (resource.location_value !== "-") {
              const original = paths.resolve(resource.location_value)
              const quarantined = paths.quarantine(token)
              yield* attemptFile("quarantineCollection", async () => {
                await mkdir(resolve(options.rootPath, ".snapshot-trash"), {
                  recursive: true,
                  mode: 0o700,
                })
                if (await fileExists(quarantined)) {
                  if (await fileExists(original))
                    throw new Error("Both live and quarantined resources exist")
                } else if (await fileExists(original)) await rename(original, quarantined)
              })
            }
            yield* database.run(
              `UPDATE resources SET state = 'quarantined', updated_at_ms = ?
               WHERE id = ? AND state = 'collecting' AND recovery_token = ?`,
              [nowMs, resourceId, token],
            )
            return undefined
          },
          mapError("quarantineCollection"),
        )

        const completeCollection = Effect.fn("SnapshotBlockStore.completeCollection")(function* (
          resourceId: CatalogResourceId,
          token: ResourceRecoveryToken,
          nowMs: number,
        ) {
          const resource = yield* loadCollectingResource(database, resourceId, token)
          if (resource.root_id !== options.rootId)
            return yield* Effect.fail(new Error("Resource belongs to another managed root"))
          yield* attemptFile("completeCollection", () =>
            rm(paths.quarantine(token), { force: true, recursive: true }),
          )
          yield* database.transaction(
            Effect.gen(function* () {
              yield* database.run(
                `UPDATE resources SET state = 'deleted', bytes = 0, reserved_bytes = 0,
                   recovery_token = NULL, failure = NULL, retry_at_ms = NULL, updated_at_ms = ?
                 WHERE id = ? AND state IN ('quarantined', 'collecting', 'deletionFailed')
                   AND recovery_token = ?`,
                [nowMs, resourceId, token],
              )
              yield* database.run("DELETE FROM review_diff_blocks WHERE resource_id = ?", [
                resourceId,
              ])
              yield* database.run(
                `DELETE FROM review_file_deltas
                 WHERE NOT EXISTS (
                   SELECT 1 FROM review_snapshot_files WHERE delta_id = review_file_deltas.id
                 ) AND NOT EXISTS (
                   SELECT 1 FROM review_diff_blocks WHERE delta_id = review_file_deltas.id
                 )`,
              )
            }),
          )
          return undefined
        }, mapError("completeCollection"))

        return SnapshotBlockStore.of({
          registerFileDelta: Effect.fn("SnapshotBlockStore.registerFileDelta")(function* (input) {
            const id = makeFileDeltaId(input.identity)
            yield* database.transaction(
              Effect.gen(function* () {
                yield* database.run(
                  `INSERT INTO review_file_deltas (
                    id, old_content_id, new_content_id, old_mode, new_mode, status,
                    diff_options, diff_policy_identity, identity_version
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO NOTHING`,
                  [
                    id,
                    input.identity.oldContentId,
                    input.identity.newContentId,
                    input.identity.oldMode,
                    input.identity.newMode,
                    input.identity.status,
                    input.identity.diffOptions,
                    input.identity.diffPolicyIdentity,
                    input.identity.identityVersion,
                  ],
                )
                for (const hunk of input.hunks) {
                  yield* database.run(
                    `INSERT INTO review_hunks (
                      id, delta_id, ordinal, fingerprint, header, old_start, old_lines,
                      new_start, new_lines, line_count
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(delta_id, id) DO NOTHING`,
                    [
                      hunk.id,
                      id,
                      hunk.ordinal,
                      hunk.fingerprint,
                      hunk.header,
                      hunk.oldStart,
                      hunk.oldLines,
                      hunk.newStart,
                      hunk.newLines,
                      hunk.lineCount,
                    ],
                  )
                }
              }),
            )
            return id
          }, mapError("registerFileDelta")),

          prepareBlock: Effect.fn("SnapshotBlockStore.prepareBlock")(function* (input) {
            const resourceId = blockResourceId(input.id)
            const pathKey = createHash("sha256").update(input.id).digest("hex")
            const temporaryPath = `.snapshot-staging/${pathKey}.partial`
            const finalPath = `snapshot-blocks/${pathKey}.block`
            return yield* database.transaction(
              Effect.gen(function* () {
                const usage = yield* database.get(
                  `SELECT COALESCE(SUM(bytes + reserved_bytes), 0) AS usage
                   FROM resources WHERE policy_class <> 'durableUserData' AND state <> 'deleted'`,
                )
                const used =
                  Option.isSome(usage) && Predicate.isNumber(usage.value.usage)
                    ? usage.value.usage
                    : 0
                const availableBytes = Math.max(0, input.quotaBytes - used)
                if (input.byteCount > availableBytes)
                  return {
                    kind: "quotaExceeded",
                    requiredBytes: input.byteCount,
                    availableBytes,
                  } as const
                yield* database.run(
                  `INSERT INTO resources (
                    id, parent_id, kind, policy_class, state, generation, location_kind, root_id,
                    location_value, bytes, reserved_bytes, created_at_ms, updated_at_ms,
                    last_used_at_ms, checksum, validation
                  ) VALUES (?, NULL, 'snapshot-block', 'cache', 'writing', 1, 'filesystem', ?, ?,
                    0, ?, ?, ?, ?, ?, 'sha256')`,
                  [
                    resourceId,
                    options.rootId,
                    finalPath,
                    input.byteCount,
                    input.nowMs,
                    input.nowMs,
                    input.nowMs,
                    input.checksum,
                  ],
                )
                yield* database.run(
                  `INSERT INTO resource_reservations
                   (id, resource_id, bytes, state, created_at_ms, expires_at_ms)
                   VALUES (?, ?, ?, 'active', ?, ?)`,
                  [
                    input.reservationId,
                    resourceId,
                    input.byteCount,
                    input.nowMs,
                    input.expiresAtMs,
                  ],
                )
                yield* database.run(
                  `INSERT INTO review_diff_blocks (
                    id, delta_id, hunk_id, ordinal, first_line, line_count, byte_count, checksum,
                    resource_id, reservation_id, temporary_path, final_path, state, created_at_ms
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
                  [
                    input.id,
                    input.deltaId,
                    input.hunkId,
                    input.ordinal,
                    input.firstLine,
                    input.lineCount,
                    input.byteCount,
                    input.checksum,
                    resourceId,
                    input.reservationId,
                    temporaryPath,
                    finalPath,
                    input.nowMs,
                  ],
                )
                return { kind: "prepared", id: input.id } as const
              }),
            )
          }, mapError("prepareBlock")),

          stageBlock: Effect.fn("SnapshotBlockStore.stageBlock")(function* (id, bytes) {
            const block = yield* loadPendingBlock(database, id)
            if (bytes.byteLength !== block.byte_count || sha256(bytes) !== block.checksum)
              return yield* Effect.fail(
                new Error("Block bytes do not match reserved size and checksum"),
              )
            const temporary = paths.resolve(block.temporary_path)
            yield* attemptFile("stageBlock", async () => {
              await mkdir(resolve(temporary, ".."), { recursive: true, mode: 0o700 })
              if (await fileExists(temporary)) {
                await verifyFilePromise(temporary, block.byte_count, block.checksum)
                return
              }
              const descriptor = await open(temporary, "wx", 0o600)
              try {
                await descriptor.writeFile(bytes)
                await descriptor.sync()
              } finally {
                await descriptor.close()
              }
            })
            return undefined
          }, mapError("stageBlock")),

          promoteBlock: Effect.fn("SnapshotBlockStore.promoteBlock")(function* (id) {
            const block = yield* loadPendingBlock(database, id)
            const temporary = paths.resolve(block.temporary_path)
            const final = paths.resolve(block.final_path)
            yield* attemptFile("promoteBlock", async () => {
              await mkdir(resolve(final, ".."), { recursive: true, mode: 0o700 })
              if (await fileExists(final)) {
                await verifyFilePromise(final, block.byte_count, block.checksum)
                return
              }
              await rename(temporary, final)
            })
          }, mapError("promoteBlock")),

          finalizeBlock,

          recoverWrites: Effect.fn("SnapshotBlockStore.recoverWrites")(function* () {
            const rows = yield* Schema.decodeUnknownEffect(Schema.Array(PendingBlockRow))(
              yield* database.all(
                "SELECT * FROM review_diff_blocks WHERE state = 'pending' ORDER BY id",
              ),
            )
            for (const block of rows) {
              const final = paths.resolve(block.final_path)
              const temporary = paths.resolve(block.temporary_path)
              if (yield* awaitFileExists(final)) {
                yield* finalizeBlock(block.id)
              } else if (yield* awaitFileExists(temporary)) {
                yield* attemptFile("recoverWrites", async () => {
                  await mkdir(resolve(final, ".."), { recursive: true, mode: 0o700 })
                  await verifyFilePromise(temporary, block.byte_count, block.checksum)
                  await rename(temporary, final)
                })
                yield* finalizeBlock(block.id)
              } else {
                yield* database.transaction(
                  Effect.gen(function* () {
                    yield* database.run("DELETE FROM review_diff_blocks WHERE id = ?", [block.id])
                    yield* database.run("DELETE FROM resources WHERE id = ?", [block.resource_id])
                  }),
                )
              }
            }
          }, mapError("recoverWrites")),

          publishSnapshot: Effect.fn("SnapshotBlockStore.publishSnapshot")(function* (input) {
            yield* database.transaction(
              Effect.gen(function* () {
                const source = sourceColumns(input.source)
                yield* database.run(
                  `INSERT INTO review_snapshot_manifests (
                    id, review_key, base_revision, head_revision, semantic_identity, source_kind,
                    spool_resource_id, repository_identity, base_object, head_object,
                    diff_policy_identity, created_at_ms
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    input.id,
                    input.reviewKey,
                    input.baseRevision,
                    input.headRevision,
                    input.semanticIdentity,
                    source.kind,
                    source.spoolResourceId,
                    source.repositoryIdentity,
                    source.baseObject,
                    source.headObject,
                    source.diffPolicyIdentity,
                    input.createdAtMs,
                  ],
                )
                for (const file of input.files)
                  yield* database.run(
                    `INSERT INTO review_snapshot_files (
                      snapshot_id, ordinal, delta_id, file_id, path, old_path, additions, deletions
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                      input.id,
                      file.ordinal,
                      file.deltaId,
                      file.fileId,
                      file.path,
                      file.oldPath,
                      file.additions,
                      file.deletions,
                    ],
                  )
                for (const [ordinal, blockId] of input.blockIds.entries())
                  yield* database.run(
                    `INSERT INTO review_block_placements (snapshot_id, ordinal, block_id)
                     SELECT ?, ?, id FROM review_diff_blocks
                     WHERE id = ? AND state = 'ready' AND delta_id IN (
                       SELECT delta_id FROM review_snapshot_files WHERE snapshot_id = ?
                     )`,
                    [input.id, ordinal, blockId, input.id],
                  )
                const count = yield* database.get(
                  "SELECT COUNT(*) AS count FROM review_block_placements WHERE snapshot_id = ?",
                  [input.id],
                )
                if (!Option.isSome(count) || count.value.count !== input.blockIds.length)
                  return yield* Effect.fail(
                    new Error(
                      "Snapshot references a block that is not ready or not in its file set",
                    ),
                  )
                for (const checkpoint of input.checkpoints)
                  yield* database.run(
                    `INSERT INTO review_snapshot_checkpoints (
                      snapshot_id, ordinal, file_ordinal, hunk_ordinal, block_id,
                      byte_offset, line_offset
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                      input.id,
                      checkpoint.ordinal,
                      checkpoint.fileOrdinal,
                      checkpoint.hunkOrdinal,
                      checkpoint.blockId,
                      checkpoint.byteOffset,
                      checkpoint.lineOffset,
                    ],
                  )
                return undefined
              }),
            )
            return undefined
          }, mapError("publishSnapshot")),

          getSnapshot: Effect.fn("SnapshotBlockStore.getSnapshot")(function* (id) {
            const manifest = yield* getSnapshotHeader(id)
            const files = yield* Schema.decodeUnknownEffect(Schema.Array(SnapshotFileRow))(
              yield* database.all(
                "SELECT * FROM review_snapshot_files WHERE snapshot_id = ? ORDER BY ordinal",
                [id],
              ),
            )
            const placements = yield* Schema.decodeUnknownEffect(Schema.Array(BlockPlacementRow))(
              yield* database.all(
                "SELECT block_id FROM review_block_placements WHERE snapshot_id = ? ORDER BY ordinal",
                [id],
              ),
            )
            const checkpoints = yield* Schema.decodeUnknownEffect(Schema.Array(CheckpointRow))(
              yield* database.all(
                "SELECT * FROM review_snapshot_checkpoints WHERE snapshot_id = ? ORDER BY ordinal",
                [id],
              ),
            )
            return {
              ...manifest,
              files: files.map((file) => ({
                ordinal: file.ordinal,
                deltaId: file.delta_id,
                fileId: file.file_id,
                path: file.path,
                oldPath: file.old_path,
                additions: file.additions,
                deletions: file.deletions,
              })),
              blockIds: placements.map(({ block_id }) => block_id),
              checkpoints: checkpoints.map((checkpoint) => ({
                ordinal: checkpoint.ordinal,
                fileOrdinal: checkpoint.file_ordinal,
                hunkOrdinal: checkpoint.hunk_ordinal,
                blockId: checkpoint.block_id,
                byteOffset: checkpoint.byte_offset,
                lineOffset: checkpoint.line_offset,
              })),
            }
          }, mapError("getSnapshot")),

          getSnapshotHeader,

          listSnapshotFiles: Effect.fn("SnapshotBlockStore.listSnapshotFiles")(function* (
            id,
            offset,
            limit,
          ) {
            const files = yield* Schema.decodeUnknownEffect(Schema.Array(SnapshotFileRow))(
              yield* database.all(
                `SELECT * FROM review_snapshot_files
                 WHERE snapshot_id = ? ORDER BY ordinal LIMIT ? OFFSET ?`,
                [id, limit, offset],
              ),
            )
            return files.map(toSnapshotFilePlacement)
          }, mapError("listSnapshotFiles")),

          findSnapshotFile: Effect.fn("SnapshotBlockStore.findSnapshotFile")(function* (
            id,
            fileId,
          ) {
            const row = yield* database.get(
              "SELECT * FROM review_snapshot_files WHERE snapshot_id = ? AND file_id = ?",
              [id, fileId],
            )
            const file = yield* Effect.fromOption(
              row,
              () => new Error(`Missing snapshot file ${fileId}`),
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SnapshotFileRow)))
            return toSnapshotFilePlacement(file)
          }, mapError("findSnapshotFile")),

          findFileHunk: Effect.fn("SnapshotBlockStore.findFileHunk")(function* (deltaId, hunkId) {
            const row = yield* database.get(
              "SELECT * FROM review_hunks WHERE delta_id = ? AND id = ?",
              [deltaId, hunkId],
            )
            const hunk = yield* Effect.fromOption(
              row,
              () => new Error(`Missing file hunk ${hunkId}`),
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(StoredHunkRow)))
            return {
              deltaId: hunk.delta_id,
              id: hunk.id,
              ordinal: hunk.ordinal,
              fingerprint: hunk.fingerprint,
              header: hunk.header,
              oldStart: hunk.old_start,
              oldLines: hunk.old_lines,
              newStart: hunk.new_start,
              newLines: hunk.new_lines,
              lineCount: hunk.line_count,
            }
          }, mapError("findFileHunk")),

          visibleBlocks: Effect.fn("SnapshotBlockStore.visibleBlocks")(function* (deltaId) {
            return yield* Schema.decodeUnknownEffect(Schema.Array(VisibleDiffBlock))(
              yield* database.all(
                `SELECT block.id, block.delta_id, block.hunk_id, block.ordinal, block.first_line,
                    block.line_count, block.byte_count, block.checksum, block.resource_id,
                    block.final_path
                 FROM review_diff_blocks AS block
                 INNER JOIN resources AS resource ON resource.id = block.resource_id
                 WHERE block.delta_id = ? AND block.state = 'ready' AND resource.state = 'ready'
                 ORDER BY block.ordinal`,
                [deltaId],
              ),
            )
          }, mapError("visibleBlocks")),

          readManagedRange: Effect.fn("SnapshotBlockStore.readManagedRange")(function* (
            resourceId,
            offset,
            length,
          ) {
            if (
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              !Number.isSafeInteger(length) ||
              length <= 0
            )
              return yield* Effect.fail(new Error("Managed range bounds are invalid"))
            const row = yield* database.get(
              `SELECT resource.id, resource.bytes, resource.location_value, resource.root_id
               FROM resources AS resource
               WHERE resource.id = ? AND resource.state = 'ready'
                 AND resource.location_kind = 'filesystem'`,
              [resourceId],
            )
            const resource = yield* Effect.fromOption(
              row,
              () => new Error(`Missing ready managed resource ${resourceId}`),
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ManagedResourceRow)))
            if (resource.root_id !== options.rootId)
              return yield* Effect.fail(new Error("Managed resource belongs to another root"))
            const readLength = Math.min(length, Math.max(0, resource.bytes - offset))
            const bytes = new Uint8Array(readLength)
            if (readLength > 0) {
              const descriptor = yield* attemptFile("readManagedRange", () =>
                open(paths.resolve(resource.location_value), "r"),
              )
              yield* Effect.acquireUseRelease(
                Effect.succeed(descriptor),
                (handle) =>
                  attemptFile("readManagedRange", async () => {
                    const result = await handle.read(bytes, 0, readLength, offset)
                    if (result.bytesRead !== readLength)
                      throw new Error("Managed range ended early")
                  }),
                (handle) => Effect.promise(() => handle.close()),
              )
            }
            return { resourceId, bytes, offset, totalBytes: resource.bytes }
          }, mapError("readManagedRange")),

          deleteSnapshot: Effect.fn("SnapshotBlockStore.deleteSnapshot")(function* (id) {
            return yield* database.transaction(
              Effect.gen(function* () {
                const candidates = yield* database.all(
                  `SELECT resource_id FROM review_diff_blocks WHERE id IN (
                     SELECT block_id FROM review_block_placements WHERE snapshot_id = ?
                   )
                   UNION
                   SELECT spool_resource_id AS resource_id FROM review_snapshot_manifests
                   WHERE id = ? AND spool_resource_id IS NOT NULL`,
                  [id, id],
                )
                yield* database.run("DELETE FROM review_snapshot_manifests WHERE id = ?", [id])
                const collectible: Array<CatalogResourceId> = []
                for (const candidate of candidates) {
                  if (!Predicate.isString(candidate.resource_id)) continue
                  const reachable = yield* resourceIsReachable(database, candidate.resource_id)
                  if (!reachable) collectible.push(CatalogResourceId.make(candidate.resource_id))
                }
                return { collectibleResourceIds: collectible }
              }),
            )
          }, mapError("deleteSnapshot")),

          beginCollection: Effect.fn("SnapshotBlockStore.beginCollection")(function* (
            resourceId,
            token,
            nowMs,
          ) {
            if (yield* resourceIsReachable(database, resourceId))
              return yield* Effect.fail(
                new Error("Resource remains reachable from a snapshot manifest"),
              )
            yield* database.run(
              `UPDATE resources SET state = 'collecting', recovery_token = ?, updated_at_ms = ?
               WHERE id = ? AND state IN ('ready', 'deletionFailed')
                 AND policy_class <> 'durableUserData'
                 AND NOT EXISTS (
                   SELECT 1 FROM resource_leases
                   WHERE resource_id = ? AND expires_at_ms > ?
                 )`,
              [token, nowMs, resourceId, resourceId, nowMs],
            )
            yield* loadCollectingResource(database, resourceId, token)
            return undefined
          }, mapError("beginCollection")),

          quarantineCollection,
          completeCollection,

          recoverCollections: Effect.fn("SnapshotBlockStore.recoverCollections")(function* (nowMs) {
            const resources = yield* Schema.decodeUnknownEffect(Schema.Array(CollectionRow))(
              yield* database.all(
                `SELECT id, state, recovery_token, location_kind, root_id, location_value
                 FROM resources
                 WHERE kind IN ('snapshot-block', 'snapshot-spool')
                   AND state IN ('collecting', 'quarantined', 'deletionFailed')
                 ORDER BY id`,
              ),
            )
            for (const resource of resources) {
              const token = resource.recovery_token
              if (token === null) continue
              if (resource.state !== "quarantined")
                yield* quarantineCollection(resource.id, token, nowMs)
              yield* completeCollection(resource.id, token, nowMs)
            }
          }, mapError("recoverCollections")),
        })
      }),
    )
  }
}

const PendingBlockRow = Schema.Struct({
  id: DiffBlockId,
  delta_id: FileDeltaId,
  hunk_id: Schema.NullOr(Schema.String),
  ordinal: NonNegativeInt,
  first_line: NonNegativeInt,
  line_count: PositiveInt,
  byte_count: PositiveInt,
  checksum: Schema.String,
  resource_id: CatalogResourceId,
  reservation_id: ResourceReservationId,
  temporary_path: Schema.String,
  final_path: Schema.String,
  state: Schema.Literal("pending"),
  created_at_ms: NonNegativeInt,
})

const CollectionRow = Schema.Struct({
  id: CatalogResourceId,
  state: Schema.Literals(["collecting", "quarantined", "deletionFailed"]),
  recovery_token: Schema.NullOr(ResourceRecoveryToken),
  location_kind: Schema.String,
  root_id: Schema.NullOr(ResourceRootId),
  location_value: Schema.String,
})

const SnapshotManifestRow = Schema.Struct({
  id: StoredSnapshotId,
  review_key: Schema.String,
  base_revision: Schema.String,
  head_revision: Schema.String,
  semantic_identity: Schema.String,
  source_kind: Schema.Literals(["managedSpool", "exactGit"]),
  spool_resource_id: Schema.NullOr(CatalogResourceId),
  repository_identity: Schema.NullOr(Schema.String),
  base_object: Schema.NullOr(Schema.String),
  head_object: Schema.NullOr(Schema.String),
  diff_policy_identity: Schema.NullOr(Schema.String),
  created_at_ms: NonNegativeInt,
})

const SnapshotFileRow = Schema.Struct({
  snapshot_id: StoredSnapshotId,
  ordinal: NonNegativeInt,
  delta_id: FileDeltaId,
  file_id: Schema.String,
  path: Schema.String,
  old_path: Schema.NullOr(Schema.String),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
})

const StoredHunkRow = Schema.Struct({
  id: Schema.String,
  delta_id: FileDeltaId,
  ordinal: NonNegativeInt,
  fingerprint: Schema.String,
  header: Schema.String,
  old_start: NonNegativeInt,
  old_lines: NonNegativeInt,
  new_start: NonNegativeInt,
  new_lines: NonNegativeInt,
  line_count: PositiveInt,
})

const ManagedResourceRow = Schema.Struct({
  id: CatalogResourceId,
  bytes: NonNegativeInt,
  location_value: Schema.String,
  root_id: Schema.NullOr(ResourceRootId),
})

const BlockPlacementRow = Schema.Struct({ block_id: DiffBlockId })

const CheckpointRow = Schema.Struct({
  snapshot_id: StoredSnapshotId,
  ordinal: NonNegativeInt,
  file_ordinal: NonNegativeInt,
  hunk_ordinal: NonNegativeInt,
  block_id: DiffBlockId,
  byte_offset: NonNegativeInt,
  line_offset: NonNegativeInt,
})

const toSnapshotFilePlacement = (file: typeof SnapshotFileRow.Type): SnapshotFilePlacement => ({
  ordinal: file.ordinal,
  deltaId: file.delta_id,
  fileId: file.file_id,
  path: file.path,
  oldPath: file.old_path,
  additions: file.additions,
  deletions: file.deletions,
})

const loadPendingBlock = Effect.fn("SnapshotBlockStore.loadPendingBlock")(function* (
  database: Database,
  id: DiffBlockId,
) {
  const row = yield* database.get("SELECT * FROM review_diff_blocks WHERE id = ?", [id])
  return yield* Effect.fromOption(row, () => new Error(`Missing pending block ${id}`)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PendingBlockRow)),
  )
})

const loadCollectingResource = Effect.fn("SnapshotBlockStore.loadCollectingResource")(function* (
  database: Database,
  resourceId: CatalogResourceId,
  token: ResourceRecoveryToken,
) {
  const row = yield* database.get(
    `SELECT id, state, recovery_token, location_kind, root_id, location_value FROM resources
     WHERE id = ? AND state IN ('collecting', 'quarantined', 'deletionFailed')
       AND recovery_token = ?`,
    [resourceId, token],
  )
  const resource = yield* Effect.fromOption(
    row,
    () => new Error("Collection token does not own an unreachable resource"),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CollectionRow)))
  if (resource.location_kind !== "filesystem")
    return yield* Effect.fail(new Error("Snapshot block collection requires a filesystem resource"))
  return resource
})

const resourceIsReachable = Effect.fn("SnapshotBlockStore.resourceIsReachable")(function* (
  database: Database,
  resourceId: string,
) {
  const row = yield* database.get(
    `SELECT 1 AS reachable
     WHERE EXISTS (
       SELECT 1 FROM review_snapshot_manifests WHERE spool_resource_id = ?
     ) OR EXISTS (
       SELECT 1 FROM review_block_placements AS placement
       INNER JOIN review_diff_blocks AS block ON block.id = placement.block_id
       WHERE block.resource_id = ?
     )`,
    [resourceId, resourceId],
  )
  return Option.isSome(row)
})

const sourceColumns = (source: SnapshotStorageSource) =>
  source.kind === "managedSpool"
    ? {
        kind: source.kind,
        spoolResourceId: source.resourceId,
        repositoryIdentity: null,
        baseObject: null,
        headObject: null,
        diffPolicyIdentity: null,
      }
    : {
        kind: source.kind,
        spoolResourceId: null,
        repositoryIdentity: source.repositoryIdentity,
        baseObject: source.baseObject,
        headObject: source.headObject,
        diffPolicyIdentity: source.diffPolicyIdentity,
      }

const decodeSource = (row: typeof SnapshotManifestRow.Type): SnapshotStorageSource => {
  if (row.source_kind === "managedSpool") {
    if (row.spool_resource_id === null) throw new Error("Managed-spool manifest lost its resource")
    return { kind: "managedSpool", resourceId: row.spool_resource_id }
  }
  if (
    row.repository_identity === null ||
    row.base_object === null ||
    row.head_object === null ||
    row.diff_policy_identity === null
  )
    throw new Error("Exact-Git manifest lost materialization metadata")
  return {
    kind: "exactGit",
    repositoryIdentity: row.repository_identity,
    baseObject: row.base_object,
    headObject: row.head_object,
    diffPolicyIdentity: row.diff_policy_identity,
  }
}

const blockResourceId = (id: DiffBlockId): CatalogResourceId =>
  CatalogResourceId.make(`snapshot-block:${createHash("sha256").update(id).digest("hex")}`)

const managedPaths = (options: SnapshotBlockStoreOptions) => {
  const root = resolve(options.rootPath)
  const contained = (path: string) => {
    if (isAbsolute(path)) throw new Error("Managed snapshot path must be relative")
    const candidate = resolve(root, path)
    const child = relative(root, candidate)
    if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
      throw new Error("Managed snapshot path escapes its registered root")
    return candidate
  }
  return {
    resolve: contained,
    quarantine: (token: ResourceRecoveryToken) =>
      contained(`.snapshot-trash/${createHash("sha256").update(token).digest("hex")}`),
  }
}

const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`

const verifyFile = (path: string, bytes: number, checksum: string) =>
  Effect.tryPromise({
    try: () => verifyFilePromise(path, bytes, checksum),
    catch: toError,
  })

const verifyFilePromise = async (path: string, bytes: number, checksum: string): Promise<void> => {
  const info = await stat(path)
  if (!info.isFile() || info.size !== bytes)
    throw new Error("Managed block size does not match metadata")
  if (sha256(await readFile(path)) !== checksum)
    throw new Error("Managed block checksum does not match metadata")
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch (cause) {
    if (Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(cause)) return false
    throw cause
  }
}

const awaitFileExists = (path: string) =>
  Effect.tryPromise({ try: () => fileExists(path), catch: toError })

const attemptFile = <A>(
  operation: typeof SnapshotBlockStoreOperation.Type,
  attempt: () => Promise<A>,
): Effect.Effect<A, SnapshotBlockStoreError> =>
  Effect.tryPromise({
    try: attempt,
    catch: (cause) => SnapshotBlockStoreError.make({ operation, cause: toError(cause) }),
  })

const mapError =
  (operation: typeof SnapshotBlockStoreOperation.Type) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, SnapshotBlockStoreError, R> =>
    effect.pipe(
      Effect.mapError((cause) =>
        Schema.is(SnapshotBlockStoreError)(cause)
          ? cause
          : SnapshotBlockStoreError.make({ operation, cause: toError(cause) }),
      ),
    )
