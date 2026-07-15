import { Schema } from "effect"

import { ReviewFileId, ReviewHunkFingerprint, ReviewHunkId } from "./review-identity"

/** File statuses derived from unified diff metadata. */
export const DiffFileStatus = Schema.Literal("added", "modified", "deleted", "renamed", "binary")

/** File statuses derived from unified diff metadata. */
export type DiffFileStatus = typeof DiffFileStatus.Type

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
export class ParsedDiffFile extends Schema.Class<ParsedDiffFile>("ParsedDiffFile")({
  fileId: ReviewFileId,
  reviewKey: Schema.String,
  path: Schema.String,
  oldPath: Schema.NullOr(Schema.String),
  status: DiffFileStatus,
  additions: Schema.Number,
  deletions: Schema.Number,
  hunks: Schema.Array(ParsedDiffHunk),
  patch: Schema.String,
}) {}

/** Parsed file-level representation of a unified diff. */
export class ParsedDiff extends Schema.Class<ParsedDiff>("ParsedDiff")({
  files: Schema.Array(ParsedDiffFile),
}) {}
