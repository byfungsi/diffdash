import { filterVisibleDiffFiles } from "@diffdash/domain/diff-file-filters"
import type { ParsedDiffFile } from "@diffdash/domain/diff"

/** Git-style status values supported by @pierre/trees. */
export type FileTreeGitStatus = "added" | "deleted" | "modified" | "renamed" | "untracked"

/** Git status entry consumed by file-tree navigation. */
export interface ReviewFileTreeGitStatusEntry {
  readonly path: string
  readonly status: FileTreeGitStatus
}

/** Prepared tree source data derived from parsed diff files. */
export interface ReviewFileTreeInput {
  readonly gitStatus: readonly ReviewFileTreeGitStatusEntry[]
  readonly hiddenCount: number
  readonly paths: readonly string[]
  readonly visibleFiles: readonly ParsedDiffFile[]
}

/** Builds path-first tree input from parsed diff files and hidden-file preference. */
export const buildReviewFileTreeInput = (
  files: readonly ParsedDiffFile[],
  showHidden: boolean,
): ReviewFileTreeInput => {
  const visibleFiles = filterVisibleDiffFiles(files, showHidden)
  const visiblePaths = visibleFiles.map((file) => file.path)
  const fileByPath = new Map(visibleFiles.map((file) => [file.path, file]))

  return {
    gitStatus: visiblePaths.flatMap((path) => {
      const file = fileByPath.get(path)
      return file === undefined ? [] : [{ path: file.path, status: toTreeGitStatus(file) }]
    }),
    hiddenCount: files.length - visibleFiles.length,
    paths: visiblePaths,
    visibleFiles,
  }
}

const toTreeGitStatus = (file: ParsedDiffFile): FileTreeGitStatus => {
  if (file.status === "binary") return "modified"
  return file.status
}
