import { ParsedDiff, ParsedDiffFile, ParsedDiffHunk, type DiffFileStatus } from "./domain"
import { makeReviewFileId, makeReviewHunkFingerprint, makeReviewHunkId } from "./review-identity"

interface DraftHunk {
  readonly header: string
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: string[]
}

interface DraftFile {
  readonly gitOldPath: string
  readonly gitNewPath: string
  readonly lines: string[]
  additions: number
  deletions: number
  hunks: DraftHunk[]
  newPath: string | null
  oldPath: string | null
  renameFrom: string | null
  renameTo: string | null
  status: DiffFileStatus | null
}

/** Parses raw unified diff text into file-level metadata and per-file patches. */
export const parseUnifiedDiff = (diff: string): ParsedDiff => {
  const files: ParsedDiffFile[] = []
  let current: DraftFile | null = null
  let currentHunk: DraftHunk | null = null

  const finishFile = () => {
    if (current === null) return
    files.push(toParsedFile(current))
    current = null
    currentHunk = null
  }

  for (const line of diff.split("\n")) {
    const fileMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (fileMatch !== null) {
      finishFile()
      current = {
        additions: 0,
        deletions: 0,
        gitNewPath: fileMatch[2] ?? "",
        gitOldPath: fileMatch[1] ?? "",
        hunks: [],
        lines: [line],
        newPath: null,
        oldPath: null,
        renameFrom: null,
        renameTo: null,
        status: null,
      }
      continue
    }

    if (current === null) continue
    current.lines.push(line)

    if (line === "new file mode 100644" || line.startsWith("new file mode ")) {
      current.status = "added"
      continue
    }
    if (line === "deleted file mode 100644" || line.startsWith("deleted file mode ")) {
      current.status = "deleted"
      continue
    }
    if (line.startsWith("rename from ")) {
      current.renameFrom = line.slice("rename from ".length)
      current.status = "renamed"
      continue
    }
    if (line.startsWith("rename to ")) {
      current.renameTo = line.slice("rename to ".length)
      current.status = "renamed"
      continue
    }
    if (line.startsWith("Binary files ")) {
      current.status = "binary"
      continue
    }
    if (line.startsWith("--- ")) {
      current.oldPath = normalizeDiffPath(line.slice(4))
      continue
    }
    if (line.startsWith("+++ ")) {
      current.newPath = normalizeDiffPath(line.slice(4))
      continue
    }

    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunkMatch !== null) {
      currentHunk = {
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldLines: Number(hunkMatch[2] ?? "1"),
        newStart: Number(hunkMatch[3]),
        newLines: Number(hunkMatch[4] ?? "1"),
        lines: [],
      }
      current.hunks.push(currentHunk)
      continue
    }

    if (currentHunk !== null) {
      currentHunk.lines.push(line)
      if (line.startsWith("+") && !line.startsWith("+++")) current.additions += 1
      if (line.startsWith("-") && !line.startsWith("---")) current.deletions += 1
    }
  }

  finishFile()
  return ParsedDiff.make({ files })
}

const toParsedFile = (file: DraftFile) => {
  const path = file.renameTo ?? file.newPath ?? file.gitNewPath
  const oldPath = file.renameFrom ?? deletedOldPath(file)
  const status = inferStatus(file)
  const fileId = makeReviewFileId(path, oldPath)

  return ParsedDiffFile.make({
    fileId,
    reviewKey: oldPath === null ? path : `${oldPath}->${path}`,
    path,
    oldPath,
    status,
    additions: file.additions,
    deletions: file.deletions,
    hunks: file.hunks.map((hunk) =>
      ParsedDiffHunk.make({
        id: makeReviewHunkId(fileId, hunk.header, hunk.lines),
        fingerprint: makeReviewHunkFingerprint(hunk.lines),
        ...hunk,
      }),
    ),
    patch: trimTrailingEmptyLine(file.lines).join("\n"),
  })
}

const inferStatus = (file: DraftFile): DiffFileStatus => {
  if (file.status !== null) return file.status
  if (file.oldPath === null && file.newPath !== null) return "added"
  if (file.newPath === null && file.oldPath !== null) return "deleted"
  return "modified"
}

const deletedOldPath = (file: DraftFile) => {
  if (file.newPath === null) return file.oldPath ?? file.gitOldPath
  if (file.oldPath !== null && file.oldPath !== file.newPath) return file.oldPath
  return null
}

const normalizeDiffPath = (path: string) => {
  if (path === "/dev/null") return null
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2)
  return path
}

const trimTrailingEmptyLine = (lines: readonly string[]) => {
  if (lines[lines.length - 1] !== "") return [...lines]
  return lines.slice(0, -1)
}
