import type { ParsedDiffFile } from "./diff"

/** Changed-line threshold after which a diff is treated as very large. */
export const VERY_LARGE_DIFF_CHANGED_LINE_THRESHOLD = 20_000

/** Patch-text threshold after which a diff is treated as very large. */
export const VERY_LARGE_DIFF_CHARACTER_THRESHOLD = 2_000_000

/** Returns the added-plus-deleted line count represented by a parsed file. */
export const changedLineCount = (file: Pick<ParsedDiffFile, "additions" | "deletions">) =>
  file.additions + file.deletions

/** Determines whether one file should avoid whole-file syntax highlighting. */
export const isVeryLargeDiffFile = (
  file: Pick<ParsedDiffFile, "additions" | "deletions" | "patch">,
) =>
  changedLineCount(file) > VERY_LARGE_DIFF_CHANGED_LINE_THRESHOLD ||
  file.patch.length > VERY_LARGE_DIFF_CHARACTER_THRESHOLD

/** Determines whether aggregate review size requires sampled walkthrough generation. */
export const isVeryLargeDiff = (
  files: readonly Pick<ParsedDiffFile, "additions" | "deletions" | "patch">[],
) => {
  let changedLines = 0
  let patchCharacters = 0
  for (const file of files) {
    changedLines += changedLineCount(file)
    patchCharacters += file.patch.length
    if (
      changedLines > VERY_LARGE_DIFF_CHANGED_LINE_THRESHOLD ||
      patchCharacters > VERY_LARGE_DIFF_CHARACTER_THRESHOLD
    ) {
      return true
    }
  }
  return false
}
