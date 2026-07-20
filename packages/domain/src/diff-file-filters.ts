import type { ParsedDiffFile } from "./diff"
import { reviewPathBasename } from "./review-path"

/** Minimal parsed-file metadata required for visibility decisions. */
export type DiffFileSummary = Pick<ParsedDiffFile, "path" | "status">

/** Reasons a diff file is hidden by default in review navigation. */
export type HiddenDiffFileReason = "binary" | "generated" | "lockfile" | "vendored"

/** A parsed diff file with its default visibility decision. */
export interface DiffFileVisibility {
  readonly file: ParsedDiffFile
  readonly hiddenReason: HiddenDiffFileReason | null
}

/** Returns the hidden-by-default reason for noisy files, or null when visible. */
export const getHiddenDiffFileReason = (file: DiffFileSummary): HiddenDiffFileReason | null => {
  const path = file.path.toLowerCase()
  const name = reviewPathBasename(path)

  if (file.status === "binary" || binaryExtensions.some((extension) => path.endsWith(extension))) {
    return "binary"
  }
  if (lockfileNames.has(name)) return "lockfile"
  if (vendoredSegments.some((segment) => path.includes(segment))) return "vendored"
  if (generatedPatterns.some((pattern) => pattern.test(path))) return "generated"
  return null
}

/** Adds visibility metadata to parsed diff files. */
export const annotateDiffFileVisibility = (
  files: readonly ParsedDiffFile[],
): readonly DiffFileVisibility[] =>
  files.map((file) => ({ file, hiddenReason: getHiddenDiffFileReason(file) }))

/** Returns files visible under the current hidden-file preference. */
export const filterVisibleDiffFiles = <File extends DiffFileSummary>(
  files: readonly File[],
  showHidden: boolean,
): readonly File[] =>
  showHidden ? files : files.filter((file) => getHiddenDiffFileReason(file) === null)

const lockfileNames = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock",
])

const vendoredSegments = [
  "/.yarn/cache/",
  "/node_modules/",
  "/third_party/",
  "/vendor/",
  "node_modules/",
  "third_party/",
  "vendor/",
]

const generatedPatterns = [
  /(^|\/)__generated__\//,
  /(^|\/)generated\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)coverage\//,
  /\.generated\./,
  /\.gen\.[cm]?[jt]sx?$/,
  /\.min\.[cm]?js$/,
  /\.pb\.go$/,
]

const binaryExtensions = [
  ".avif",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp4",
  ".pdf",
  ".png",
  ".webp",
  ".zip",
]
