import type { ParsedDiffFile } from "@diffdash/domain/diff"
import { projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"

/** The semantic side occupied by a searchable unified-diff line. */
type ReviewSearchSide = "additions" | "context" | "deletions"

/** A searchable source line with stable review and diff coordinates. */
type ReviewSearchLine = {
  readonly filePath: string
  readonly hunkId: string
  readonly hunkLineIndex: number
  readonly newLineNumber: number | null
  readonly oldLineNumber: number | null
  readonly reviewKey: string
  readonly side: ReviewSearchSide
  readonly text: string
}

/** A reusable line index for literal searches over a parsed review diff. */
type ReviewSearchIndex = readonly ReviewSearchLine[]

/** One literal substring occurrence and its exact UTF-16 offsets in a diff line. */
export type ReviewSearchOccurrence = ReviewSearchLine & {
  readonly end: number
  readonly id: string
  readonly start: number
}

/** Builds a document-ordered index of code lines from every parsed diff file. */
export const buildReviewSearchIndex = (files: readonly ParsedDiffFile[]): ReviewSearchIndex => {
  const lines: ReviewSearchLine[] = []

  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of projectDiffHunkLines(hunk)) {
        if (line.kind === "metadata") continue
        lines.push({
          filePath: file.path,
          hunkId: hunk.id,
          hunkLineIndex: line.index,
          newLineNumber: line.newLineNumber,
          oldLineNumber: line.oldLineNumber,
          reviewKey: file.reviewKey,
          side:
            line.kind === "context"
              ? "context"
              : line.kind === "deletion"
                ? "deletions"
                : "additions",
          text: line.content,
        })
      }
    }
  }

  return lines
}

/** Finds case-insensitive, non-overlapping literal substrings in review order. */
export const searchReviewIndex = (
  index: ReviewSearchIndex,
  query: string,
): readonly ReviewSearchOccurrence[] => {
  if (query.length === 0) return []

  const expression = new RegExp(escapeRegExp(query), "giu")
  const occurrences: ReviewSearchOccurrence[] = []

  for (const line of index) {
    expression.lastIndex = 0
    for (
      let match = expression.exec(line.text);
      match !== null;
      match = expression.exec(line.text)
    ) {
      occurrences.push({
        ...line,
        end: match.index + match[0].length,
        id: `${line.reviewKey}:${line.hunkId}:${line.hunkLineIndex}:${match.index}`,
        start: match.index,
      })
    }
  }

  return occurrences
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
