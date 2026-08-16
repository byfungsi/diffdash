import { Context, Effect, Layer } from "effect"

import { findProjectedDiffHunkLine, projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"
import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  CurrentReviewAnchor,
  LineReviewAnchor,
  type ReviewThread,
} from "@diffdash/domain/review-thread"
import {
  ReviewThreadStore,
  type ReviewThreadStoreError,
} from "@diffdash/persistence/review-thread-store"
import type { SnapshotFilePlacement, StoredHunk } from "@diffdash/persistence/snapshot-block-store"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"

import {
  OPERATION_SNAPSHOT_HUNK_LIMIT,
  OPERATION_SNAPSHOT_INVENTORY_LIMIT,
  type OperationSnapshotHandle,
  type OperationSnapshotReaderError,
} from "./operation-snapshot-reader"
import { decodeSnapshotHunkLines, projectSnapshotHunk } from "./operation-snapshot-projection"

/** A bounded reader and repository identity used to remap local threads for one revision. */
interface MapReviewThreadAnchorsInput {
  readonly repoId: Parameters<ReviewThreadStore["Service"]["listForReview"]>[0]["repoId"]
  readonly handle: OperationSnapshotHandle
}

type MappingError = ReviewThreadStoreError | OperationSnapshotReaderError

type UniqueMatch<A> =
  | { readonly kind: "found"; readonly value: A }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" }

/** Maps persisted anchors using bounded inventory pages and targeted hunk reads. */
export class ReviewThreadAnchorMapper extends Context.Service<
  ReviewThreadAnchorMapper,
  {
    readonly mapReview: (
      input: MapReviewThreadAnchorsInput,
    ) => Effect.Effect<readonly ReviewThread[], MappingError>
  }
>()("@diffdash/ReviewThreadAnchorMapper") {
  static readonly layer = Layer.effect(
    ReviewThreadAnchorMapper,
    Effect.gen(function* () {
      const store = yield* ReviewThreadStore

      return ReviewThreadAnchorMapper.of({
        mapReview: Effect.fn("ReviewThreadAnchorMapper.mapReview")(function* (input) {
          const snapshot = input.handle.snapshot
          const threads = yield* store.listForReview({
            repoId: input.repoId,
            reviewKey: ReviewKey.make(snapshot.reviewKey),
          })
          const mappings = yield* Effect.forEach(threads, (thread) =>
            toCurrentMapping(thread, input.handle),
          )
          yield* store.updateCurrentMappings(mappings)
          return yield* store.listForReview({
            repoId: input.repoId,
            reviewKey: ReviewKey.make(snapshot.reviewKey),
          })
        }),
      })
    }),
  )
}

const toCurrentMapping = Effect.fn("ReviewThreadAnchorMapper.toCurrentMapping")(function* (
  thread: ReviewThread,
  handle: OperationSnapshotHandle,
) {
  const currentAnchor = yield* mapAnchor(thread, handle)
  return {
    threadId: thread.id,
    currentBaseRevision: ReviewRevision.make(handle.snapshot.baseRevision),
    currentHeadRevision: ReviewRevision.make(handle.snapshot.headRevision),
    currentAnchor,
  }
})

const mapAnchor = Effect.fn("ReviewThreadAnchorMapper.mapAnchor")(function* (
  thread: ReviewThread,
  handle: OperationSnapshotHandle,
) {
  const anchor = thread.displayAnchor
  const fileMatch = yield* findFile(anchor, handle)
  if (fileMatch.kind === "missing") return CurrentReviewAnchor.cases.Outdated.make({})
  if (fileMatch.kind === "ambiguous") return CurrentReviewAnchor.cases.Unresolved.make({})
  const file = fileMatch.value
  if (file === undefined) return CurrentReviewAnchor.cases.Outdated.make({})

  const hunkMatch = yield* findHunk(anchor, file, handle)
  if (hunkMatch.kind !== "found") return CurrentReviewAnchor.cases.Unresolved.make({})
  const hunk = hunkMatch.value
  if (hunk === undefined) return CurrentReviewAnchor.cases.Unresolved.make({})
  const read = yield* handle.readHunk(ReviewFileId.make(file.fileId), ReviewHunkId.make(hunk.id))
  const lines = yield* decodeSnapshotHunkLines(read.bytes)
  const projected = projectSnapshotHunk(read.hunk, lines)
  const anchorStarts = parseHunkStarts(anchor.hunkHeader)
  if (anchorStarts === null) return CurrentReviewAnchor.cases.Unresolved.make({})
  const sourceLine = findProjectedDiffHunkLine(projectDiffHunkLines(projected, anchorStarts), {
    side: anchor.side,
    lineNumber: anchor.lineNumber,
    content: anchor.lineContent,
  })
  if (sourceLine === null) return CurrentReviewAnchor.cases.Unresolved.make({})
  const currentLine = projectDiffHunkLines(projected)[sourceLine.index]
  const lineNumber = anchor.side === "old" ? currentLine?.oldLineNumber : currentLine?.newLineNumber
  if (lineNumber === null || lineNumber === undefined)
    return CurrentReviewAnchor.cases.Unresolved.make({})

  return CurrentReviewAnchor.cases.Active.make({
    anchor: LineReviewAnchor.make({
      fileId: ReviewFileId.make(file.fileId),
      filePath: RepositoryRelativePath.make(file.path),
      oldPath: file.oldPath === null ? null : RepositoryRelativePath.make(file.oldPath),
      hunkId: ReviewHunkId.make(hunk.id),
      hunkFingerprint: ReviewHunkFingerprint.make(hunk.fingerprint),
      hunkHeader: hunk.header,
      side: anchor.side,
      lineNumber,
      lineContent: anchor.lineContent,
    }),
  })
})

const findFile = Effect.fn("ReviewThreadAnchorMapper.findFile")(function* (
  anchor: LineReviewAnchor,
  handle: OperationSnapshotHandle,
) {
  const tiers: [SnapshotFilePlacement[], SnapshotFilePlacement[], SnapshotFilePlacement[]] = [
    [],
    [],
    [],
  ]
  let offset = 0
  for (;;) {
    const page = yield* handle.inventory(offset, OPERATION_SNAPSHOT_INVENTORY_LIMIT)
    for (const file of page) {
      if (file.fileId === anchor.fileId) tiers[0].push(file)
      if (file.path === anchor.filePath) tiers[1].push(file)
      if (file.status === "renamed" && file.oldPath === anchor.filePath) tiers[2].push(file)
    }
    if (page.length < OPERATION_SNAPSHOT_INVENTORY_LIMIT) break
    offset += page.length
  }
  for (const candidates of tiers) {
    if (candidates.length > 1) return { kind: "ambiguous" }
    const candidate = candidates[0]
    if (candidate !== undefined)
      return { kind: "found", value: candidate } satisfies UniqueMatch<SnapshotFilePlacement>
  }
  return { kind: "missing" }
})

const parseHunkStarts = (header: string) => {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header)
  if (match === null) return null
  return { oldStart: Number(match[1]), newStart: Number(match[2]) }
}

const findHunk = Effect.fn("ReviewThreadAnchorMapper.findHunk")(function* (
  anchor: LineReviewAnchor,
  file: SnapshotFilePlacement,
  handle: OperationSnapshotHandle,
) {
  const exact: StoredHunk[] = []
  const fingerprints: StoredHunk[] = []
  let offset = 0
  for (;;) {
    const page = yield* handle.hunks(
      ReviewFileId.make(file.fileId),
      offset,
      OPERATION_SNAPSHOT_HUNK_LIMIT,
    )
    for (const hunk of page) {
      if (hunk.id === anchor.hunkId && hunk.fingerprint === anchor.hunkFingerprint) exact.push(hunk)
      if (hunk.fingerprint === anchor.hunkFingerprint) fingerprints.push(hunk)
    }
    if (page.length < OPERATION_SNAPSHOT_HUNK_LIMIT) break
    offset += page.length
  }
  if (exact.length > 1) return { kind: "ambiguous" }
  const exactCandidate = exact[0]
  if (exactCandidate !== undefined)
    return { kind: "found", value: exactCandidate } satisfies UniqueMatch<StoredHunk>
  if (fingerprints.length > 1) return { kind: "ambiguous" }
  const fingerprintCandidate = fingerprints[0]
  if (fingerprintCandidate !== undefined)
    return { kind: "found", value: fingerprintCandidate } satisfies UniqueMatch<StoredHunk>
  return { kind: "missing" }
})
