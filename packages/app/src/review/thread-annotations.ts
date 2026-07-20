import type { ParsedDiffFile } from "@diffdash/domain/diff"
import { findProjectedDiffHunkLine, projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"
import {
  LineReviewAnchor,
  type ReviewThreadAnchor,
  type ReviewThreadDetails,
} from "@diffdash/domain/review-thread"
import type { DiffLineAnnotation } from "@/review/pierre"

/** Metadata rendered below one annotated diff line. */
export type ReviewThreadAnnotation = {
  readonly anchor: ReviewThreadAnchor
  readonly details: readonly ReviewThreadDetails[]
  readonly draftAnchor: ReviewThreadAnchor | null
  readonly expanded: boolean
}

/** Groups active matching threads by exact diff line and adds an empty expanded draft. */
export const reviewThreadAnnotations = (
  file: ParsedDiffFile,
  details: readonly ReviewThreadDetails[],
  expandedLineAnchor: ReviewThreadAnchor | null,
): DiffLineAnnotation<ReviewThreadAnnotation>[] => {
  const annotations: DiffLineAnnotation<ReviewThreadAnnotation>[] = []
  for (const item of details) {
    const anchor = item.thread.currentAnchor
    if (
      anchor === null ||
      item.thread.anchorStatus !== "active" ||
      !lineAnchorIsInFile(anchor, file)
    ) {
      continue
    }
    const existingIndex = annotations.findIndex((annotation) =>
      sameReviewThreadLine(annotation.metadata.anchor, anchor),
    )
    if (existingIndex < 0) {
      annotations.push({
        ...annotationPosition(anchor),
        metadata: {
          anchor,
          details: [item],
          draftAnchor: null,
          expanded: sameReviewThreadLine(expandedLineAnchor, anchor),
        },
      })
      continue
    }
    const existing = annotations[existingIndex]
    if (existing !== undefined) {
      annotations[existingIndex] = {
        ...existing,
        metadata: { ...existing.metadata, details: [...existing.metadata.details, item] },
      }
    }
  }

  if (expandedLineAnchor === null || !lineAnchorIsInFile(expandedLineAnchor, file)) {
    return annotations
  }
  if (
    annotations.some((annotation) =>
      sameReviewThreadLine(annotation.metadata.anchor, expandedLineAnchor),
    )
  ) {
    return annotations
  }
  return [
    ...annotations,
    {
      ...annotationPosition(expandedLineAnchor),
      metadata: {
        anchor: expandedLineAnchor,
        details: [],
        draftAnchor: expandedLineAnchor,
        expanded: true,
      },
    },
  ]
}

/** Returns the stable disclosure content ID for one annotation. */
export const reviewThreadAnnotationContentId = (anchor: ReviewThreadAnchor) =>
  `review-thread-${anchor.hunkId}-${anchor.side}-${anchor.lineNumber}`

/** Reconstructs an exact line anchor from a rendered diff coordinate. */
export const lineReviewAnchor = (
  file: ParsedDiffFile,
  annotationSide: "additions" | "deletions",
  lineNumber: number,
): ReviewThreadAnchor | null => {
  const side = annotationSide === "deletions" ? "old" : "new"
  for (const hunk of file.hunks) {
    const line = findProjectedDiffHunkLine(projectDiffHunkLines(hunk), { side, lineNumber })
    if (line === null) continue
    return LineReviewAnchor.make({
      fileId: file.fileId,
      filePath: file.path,
      oldPath: file.oldPath,
      hunkId: hunk.id,
      hunkFingerprint: hunk.fingerprint,
      hunkHeader: hunk.header,
      side,
      lineNumber,
      lineContent: line.content,
    })
  }
  return null
}

/** Checks that an anchor still points to the exact content in a parsed file. */
export const lineAnchorIsInFile = (anchor: ReviewThreadAnchor, file: ParsedDiffFile) => {
  if (anchor.fileId !== file.fileId || anchor.filePath !== file.path) return false
  const annotationSide = anchor.side === "old" ? "deletions" : "additions"
  const candidate = lineReviewAnchor(file, annotationSide, anchor.lineNumber)
  return (
    candidate !== null &&
    candidate.hunkId === anchor.hunkId &&
    candidate.hunkFingerprint === anchor.hunkFingerprint &&
    candidate.lineContent === anchor.lineContent
  )
}

/** Checks whether two anchors identify the same exact diff line. */
export const sameReviewThreadLine = (left: ReviewThreadAnchor | null, right: ReviewThreadAnchor) =>
  left !== null &&
  left.fileId === right.fileId &&
  left.hunkId === right.hunkId &&
  left.hunkFingerprint === right.hunkFingerprint &&
  left.side === right.side &&
  left.lineNumber === right.lineNumber &&
  left.lineContent === right.lineContent

const annotationPosition = (
  anchor: ReviewThreadAnchor,
): Pick<DiffLineAnnotation<ReviewThreadAnnotation>, "lineNumber" | "side"> => ({
  lineNumber: anchor.lineNumber,
  side: anchor.side === "old" ? "deletions" : "additions",
})
