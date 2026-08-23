import { Option, Schema } from "effect"

import type { ParsedDiffHunk } from "./diff"
import {
  type DiffHunkLineKind,
  projectDiffHunkLines,
  type ProjectedDiffHunkLine,
} from "./diff-hunk-lines"

/** Visual meaning of one changed range in a full-file Code view. */
export const CodeLineChangeKind = Schema.Literals(["added", "modified", "deleted"])

/** Visual meaning of one changed range in a full-file Code view. */
export type CodeLineChangeKind = typeof CodeLineChangeKind.Type

const PositiveLineNumber = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

/** Inclusive 1-based line range decorated in a full-file Code view. */
export class CodeLineChangeRange extends Schema.Class<CodeLineChangeRange>("CodeLineChangeRange")({
  kind: CodeLineChangeKind,
  startLine: PositiveLineNumber,
  endLine: PositiveLineNumber,
}) {}

/** Projects parsed unified-diff hunks into compact ranges on the current-file side. */
export const codeLineChangesFromHunks = (
  hunks: readonly ParsedDiffHunk[],
): readonly CodeLineChangeRange[] => {
  const ranges: CodeLineChangeRange[] = []
  for (const hunk of hunks) {
    const group: ProjectedDiffHunkLine[] = []
    for (const line of projectDiffHunkLines(hunk)) {
      const handleLineKind = {
        addition: () => group.push(line),
        deletion: () => group.push(line),
        context: () => {
          appendEditGroup(
            ranges,
            group,
            Option.getOrElse(Option.fromNullishOr(line.newLineNumber), () => hunk.newStart),
          )
          group.length = 0
        },
        metadata: () => {
          appendEditGroup(
            ranges,
            group,
            Option.getOrElse(Option.fromNullishOr(line.newLineNumber), () => hunk.newStart),
          )
          group.length = 0
        },
      } satisfies Record<DiffHunkLineKind, () => number | void>
      handleLineKind[line.kind]()
    }
    const last = Option.fromNullishOr(group.at(-1))
    appendEditGroup(
      ranges,
      group,
      Math.max(
        1,
        Option.match(last, {
          onNone: () => hunk.newStart,
          onSome: (line) =>
            Option.getOrElse(Option.fromNullishOr(line.newLineNumber), () => hunk.newStart) +
            (
              { addition: 1, context: 0, deletion: 0, metadata: 0 } satisfies Record<
                DiffHunkLineKind,
                number
              >
            )[line.kind],
        }),
      ),
    )
  }
  const merged: CodeLineChangeRange[] = []
  for (const range of ranges) {
    Option.match(Option.fromNullishOr(merged.at(-1)), {
      onNone: () => merged.push(range),
      onSome: (previous) => {
        if (previous.kind === range.kind && range.startLine <= previous.endLine + 1) {
          merged[merged.length - 1] = CodeLineChangeRange.make({
            kind: previous.kind,
            startLine: previous.startLine,
            endLine: Math.max(previous.endLine, range.endLine),
          })
          return
        }
        merged.push(range)
      },
    })
  }
  return merged
}

const appendEditGroup = (
  ranges: CodeLineChangeRange[],
  group: readonly ProjectedDiffHunkLine[],
  deletionAnchor: number,
) => {
  if (group.length === 0) return
  const additions = group.flatMap((line) => {
    if (line.kind !== "addition") return []
    return Option.match(Option.fromNullishOr(line.newLineNumber), {
      onNone: () => [],
      onSome: (lineNumber) => [lineNumber],
    })
  })
  const hasDeletions = group.some((line) => line.kind === "deletion")
  if (additions.length > 0) {
    let kind: CodeLineChangeKind = "added"
    if (hasDeletions) kind = "modified"
    ranges.push(
      CodeLineChangeRange.make({
        kind,
        startLine: Option.getOrElse(Option.fromNullishOr(additions[0]), () => 1),
        endLine: Option.getOrElse(Option.fromNullishOr(additions.at(-1)), () => 1),
      }),
    )
  } else if (hasDeletions) {
    const anchor = Math.max(1, deletionAnchor)
    ranges.push(CodeLineChangeRange.make({ kind: "deleted", startLine: anchor, endLine: anchor }))
  }
}
