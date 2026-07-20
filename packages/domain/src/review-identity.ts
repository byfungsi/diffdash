import { Schema } from "effect"

import { type HostedReviewLocator, makeHostedReviewKey } from "./git-provider"

/** Canonical identity for one repository review across revisions. */
export const ReviewKey = Schema.String.pipe(Schema.minLength(1), Schema.brand("ReviewKey"))

/** Canonical identity for one repository review across revisions. */
export type ReviewKey = typeof ReviewKey.Type

/** A Git commit SHA or local working-tree diff digest identifying one review revision. */
export const ReviewRevision = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ReviewRevision"),
)

/** A Git commit SHA or local working-tree diff digest identifying one review revision. */
export type ReviewRevision = typeof ReviewRevision.Type

/** Stable digest identifying the exact raw diff captured by a review snapshot. */
export const ReviewDiffIdentity = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ReviewDiffIdentity"),
)

/** Stable digest identifying the exact raw diff captured by a review snapshot. */
export type ReviewDiffIdentity = typeof ReviewDiffIdentity.Type

/** Immutable identity for one coherent review revision and exact diff. */
export const ReviewSnapshotId = Schema.String.pipe(
  Schema.pattern(/^snapshot:v1:[0-9a-f]{32}$/),
  Schema.brand("ReviewSnapshotId"),
)

/** Immutable identity for one coherent review revision and exact diff. */
export type ReviewSnapshotId = typeof ReviewSnapshotId.Type

/** Stable identity for one changed file within review data. */
export const ReviewFileId = Schema.String.pipe(Schema.minLength(1), Schema.brand("ReviewFileId"))

/** Stable identity for one changed file within review data. */
export type ReviewFileId = typeof ReviewFileId.Type

/** Canonical displayed-patch identity used to retain viewed state across revisions. */
export const ReviewFilePatchHash = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ReviewFilePatchHash"),
)

/** Canonical displayed-patch identity used to retain viewed state across revisions. */
export type ReviewFilePatchHash = typeof ReviewFilePatchHash.Type

/** Snapshot-local identity for one parsed diff hunk. */
export const ReviewHunkId = Schema.String.pipe(Schema.minLength(1), Schema.brand("ReviewHunkId"))

/** Snapshot-local identity for one parsed diff hunk. */
export type ReviewHunkId = typeof ReviewHunkId.Type

/** Content identity used to carry unchanged hunks across review revisions. */
export const ReviewHunkFingerprint = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ReviewHunkFingerprint"),
)

/** Content identity used to carry unchanged hunks across review revisions. */
export type ReviewHunkFingerprint = typeof ReviewHunkFingerprint.Type

/** Creates the canonical persisted review key for one hosted review locator. */
export const makeReviewKey = (review: HostedReviewLocator) =>
  ReviewKey.make(makeHostedReviewKey(review))

/** Hashes exact unified-diff text for deterministic snapshot identity. */
export const makeReviewDiffIdentity = (diff: string) =>
  ReviewDiffIdentity.make(`diff:v1:${stablePatchHash([diff])}`)

/** Derives a deterministic snapshot ID from target, revisions, and exact diff identity. */
export const makeReviewSnapshotId = (input: {
  readonly reviewKey: ReviewKey
  readonly baseRevision: ReviewRevision
  readonly headRevision: ReviewRevision
  readonly diffIdentity: ReviewDiffIdentity | string
}) =>
  ReviewSnapshotId.make(
    `snapshot:v1:${stablePatchHash([
      input.reviewKey,
      input.baseRevision,
      input.headRevision,
      input.diffIdentity,
    ])}`,
  )

/** Creates a deterministic identity for a changed file, including rename metadata. */
export const makeReviewFileId = (path: string, oldPath: string | null) =>
  ReviewFileId.make(`file:${stableReviewHash([oldPath ?? "", path])}`)

/** Hashes the provider-neutral file patch represented by parsed diff metadata. */
export const makeReviewFilePatchHash = (file: {
  readonly hunks: readonly { readonly header: string; readonly lines: readonly string[] }[]
  readonly metadata?: readonly string[]
  readonly oldPath: string | null
  readonly path: string
  readonly status: string
}) =>
  ReviewFilePatchHash.make(
    `file-patch:v1:${stablePatchHash([
      file.status,
      file.oldPath ?? "",
      file.path,
      ...(file.metadata ?? []),
      String(file.hunks.length),
      ...file.hunks.flatMap((hunk) => [
        normalizedHunkHeader(hunk.header),
        String(hunk.lines.length),
        ...hunk.lines,
      ]),
    ])}`,
  )

/** Creates a snapshot-local hunk identity without relying on hunk ordinal. */
export const makeReviewHunkId = (fileId: ReviewFileId, header: string, lines: readonly string[]) =>
  ReviewHunkId.make(`hunk:${stableReviewHash([fileId, header, normalizedHunkContent(lines)])}`)

/** Creates a range-independent hunk fingerprint for carry-forward matching. */
export const makeReviewHunkFingerprint = (lines: readonly string[]) =>
  ReviewHunkFingerprint.make(`hunk-content:${stableReviewHash([normalizedHunkContent(lines)])}`)

const normalizedHunkContent = (lines: readonly string[]) =>
  lines.filter((line) => line !== "\\ No newline at end of file").join("\n")

const normalizedHunkHeader = (header: string) =>
  header.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, "@@ @@")

const stableReviewHash = (parts: readonly string[]) => {
  const value = parts.join("\u0000")
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, "0")
}

const stablePatchHash = (parts: readonly string[]) => {
  const value = parts.join("\u0000")
  let first = 1_779_033_703
  let second = 3_144_134_277
  let third = 1_013_904_242
  let fourth = 2_773_480_762
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = second ^ Math.imul(first ^ code, 597_399_067)
    second = third ^ Math.imul(second ^ code, 2_869_860_233)
    third = fourth ^ Math.imul(third ^ code, 951_274_213)
    fourth = first ^ Math.imul(fourth ^ code, 2_716_044_179)
  }
  first = Math.imul(third ^ (first >>> 18), 597_399_067)
  second = Math.imul(fourth ^ (second >>> 22), 2_869_860_233)
  third = Math.imul(first ^ (third >>> 17), 951_274_213)
  fourth = Math.imul(second ^ (fourth >>> 19), 2_716_044_179)
  first ^= second ^ third ^ fourth
  second ^= first
  third ^= first
  fourth ^= first
  return [first, second, third, fourth]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("")
}
