import type { ParsedDiffHunk } from "./diff"

/** Semantic kinds represented by lines inside a unified-diff hunk. */
export type DiffHunkLineKind = "context" | "addition" | "deletion" | "metadata"

/** One side of a unified-diff hunk coordinate. */
export type DiffHunkLineSide = "old" | "new"

/** Coordinate starts used to project a hunk's patch lines. */
export interface DiffHunkLineStarts {
  readonly oldStart: number
  readonly newStart: number
}

/** Canonical coordinates and content for one patch line in a parsed diff hunk. */
export interface ProjectedDiffHunkLine {
  readonly index: number
  readonly patchLine: string
  readonly content: string
  readonly kind: DiffHunkLineKind
  readonly oldLineNumber: number | null
  readonly newLineNumber: number | null
}

/** A side-specific coordinate lookup, optionally constrained by exact line content. */
export interface DiffHunkLineLookup {
  readonly side: DiffHunkLineSide
  readonly lineNumber: number
  readonly content?: string
}

/**
 * Projects parsed unified-diff lines into canonical old/new coordinates.
 * Metadata retains its complete patch text as content and advances neither side.
 */
export const projectDiffHunkLines = (
  hunk: ParsedDiffHunk,
  starts: DiffHunkLineStarts = hunk,
): readonly ProjectedDiffHunkLine[] => {
  let oldLineNumber = starts.oldStart
  let newLineNumber = starts.newStart

  return hunk.lines.map((patchLine, index) => {
    const marker = patchLine[0]
    if (marker === " ") {
      const line = {
        index,
        patchLine,
        content: patchLine.slice(1),
        kind: "context" as const,
        oldLineNumber,
        newLineNumber,
      }
      oldLineNumber += 1
      newLineNumber += 1
      return line
    }
    if (marker === "-") {
      const line = {
        index,
        patchLine,
        content: patchLine.slice(1),
        kind: "deletion" as const,
        oldLineNumber,
        newLineNumber: null,
      }
      oldLineNumber += 1
      return line
    }
    if (marker === "+") {
      const line = {
        index,
        patchLine,
        content: patchLine.slice(1),
        kind: "addition" as const,
        oldLineNumber: null,
        newLineNumber,
      }
      newLineNumber += 1
      return line
    }
    return {
      index,
      patchLine,
      content: patchLine,
      kind: "metadata" as const,
      oldLineNumber: null,
      newLineNumber: null,
    }
  })
}

/** Finds the projected hunk line at an exact side coordinate and optional content value. */
export const findProjectedDiffHunkLine = (
  lines: readonly ProjectedDiffHunkLine[],
  lookup: DiffHunkLineLookup,
): ProjectedDiffHunkLine | null =>
  lines.find(
    (line) =>
      (lookup.side === "old" ? line.oldLineNumber : line.newLineNumber) === lookup.lineNumber &&
      (lookup.content === undefined || line.content === lookup.content),
  ) ?? null
