import { Option, Schema } from "effect"

import { RepositoryRelativePath } from "./repository-path"
import { reviewPathBasename } from "./review-path"
import {
  ReviewFileId,
  ReviewFilePatchHash,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
} from "./review-identity"

/** File statuses derived from unified diff metadata. */
export const DiffFileStatus = Schema.Literals(["added", "modified", "deleted", "renamed", "binary"])

/** File statuses derived from unified diff metadata. */
export type DiffFileStatus = typeof DiffFileStatus.Type

/** Reasons a diff file is hidden by default in review navigation. */
export const HiddenDiffFileReason = Schema.Literals(["binary", "lockfile", "vendored", "generated"])

/** Reasons a diff file is hidden by default in review navigation. */
export type HiddenDiffFileReason = typeof HiddenDiffFileReason.Type

/** Default review visibility derived from a diff file's path and status. */
export const DiffFileVisibility = Schema.TaggedUnion({
  Visible: {},
  Hidden: { reason: HiddenDiffFileReason },
})

/** Default review visibility derived from a diff file's path and status. */
export type DiffFileVisibility = typeof DiffFileVisibility.Type

const DiffFileVisibilitySource = Schema.Struct({
  path: RepositoryRelativePath,
  status: DiffFileStatus,
})

const BinaryDiffFile = DiffFileVisibilitySource.pipe(
  Schema.check(
    Schema.makeFilter(({ path, status }) => {
      const normalizedPath = path.toLowerCase()
      return (
        status === "binary" ||
        binaryExtensions.some((extension) => normalizedPath.endsWith(extension))
      )
    }),
  ),
)

const LockfileDiffFile = DiffFileVisibilitySource.pipe(
  Schema.check(
    Schema.makeFilter(({ path }) => lockfileNames.has(reviewPathBasename(path.toLowerCase()))),
  ),
)

const VendoredDiffFile = DiffFileVisibilitySource.pipe(
  Schema.check(
    Schema.makeFilter(({ path }) => {
      const normalizedPath = path.toLowerCase()
      return vendoredSegments.some((segment) => normalizedPath.includes(segment))
    }),
  ),
)

const GeneratedDiffFile = DiffFileVisibilitySource.pipe(
  Schema.check(
    Schema.makeFilter(({ path }) => {
      const normalizedPath = path.toLowerCase()
      return generatedPatterns.some((pattern) => pattern.test(normalizedPath))
    }),
  ),
)

/** A parsed unified diff hunk. */
export class ParsedDiffHunk extends Schema.Class<ParsedDiffHunk>("ParsedDiffHunk")({
  id: ReviewHunkId,
  fingerprint: ReviewHunkFingerprint,
  header: Schema.String,
  oldStart: Schema.Number,
  oldLines: Schema.Number,
  newStart: Schema.Number,
  newLines: Schema.Number,
  lines: Schema.Array(Schema.String),
}) {}

/** Parsed metadata and renderable patch text for one changed file. */
const ParsedDiffFileSource = Schema.Struct({
  fileId: ReviewFileId,
  patchHash: ReviewFilePatchHash,
  reviewKey: ReviewKey,
  path: RepositoryRelativePath,
  oldPath: Schema.NullOr(RepositoryRelativePath),
  status: DiffFileStatus,
  additions: Schema.Number,
  deletions: Schema.Number,
  hunks: Schema.Array(ParsedDiffHunk),
  patch: Schema.String,
})

/** Parsed metadata and renderable patch text with schema-derived default visibility. */
export const ParsedDiffFile = ParsedDiffFileSource.pipe(
  Schema.extendTo(
    { visibility: DiffFileVisibility },
    {
      visibility: (source) => {
        if (Schema.is(BinaryDiffFile)(source)) {
          return Option.some(DiffFileVisibility.cases.Hidden.make({ reason: "binary" }))
        }
        if (Schema.is(LockfileDiffFile)(source)) {
          return Option.some(DiffFileVisibility.cases.Hidden.make({ reason: "lockfile" }))
        }
        if (Schema.is(VendoredDiffFile)(source)) {
          return Option.some(DiffFileVisibility.cases.Hidden.make({ reason: "vendored" }))
        }
        if (Schema.is(GeneratedDiffFile)(source)) {
          return Option.some(DiffFileVisibility.cases.Hidden.make({ reason: "generated" }))
        }
        return Option.some(DiffFileVisibility.cases.Visible.make({}))
      },
    },
  ),
)

/** Parsed metadata and renderable patch text with schema-derived default visibility. */
export type ParsedDiffFile = typeof ParsedDiffFile.Type

/** Parsed file-level representation of a unified diff. */
export class ParsedDiff extends Schema.Class<ParsedDiff>("ParsedDiff")({
  files: Schema.Array(ParsedDiffFile),
}) {}

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
