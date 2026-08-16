import { createHash } from "node:crypto"

import type {
  ReviewDiffAcquisition,
  ReviewDiffSource,
  ReviewDiffSourceError,
} from "@diffdash/git-provider"
import { reviewDiffStorageRequirement } from "@diffdash/git-provider"
import { ParsedDiffFile, type DiffFileVisibility } from "@diffdash/domain/diff"
import type { ReviewDescriptor } from "@diffdash/domain/review-context"
import {
  DiffBlockId,
  type FileDeltaId,
  type FileDeltaIdentity,
  makeFileDeltaId,
  SnapshotBlockStore,
  type SnapshotBlockStoreError,
  type SnapshotCheckpoint,
  type SnapshotFilePlacement,
  type SnapshotStorageSource,
  StoredSnapshotId,
} from "@diffdash/persistence/snapshot-block-store"
import { ResourceReservationId } from "@diffdash/persistence/resource-catalog"
import {
  type ClosedDiffFile,
  type IncrementalDiffBatch,
  type IncrementalDiffEvent,
  isBoundedIncrementalDiffBatch,
  type ReviewDataWorkerFailure,
} from "@diffdash/review-data-worker"
import {
  ReviewFilePatchHash,
  type ReviewDiffIdentity,
  type ReviewKey,
  type ReviewProjectId,
  type ReviewRevision,
  type ReviewSnapshotId,
  makeReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import { Clock, Context, Effect, Exit, Layer, Match, Schema } from "effect"

import {
  CoreReviewDataWorker,
  CoreReviewDataWorkerBatchError,
} from "./review-data-worker-coordinator"

const encoder = new TextEncoder()

/** Default hard bound for one complete persisted hunk block. */
export const CORE_SNAPSHOT_MAX_BLOCK_BYTES = 512 * 1024

/** Exact source-derived key required before a file's first hunk can be persisted. */
export interface CoreSnapshotFileDeltaKeySource {
  /** Resolves every exact content, mode, policy, option, status, and version input for one file. */
  readonly resolve: (file: {
    readonly ordinal: number
    readonly gitOldPath: string
    readonly gitNewPath: string
  }) => Effect.Effect<FileDeltaIdentity, CoreSnapshotIngestionError>
}

/** Immutable snapshot identity and project ownership supplied by an acquisition handler. */
export interface CoreSnapshotManifestIdentity {
  readonly projectId: ReviewProjectId
  readonly snapshotId: ReviewSnapshotId
  readonly reviewKey: ReviewKey
  readonly baseRevision: ReviewRevision
  readonly headRevision: ReviewRevision
  readonly semanticIdentity: ReviewDiffIdentity
  readonly descriptor: ReviewDescriptor
  readonly storageSource: SnapshotStorageSource
}

/** Input needed to stream one validated review source into immutable snapshot storage. */
export interface CoreSnapshotIngestionInput {
  readonly source: ReviewDiffSource
  readonly acquisition: ReviewDiffAcquisition
  readonly manifest: CoreSnapshotManifestIdentity
  readonly fileDeltaKeys: CoreSnapshotFileDeltaKeySource
}

/** Lightweight file inventory produced without retaining finalized hunk line arrays. */
export interface CoreSnapshotIngestedFile extends SnapshotFilePlacement {
  readonly patchHash: ReviewFilePatchHash
  readonly reviewKey: ReviewKey
  readonly status: ClosedDiffFile["status"]
  readonly visibility: DiffFileVisibility
  readonly hunkCount: number
}

/** Published snapshot identity and file inventory returned to acquisition handlers. */
export interface CoreSnapshotIngestionResult {
  readonly projectId: ReviewProjectId
  readonly snapshotId: ReviewSnapshotId
  readonly reviewKey: ReviewKey
  readonly files: ReadonlyArray<CoreSnapshotIngestedFile>
}

/** Invalid stream state, inconsistent exact identity, oversized indivisible content, or quota. */
export class CoreSnapshotIngestionError extends Schema.TaggedError<CoreSnapshotIngestionError>()(
  "CoreSnapshotIngestionError",
  {
    reason: Schema.Literals([
      "identityMismatch",
      "invalidEventOrder",
      "hunkTooLarge",
      "quotaExceeded",
      "verificationFailed",
    ]),
    message: Schema.String,
  },
) {}

/** Expected failures while consuming, storing, verifying, or publishing a snapshot. */
export type CoreSnapshotIngestionFailure =
  | CoreSnapshotIngestionError
  | CoreReviewDataWorkerBatchError
  | ReviewDataWorkerFailure
  | ReviewDiffSourceError
  | SnapshotBlockStoreError

/** Bounds and reserve-ahead policy selected by the Core composition root. */
export interface CoreSnapshotIngestionOptions {
  /** Total managed cache quota considered by each reserve-ahead block write. */
  readonly managedQuotaBytes: number
  /** Time allowed for one block reservation before startup recovery may reclaim it. */
  readonly reservationLifetimeMs: number
  /** Optional tighter durable block bound; values above the hard limit are clamped. */
  readonly maximumBlockBytes?: number
}

/** Core authority for incremental review-source ingestion and final snapshot publication. */
export class CoreSnapshotIngestion extends Context.Service<
  CoreSnapshotIngestion,
  {
    /** Consumes one source generation and returns only after immutable publication succeeds. */
    readonly ingest: (
      input: CoreSnapshotIngestionInput,
    ) => Effect.Effect<CoreSnapshotIngestionResult, CoreSnapshotIngestionFailure>
  }
>()("@diffdash/core/CoreSnapshotIngestion") {}

/** Builds snapshot ingestion while leaving worker and persistence implementations visible. */
export const coreSnapshotIngestionLayer = (
  options: CoreSnapshotIngestionOptions,
): Layer.Layer<CoreSnapshotIngestion, never, CoreReviewDataWorker | SnapshotBlockStore> =>
  Layer.effect(
    CoreSnapshotIngestion,
    Effect.gen(function* () {
      const worker = yield* CoreReviewDataWorker
      const store = yield* SnapshotBlockStore
      const maximumBlockBytes = Math.min(
        options.maximumBlockBytes ?? CORE_SNAPSHOT_MAX_BLOCK_BYTES,
        CORE_SNAPSHOT_MAX_BLOCK_BYTES,
      )

      const ingest = Effect.fn("CoreSnapshotIngestion.ingest")(function* (
        input: CoreSnapshotIngestionInput,
      ) {
        const state = new IngestionState(input.manifest.reviewKey, maximumBlockBytes)
        let batchFailure:
          | CoreSnapshotIngestionError
          | CoreReviewDataWorkerBatchError
          | SnapshotBlockStoreError
          | null = null

        const processing = worker
          .process(input.source, input.acquisition, (batch) =>
            batchFailure === null
              ? consumeBatch(store, input, state, batch, options).pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => {
                      batchFailure = error
                      throw new Error("Snapshot batch ingestion failed")
                    }),
                  ),
                )
              : Effect.void,
          )
          .pipe(Effect.scoped)

        const workflow = Effect.gen(function* () {
          yield* validateManifestIdentity(input)
          const processingExit = yield* Effect.exit(processing)
          if (batchFailure !== null) return yield* Effect.fail(batchFailure)
          if (Exit.isFailure(processingExit)) return yield* Effect.failCause(processingExit.cause)
          const publication = yield* state.finish()
          yield* verifyReadyBlocks(store, publication.blocks)
          const nowMs = yield* Clock.currentTimeMillis
          yield* store.publishSnapshot({
            id: StoredSnapshotId.make(input.manifest.snapshotId),
            projectId: input.manifest.projectId,
            reviewKey: input.manifest.reviewKey,
            baseRevision: input.manifest.baseRevision,
            headRevision: input.manifest.headRevision,
            semanticIdentity: input.manifest.semanticIdentity,
            descriptor: input.manifest.descriptor,
            source: input.manifest.storageSource,
            files: publication.files,
            blockIds: publication.blocks.map(({ id }) => id),
            checkpoints: publication.checkpoints,
            createdAtMs: nowMs,
          })
          return {
            projectId: input.manifest.projectId,
            snapshotId: input.manifest.snapshotId,
            reviewKey: input.manifest.reviewKey,
            files: publication.inventory,
          }
        })

        return yield* workflow.pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? store.recoverWrites().pipe(Effect.ignore) : Effect.void,
          ),
          Effect.ensuring(input.source.close.pipe(Effect.ignore)),
        )
      })

      return CoreSnapshotIngestion.of({ ingest })
    }),
  )

interface ActiveFile {
  readonly ordinal: number
  readonly identity: FileDeltaIdentity
  readonly deltaId: FileDeltaId
  readonly patchHash: ReturnType<typeof createHash>
  hunk: ActiveHunk | null
  hunkCount: number
  lineOffset: number
  nextBlockOrdinal: number
}

interface ActiveHunk {
  readonly started: Extract<IncrementalDiffEvent, { readonly _tag: "HunkStarted" }>
  /** Encoded content for only the current not-yet-durable block. */
  parts: Uint8Array[]
  byteCount: number
  blockFirstLine: number
  blockLineCount: number
  nextPartOrdinal: number
  totalLineCount: number
  readonly provisionalBlockIds: DiffBlockId[]
}

interface ExpectedBlock {
  readonly id: DiffBlockId
  readonly deltaId: FileDeltaId
  hunkId: string | null
  readonly ordinal: number
  readonly fileOrdinal: number
  readonly hunkOrdinal: number
  readonly firstLine: number
  readonly lineCount: number
  readonly byteCount: number
  readonly checksum: string
}

interface PublicationState {
  readonly files: ReadonlyArray<CoreSnapshotIngestedFile>
  readonly inventory: ReadonlyArray<CoreSnapshotIngestedFile>
  readonly blocks: ReadonlyArray<ExpectedBlock>
  readonly checkpoints: ReadonlyArray<SnapshotCheckpoint>
}

class IngestionState {
  readonly #reviewKey: ReviewKey
  readonly #maximumBlockBytes: number
  readonly #files: CoreSnapshotIngestedFile[] = []
  readonly #inventory: CoreSnapshotIngestedFile[] = []
  readonly #blocks: ExpectedBlock[] = []
  readonly #checkpoints: SnapshotCheckpoint[] = []
  #file: ActiveFile | null = null
  #byteOffset = 0
  #lineOffset = 0

  constructor(reviewKey: ReviewKey, maximumBlockBytes: number) {
    this.#reviewKey = reviewKey
    this.#maximumBlockBytes = maximumBlockBytes
  }

  startFile(
    event: Extract<IncrementalDiffEvent, { readonly _tag: "FileStarted" }>,
    identity: FileDeltaIdentity,
  ): Effect.Effect<void, CoreSnapshotIngestionError> {
    if (this.#file !== null || event.fileOrdinal !== this.#files.length)
      return invalidOrder("A file started before the preceding file closed")
    const patchHash = createHash("sha256")
    hashPart(patchHash, event.line)
    this.#file = {
      ordinal: event.fileOrdinal,
      identity,
      deltaId: makeFileDeltaId(identity),
      patchHash,
      hunk: null,
      hunkCount: 0,
      lineOffset: 0,
      nextBlockOrdinal: 0,
    }
    return Effect.void
  }

  startHunk(
    event: Extract<IncrementalDiffEvent, { readonly _tag: "HunkStarted" }>,
  ): Effect.Effect<void, CoreSnapshotIngestionError> {
    const file = this.#file
    if (
      file === null ||
      file.hunk !== null ||
      event.fileOrdinal !== file.ordinal ||
      event.hunkOrdinal !== file.hunkCount ||
      event.fingerprint !== null
    )
      return invalidOrder("A hunk started outside its expected file position")
    const header = lineBytes(event.header)
    if (header.byteLength > this.#maximumBlockBytes)
      return hunkTooLarge(this.#maximumBlockBytes, header.byteLength)
    hashPart(file.patchHash, event.header)
    file.hunk = {
      started: event,
      parts: [header],
      byteCount: header.byteLength,
      blockFirstLine: file.lineOffset,
      blockLineCount: 0,
      nextPartOrdinal: 0,
      totalLineCount: 0,
      provisionalBlockIds: [],
    }
    return Effect.void
  }

  recordPrelude(
    event: Extract<IncrementalDiffEvent, { readonly _tag: "FilePrelude" }>,
  ): Effect.Effect<
    {
      readonly file: ActiveFile
      readonly bytes: Uint8Array
      readonly lineCount: number
      readonly ordinal: number
    },
    CoreSnapshotIngestionError
  > {
    const file = this.#file
    if (
      file === null ||
      file.hunk !== null ||
      file.hunkCount !== 0 ||
      file.lineOffset !== 0 ||
      event.fileOrdinal !== file.ordinal ||
      event.lines.length === 0
    )
      return invalidOrder("A file prelude arrived outside its expected file position")
    const parts = event.lines.map(lineBytes)
    const byteCount = parts.reduce((total, part) => total + part.byteLength, 0)
    if (byteCount > this.#maximumBlockBytes) return hunkTooLarge(this.#maximumBlockBytes, byteCount)
    file.lineOffset = event.lines.length
    const ordinal = file.nextBlockOrdinal
    file.nextBlockOrdinal += 1
    return Effect.succeed({
      file,
      bytes: concatBytes(parts, byteCount),
      lineCount: event.lines.length,
      ordinal,
    })
  }

  addHunkLine(
    event: Extract<IncrementalDiffEvent, { readonly _tag: "HunkLine" }>,
  ): Effect.Effect<PendingHunkBlock | null, CoreSnapshotIngestionError> {
    const file = this.#file
    if (file === null || file.hunk === null)
      return invalidOrder("A hunk line arrived without its active hunk")
    const hunk = file.hunk
    if (event.fileOrdinal !== file.ordinal || event.hunkOrdinal !== hunk.started.hunkOrdinal)
      return invalidOrder("A hunk line arrived without its active hunk")
    const bytes = lineBytes(event.line)
    if (bytes.byteLength > this.#maximumBlockBytes)
      return hunkTooLarge(this.#maximumBlockBytes, bytes.byteLength)
    let completed: PendingHunkBlock | null = null
    if (hunk.byteCount + bytes.byteLength > this.#maximumBlockBytes) {
      if (hunk.blockLineCount === 0)
        return hunkTooLarge(this.#maximumBlockBytes, hunk.byteCount + bytes.byteLength)
      completed = this.#takeHunkBlock(file, hunk)
      hunk.parts = []
      hunk.byteCount = 0
      hunk.blockFirstLine += hunk.blockLineCount
      hunk.blockLineCount = 0
    }
    hunk.parts.push(bytes)
    hunk.byteCount += bytes.byteLength
    hunk.blockLineCount += 1
    hunk.totalLineCount += 1
    hashPart(file.patchHash, event.line)
    return Effect.succeed(completed)
  }

  closeHunk(event: Extract<IncrementalDiffEvent, { readonly _tag: "HunkClosed" }>): Effect.Effect<
    {
      readonly file: ActiveFile
      readonly hunk: ActiveHunk
      readonly block: PendingHunkBlock
    },
    CoreSnapshotIngestionError
  > {
    const file = this.#file
    if (file === null || file.hunk === null)
      return invalidOrder("A hunk closed without matching its complete provisional content")
    const hunk = file.hunk
    if (
      event.fileOrdinal !== file.ordinal ||
      event.hunkOrdinal !== hunk.started.hunkOrdinal ||
      event.lineCount !== hunk.totalLineCount ||
      event.lineCount < 1
    )
      return invalidOrder("A hunk closed without matching its complete provisional content")
    const block = this.#takeHunkBlock(file, hunk)
    hunk.parts = []
    hunk.byteCount = 0
    file.lineOffset += event.lineCount
    file.hunk = null
    file.hunkCount += 1
    return Effect.succeed({ file, hunk, block })
  }

  recordProvisionalHunkBlock(
    fileOrdinal: number,
    hunkOrdinal: number,
    block: ExpectedBlock,
  ): Effect.Effect<void, CoreSnapshotIngestionError> {
    const file = this.#file
    if (
      file === null ||
      file.hunk === null ||
      file.ordinal !== fileOrdinal ||
      file.hunk.started.hunkOrdinal !== hunkOrdinal
    )
      return invalidOrder("A provisional block did not match its active hunk")
    file.hunk.provisionalBlockIds.push(block.id)
    this.recordBlock(block)
    return Effect.void
  }

  bindProvisionalHunkBlocks(blockIds: ReadonlyArray<DiffBlockId>, hunkId: string): void {
    const ids = new Set(blockIds)
    for (const block of this.#blocks) if (ids.has(block.id)) block.hunkId = hunkId
  }

  recordBlock(block: ExpectedBlock): void {
    this.#blocks.push(block)
    this.#checkpoints.push({
      ordinal: this.#checkpoints.length,
      fileOrdinal: block.fileOrdinal,
      hunkOrdinal: block.hunkOrdinal,
      blockId: block.id,
      byteOffset: this.#byteOffset,
      lineOffset: this.#lineOffset,
    })
    this.#byteOffset += block.byteCount
    this.#lineOffset += block.lineCount
  }

  closeFile(file: ClosedDiffFile | null): Effect.Effect<void, CoreSnapshotIngestionError> {
    const active = this.#file
    if (active === null || active.hunk !== null)
      return invalidOrder("A file closed without a complete active file")
    if (file === null || file.ordinal !== active.ordinal || file.status !== active.identity.status)
      return Effect.fail(
        CoreSnapshotIngestionError.make({
          reason: "identityMismatch",
          message: "Closed file metadata did not match its exact source-derived delta identity",
        }),
      )
    if (file.hunkLineCounts.length !== active.hunkCount)
      return invalidOrder("Closed file hunk counts did not match consumed hunks")
    hashPart(active.patchHash, file.status)
    hashPart(active.patchHash, file.oldPath ?? "")
    hashPart(active.patchHash, file.path)
    for (const metadata of file.metadata) hashPart(active.patchHash, metadata)
    const patchHash = ReviewFilePatchHash.make(`file-patch:v2:${active.patchHash.digest("hex")}`)
    const visibility = Schema.decodeUnknownSync(ParsedDiffFile)({
      fileId: file.fileId,
      patchHash,
      reviewKey: this.#reviewKey,
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      hunks: [],
      patch: "",
    }).visibility
    const placement = {
      ordinal: file.ordinal,
      deltaId: active.deltaId,
      fileId: file.fileId,
      path: file.path,
      oldPath: file.oldPath,
      additions: file.additions,
      deletions: file.deletions,
    }
    const inventory = {
      ...placement,
      patchHash,
      reviewKey: this.#reviewKey,
      status: file.status,
      visibility,
      hunkCount: active.hunkCount,
    }
    this.#files.push(inventory)
    this.#inventory.push(inventory)
    this.#file = null
    return Effect.void
  }

  identityFor(fileOrdinal: number): Effect.Effect<FileDeltaIdentity, CoreSnapshotIngestionError> {
    return this.#file?.ordinal === fileOrdinal
      ? Effect.succeed(this.#file.identity)
      : invalidOrder("Closed file did not match the active exact delta identity")
  }

  finish(): Effect.Effect<PublicationState, CoreSnapshotIngestionError> {
    if (this.#file !== null) return invalidOrder("Incremental worker finished with an open file")
    return Effect.succeed({
      files: this.#files,
      inventory: this.#inventory,
      blocks: this.#blocks,
      checkpoints: this.#checkpoints,
    })
  }

  #takeHunkBlock(file: ActiveFile, hunk: ActiveHunk): PendingHunkBlock {
    const block = {
      bytes: concatBytes(hunk.parts, hunk.byteCount),
      firstLine: hunk.blockFirstLine,
      lineCount: hunk.blockLineCount,
      ordinal: file.nextBlockOrdinal,
      partOrdinal: hunk.nextPartOrdinal,
    }
    file.nextBlockOrdinal += 1
    hunk.nextPartOrdinal += 1
    return block
  }
}

interface PendingHunkBlock {
  readonly bytes: Uint8Array
  readonly firstLine: number
  readonly lineCount: number
  readonly ordinal: number
  readonly partOrdinal: number
}

const consumeBatch = Effect.fn("CoreSnapshotIngestion.consumeBatch")(function* (
  store: SnapshotBlockStore["Service"],
  input: CoreSnapshotIngestionInput,
  state: IngestionState,
  batch: IncrementalDiffBatch,
  options: CoreSnapshotIngestionOptions,
) {
  if (!isBoundedIncrementalDiffBatch(batch))
    return yield* CoreReviewDataWorkerBatchError.make({
      safeMessage: "DiffDash rejected invalid incremental review data.",
    })
  for (const item of batch.events) {
    yield* Match.value(item).pipe(
      Match.tagsExhaustive({
        FileStarted: (event) =>
          Effect.gen(function* () {
            const identity = yield* input.fileDeltaKeys.resolve({
              ordinal: event.fileOrdinal,
              gitOldPath: event.gitOldPath,
              gitNewPath: event.gitNewPath,
            })
            if (
              input.manifest.storageSource.kind === "exactGit" &&
              identity.diffPolicyIdentity !== input.manifest.storageSource.diffPolicyIdentity
            )
              return yield* Effect.fail(
                CoreSnapshotIngestionError.make({
                  reason: "identityMismatch",
                  message: "File delta policy did not match the exact Git snapshot source",
                }),
              )
            return yield* state.startFile(event, identity)
          }),
        FilePrelude: (event) =>
          Effect.gen(function* () {
            const prelude = yield* state.recordPrelude(event)
            yield* store.registerFileDelta({ identity: prelude.file.identity, hunks: [] })
            const checksum = checksumBytes(prelude.bytes)
            const id = DiffBlockId.make(
              `block:v1:${digest(`${prelude.file.deltaId}:prelude:${checksum}`)}`,
            )
            const block = {
              id,
              deltaId: prelude.file.deltaId,
              hunkId: null,
              ordinal: prelude.ordinal,
              fileOrdinal: prelude.file.ordinal,
              hunkOrdinal: 0,
              firstLine: 0,
              lineCount: prelude.lineCount,
              byteCount: prelude.bytes.byteLength,
              checksum,
            }
            yield* persistBlock(store, block, prelude.bytes, options)
            state.recordBlock(block)
          }),
        HunkStarted: (event) => state.startHunk(event),
        HunkLine: (event) =>
          Effect.gen(function* () {
            const pending = yield* state.addHunkLine(event)
            if (pending === null) return
            const file = yield* state.identityFor(event.fileOrdinal)
            const deltaId = makeFileDeltaId(file)
            const checksum = checksumBytes(pending.bytes)
            const id = provisionalHunkBlockId(
              deltaId,
              event.hunkOrdinal,
              pending.partOrdinal,
              checksum,
            )
            const block: ExpectedBlock = {
              id,
              deltaId,
              hunkId: null,
              ordinal: pending.ordinal,
              fileOrdinal: event.fileOrdinal,
              hunkOrdinal: event.hunkOrdinal,
              firstLine: pending.firstLine,
              lineCount: pending.lineCount,
              byteCount: pending.bytes.byteLength,
              checksum,
            }
            yield* persistBlock(store, block, pending.bytes, options, true)
            yield* state.recordProvisionalHunkBlock(event.fileOrdinal, event.hunkOrdinal, block)
          }),
        HunkClosed: (event) =>
          Effect.gen(function* () {
            const closed = yield* state.closeHunk(event)
            yield* store.registerFileDelta({
              identity: closed.file.identity,
              hunks: [
                {
                  id: event.id,
                  ordinal: event.hunkOrdinal,
                  fingerprint: event.fingerprint,
                  header: closed.hunk.started.header,
                  oldStart: closed.hunk.started.oldStart,
                  oldLines: closed.hunk.started.oldLines,
                  newStart: closed.hunk.started.newStart,
                  newLines: closed.hunk.started.newLines,
                  lineCount: event.lineCount,
                },
              ],
            })
            const checksum = checksumBytes(closed.block.bytes)
            const split = closed.hunk.provisionalBlockIds.length > 0
            const id = split
              ? provisionalHunkBlockId(
                  closed.file.deltaId,
                  event.hunkOrdinal,
                  closed.block.partOrdinal,
                  checksum,
                )
              : DiffBlockId.make(
                  `block:v1:${digest(`${closed.file.deltaId}:${event.id}:${checksum}`)}`,
                )
            const block: ExpectedBlock = {
              id,
              deltaId: closed.file.deltaId,
              hunkId: event.id,
              ordinal: closed.block.ordinal,
              fileOrdinal: event.fileOrdinal,
              hunkOrdinal: event.hunkOrdinal,
              firstLine: closed.block.firstLine,
              lineCount: closed.block.lineCount,
              byteCount: closed.block.bytes.byteLength,
              checksum,
            }
            yield* persistBlock(store, block, closed.block.bytes, options)
            if (split) {
              yield* store.bindBlocksToHunk({
                deltaId: closed.file.deltaId,
                hunkId: event.id,
                blockIds: closed.hunk.provisionalBlockIds,
              })
              state.bindProvisionalHunkBlocks(closed.hunk.provisionalBlockIds, event.id)
            }
            state.recordBlock(block)
          }),
        FileClosed: (event) =>
          Effect.gen(function* () {
            if (event.file !== null && event.file.hunkLineCounts.length === 0) {
              const activeIdentity = yield* state.identityFor(event.file.ordinal)
              yield* store.registerFileDelta({ identity: activeIdentity, hunks: [] })
            }
            yield* state.closeFile(event.file)
          }),
      }),
    )
  }
  return undefined
})

const persistBlock = Effect.fn("CoreSnapshotIngestion.persistBlock")(function* (
  store: SnapshotBlockStore["Service"],
  block: ExpectedBlock,
  bytes: Uint8Array,
  options: CoreSnapshotIngestionOptions,
  allowAlreadyBoundHunk = false,
) {
  const visible = yield* store.visibleBlocks(block.deltaId)
  const existing = visible.find((candidate) => candidate.id === block.id)
  if (existing === undefined) {
    const nowMs = yield* Clock.currentTimeMillis
    const prepared = yield* store.prepareBlock({
      ...block,
      reservationId: ResourceReservationId.make(`ingest:${digest(block.id)}`),
      nowMs,
      expiresAtMs: nowMs + options.reservationLifetimeMs,
      quotaBytes: options.managedQuotaBytes,
    })
    if (prepared.kind === "quotaExceeded")
      return yield* Effect.fail(
        CoreSnapshotIngestionError.make({
          reason: "quotaExceeded",
          message: `Snapshot block needs ${prepared.requiredBytes} bytes but only ${prepared.availableBytes} are available`,
        }),
      )
    yield* store.stageBlock(block.id, bytes)
    yield* store.promoteBlock(block.id)
    yield* store.finalizeBlock(block.id)
  } else if (
    !sameBlock(existing, block) &&
    !(allowAlreadyBoundHunk && block.hunkId === null && sameBlockContent(existing, block))
  ) {
    return yield* verificationFailed("An existing content-addressed block had different metadata")
  }
  return undefined
})

const provisionalHunkBlockId = (
  deltaId: FileDeltaId,
  hunkOrdinal: number,
  partOrdinal: number,
  checksum: string,
): DiffBlockId =>
  DiffBlockId.make(
    `block:v2:${digest(`${deltaId}:hunk:${hunkOrdinal}:part:${partOrdinal}:${checksum}`)}`,
  )

const validateManifestIdentity = Effect.fn("CoreSnapshotIngestion.validateManifestIdentity")(
  function* (input: CoreSnapshotIngestionInput) {
    const expectedReviewKey = input.source.offer.target.reviewKey
    const expectedSnapshotId = makeReviewSnapshotId({
      reviewKey: expectedReviewKey,
      baseRevision: input.manifest.baseRevision,
      headRevision: input.manifest.headRevision,
      diffIdentity: input.source.offer.semanticIdentity,
    })
    const storageRequirement = reviewDiffStorageRequirement(input.source.offer.facts)
    if (
      input.manifest.reviewKey !== expectedReviewKey ||
      input.manifest.snapshotId !== expectedSnapshotId ||
      input.manifest.semanticIdentity !== input.source.offer.semanticIdentity ||
      input.acquisition.expectedRevision !== input.source.offer.expectedRevision ||
      input.manifest.headRevision !== input.acquisition.expectedRevision ||
      (storageRequirement === "managedCompleteSpool" &&
        input.manifest.storageSource.kind !== "managedSpool")
    )
      return yield* Effect.fail(
        CoreSnapshotIngestionError.make({
          reason: "identityMismatch",
          message: "Snapshot identity did not match the committed review source acquisition",
        }),
      )
    return undefined
  },
)

const verifyReadyBlocks = Effect.fn("CoreSnapshotIngestion.verifyReadyBlocks")(function* (
  store: SnapshotBlockStore["Service"],
  blocks: ReadonlyArray<ExpectedBlock>,
) {
  const byDelta = new Map<FileDeltaId, ExpectedBlock[]>()
  for (const block of blocks) {
    const current = byDelta.get(block.deltaId) ?? []
    current.push(block)
    byDelta.set(block.deltaId, current)
  }
  for (const [deltaId, expected] of byDelta) {
    const visible = yield* store.visibleBlocks(deltaId)
    for (const block of expected) {
      const candidate = visible.find(({ id }) => id === block.id)
      if (candidate === undefined || !sameBlock(candidate, block))
        return yield* verificationFailed(
          "A finalized snapshot block failed ready-state verification",
        )
    }
  }
  return undefined
})

const sameBlock = (
  actual: {
    readonly delta_id: FileDeltaId
    readonly hunk_id: string | null
    readonly ordinal: number
    readonly first_line: number
    readonly line_count: number
    readonly byte_count: number
    readonly checksum: string
  },
  expected: ExpectedBlock,
): boolean =>
  actual.delta_id === expected.deltaId &&
  actual.hunk_id === expected.hunkId &&
  actual.ordinal === expected.ordinal &&
  actual.first_line === expected.firstLine &&
  actual.line_count === expected.lineCount &&
  actual.byte_count === expected.byteCount &&
  actual.checksum === expected.checksum

const sameBlockContent = (
  actual: Parameters<typeof sameBlock>[0],
  expected: ExpectedBlock,
): boolean =>
  actual.delta_id === expected.deltaId &&
  actual.ordinal === expected.ordinal &&
  actual.first_line === expected.firstLine &&
  actual.line_count === expected.lineCount &&
  actual.byte_count === expected.byteCount &&
  actual.checksum === expected.checksum

const lineBytes = (line: string): Uint8Array => encoder.encode(`${line}\n`)

const concatBytes = (parts: ReadonlyArray<Uint8Array>, byteCount: number): Uint8Array => {
  const bytes = new Uint8Array(byteCount)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

const hashPart = (hash: ReturnType<typeof createHash>, value: string): void => {
  const bytes = encoder.encode(value)
  hash.update(String(bytes.byteLength))
  hash.update(":")
  hash.update(bytes)
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex")

const checksumBytes = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`

const invalidOrder = (message: string): Effect.Effect<never, CoreSnapshotIngestionError> =>
  Effect.fail(CoreSnapshotIngestionError.make({ reason: "invalidEventOrder", message }))

const hunkTooLarge = (
  limit: number,
  actual: number,
): Effect.Effect<never, CoreSnapshotIngestionError> =>
  Effect.fail(
    CoreSnapshotIngestionError.make({
      reason: "hunkTooLarge",
      message: `Complete hunk block is ${actual} bytes, exceeding the ${limit} byte limit`,
    }),
  )

const verificationFailed = (message: string): Effect.Effect<never, CoreSnapshotIngestionError> =>
  Effect.fail(CoreSnapshotIngestionError.make({ reason: "verificationFailed", message }))
