import { Schema } from "effect"

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

/** Stable identity for one changed file within review data. */
export const ReviewFileId = Schema.String.pipe(Schema.minLength(1), Schema.brand("ReviewFileId"))

/** Stable identity for one changed file within review data. */
export type ReviewFileId = typeof ReviewFileId.Type

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

/** Creates the canonical persisted key for one provider pull request. */
export const makePullRequestReviewKey = (
  provider: string,
  owner: string,
  name: string,
  number: number,
) => ReviewKey.make(`${provider}:${owner}/${name}#${number}`)

/** Creates a deterministic identity for a changed file, including rename metadata. */
export const makeReviewFileId = (path: string, oldPath: string | null) =>
  ReviewFileId.make(`file:${stableReviewHash([oldPath ?? "", path])}`)

/** Creates a snapshot-local hunk identity without relying on hunk ordinal. */
export const makeReviewHunkId = (fileId: ReviewFileId, header: string, lines: readonly string[]) =>
  ReviewHunkId.make(`hunk:${stableReviewHash([fileId, header, normalizedHunkContent(lines)])}`)

/** Creates a range-independent hunk fingerprint for carry-forward matching. */
export const makeReviewHunkFingerprint = (lines: readonly string[]) =>
  ReviewHunkFingerprint.make(`hunk-content:${stableReviewHash([normalizedHunkContent(lines)])}`)

const normalizedHunkContent = (lines: readonly string[]) =>
  lines.filter((line) => line !== "\\ No newline at end of file").join("\n")

const stableReviewHash = (parts: readonly string[]) => {
  const value = parts.join("\u0000")
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, "0")
}
