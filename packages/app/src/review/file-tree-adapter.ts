import { type DiffFileStatus, DiffFileVisibility } from "@diffdash/domain/diff"

/** Git-style status values supported by @pierre/trees. */
type FileTreeGitStatus = "added" | "deleted" | "modified" | "renamed" | "untracked"

const folderStatusByFileStatus = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "modified",
  untracked: "modified",
} as const satisfies Readonly<Record<FileTreeGitStatus, FileTreeGitStatus>>

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
  const fileStatuses = visibleFiles.map((file) => ({
    path: file.path,
    status: toTreeGitStatus(file),
  }))
  const directoryStatuses = new Map<string, FileTreeGitStatus>()
  for (const entry of fileStatuses) {
    const folderStatus = folderStatusByFileStatus[entry.status]
    let separatorIndex = entry.path.indexOf("/")
    while (separatorIndex >= 0) {
      const directoryPath = entry.path.slice(0, separatorIndex + 1)
      const current = directoryStatuses.get(directoryPath)
      if (current === undefined) {
        directoryStatuses.set(directoryPath, folderStatus)
      } else if (current !== folderStatus) {
        directoryStatuses.set(directoryPath, "modified")
      }
      separatorIndex = entry.path.indexOf("/", separatorIndex + 1)
    }
  }

  return {
    gitStatus: [
      ...[...directoryStatuses]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, status]) => ({ path, status })),
      ...fileStatuses,
    ],
    hiddenCount: files.length - visibleFiles.length,
    paths: visibleFiles.map((file) => file.path),
    visibleFiles,
  }
}

const toTreeGitStatus = (file: ReviewFileTreeFile): FileTreeGitStatus => {
  if (file.status === "binary") return "modified"
  return file.status
}
