import { createHash } from "node:crypto"

import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  CoreRpcPayloadBytes,
  HostRequestId,
} from "@diffdash/core-rpc"
import {
  ReviewFileId,
  ReviewHunkId,
  ReviewKey,
  ReviewProjectId,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import {
  DiffBlockId,
  type FileDeltaId,
  type SnapshotFilePlacement,
  SnapshotBlockStore,
  type StoredHunk,
  type StoredSnapshotHeader,
  StoredSnapshotId,
  type VisibleDiffBlock,
} from "@diffdash/persistence/snapshot-block-store"
import {
  ResourceCatalog,
  ResourceLeaseId,
  ResourceReservationId,
} from "@diffdash/persistence/resource-catalog"
import {
  Clock,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect"

/** Maximum changed files returned by one progressive inventory query. */
export const SNAPSHOT_INVENTORY_QUERY_LIMIT = 256

/** Identity of one generation-scoped foreground snapshot session. */
export const SnapshotRepositorySessionId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
  Schema.brand("SnapshotRepositorySessionId"),
)

/** Identity of one generation-scoped foreground snapshot session. */
export type SnapshotRepositorySessionId = typeof SnapshotRepositorySessionId.Type

/** Full authority presented to every snapshot repository operation. */
export const SnapshotRepositoryIdentity = Schema.Struct({
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  requestId: HostRequestId,
  projectId: ReviewProjectId,
  reviewKey: ReviewKey,
  snapshotId: ReviewSnapshotId,
  sessionId: SnapshotRepositorySessionId,
})

/** Full authority presented to every snapshot repository operation. */
export type SnapshotRepositoryIdentity = typeof SnapshotRepositoryIdentity.Type

/** Exact block generated lazily from immutable Git objects. */
export interface LazySnapshotBlock {
  readonly hunkId: ReviewHunkId | null
  readonly ordinal: number
  readonly firstLine: number
  readonly lineCount: number
  readonly bytes: Uint8Array
}

/** Adapter for bounded canonical output from exact immutable Git objects. */
export class SnapshotGitRangeSource extends Context.Service<
  SnapshotGitRangeSource,
  | {
      readonly generateFile: (input: {
        readonly snapshot: StoredSnapshotHeader
        readonly file: SnapshotFilePlacement
        readonly maximumBlockBytes: number
      }) => Effect.Effect<ReadonlyArray<LazySnapshotBlock>, SnapshotRepositorySourceError>
      readonly generateFileBlocks?: never
    }
  | {
      readonly generateFile?: never
      readonly generateFileBlocks: (input: {
        readonly snapshot: StoredSnapshotHeader
        readonly file: SnapshotFilePlacement
        readonly maximumBlockBytes: number
      }) => Stream.Stream<LazySnapshotBlock, SnapshotRepositorySourceError>
    }
>()("@diffdash/core/SnapshotGitRangeSource") {}

/** Project authority used before a manifest may enter a foreground session. */
export class SnapshotProjectAuthority extends Context.Service<
  SnapshotProjectAuthority,
  {
    readonly contains: (
      projectId: ReviewProjectId,
      snapshot: StoredSnapshotHeader,
    ) => Effect.Effect<boolean, SnapshotRepositorySourceError>
  }
>()("@diffdash/core/SnapshotProjectAuthority") {}

const SnapshotRepositoryOperation = Schema.Literals([
  "openSession",
  "closeSession",
  "inventory",
  "findFile",
  "findFileHunk",
  "resolveTarget",
  "waitForRange",
  "readRange",
])

const SnapshotRepositoryFailureReason = Schema.Literals([
  "identityRejected",
  "superseded",
  "notFound",
  "rangeLimit",
  "quotaExceeded",
  "sourceUnavailable",
])

/** Expected rejection at the generation-scoped snapshot repository boundary. */
export class SnapshotRepositoryError extends Schema.TaggedError<SnapshotRepositoryError>()(
  "SnapshotRepositoryError",
  {
    operation: SnapshotRepositoryOperation,
    reason: SnapshotRepositoryFailureReason,
    message: Schema.String,
  },
) {}

/** Expected failure produced by an exact-Git range adapter. */
export class SnapshotRepositorySourceError extends Schema.TaggedError<SnapshotRepositorySourceError>()(
  "SnapshotRepositorySourceError",
  { message: Schema.String },
) {}

/** Progressive snapshot inventory page. */
export interface SnapshotInventoryPage {
  readonly files: ReadonlyArray<SnapshotFilePlacement>
  readonly nextOffset: number | null
}

/** Stable semantic coordinates of one complete range block. */
export interface SnapshotRangeBlock {
  readonly id: DiffBlockId
  readonly deltaId: FileDeltaId
  readonly hunkId: string | null
  readonly ordinal: number
  readonly firstLine: number
  readonly lineCount: number
  readonly bytes: Uint8Array
}

/** Complete blocks split only at persisted legal boundaries. */
export interface SnapshotRange {
  readonly file: SnapshotFilePlacement
  readonly blocks: ReadonlyArray<SnapshotRangeBlock>
  readonly byteCount: number
  readonly complete: boolean
}

/** Resolved target and a bounded legal range beginning at its containing block. */
export interface ResolvedSnapshotTarget {
  readonly file: SnapshotFilePlacement
  readonly blockOrdinal: number
  readonly blockFirstLine: number
  readonly line: number
  readonly targetLineOffset: number
}

/** Persisted coordinate used to locate one exact snapshot block. */
export type SnapshotTarget =
  | {
      readonly _tag: "HunkLine"
      readonly hunkId: ReviewHunkId | null
      readonly line: number
    }
  | {
      readonly _tag: "SideLine"
      readonly hunkId: ReviewHunkId
      readonly side: "old" | "new"
      readonly lineNumber: number
    }

/** Repository limits sourced from Core RPC and managed-resource policy. */
export interface SnapshotRepositoryOptions {
  readonly maximumResponseBytes: CoreRpcPayloadBytes
  readonly maximumBlockBytes: number
  readonly maximumLazyBlocks: number
  readonly maximumLazyConcurrency: number
  readonly managedQuotaBytes: number
  readonly reservationLifetimeMs: number
  readonly leaseLifetimeMs: number
}

interface ActiveSession {
  readonly identity: Omit<SnapshotRepositoryIdentity, "requestId">
  readonly generation: number
  readonly snapshot: StoredSnapshotHeader
}

type Operation = typeof SnapshotRepositoryOperation.Type

/** Core authority for one application-wide foreground snapshot session. */
export class SnapshotRepository extends Context.Service<
  SnapshotRepository,
  {
    readonly openSession: (
      identity: SnapshotRepositoryIdentity,
    ) => Effect.Effect<StoredSnapshotHeader, SnapshotRepositoryError>
    readonly closeSession: (
      identity: SnapshotRepositoryIdentity,
    ) => Effect.Effect<boolean, SnapshotRepositoryError>
    readonly inventory: (
      identity: SnapshotRepositoryIdentity,
      offset: number,
      limit: number,
    ) => Effect.Effect<SnapshotInventoryPage, SnapshotRepositoryError>
    readonly findFile: (
      identity: SnapshotRepositoryIdentity,
      fileId: ReviewFileId,
    ) => Effect.Effect<SnapshotFilePlacement, SnapshotRepositoryError>
    readonly findFileHunk: (
      identity: SnapshotRepositoryIdentity,
      fileId: ReviewFileId,
      hunkId: ReviewHunkId,
    ) => Effect.Effect<StoredHunk, SnapshotRepositoryError>
    readonly resolveTarget: (
      identity: SnapshotRepositoryIdentity,
      fileId: ReviewFileId,
      target: SnapshotTarget,
    ) => Effect.Effect<ResolvedSnapshotTarget, SnapshotRepositoryError>
    readonly waitForRange: (
      identity: SnapshotRepositoryIdentity,
      fileId: ReviewFileId,
      startLine: number,
    ) => Effect.Effect<SnapshotRange, SnapshotRepositoryError>
    readonly readRange: (
      identity: SnapshotRepositoryIdentity,
      fileId: ReviewFileId,
      startLine: number,
    ) => Effect.Effect<SnapshotRange, SnapshotRepositoryError>
  }
>()("@diffdash/core/SnapshotRepository") {}

/** Builds the repository while leaving concrete persistence and Git adapters visible to composition. */
export const snapshotRepositoryLayer = (
  options: SnapshotRepositoryOptions,
): Layer.Layer<
  SnapshotRepository,
  never,
  SnapshotBlockStore | ResourceCatalog | SnapshotGitRangeSource | SnapshotProjectAuthority
> =>
  Layer.effect(
    SnapshotRepository,
    Effect.gen(function* () {
      const store = yield* SnapshotBlockStore
      const resources = yield* ResourceCatalog
      const git = yield* SnapshotGitRangeSource
      const projects = yield* SnapshotProjectAuthority
      const sessionLock = yield* Semaphore.make(1)
      const lazyCapacity = yield* Semaphore.make(options.maximumLazyConcurrency)
      const active = yield* Ref.make<Option.Option<ActiveSession>>(Option.none())
      let nextGeneration = 0

      const reject = (
        operation: Operation,
        reason: typeof SnapshotRepositoryFailureReason.Type,
        message: string,
      ) => SnapshotRepositoryError.make({ operation, reason, message })

      const current = Effect.fn("SnapshotRepository.current")(function* (
        operation: Operation,
        identity: SnapshotRepositoryIdentity,
      ) {
        if (!Schema.is(SnapshotRepositoryIdentity)(identity))
          return yield* reject(
            operation,
            "identityRejected",
            "Snapshot repository request identity is malformed",
          )
        const value = yield* Ref.get(active)
        if (Option.isNone(value) || !sameSession(value.value.identity, identity))
          return yield* reject(
            operation,
            Option.isSome(value) ? "superseded" : "identityRejected",
            "Snapshot repository identity does not own the foreground session",
          )
        return value.value
      })

      const loadFile = Effect.fn("SnapshotRepository.loadFile")(function* (
        operation: Operation,
        identity: SnapshotRepositoryIdentity,
        fileId: ReviewFileId,
      ) {
        const session = yield* current(operation, identity)
        const file = yield* store
          .findSnapshotFile(StoredSnapshotId.make(identity.snapshotId), fileId)
          .pipe(Effect.mapError(() => reject(operation, "notFound", "Snapshot file was not found")))
        yield* current(operation, identity)
        return { session, file }
      })

      const materialize = Effect.fn("SnapshotRepository.materialize")(function* (
        operation: "resolveTarget" | "waitForRange" | "readRange",
        identity: SnapshotRepositoryIdentity,
        session: ActiveSession,
        file: SnapshotFilePlacement,
      ) {
        if (session.snapshot.source.kind !== "exactGit") return []
        return yield* lazyCapacity.withPermits(1)(
          Effect.gen(function* () {
            const input = {
              snapshot: session.snapshot,
              file,
              maximumBlockBytes: options.maximumBlockBytes,
            }
            const generated =
              git.generateFileBlocks !== undefined
                ? git.generateFileBlocks(input)
                : Stream.fromEffect(git.generateFile(input)).pipe(
                    Stream.flatMap((blocks) => Stream.fromIterable(blocks)),
                  )
            let nextLine = 0
            let blockCount = 0
            const promoted: DiffBlockId[] = []
            yield* generated.pipe(
              Stream.mapError((error) => reject(operation, "sourceUnavailable", error.message)),
              Stream.runForEach((block) =>
                Effect.gen(function* () {
                  const index = blockCount
                  blockCount += 1
                  if (blockCount > options.maximumLazyBlocks)
                    return yield* reject(
                      operation,
                      "rangeLimit",
                      "Exact-Git output exceeded the bounded block count",
                    )
                  if (
                    block.ordinal !== index ||
                    block.firstLine !== nextLine ||
                    block.bytes.byteLength === 0 ||
                    block.bytes.byteLength > options.maximumBlockBytes ||
                    block.lineCount <= 0
                  )
                    return yield* reject(
                      operation,
                      "rangeLimit",
                      "Exact-Git output crossed a block protocol limit",
                    )
                  nextLine += block.lineCount
                  yield* current(operation, identity)
                  const blockId = makeLazyBlockId(file.deltaId, block)
                  const nowMs = yield* Clock.currentTimeMillis
                  const prepared = yield* store
                    .prepareBlock({
                      id: blockId,
                      deltaId: file.deltaId,
                      hunkId: block.hunkId,
                      ordinal: block.ordinal,
                      firstLine: block.firstLine,
                      lineCount: block.lineCount,
                      byteCount: block.bytes.byteLength,
                      checksum: checksum(block.bytes),
                      reservationId: ResourceReservationId.make(`lazy:${hash(blockId)}`),
                      nowMs,
                      expiresAtMs: nowMs + options.reservationLifetimeMs,
                      quotaBytes: options.managedQuotaBytes,
                    })
                    .pipe(
                      Effect.mapError(() =>
                        reject(operation, "sourceUnavailable", "Could not reserve lazy output"),
                      ),
                    )
                  if (prepared.kind === "quotaExceeded")
                    return yield* reject(
                      operation,
                      "quotaExceeded",
                      "Managed snapshot quota cannot reserve exact-Git output",
                    )
                  yield* store
                    .stageBlock(blockId, block.bytes)
                    .pipe(
                      Effect.mapError(() =>
                        reject(operation, "sourceUnavailable", "Could not stage lazy output"),
                      ),
                    )
                  yield* current(operation, identity)
                  yield* store
                    .promoteBlock(blockId)
                    .pipe(
                      Effect.mapError(() =>
                        reject(operation, "sourceUnavailable", "Could not promote lazy output"),
                      ),
                    )
                  promoted.push(blockId)
                  return undefined
                }),
              ),
            )
            yield* sessionLock.withPermits(1)(
              current(operation, identity).pipe(
                Effect.andThen(
                  Effect.forEach(
                    promoted,
                    (blockId) =>
                      store
                        .finalizeBlock(blockId)
                        .pipe(
                          Effect.mapError(() =>
                            reject(operation, "sourceUnavailable", "Could not publish lazy output"),
                          ),
                        ),
                    { discard: true },
                  ),
                ),
              ),
            )
            return yield* store
              .visibleBlocks(file.deltaId)
              .pipe(
                Effect.mapError(() =>
                  reject(operation, "sourceUnavailable", "Could not load lazy output"),
                ),
              )
          }),
        )
      })

      const read = Effect.fn("SnapshotRepository.read")(function* (
        operation: "waitForRange" | "readRange",
        identity: SnapshotRepositoryIdentity,
        fileId: ReviewFileId,
        startLine: number,
      ) {
        if (!Number.isSafeInteger(startLine) || startLine < 0)
          return yield* reject(operation, "rangeLimit", "Range start line is invalid")
        const { file, session } = yield* loadFile(operation, identity, fileId)
        let blocks = yield* store
          .visibleBlocks(file.deltaId)
          .pipe(
            Effect.mapError(() =>
              reject(operation, "sourceUnavailable", "Could not query snapshot blocks"),
            ),
          )
        if (blocks.length === 0) blocks = yield* materialize(operation, identity, session, file)
        yield* current(operation, identity)
        const selected = selectLegalRange(blocks, startLine, options.maximumResponseBytes)
        if (selected.length === 0)
          return blocks.length === 0
            ? { file, blocks: [], byteCount: 0, complete: true }
            : yield* reject(
                operation,
                "rangeLimit",
                "One legal snapshot block exceeds the response policy",
              )
        const rangeBlocks = yield* Effect.forEach(selected, (block) =>
          readLeasedBlock(
            resources,
            store,
            identity,
            session.generation,
            block,
            options.leaseLifetimeMs,
          ),
        ).pipe(
          Effect.mapError(() =>
            reject(operation, "sourceUnavailable", "Could not read a leased snapshot block"),
          ),
        )
        yield* current(operation, identity)
        const last = selected.at(-1)
        return {
          file,
          blocks: rangeBlocks,
          byteCount: selected.reduce((total, block) => total + block.byte_count, 0),
          complete: last?.ordinal === blocks.at(-1)?.ordinal,
        }
      })

      return SnapshotRepository.of({
        openSession: Effect.fn("SnapshotRepository.openSession")(function* (identity) {
          if (!Schema.is(SnapshotRepositoryIdentity)(identity))
            return yield* reject(
              "openSession",
              "identityRejected",
              "Snapshot repository request identity is malformed",
            )
          const snapshot = yield* store
            .getSnapshotHeader(StoredSnapshotId.make(identity.snapshotId))
            .pipe(
              Effect.mapError(() =>
                reject("openSession", "notFound", "Snapshot manifest was not found"),
              ),
            )
          const belongsToProject = yield* projects
            .contains(identity.projectId, snapshot)
            .pipe(
              Effect.mapError((error) => reject("openSession", "sourceUnavailable", error.message)),
            )
          if (snapshot.reviewKey !== identity.reviewKey || !belongsToProject)
            return yield* reject(
              "openSession",
              "identityRejected",
              "Project, review, and snapshot identity do not describe one manifest",
            )
          yield* sessionLock.withPermits(1)(
            Ref.set(
              active,
              Option.some({
                identity: withoutRequest(identity),
                generation: ++nextGeneration,
                snapshot,
              }),
            ),
          )
          return snapshot
        }),
        closeSession: Effect.fn("SnapshotRepository.closeSession")(function* (identity) {
          if (!Schema.is(SnapshotRepositoryIdentity)(identity))
            return yield* reject(
              "closeSession",
              "identityRejected",
              "Snapshot repository request identity is malformed",
            )
          return yield* sessionLock.withPermits(1)(
            Ref.modify(active, (value) =>
              Option.isSome(value) && sameSession(value.value.identity, identity)
                ? [true, Option.none()]
                : [false, value],
            ),
          )
        }),
        inventory: Effect.fn("SnapshotRepository.inventory")(function* (identity, offset, limit) {
          yield* current("inventory", identity)
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(limit) ||
            limit <= 0 ||
            limit > SNAPSHOT_INVENTORY_QUERY_LIMIT
          )
            return yield* reject("inventory", "rangeLimit", "Inventory query is outside its bound")
          const queried = yield* store
            .listSnapshotFiles(StoredSnapshotId.make(identity.snapshotId), offset, limit + 1)
            .pipe(
              Effect.mapError(() =>
                reject("inventory", "sourceUnavailable", "Could not query snapshot inventory"),
              ),
            )
          yield* current("inventory", identity)
          const files = queried.slice(0, limit)
          return { files, nextOffset: queried.length > limit ? offset + files.length : null }
        }),
        findFile: Effect.fn("SnapshotRepository.findFile")(function* (identity, fileId) {
          return (yield* loadFile("findFile", identity, fileId)).file
        }),
        findFileHunk: Effect.fn("SnapshotRepository.findFileHunk")(
          function* (identity, fileId, hunkId) {
            const { file } = yield* loadFile("findFileHunk", identity, fileId)
            const hunk = yield* store
              .findFileHunk(file.deltaId, hunkId)
              .pipe(
                Effect.mapError(() =>
                  reject("findFileHunk", "notFound", "Snapshot file hunk was not found"),
                ),
              )
            yield* current("findFileHunk", identity)
            return hunk
          },
        ),
        resolveTarget: Effect.fn("SnapshotRepository.resolveTarget")(
          function* (identity, fileId, coordinate) {
            const { file, session } = yield* loadFile("resolveTarget", identity, fileId)
            let blocks = yield* store
              .visibleBlocks(file.deltaId)
              .pipe(
                Effect.mapError(() =>
                  reject("resolveTarget", "sourceUnavailable", "Could not query target blocks"),
                ),
              )
            if (blocks.length === 0)
              blocks = yield* materialize("resolveTarget", identity, session, file)
            const resolution = yield* Match.valueTags(coordinate, {
              HunkLine: ({ hunkId, line }) => {
                let target: VisibleDiffBlock | undefined
                let targetLineOffset = 0
                if (hunkId === null) {
                  target = blocks.find(
                    (block) =>
                      line >= block.first_line && line < block.first_line + block.line_count,
                  )
                  if (target !== undefined) targetLineOffset = line - target.first_line
                } else {
                  let remaining = line
                  for (const block of blocks) {
                    if (block.hunk_id !== hunkId) continue
                    if (remaining < block.line_count) {
                      target = block
                      targetLineOffset = remaining
                      break
                    }
                    remaining -= block.line_count
                  }
                }
                return Effect.succeed({ line, target, targetLineOffset })
              },
              SideLine: (sideTarget) =>
                Effect.gen(function* () {
                  const hunk = yield* store
                    .findFileHunk(file.deltaId, sideTarget.hunkId)
                    .pipe(
                      Effect.mapError(() =>
                        reject("resolveTarget", "notFound", "Snapshot target hunk was not found"),
                      ),
                    )
                  let oldLineNumber = hunk.oldStart
                  let newLineNumber = hunk.newStart
                  let target: VisibleDiffBlock | undefined
                  let targetLineOffset = 0
                  for (const block of blocks) {
                    if (block.hunk_id !== sideTarget.hunkId) continue
                    const bytes = yield* store
                      .readManagedRange(block.resource_id, 0, block.byte_count)
                      .pipe(
                        Effect.mapError(() =>
                          reject(
                            "resolveTarget",
                            "sourceUnavailable",
                            "Could not read target block",
                          ),
                        ),
                      )
                    const text = yield* Effect.try({
                      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.bytes),
                      catch: () =>
                        reject(
                          "resolveTarget",
                          "sourceUnavailable",
                          "Committed snapshot block is not valid UTF-8",
                        ),
                    })
                    const patchLines = text.split("\n")
                    if (patchLines.at(-1) === "") patchLines.pop()
                    for (const [offset, patchLine] of patchLines.entries()) {
                      const marker = patchLine[0]
                      const matches =
                        marker === " "
                          ? sideTarget.side === "old"
                            ? oldLineNumber === sideTarget.lineNumber
                            : newLineNumber === sideTarget.lineNumber
                          : marker === "-"
                            ? sideTarget.side === "old" && oldLineNumber === sideTarget.lineNumber
                            : marker === "+" &&
                              sideTarget.side === "new" &&
                              newLineNumber === sideTarget.lineNumber
                      if (matches) {
                        target = block
                        targetLineOffset = offset
                        break
                      }
                      if (marker === " " || marker === "-") oldLineNumber += 1
                      if (marker === " " || marker === "+") newLineNumber += 1
                    }
                    if (target !== undefined) break
                    yield* current("resolveTarget", identity)
                  }
                  return { line: sideTarget.lineNumber, target, targetLineOffset }
                }),
            })
            if (resolution.target === undefined)
              return yield* reject("resolveTarget", "notFound", "Snapshot target was not found")
            yield* current("resolveTarget", identity)
            return {
              file,
              blockOrdinal: resolution.target.ordinal,
              blockFirstLine: resolution.target.first_line,
              line: resolution.line,
              targetLineOffset: resolution.targetLineOffset,
            }
          },
        ),
        waitForRange: (identity, fileId, startLine) =>
          read("waitForRange", identity, fileId, startLine),
        readRange: (identity, fileId, startLine) => read("readRange", identity, fileId, startLine),
      })
    }),
  )

const readLeasedBlock = Effect.fn("SnapshotRepository.readLeasedBlock")(function* (
  resources: ResourceCatalog["Service"],
  store: SnapshotBlockStore["Service"],
  identity: SnapshotRepositoryIdentity,
  generation: number,
  block: VisibleDiffBlock,
  leaseLifetimeMs: number,
) {
  const nowMs = yield* Clock.currentTimeMillis
  const leaseId = ResourceLeaseId.make(
    `range:${hash(`${identity.sessionId}:${generation}:${identity.requestId}:${block.id}`)}`,
  )
  yield* resources.acquireLease({
    id: leaseId,
    resourceId: block.resource_id,
    ownerKind: "snapshotRange",
    ownerId: identity.sessionId,
    applicationInstanceId: identity.applicationInstanceId,
    processEpoch: identity.processEpoch,
    acquiredAtMs: nowMs,
    renewedAtMs: nowMs,
    expiresAtMs: nowMs + leaseLifetimeMs,
    purpose: "bounded snapshot range read",
  })
  return yield* Effect.acquireUseRelease(
    Effect.void,
    () =>
      store.readManagedRange(block.resource_id, 0, block.byte_count).pipe(
        Effect.map((range) => ({
          id: block.id,
          deltaId: block.delta_id,
          hunkId: block.hunk_id,
          ordinal: block.ordinal,
          firstLine: block.first_line,
          lineCount: block.line_count,
          bytes: range.bytes,
        })),
      ),
    () =>
      resources.releaseLease({
        id: leaseId,
        applicationInstanceId: identity.applicationInstanceId,
        processEpoch: identity.processEpoch,
      }),
  )
})

const selectLegalRange = (
  blocks: ReadonlyArray<VisibleDiffBlock>,
  startLine: number,
  maximumBytes: number,
): ReadonlyArray<VisibleDiffBlock> => {
  const first = blocks.findIndex((block) => startLine < block.first_line + block.line_count)
  if (first < 0) return []
  const selected: VisibleDiffBlock[] = []
  let bytes = 0
  for (let index = first; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block === undefined || bytes + block.byte_count > maximumBytes) break
    selected.push(block)
    bytes += block.byte_count
  }
  return selected
}

const sameSession = (
  active: Omit<SnapshotRepositoryIdentity, "requestId">,
  candidate: SnapshotRepositoryIdentity,
): boolean =>
  active.applicationInstanceId === candidate.applicationInstanceId &&
  active.processEpoch === candidate.processEpoch &&
  active.projectId === candidate.projectId &&
  active.reviewKey === candidate.reviewKey &&
  active.snapshotId === candidate.snapshotId &&
  active.sessionId === candidate.sessionId

const withoutRequest = (
  identity: SnapshotRepositoryIdentity,
): Omit<SnapshotRepositoryIdentity, "requestId"> => ({
  applicationInstanceId: identity.applicationInstanceId,
  processEpoch: identity.processEpoch,
  projectId: identity.projectId,
  reviewKey: identity.reviewKey,
  snapshotId: identity.snapshotId,
  sessionId: identity.sessionId,
})

const makeLazyBlockId = (deltaId: FileDeltaId, block: LazySnapshotBlock): DiffBlockId =>
  DiffBlockId.make(
    `block:v1:${hash(`${deltaId}:${block.hunkId ?? ""}:${block.ordinal}:${block.firstLine}:${checksum(block.bytes)}`)}`,
  )

const checksum = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`

const hash = (value: string): string => createHash("sha256").update(value).digest("hex")
