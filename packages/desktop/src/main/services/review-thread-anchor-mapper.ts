import { Context, Effect, Layer } from "effect"

import type { ParsedDiff, ParsedDiffFile, ParsedDiffHunk } from "../../shared/domain"
import type { ReviewKey, ReviewRevision } from "../../shared/review-identity"
import {
  LineReviewAnchor,
  type ReviewThreadAnchor,
  type ReviewAnchorStatus,
  type ReviewThread,
} from "../../shared/review-thread"
import {
  ReviewThreadStore,
  type ReviewThreadCurrentMapping,
  type ReviewThreadStoreError,
} from "./review-thread-store"

/** A coherent target revision used to remap every local thread for one review. */
export interface MapReviewThreadAnchorsInput {
  readonly repoId: string
  readonly reviewKey: ReviewKey
  readonly baseRevision: ReviewRevision
  readonly headRevision: ReviewRevision
  readonly parsedDiff: ParsedDiff
}

interface AnchorMapping {
  readonly currentAnchor: ReviewThreadAnchor | null
  readonly anchorStatus: ReviewAnchorStatus
}

type UniqueMatch<A> =
  | { readonly kind: "found"; readonly value: A }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" }

/** Maps persisted review-thread anchors into the latest parsed review revision. */
export class ReviewThreadAnchorMapper extends Context.Tag("@diffdash/ReviewThreadAnchorMapper")<
  ReviewThreadAnchorMapper,
  {
    readonly mapReview: (
      input: MapReviewThreadAnchorsInput,
    ) => Effect.Effect<readonly ReviewThread[], ReviewThreadStoreError>
  }
>() {
  static readonly layer = Layer.effect(
    ReviewThreadAnchorMapper,
    Effect.gen(function* () {
      const store = yield* ReviewThreadStore

      return ReviewThreadAnchorMapper.of({
        mapReview: Effect.fn("ReviewThreadAnchorMapper.mapReview")(function* (input) {
          const threads = yield* store.listForReview({
            repoId: input.repoId,
            reviewKey: input.reviewKey,
          })
          const mappings = threads.map((thread) =>
            toCurrentMapping(thread, input.baseRevision, input.headRevision, input.parsedDiff),
          )
          yield* store.updateCurrentMappings(mappings)
          return yield* store.listForReview({ repoId: input.repoId, reviewKey: input.reviewKey })
        }),
      })
    }),
  )
}

const toCurrentMapping = (
  thread: ReviewThread,
  currentBaseRevision: ReviewRevision,
  currentHeadRevision: ReviewRevision,
  diff: ParsedDiff,
): ReviewThreadCurrentMapping => ({
  threadId: thread.id,
  currentBaseRevision,
  currentHeadRevision,
  ...mapAnchor(thread, diff),
})

const mapAnchor = (thread: ReviewThread, diff: ParsedDiff): AnchorMapping => {
  const anchor = thread.currentAnchor ?? thread.originalAnchor
  const fileMatch = findFile(anchor, diff)

  if (fileMatch.kind === "missing") return { currentAnchor: null, anchorStatus: "outdated" }
  if (fileMatch.kind === "ambiguous") {
    return { currentAnchor: null, anchorStatus: "unresolved_anchor" }
  }

  const file = fileMatch.value
  return mapLineAnchor(anchor, file)
}

const findFile = (anchor: LineReviewAnchor, diff: ParsedDiff): UniqueMatch<ParsedDiffFile> => {
  const tiers = [
    diff.files.filter((file) => file.fileId === anchor.fileId),
    diff.files.filter((file) => file.path === anchor.filePath),
    diff.files.filter((file) => file.status === "renamed" && file.oldPath === anchor.filePath),
  ]
  for (const candidates of tiers) {
    if (candidates.length > 1) return { kind: "ambiguous" }
    const candidate = candidates[0]
    if (candidate !== undefined) return { kind: "found", value: candidate }
  }
  return { kind: "missing" }
}

const mapLineAnchor = (anchor: LineReviewAnchor, file: ParsedDiffFile): AnchorMapping => {
  const hunkMatch = findHunk(anchor.hunkId, anchor.hunkFingerprint, file)
  if (hunkMatch.kind === "missing")
    return { currentAnchor: null, anchorStatus: "unresolved_anchor" }
  if (hunkMatch.kind === "ambiguous") {
    return { currentAnchor: null, anchorStatus: "unresolved_anchor" }
  }

  const lineIndex = findAnchoredLineIndex(anchor, hunkMatch.value.lines)
  if (lineIndex === null) return { currentAnchor: null, anchorStatus: "unresolved_anchor" }
  const lineNumber = lineNumberAtIndex(hunkMatch.value, anchor.side, lineIndex)
  if (lineNumber === null) return { currentAnchor: null, anchorStatus: "unresolved_anchor" }

  return {
    currentAnchor: LineReviewAnchor.make({
      fileId: file.fileId,
      filePath: file.path,
      oldPath: file.oldPath,
      hunkId: hunkMatch.value.id,
      hunkFingerprint: hunkMatch.value.fingerprint,
      hunkHeader: hunkMatch.value.header,
      side: anchor.side,
      lineNumber,
      lineContent: anchor.lineContent,
    }),
    anchorStatus: "active",
  }
}

const findHunk = (
  hunkId: LineReviewAnchor["hunkId"],
  fingerprint: LineReviewAnchor["hunkFingerprint"],
  file: ParsedDiffFile,
): UniqueMatch<ParsedDiffHunk> => {
  const exact = file.hunks.filter((hunk) => hunk.id === hunkId && hunk.fingerprint === fingerprint)
  if (exact.length > 1) return { kind: "ambiguous" }
  if (exact[0] !== undefined) return { kind: "found", value: exact[0] }

  const fingerprints = file.hunks.filter((hunk) => hunk.fingerprint === fingerprint)
  if (fingerprints.length > 1) return { kind: "ambiguous" }
  if (fingerprints[0] !== undefined) return { kind: "found", value: fingerprints[0] }
  return { kind: "missing" }
}

const findAnchoredLineIndex = (anchor: LineReviewAnchor, lines: readonly string[]) => {
  const starts = parseHunkStarts(anchor.hunkHeader)
  if (starts === null) return null
  let oldLine = starts.oldStart
  let newLine = starts.newStart

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    const hasOldSide = line.startsWith(" ") || line.startsWith("-")
    const hasNewSide = line.startsWith(" ") || line.startsWith("+")
    const sourceLine = anchor.side === "old" ? oldLine : newLine
    const hasSide = anchor.side === "old" ? hasOldSide : hasNewSide
    if (hasSide && sourceLine === anchor.lineNumber && line.slice(1) === anchor.lineContent) {
      return index
    }
    if (hasOldSide) oldLine += 1
    if (hasNewSide) newLine += 1
  }
  return null
}

const lineNumberAtIndex = (
  hunk: ParsedDiffHunk,
  side: LineReviewAnchor["side"],
  targetIndex: number,
) => {
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  for (let index = 0; index < hunk.lines.length; index += 1) {
    const line = hunk.lines[index]
    if (line === undefined) continue
    const hasOldSide = line.startsWith(" ") || line.startsWith("-")
    const hasNewSide = line.startsWith(" ") || line.startsWith("+")
    if (index === targetIndex) {
      if (side === "old") return hasOldSide ? oldLine : null
      return hasNewSide ? newLine : null
    }
    if (hasOldSide) oldLine += 1
    if (hasNewSide) newLine += 1
  }
  return null
}

const parseHunkStarts = (header: string) => {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header)
  if (match === null) return null
  return { oldStart: Number(match[1]), newStart: Number(match[2]) }
}
