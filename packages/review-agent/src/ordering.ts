import type { ReviewSnapshot } from "@diffdash/domain/review-context"

/** Compares strings by stable code-unit order without locale-dependent behavior. */
export const compareStrings = (left: string, right: string) =>
  left === right ? 0 : left < right ? -1 : 1

/** Returns a sorted copy without mutating the supplied collection. */
export const sortedCopy = <Item>(
  items: readonly Item[],
  compare: (left: Item, right: Item) => number,
) => {
  const copy = [...items]
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks toSorted; only the copy mutates.
  return copy.sort(compare)
}

/** Orders review files deterministically for prompts and MCP output. */
export const orderedReviewFiles = (snapshot: ReviewSnapshot) =>
  sortedCopy(
    snapshot.parsedDiff.files,
    (left, right) =>
      compareStrings(left.path, right.path) ||
      compareStrings(left.oldPath ?? "", right.oldPath ?? "") ||
      compareStrings(left.fileId, right.fileId),
  )

/** Orders diff hunks deterministically by source location and stable identity. */
export const orderedReviewHunks = <
  Hunk extends { readonly id: string; readonly oldStart: number; readonly newStart: number },
>(
  hunks: readonly Hunk[],
) =>
  sortedCopy(
    hunks,
    (left, right) =>
      left.oldStart - right.oldStart ||
      left.newStart - right.newStart ||
      compareStrings(left.id, right.id),
  )
