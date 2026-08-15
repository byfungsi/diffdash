import { createHash } from "node:crypto"

import { ReviewFileId, ReviewHunkFingerprint, ReviewHunkId } from "@diffdash/domain/review-identity"
import type { SnapshotFilePlacement, StoredHunk } from "@diffdash/persistence/snapshot-block-store"
import { Context, Effect, Layer, Schema } from "effect"

import {
  SnapshotRepository,
  type SnapshotRepositoryError,
  type SnapshotRepositoryIdentity,
} from "./snapshot-repository"

/** Stable content coordinate used to resume a directional search rescan. */
export interface SnapshotSearchCoordinate {
  readonly fileOrdinal: number
  readonly hunkOrdinal: number
  readonly hunkLineIndex: number
  readonly start: number
}

/** Query-bound semantic cursor; it does not encode a retained match-array offset. */
export interface SnapshotSearchCursor {
  readonly queryIdentity: string
  readonly coordinate: SnapshotSearchCoordinate
}

/** Independently byte-capped source context around one literal occurrence. */
export interface SnapshotSearchExcerpt {
  readonly text: string
  readonly start: number
  readonly end: number
  readonly omittedBefore: boolean
  readonly omittedAfter: boolean
  readonly utf8Bytes: number
}

/** One non-overlapping literal occurrence in canonical committed diff content. */
export interface SnapshotSearchMatch {
  readonly id: string
  readonly fileId: ReviewFileId
  readonly filePath: string
  readonly hunkId: ReviewHunkId
  readonly hunkFingerprint: ReviewHunkFingerprint
  readonly hunkLineIndex: number
  readonly newLineNumber: number | null
  readonly oldLineNumber: number | null
  readonly side: "additions" | "context" | "deletions"
  readonly start: number
  readonly end: number
  readonly coordinate: SnapshotSearchCoordinate
  readonly excerpt: SnapshotSearchExcerpt
}

/** Monotonic lower-bound update emitted before a complete scan exists. */
export interface SnapshotSearchProvisional {
  readonly kind: "provisional"
  readonly lowerBoundMatches: number
  readonly matches: ReadonlyArray<SnapshotSearchMatch>
  readonly previousCursor: null
  readonly nextCursor: null
  readonly wrapped: false
}

/** Exact total and bounded page produced after scanning the complete snapshot. */
export interface SnapshotSearchFinal {
  readonly kind: "final"
  readonly totalMatches: number
  readonly matches: ReadonlyArray<SnapshotSearchMatch>
  readonly previousCursor: SnapshotSearchCursor | null
  readonly nextCursor: SnapshotSearchCursor | null
  readonly wrapped: boolean
}

/** Literal search request over one generation-scoped committed snapshot. */
export interface SnapshotSearchInput {
  readonly identity: SnapshotRepositoryIdentity
  readonly query: string
  readonly anchorFileId: ReviewFileId | null
  readonly direction: "next" | "previous"
  readonly cursor: SnapshotSearchCursor | null
  readonly limit: number
}

/** Fixed limits controlling retained results and independently capped excerpts. */
export interface SnapshotSearchOptions {
  readonly maximumPageMatches: number
  readonly maximumExcerptBytes: number
}

const SnapshotSearchFailureReason = Schema.Literals([
  "invalidRequest",
  "invalidCursor",
  "sourceUnavailable",
  "superseded",
])

/** Expected fixed-space search rejection. */
export class SnapshotSearchError extends Schema.TaggedError<SnapshotSearchError>()(
  "SnapshotSearchError",
  {
    reason: SnapshotSearchFailureReason,
    message: Schema.String,
  },
) {}

/** Core application service for progressive scans and bounded directional rescans. */
export class SnapshotSearch extends Context.Service<
  SnapshotSearch,
  {
    readonly scan: (
      input: SnapshotSearchInput,
      onProgress: (progress: SnapshotSearchProvisional) => Effect.Effect<void>,
    ) => Effect.Effect<SnapshotSearchFinal, SnapshotSearchError>
  }
>()("@diffdash/core/SnapshotSearch") {}

/** Builds fixed-space search while leaving committed snapshot authority visible to composition. */
export const snapshotSearchLayer = (
  options: SnapshotSearchOptions,
): Layer.Layer<SnapshotSearch, never, SnapshotRepository> =>
  Layer.effect(
    SnapshotSearch,
    Effect.gen(function* () {
      const repository = yield* SnapshotRepository
      let generation = 0

      return SnapshotSearch.of({
        scan: Effect.fn("SnapshotSearch.scan")(function* (input, onProgress) {
          if (
            input.query.length === 0 ||
            !Number.isSafeInteger(input.limit) ||
            input.limit <= 0 ||
            input.limit > options.maximumPageMatches ||
            utf8Length(input.query) > options.maximumExcerptBytes
          ) {
            return yield* SnapshotSearchError.make({
              reason: "invalidRequest",
              message: "Search query, page limit, or excerpt budget is invalid",
            })
          }

          const searchGeneration = ++generation
          const identity = input.identity
          const queryIdentity = searchQueryIdentity(identity, input.query, input.anchorFileId)
          if (input.cursor !== null && input.cursor.queryIdentity !== queryIdentity) {
            return yield* SnapshotSearchError.make({
              reason: "invalidCursor",
              message: "Search cursor belongs to another query or snapshot",
            })
          }

          return yield* scanCommittedSnapshot(
            repository,
            identity,
            input,
            queryIdentity,
            options.maximumExcerptBytes,
            onProgress,
            () => generation === searchGeneration,
          )
        }),
      })
    }),
  )

const scanCommittedSnapshot = Effect.fn("SnapshotSearch.scanCommittedSnapshot")(function* (
  repository: SnapshotRepository["Service"],
  identity: SnapshotRepositoryIdentity,
  input: SnapshotSearchInput,
  queryIdentity: string,
  maximumExcerptBytes: number,
  onProgress: (progress: SnapshotSearchProvisional) => Effect.Effect<void>,
  isCurrent: () => boolean,
) {
  const anchorOrdinal =
    input.anchorFileId === null
      ? 0
      : (yield* repository
          .findFile(identity, input.anchorFileId)
          .pipe(Effect.mapError(mapRepositoryError))).ordinal
  const selected: Array<{ readonly match: SnapshotSearchMatch; readonly index: number }> = []
  let previousWindow: Array<{ readonly match: SnapshotSearchMatch; readonly index: number }> = []
  let totalMatches = 0
  let cursorFound = input.cursor === null

  const visitMatch = (match: SnapshotSearchMatch): void => {
    const index = totalMatches
    totalMatches += 1
    const isCursor =
      input.cursor !== null && sameCoordinate(match.coordinate, input.cursor.coordinate)
    if (input.direction === "next") {
      if (isCursor) {
        cursorFound = true
      } else if (cursorFound && selected.length < input.limit) {
        selected.push({ match, index })
      }
      return
    }
    if (isCursor) {
      cursorFound = true
      selected.push(...previousWindow)
      previousWindow = []
      return
    }
    if (input.cursor === null || !cursorFound) {
      previousWindow.push({ match, index })
      if (previousWindow.length > input.limit) previousWindow.shift()
    }
  }

  const visitRange = Effect.fn("SnapshotSearch.visitRange")(function* (
    file: SnapshotFilePlacement,
    state: { current: HunkState | null },
    startLine: number,
  ) {
    const range = yield* repository
      .readRange(identity, ReviewFileId.make(file.fileId), startLine)
      .pipe(Effect.mapError(mapRepositoryError))
    for (const block of range.blocks) {
      if (block.hunkId === null) continue
      if (state.current?.hunk.id !== block.hunkId) {
        const hunk = yield* repository
          .findFileHunk(identity, ReviewFileId.make(file.fileId), ReviewHunkId.make(block.hunkId))
          .pipe(Effect.mapError(mapRepositoryError))
        state.current = makeHunkState(hunk)
      }
      const hunkState = state.current
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(block.bytes),
        catch: () =>
          SnapshotSearchError.make({
            reason: "sourceUnavailable",
            message: "Committed snapshot block is not valid UTF-8",
          }),
      })
      for (const patchLine of splitPatchLines(text)) {
        const line = projectLine(hunkState, patchLine)
        if (line === null) continue
        for (let start = line.content.indexOf(input.query); start >= 0; ) {
          visitMatch(
            makeMatch(file, hunkState.hunk, line, start, input.query.length, maximumExcerptBytes),
          )
          start = line.content.indexOf(input.query, start + input.query.length)
        }
      }
      const provisionalMatches =
        input.direction === "previous" && input.cursor === null
          ? previousWindow.map(({ match }) => match)
          : selected.map(({ match }) => match)
      yield* onProgress({
        kind: "provisional",
        lowerBoundMatches: totalMatches,
        matches: provisionalMatches,
        previousCursor: null,
        nextCursor: null,
        wrapped: false,
      })
      if (!isCurrent()) {
        return yield* SnapshotSearchError.make({
          reason: "superseded",
          message: "Search was superseded by a newer query",
        })
      }
      yield* repository
        .findFile(identity, ReviewFileId.make(file.fileId))
        .pipe(Effect.asVoid, Effect.mapError(mapRepositoryError))
    }
    const last = range.blocks.at(-1)
    return {
      complete: range.complete,
      nextLine: last === undefined ? startLine : last.firstLine + last.lineCount,
    }
  })

  for (const [start, end] of [
    [anchorOrdinal, Number.MAX_SAFE_INTEGER],
    [0, anchorOrdinal],
  ] as const) {
    let offset = start
    while (offset < end) {
      const page = yield* repository
        .inventory(identity, offset, Math.min(64, end - offset))
        .pipe(Effect.mapError(mapRepositoryError))
      if (page.files.length === 0) break
      for (const file of page.files) {
        if (file.ordinal >= end) break
        const state: { current: HunkState | null } = { current: null }
        let startLine = 0
        for (;;) {
          const step = yield* visitRange(file, state, startLine)
          if (step.complete || step.nextLine <= startLine) break
          startLine = step.nextLine
        }
      }
      if (page.nextOffset === null || page.nextOffset <= offset) break
      offset = page.nextOffset
    }
  }

  if (input.direction === "previous" && input.cursor === null) selected.push(...previousWindow)
  if (!cursorFound) {
    return yield* SnapshotSearchError.make({
      reason: "invalidCursor",
      message: "Search cursor coordinate no longer exists",
    })
  }
  const first = selected.at(0)
  const last = selected.at(-1)
  const previousCursor =
    first !== undefined && first.index > 0
      ? { queryIdentity, coordinate: first.match.coordinate }
      : null
  const nextCursor =
    last !== undefined && last.index < totalMatches - 1
      ? { queryIdentity, coordinate: last.match.coordinate }
      : null
  return {
    kind: "final",
    totalMatches,
    matches: selected.map(({ match }) => match),
    previousCursor,
    nextCursor,
    wrapped: input.anchorFileId !== null && anchorOrdinal > 0,
  } satisfies SnapshotSearchFinal
})

interface HunkState {
  readonly hunk: StoredHunk
  hunkLineIndex: number
  oldLineNumber: number
  newLineNumber: number
}

interface ProjectedLine {
  readonly content: string
  readonly hunkLineIndex: number
  readonly oldLineNumber: number | null
  readonly newLineNumber: number | null
  readonly side: SnapshotSearchMatch["side"]
}

const makeHunkState = (hunk: StoredHunk): HunkState => ({
  hunk,
  hunkLineIndex: 0,
  oldLineNumber: hunk.oldStart,
  newLineNumber: hunk.newStart,
})

const projectLine = (state: HunkState, patchLine: string): ProjectedLine | null => {
  const hunkLineIndex = state.hunkLineIndex
  state.hunkLineIndex += 1
  const marker = patchLine[0]
  if (marker === " ") {
    const line = {
      content: patchLine.slice(1),
      hunkLineIndex,
      oldLineNumber: state.oldLineNumber,
      newLineNumber: state.newLineNumber,
      side: "context" as const,
    }
    state.oldLineNumber += 1
    state.newLineNumber += 1
    return line
  }
  if (marker === "-") {
    const line = {
      content: patchLine.slice(1),
      hunkLineIndex,
      oldLineNumber: state.oldLineNumber,
      newLineNumber: null,
      side: "deletions" as const,
    }
    state.oldLineNumber += 1
    return line
  }
  if (marker === "+") {
    const line = {
      content: patchLine.slice(1),
      hunkLineIndex,
      oldLineNumber: null,
      newLineNumber: state.newLineNumber,
      side: "additions" as const,
    }
    state.newLineNumber += 1
    return line
  }
  return null
}

const makeMatch = (
  file: SnapshotFilePlacement,
  hunk: StoredHunk,
  line: ProjectedLine,
  start: number,
  queryLength: number,
  maximumExcerptBytes: number,
): SnapshotSearchMatch => {
  const coordinate = {
    fileOrdinal: file.ordinal,
    hunkOrdinal: hunk.ordinal,
    hunkLineIndex: line.hunkLineIndex,
    start,
  }
  return {
    id: `${file.fileId}:${hunk.id}:${line.hunkLineIndex}:${start}`,
    fileId: ReviewFileId.make(file.fileId),
    filePath: file.path,
    hunkId: ReviewHunkId.make(hunk.id),
    hunkFingerprint: ReviewHunkFingerprint.make(hunk.fingerprint),
    hunkLineIndex: line.hunkLineIndex,
    newLineNumber: line.newLineNumber,
    oldLineNumber: line.oldLineNumber,
    side: line.side,
    start,
    end: start + queryLength,
    coordinate,
    excerpt: makeExcerpt(line.content, start, start + queryLength, maximumExcerptBytes),
  }
}

const makeExcerpt = (
  content: string,
  matchStart: number,
  matchEnd: number,
  maximumBytes: number,
): SnapshotSearchExcerpt => {
  let start = matchStart
  let end = matchEnd
  while (true) {
    let changed = false
    if (start > 0) {
      const candidate = previousCodePointStart(content, start)
      if (utf8Length(content.slice(candidate, end)) <= maximumBytes) {
        start = candidate
        changed = true
      }
    }
    if (end < content.length) {
      const candidate = nextCodePointEnd(content, end)
      if (utf8Length(content.slice(start, candidate)) <= maximumBytes) {
        end = candidate
        changed = true
      }
    }
    if (!changed) break
  }
  const text = content.slice(start, end)
  return {
    text,
    start: matchStart - start,
    end: matchEnd - start,
    omittedBefore: start > 0,
    omittedAfter: end < content.length,
    utf8Bytes: utf8Length(text),
  }
}

const previousCodePointStart = (value: string, index: number): number => {
  const candidate = index - 1
  const unit = value.charCodeAt(candidate)
  return unit >= 0xdc00 && unit <= 0xdfff && candidate > 0 ? candidate - 1 : candidate
}

const nextCodePointEnd = (value: string, index: number): number => {
  const unit = value.charCodeAt(index)
  return unit >= 0xd800 && unit <= 0xdbff ? Math.min(value.length, index + 2) : index + 1
}

const splitPatchLines = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

const sameCoordinate = (left: SnapshotSearchCoordinate, right: SnapshotSearchCoordinate): boolean =>
  left.fileOrdinal === right.fileOrdinal &&
  left.hunkOrdinal === right.hunkOrdinal &&
  left.hunkLineIndex === right.hunkLineIndex &&
  left.start === right.start

const searchQueryIdentity = (
  identity: SnapshotRepositoryIdentity,
  query: string,
  anchorFileId: ReviewFileId | null,
): string =>
  createHash("sha256")
    .update(identity.snapshotId)
    .update("\0")
    .update(query)
    .update("\0")
    .update(anchorFileId ?? "")
    .digest("hex")

const mapRepositoryError = (error: SnapshotRepositoryError): SnapshotSearchError =>
  SnapshotSearchError.make({ reason: "sourceUnavailable", message: error.message })

const utf8Length = (value: string): number => Buffer.byteLength(value, "utf8")
