import { createHash, randomUUID } from "node:crypto"

import { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
import {
  ReviewFileId,
  ReviewHunkId,
  ReviewKey,
  ReviewProjectId,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import {
  ResourceCatalog,
  ResourceLeaseId,
  type CatalogResourceId,
  type CatalogResourceLease,
} from "@diffdash/persistence/resource-catalog"
import {
  SnapshotBlockStore,
  StoredSnapshotId,
  type SnapshotFilePlacement,
  type StoredHunk,
  type StoredSnapshotHeader,
  type VisibleDiffBlock,
} from "@diffdash/persistence/snapshot-block-store"
import { Clock, Context, Effect, Layer, Schema, type Scope } from "effect"

/** Maximum files returned by one operation-owned inventory read. */
export const OPERATION_SNAPSHOT_INVENTORY_LIMIT = 256

/** Durable operation identity and immutable snapshot authority. */
export const OperationSnapshotIdentity = Schema.Struct({
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  operationId: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(200)),
  ),
  projectId: ReviewProjectId,
  reviewKey: ReviewKey,
  snapshotId: ReviewSnapshotId,
})

/** Durable operation identity and immutable snapshot authority. */
export type OperationSnapshotIdentity = typeof OperationSnapshotIdentity.Type

const OperationSnapshotReaderOperation = Schema.Literals([
  "open",
  "inventory",
  "findFile",
  "findHunk",
  "readFile",
  "readHunk",
])

/** Expected rejection from the bounded operation-owned snapshot reader. */
export class OperationSnapshotReaderError extends Schema.TaggedError<OperationSnapshotReaderError>()(
  "OperationSnapshotReaderError",
  {
    operation: OperationSnapshotReaderOperation,
    reason: Schema.Literals(["identityRejected", "notFound", "rangeLimit", "sourceUnavailable"]),
    message: Schema.String,
  },
) {}

/** One bounded hunk read with canonical persisted metadata and bytes. */
export interface OperationSnapshotHunk {
  readonly file: SnapshotFilePlacement
  readonly hunk: StoredHunk
  readonly bytes: Uint8Array
}

/** One bounded targeted file read without constructing a repository-wide parsed diff. */
export interface OperationSnapshotFile {
  readonly file: SnapshotFilePlacement
  readonly hunks: ReadonlyArray<StoredHunk>
  readonly bytes: Uint8Array
}

/** Scoped immutable snapshot access owned by one durable operation. */
export interface OperationSnapshotHandle {
  readonly snapshot: StoredSnapshotHeader
  readonly inventory: (
    offset: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<SnapshotFilePlacement>, OperationSnapshotReaderError>
  readonly findFile: (
    fileId: ReviewFileId,
  ) => Effect.Effect<SnapshotFilePlacement, OperationSnapshotReaderError>
  readonly findHunk: (
    fileId: ReviewFileId,
    hunkId: ReviewHunkId,
  ) => Effect.Effect<StoredHunk, OperationSnapshotReaderError>
  readonly readFile: (
    fileId: ReviewFileId,
  ) => Effect.Effect<OperationSnapshotFile, OperationSnapshotReaderError>
  readonly readHunk: (
    fileId: ReviewFileId,
    hunkId: ReviewHunkId,
  ) => Effect.Effect<OperationSnapshotHunk, OperationSnapshotReaderError>
}

/** Runtime ownership and read bounds selected by the Core composition root. */
export interface OperationSnapshotReaderOptions {
  readonly leaseLifetimeMs: number
  readonly maximumHunkBytes: number
  readonly maximumFileBytes: number
}

/** Opens operation-owned snapshot leases without participating in foreground renderer sessions. */
export class OperationSnapshotReader extends Context.Service<
  OperationSnapshotReader,
  {
    readonly open: (
      identity: OperationSnapshotIdentity,
    ) => Effect.Effect<OperationSnapshotHandle, OperationSnapshotReaderError, Scope.Scope>
  }
>()("@diffdash/core/OperationSnapshotReader") {}

/** Builds the durable operation reader over the canonical snapshot and resource stores. */
export const operationSnapshotReaderLayer = (
  options: OperationSnapshotReaderOptions,
): Layer.Layer<OperationSnapshotReader, never, SnapshotBlockStore | ResourceCatalog> =>
  Layer.effect(
    OperationSnapshotReader,
    Effect.gen(function* () {
      const store = yield* SnapshotBlockStore
      const resources = yield* ResourceCatalog

      const reject = (
        operation: typeof OperationSnapshotReaderOperation.Type,
        reason: OperationSnapshotReaderError["reason"],
        message: string,
      ) => OperationSnapshotReaderError.make({ operation, reason, message })

      const open = Effect.fn("OperationSnapshotReader.open")(function* (
        identity: OperationSnapshotIdentity,
      ) {
        if (!Schema.is(OperationSnapshotIdentity)(identity))
          return yield* reject(
            "open",
            "identityRejected",
            "Operation snapshot identity is malformed",
          )
        const snapshot = yield* store
          .getSnapshotHeader(StoredSnapshotId.make(identity.snapshotId))
          .pipe(
            Effect.mapError(() => reject("open", "notFound", "Snapshot manifest was not found")),
          )
        if (snapshot.projectId !== identity.projectId || snapshot.reviewKey !== identity.reviewKey)
          return yield* reject(
            "open",
            "identityRejected",
            "Project, review, and snapshot identity do not describe one manifest",
          )

        if (snapshot.source.kind === "managedSpool")
          yield* acquireScopedLeases(
            resources,
            options,
            identity,
            [snapshot.source.resourceId],
            "snapshot source",
          ).pipe(
            Effect.mapError(() =>
              reject("open", "sourceUnavailable", "Could not lease the snapshot source"),
            ),
          )

        const findFile = Effect.fn("OperationSnapshotReader.findFile")(function* (
          fileId: ReviewFileId,
        ) {
          return yield* store
            .findSnapshotFile(StoredSnapshotId.make(identity.snapshotId), fileId)
            .pipe(
              Effect.mapError(() => reject("findFile", "notFound", "Snapshot file was not found")),
            )
        })

        const findHunk = Effect.fn("OperationSnapshotReader.findHunk")(function* (
          fileId: ReviewFileId,
          hunkId: ReviewHunkId,
        ) {
          const file = yield* findFile(fileId)
          return yield* store
            .findFileHunk(file.deltaId, hunkId)
            .pipe(
              Effect.mapError(() => reject("findHunk", "notFound", "Snapshot hunk was not found")),
            )
        })

        return {
          snapshot,
          inventory: Effect.fn("OperationSnapshotReader.inventory")(function* (offset, limit) {
            if (
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              !Number.isSafeInteger(limit) ||
              limit <= 0 ||
              limit > OPERATION_SNAPSHOT_INVENTORY_LIMIT
            )
              return yield* reject(
                "inventory",
                "rangeLimit",
                "Inventory query is outside its bound",
              )
            return yield* store
              .listSnapshotFiles(StoredSnapshotId.make(identity.snapshotId), offset, limit)
              .pipe(
                Effect.mapError(() =>
                  reject("inventory", "sourceUnavailable", "Could not query snapshot inventory"),
                ),
              )
          }),
          findFile,
          findHunk,
          readFile: Effect.fn("OperationSnapshotReader.readFile")(function* (fileId) {
            const file = yield* findFile(fileId)
            const blocks = yield* store
              .visibleBlocks(file.deltaId)
              .pipe(
                Effect.mapError(() =>
                  reject("readFile", "sourceUnavailable", "Could not query snapshot blocks"),
                ),
              )
            const bytes = yield* readBlocks(
              resources,
              store,
              options,
              identity,
              blocks,
              options.maximumFileBytes,
              "readFile",
              reject,
            )
            const hunkIds = [
              ...new Set(blocks.flatMap(({ hunk_id }) => (hunk_id === null ? [] : [hunk_id]))),
            ]
            const hunks = yield* Effect.forEach(hunkIds, (hunkId) =>
              store.findFileHunk(file.deltaId, hunkId),
            ).pipe(
              Effect.mapError(() =>
                reject("readFile", "sourceUnavailable", "Could not query snapshot hunks"),
              ),
            )
            return { file, hunks, bytes }
          }),
          readHunk: Effect.fn("OperationSnapshotReader.readHunk")(function* (fileId, hunkId) {
            const file = yield* findFile(fileId)
            const hunk = yield* findHunk(fileId, hunkId)
            const blocks = (yield* store
              .visibleBlocks(file.deltaId)
              .pipe(
                Effect.mapError(() =>
                  reject("readHunk", "sourceUnavailable", "Could not query snapshot blocks"),
                ),
              )).filter((block) => block.hunk_id === hunkId)
            if (blocks.length === 0)
              return yield* reject("readHunk", "notFound", "Snapshot hunk content was not found")
            const bytes = yield* readBlocks(
              resources,
              store,
              options,
              identity,
              blocks,
              options.maximumHunkBytes,
              "readHunk",
              reject,
            )
            return { file, hunk, bytes }
          }),
        }
      })

      return OperationSnapshotReader.of({ open })
    }),
  )

const readBlock = Effect.fn("OperationSnapshotReader.readBlock")(function* (
  resources: ResourceCatalog["Service"],
  store: SnapshotBlockStore["Service"],
  options: OperationSnapshotReaderOptions,
  identity: OperationSnapshotIdentity,
  block: VisibleDiffBlock,
) {
  return yield* Effect.scoped(
    acquireScopedLeases(
      resources,
      options,
      identity,
      [block.resource_id],
      `snapshot block ${block.id}`,
    ).pipe(
      Effect.andThen(store.readManagedRange(block.resource_id, 0, block.byte_count)),
      Effect.map((range) => range.bytes),
    ),
  )
})

const readBlocks = Effect.fn("OperationSnapshotReader.readBlocks")(function* (
  resources: ResourceCatalog["Service"],
  store: SnapshotBlockStore["Service"],
  options: OperationSnapshotReaderOptions,
  identity: OperationSnapshotIdentity,
  blocks: readonly VisibleDiffBlock[],
  maximumBytes: number,
  operation: "readFile" | "readHunk",
  reject: (
    operation: typeof OperationSnapshotReaderOperation.Type,
    reason: OperationSnapshotReaderError["reason"],
    message: string,
  ) => OperationSnapshotReaderError,
) {
  const byteCount = blocks.reduce((total, block) => total + block.byte_count, 0)
  if (byteCount > maximumBytes)
    return yield* reject(
      operation,
      "rangeLimit",
      `Snapshot ${operation === "readFile" ? "file" : "hunk"} exceeds its read bound`,
    )
  const parts = yield* Effect.forEach(blocks, (block) =>
    readBlock(resources, store, options, identity, block),
  ).pipe(
    Effect.mapError(() =>
      reject(operation, "sourceUnavailable", "Could not read leased snapshot blocks"),
    ),
  )
  const bytes = new Uint8Array(byteCount)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
})

const acquireScopedLeases = Effect.fn("OperationSnapshotReader.acquireScopedLeases")(function* (
  resources: ResourceCatalog["Service"],
  options: OperationSnapshotReaderOptions,
  identity: OperationSnapshotIdentity,
  resourceIds: readonly CatalogResourceId[],
  purpose: string,
) {
  const nowMs = yield* Clock.currentTimeMillis
  const leases = resourceIds.map(
    (resourceId): CatalogResourceLease => ({
      id: ResourceLeaseId.make(
        `operation:${digest(`${identity.operationId}:${resourceId}:${randomUUID()}`)}`,
      ),
      resourceId,
      ownerKind: "durableOperation",
      ownerId: identity.operationId,
      applicationInstanceId: identity.applicationInstanceId,
      processEpoch: identity.processEpoch,
      acquiredAtMs: nowMs,
      renewedAtMs: nowMs,
      expiresAtMs: nowMs + options.leaseLifetimeMs,
      purpose,
    }),
  )
  yield* Effect.acquireRelease(resources.acquireLeases(leases), () =>
    resources
      .releaseLeases({
        ids: leases.map(({ id }) => id),
        applicationInstanceId: identity.applicationInstanceId,
        processEpoch: identity.processEpoch,
      })
      .pipe(Effect.ignore),
  )
})

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
