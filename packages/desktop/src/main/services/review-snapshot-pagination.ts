import type { ParsedDiffFile } from "@diffdash/domain/diff"
import { projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"
import type { ReviewSnapshot } from "@diffdash/domain/review-context"
import { makeReviewSnapshotManifest } from "@diffdash/domain/review-context"
import type { ReviewFileId } from "@diffdash/domain/review-identity"
import {
  assertJsonPayloadWithinBudget,
  jsonSafeUtf8ByteLength,
} from "@diffdash/protocol/payload-budget"
import {
  REVIEW_SNAPSHOT_PAGE_FILE_LIMIT,
  ReviewSnapshotExpired,
  ReviewSnapshotFileTooLarge,
  ReviewSnapshotPageAvailable,
  ReviewSnapshotPageCursor,
  type ReviewSnapshotPageRequest,
  type ReviewSnapshotPageResponse,
  ReviewSnapshotPageResponse as ReviewSnapshotPageResponseSchema,
  ReviewSnapshotSearchAvailable,
  ReviewSnapshotSearchCursor,
  type ReviewSnapshotSearchFileAnchor,
  ReviewSnapshotSearchMatch,
  type ReviewSnapshotSearchRequest,
  type ReviewSnapshotSearchResponse,
  ReviewSnapshotSearchResponse as ReviewSnapshotSearchResponseSchema,
} from "@diffdash/protocol/review-snapshot"
import { transportError } from "@diffdash/protocol/transport-error"
import { Schema } from "effect"

/** Builds one stable, complete-file page under the supplied encoded response byte limit. */
export const paginateReviewSnapshot = (
  snapshot: ReviewSnapshot,
  request: ReviewSnapshotPageRequest,
  maxResponseBytes: number,
): ReviewSnapshotPageResponse => {
  if (request.snapshotId !== snapshot.snapshotId) {
    return ReviewSnapshotExpired.make({ snapshotId: request.snapshotId, reason: "mismatched" })
  }
  const selected = selectFiles(snapshot, request.fileIds)
  if (selected === null) {
    return ReviewSnapshotExpired.make({ snapshotId: request.snapshotId, reason: "mismatched" })
  }
  const selectionHash = stableCursorHash(selected.map((file) => file.fileId))
  const offset = decodeCursor(request.cursor, "page", selectionHash)
  if (offset === null || offset > selected.length) {
    return ReviewSnapshotExpired.make({ snapshotId: request.snapshotId, reason: "mismatched" })
  }

  const files: ParsedDiffFile[] = []
  const pageEnd = Math.min(selected.length, offset + REVIEW_SNAPSHOT_PAGE_FILE_LIMIT)
  for (let index = offset; index < pageEnd; index += 1) {
    const file = selected[index]
    if (file === undefined) break
    const nextOffset = index + 1
    const candidateFiles = [...files, file]
    const candidate = ReviewSnapshotPageAvailable.make({
      snapshotId: snapshot.snapshotId,
      files: candidateFiles,
      nextCursor: nextOffset < selected.length ? makePageCursor(nextOffset, selectionHash) : null,
    })
    if (encodedByteLength(ReviewSnapshotPageResponseSchema, candidate) > maxResponseBytes) break
    files.push(file)
  }

  if (files.length === 0 && offset < selected.length) {
    const file = selected[offset]
    if (file === undefined) {
      return ReviewSnapshotExpired.make({ snapshotId: request.snapshotId, reason: "mismatched" })
    }
    const inventory = makeReviewSnapshotManifest(snapshot).files.find(
      (candidate) => candidate.fileId === file.fileId,
    )
    if (inventory === undefined) {
      return ReviewSnapshotExpired.make({ snapshotId: request.snapshotId, reason: "mismatched" })
    }
    const response = ReviewSnapshotFileTooLarge.make({
      snapshotId: snapshot.snapshotId,
      file: inventory,
      maxResponseBytes,
    })
    assertEncodedBudget(ReviewSnapshotPageResponseSchema, response, maxResponseBytes)
    return response
  }

  const nextOffset = offset + files.length
  const response = ReviewSnapshotPageAvailable.make({
    snapshotId: snapshot.snapshotId,
    files,
    nextCursor: nextOffset < selected.length ? makePageCursor(nextOffset, selectionHash) : null,
  })
  assertEncodedBudget(ReviewSnapshotPageResponseSchema, response, maxResponseBytes)
  return response
}

/** Searches every cached parsed hunk and returns one stable bounded result page. */
export const searchReviewSnapshot = (
  snapshot: ReviewSnapshot,
  request: ReviewSnapshotSearchRequest,
  maxResponseBytes: number,
): ReviewSnapshotSearchResponse => {
  if (request.snapshotId !== snapshot.snapshotId) {
    return ReviewSnapshotExpired.make({ snapshotId: request.snapshotId, reason: "mismatched" })
  }
  const queryHash = stableCursorHash([request.query, searchAnchorKey(request.anchor)])
  const offset = decodeCursor(request.cursor, "search", queryHash)
  const matches = anchoredSearchMatches(snapshot, request.query, request.anchor)
  if (matches === null) {
    return ReviewSnapshotExpired.make({ snapshotId: request.snapshotId, reason: "mismatched" })
  }
  if (offset === null || offset > matches.length) {
    return ReviewSnapshotExpired.make({ snapshotId: request.snapshotId, reason: "mismatched" })
  }

  const page: ReviewSnapshotSearchMatch[] = []
  const end = Math.min(matches.length, offset + request.limit)
  for (let index = offset; index < end; index += 1) {
    const match = matches[index]
    if (match === undefined) break
    const nextOffset = index + 1
    const candidateMatches = [...page, match]
    const candidate = ReviewSnapshotSearchAvailable.make({
      snapshotId: snapshot.snapshotId,
      matches: candidateMatches,
      totalMatches: matches.length,
      nextCursor: nextOffset < matches.length ? makeSearchCursor(nextOffset, queryHash) : null,
    })
    if (encodedByteLength(ReviewSnapshotSearchResponseSchema, candidate) > maxResponseBytes) break
    page.push(match)
  }

  if (page.length === 0 && offset < matches.length) {
    throw transportError(
      "PAYLOAD_TOO_LARGE",
      "One review search result exceeds the bounded response size.",
      "reviewSnapshots:search",
    )
  }
  const nextOffset = offset + page.length
  const response = ReviewSnapshotSearchAvailable.make({
    snapshotId: snapshot.snapshotId,
    matches: page,
    totalMatches: matches.length,
    nextCursor: nextOffset < matches.length ? makeSearchCursor(nextOffset, queryHash) : null,
  })
  assertEncodedBudget(ReviewSnapshotSearchResponseSchema, response, maxResponseBytes)
  return response
}

const selectFiles = (snapshot: ReviewSnapshot, fileIds: readonly ReviewFileId[]) => {
  if (fileIds.length === 0) return snapshot.parsedDiff.files
  if (new Set(fileIds).size !== fileIds.length) return null
  const filesById = new Map(snapshot.parsedDiff.files.map((file) => [file.fileId, file]))
  const selected = fileIds.flatMap((fileId) => {
    const file = filesById.get(fileId)
    return file === undefined ? [] : [file]
  })
  return selected.length === fileIds.length ? selected : null
}

const allSearchMatches = (snapshot: ReviewSnapshot, query: string) => {
  const expression = new RegExp(escapeRegExp(query), "giu")
  const matches: ReviewSnapshotSearchMatch[] = []
  for (const file of snapshot.parsedDiff.files) {
    for (const hunk of file.hunks) {
      for (const line of projectDiffHunkLines(hunk)) {
        if (line.kind === "metadata") continue
        expression.lastIndex = 0
        for (
          let match = expression.exec(line.content);
          match !== null;
          match = expression.exec(line.content)
        ) {
          matches.push(
            ReviewSnapshotSearchMatch.make({
              id: `${file.fileId}:${hunk.id}:${line.index}:${match.index}`,
              fileId: file.fileId,
              filePath: file.path,
              reviewKey: file.reviewKey,
              hunkId: hunk.id,
              hunkLineIndex: line.index,
              newLineNumber: line.newLineNumber,
              oldLineNumber: line.oldLineNumber,
              side:
                line.kind === "context"
                  ? "context"
                  : line.kind === "deletion"
                    ? "deletions"
                    : "additions",
              text: line.content,
              start: match.index,
              end: match.index + match[0].length,
            }),
          )
        }
      }
    }
  }
  return matches
}

const anchoredSearchMatches = (
  snapshot: ReviewSnapshot,
  query: string,
  anchor: ReviewSnapshotSearchFileAnchor | null,
) => {
  const matches = allSearchMatches(snapshot, query)
  if (anchor === null || matches.length === 0) return matches
  const anchorFileIndex = snapshot.parsedDiff.files.findIndex(
    (file) => file.fileId === anchor.fileId,
  )
  if (anchorFileIndex < 0) return null

  const filesById = new Map(
    snapshot.parsedDiff.files.map((file, fileIndex) => [file.fileId, fileIndex]),
  )
  const startIndex = matches.findIndex((match) => {
    const fileIndex = filesById.get(match.fileId)
    return fileIndex !== undefined && fileIndex >= anchorFileIndex
  })
  if (startIndex <= 0) return matches
  return [...matches.slice(startIndex), ...matches.slice(0, startIndex)]
}

const searchAnchorKey = (anchor: ReviewSnapshotSearchFileAnchor | null) =>
  anchor === null ? "" : `file:${anchor.fileId}`

const makePageCursor = (offset: number, hash: string) =>
  ReviewSnapshotPageCursor.make(`page:v1:${offset}:${hash}`)

const makeSearchCursor = (offset: number, hash: string) =>
  ReviewSnapshotSearchCursor.make(`search:v1:${offset}:${hash}`)

const decodeCursor = (cursor: string | null, kind: "page" | "search", expectedHash: string) => {
  if (cursor === null) return 0
  const match = new RegExp(`^${kind}:v1:([0-9]+):([0-9a-f]{8})$`).exec(cursor)
  if (match === null || match[2] !== expectedHash) return null
  const offset = Number(match[1])
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null
}

const stableCursorHash = (parts: readonly string[]) => {
  const value = parts.join("\u0000")
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

const encodedByteLength = (schema: Schema.Schema.AnyNoContext, value: unknown) =>
  jsonSafeUtf8ByteLength(Schema.encodeUnknownSync(schema)(value))

const assertEncodedBudget = (
  schema: Schema.Schema.AnyNoContext,
  value: unknown,
  maxBytes: number,
) => assertJsonPayloadWithinBudget(Schema.encodeUnknownSync(schema)(value), maxBytes)

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
