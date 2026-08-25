import type { ParsedDiffFile } from "@diffdash/domain/diff"
import { findProjectedDiffHunkLine, projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"
import {
  LineReviewAnchor,
  type ReviewThreadAnchor,
  type ReviewThreadDetails,
} from "@diffdash/domain/review-thread"
import { Option } from "effect"

interface ReviewThreadLineAnnotation {
  readonly lineNumber: number
  readonly side: "additions" | "deletions"
  readonly metadata: ReviewThreadAnnotation
}

/** Metadata rendered below one annotated diff line. */
export type ReviewThreadAnnotation = {
  readonly anchor: ReviewThreadAnchor
  readonly details: readonly ReviewThreadDetails[]
  readonly draftAnchor: Option.Option<ReviewThreadAnchor>
  readonly expanded: boolean
}

/** Groups active matching threads by exact diff line and adds an empty expanded draft. */
export const reviewThreadAnnotations = (
  file: ParsedDiffFile,
  details: readonly ReviewThreadDetails[],
  expandedLineAnchor: Option.Option<ReviewThreadAnchor>,
): ReviewThreadLineAnnotation[] => {
  const annotations: ReviewThreadLineAnnotation[] = []
  for (const item of details) {
    const activeAnchor = Option.fromNullishOr(item.thread.activeAnchor)
    if (Option.isNone(activeAnchor) || !lineAnchorIsInFile(activeAnchor.value, file)) {
      continue
    }
    const anchor = activeAnchor.value
    const existingIndex = annotations.findIndex((annotation) =>
      sameReviewThreadLine(annotation.metadata.anchor, anchor),
    )
    if (existingIndex < 0) {
      annotations.push({
        ...annotationPosition(anchor),
        metadata: {
          anchor,
          details: [item],
          draftAnchor: Option.none(),
          expanded: Option.exists(expandedLineAnchor, (expanded) =>
            sameReviewThreadLine(expanded, anchor),
          ),
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

  if (Option.isNone(expandedLineAnchor) || !lineAnchorIsInFile(expandedLineAnchor.value, file)) {
    return annotations
  }
  const expandedAnchor = expandedLineAnchor.value
  if (
    annotations.some((annotation) =>
      sameReviewThreadLine(annotation.metadata.anchor, expandedAnchor),
    )
  ) {
    return annotations
  }
  return [
    ...annotations,
    {
      ...annotationPosition(expandedAnchor),
      metadata: {
        anchor: expandedAnchor,
        details: [],
        draftAnchor: Option.some(expandedAnchor),
        expanded: true,
      },
    },
  ]
}

/** Returns the stable disclosure content ID for one annotation. */
export const reviewThreadAnnotationContentId = (anchor: ReviewThreadAnchor): string =>
  `review-thread-${anchor.hunkId}-${anchor.side}-${anchor.lineNumber}`

/** Reconstructs an exact line anchor from a rendered diff coordinate. */
export const lineReviewAnchor = (
  file: ParsedDiffFile,
  annotationSide: "additions" | "deletions",
  lineNumber: number,
): Option.Option<ReviewThreadAnchor> => {
  const side = annotationSide === "deletions" ? "old" : "new"
  for (const hunk of file.hunks) {
    const line = findProjectedDiffHunkLine(projectDiffHunkLines(hunk), { side, lineNumber })
    if (line === null) continue
    return Option.some(
      LineReviewAnchor.make({
        fileId: file.fileId,
        filePath: file.path,
        oldPath: file.oldPath,
        hunkId: hunk.id,
        hunkFingerprint: hunk.fingerprint,
        hunkHeader: hunk.header,
        side,
        lineNumber,
        lineContent: line.content,
      }),
    )
  }
  return Option.none()
}

/** Checks that an anchor still points to the exact content in a parsed file. */
export const lineAnchorIsInFile = (anchor: ReviewThreadAnchor, file: ParsedDiffFile): boolean => {
  if (anchor.fileId !== file.fileId || anchor.filePath !== file.path) return false
  const annotationSide = anchor.side === "old" ? "deletions" : "additions"
  const candidate = lineReviewAnchor(file, annotationSide, anchor.lineNumber)
  return Option.exists(
    candidate,
    (value) =>
      value.hunkId === anchor.hunkId &&
      value.hunkFingerprint === anchor.hunkFingerprint &&
      value.lineContent === anchor.lineContent,
  )
}

/** Checks whether two anchors identify the same exact diff line. */
export const sameReviewThreadLine = (
  left: ReviewThreadAnchor,
  right: ReviewThreadAnchor,
): boolean =>
  left.fileId === right.fileId &&
  left.hunkId === right.hunkId &&
  left.hunkFingerprint === right.hunkFingerprint &&
  left.side === right.side &&
  left.lineNumber === right.lineNumber &&
  left.lineContent === right.lineContent

const annotationPosition = (
  anchor: ReviewThreadAnchor,
): Pick<ReviewThreadLineAnnotation, "lineNumber" | "side"> => ({
  lineNumber: anchor.lineNumber,
  side: anchor.side === "old" ? "deletions" : "additions",
})
