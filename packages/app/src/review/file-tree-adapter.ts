import { type DiffFileStatus, DiffFileVisibility } from "@diffdash/domain/diff"

/** Git-style status values supported by @pierre/trees. */
type FileTreeGitStatus = "added" | "deleted" | "modified" | "renamed" | "untracked"

/** Git status entry consumed by file-tree navigation. */
interface ReviewFileTreeGitStatusEntry {
  readonly path: string
  readonly status: FileTreeGitStatus
}

/** Prepared tree source data derived from parsed diff files. */
interface ReviewFileTreeInput {
  readonly gitStatus: readonly ReviewFileTreeGitStatusEntry[]
  readonly hiddenCount: number
  readonly paths: readonly string[]
  readonly visibleFiles: readonly ReviewFileTreeFile[]
}

/** File metadata consumed by the review tree before parsed pages are loaded. */
type ReviewFileTreeFile = {
  readonly path: string
  readonly status: DiffFileStatus
  readonly visibility: typeof DiffFileVisibility.Type
}

/** Builds path-first tree input from parsed diff files and hidden-file preference. */
export const buildReviewFileTreeInput = (
  files: readonly ReviewFileTreeFile[],
  showHidden: boolean,
): ReviewFileTreeInput => {
  const visibleFiles = showHidden
    ? files
    : files.filter((file) => DiffFileVisibility.guards.Visible(file.visibility))

  return {
    gitStatus: visibleFiles.map((file) => ({ path: file.path, status: toTreeGitStatus(file) })),
    hiddenCount: files.length - visibleFiles.length,
    paths: visibleFiles.map((file) => file.path),
    visibleFiles,
  }
}

const toTreeGitStatus = (file: ReviewFileTreeFile): FileTreeGitStatus => {
  if (file.status === "binary") return "modified"
  return file.status
}
