import type {
  ReviewPromptFile,
  ReviewPromptIdentity,
  ReviewThreadPromptHunkExcerpt,
} from "@diffdash/agents/review-thread"
import { ParsedDiffHunk, type ParsedDiffFile } from "@diffdash/domain/diff"
import { findProjectedDiffHunkLine, projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"
import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import type { LineReviewAnchor } from "@diffdash/domain/review-thread"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import type {
  SnapshotFilePlacement,
  StoredHunk,
  StoredSnapshotHeader,
} from "@diffdash/persistence/snapshot-block-store"
import { Effect } from "effect"

import { OperationSnapshotReaderError } from "./operation-snapshot-reader"

/** Projects durable snapshot metadata into the bounded identity accepted by agent prompts. */
export const reviewPromptIdentity = (snapshot: StoredSnapshotHeader): ReviewPromptIdentity => ({
  reviewKey: ReviewKey.make(snapshot.reviewKey),
  baseRevision: ReviewRevision.make(snapshot.baseRevision),
  headRevision: ReviewRevision.make(snapshot.headRevision),
  descriptor: snapshot.descriptor,
})

/** Projects one inventory placement without loading any patch or hunk content. */
export const reviewPromptFile = (file: SnapshotFilePlacement): ReviewPromptFile => ({
  fileId: ReviewFileId.make(file.fileId),
  path: RepositoryRelativePath.make(file.path),
  oldPath: file.oldPath === null ? null : RepositoryRelativePath.make(file.oldPath),
  status: file.status,
  additions: file.additions,
  deletions: file.deletions,
  hunkCount: file.hunkCount,
})

/** Decodes one reader-bounded hunk body into its canonical patch lines. */
export const decodeSnapshotHunkLines = (
  bytes: Uint8Array,
): Effect.Effect<readonly string[], OperationSnapshotReaderError> =>
  Effect.try({
    try: () => {
      const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n")
      if (lines.at(-1) === "") lines.pop()
      return lines
    },
    catch: () =>
      OperationSnapshotReaderError.make({
        operation: "readHunk",
        reason: "sourceUnavailable",
        message: "Snapshot hunk content is not valid UTF-8",
      }),
  })

/** Projects one targeted stored hunk; this never constructs a repository-wide parsed diff. */
export const projectSnapshotHunk = (hunk: StoredHunk, lines: readonly string[]): ParsedDiffHunk =>
  ParsedDiffHunk.make({
    id: ReviewHunkId.make(hunk.id),
    fingerprint: ReviewHunkFingerprint.make(hunk.fingerprint),
    header: hunk.header,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines,
  })

/** Projects one selected file and its already-bounded hunks for walkthrough preparation. */
export const projectSnapshotFile = (
  file: SnapshotFilePlacement,
  reviewKey: string,
  hunks: readonly ParsedDiffHunk[],
): ParsedDiffFile => ({
  fileId: ReviewFileId.make(file.fileId),
  patchHash: file.patchHash,
  reviewKey: ReviewKey.make(reviewKey),
  path: RepositoryRelativePath.make(file.path),
  oldPath: file.oldPath === null ? null : RepositoryRelativePath.make(file.oldPath),
  status: file.status,
  visibility: file.visibility,
  additions: file.additions,
  deletions: file.deletions,
  hunks,
  patch: hunks.flatMap((hunk) => [hunk.header, ...hunk.lines]).join("\n"),
})

/** Selects prompt context around the persisted line anchor from one targeted hunk read. */
export const reviewThreadHunkExcerpt = (
  anchor: LineReviewAnchor,
  hunk: StoredHunk,
  lines: readonly string[],
): ReviewThreadPromptHunkExcerpt | null => {
  const projected = projectSnapshotHunk(hunk, lines)
  const match = findProjectedDiffHunkLine(projectDiffHunkLines(projected), {
    side: anchor.side,
    lineNumber: anchor.lineNumber,
    content: anchor.lineContent,
  })
  if (match === null) return null
  return {
    fileId: ReviewFileId.make(anchor.fileId),
    hunkId: ReviewHunkId.make(hunk.id),
    header: hunk.header,
    lines,
    anchorLineIndex: match.index,
    omittedBefore: 0,
    omittedAfter: 0,
  }
}
