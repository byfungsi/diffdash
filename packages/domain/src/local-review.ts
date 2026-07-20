import { Schema } from "effect"

import { ChangedFile } from "./git-provider"

/** Local changes compared with the checkout's current HEAD. */
export const WorkingTreeComparison = Schema.TaggedStruct("workingTree", {})

/** Local checkout compared from its merge base with one resolved comparison branch. */
export const BranchComparison = Schema.TaggedStruct("branch", {
  branchName: Schema.NonEmptyString,
  baseRef: Schema.NonEmptyString,
  baseSha: Schema.NonEmptyString,
})

/** The comparison strategy used to build a local review. */
export const LocalReviewComparison = Schema.Union(WorkingTreeComparison, BranchComparison)

/** The comparison strategy used to build a local review. */
export type LocalReviewComparison = typeof LocalReviewComparison.Type

/** Renderer-safe locator for one local review. */
export class LocalReviewTarget extends Schema.Class<LocalReviewTarget>("LocalReviewTarget")({
  kind: Schema.Literal("local"),
  rootPath: Schema.NonEmptyString,
  comparison: Schema.optionalWith(LocalReviewComparison, {
    default: () => WorkingTreeComparison.make({}),
  }),
}) {}

/** Detailed metadata for reviewing local working tree changes. */
export class LocalReviewDetail extends Schema.Class<LocalReviewDetail>("LocalReviewDetail")({
  rootPath: Schema.String,
  repoName: Schema.String,
  branchName: Schema.NullOr(Schema.String),
  comparison: Schema.optionalWith(LocalReviewComparison, {
    default: () => WorkingTreeComparison.make({}),
  }),
  baseSha: Schema.String,
  headSha: Schema.String,
  diffHash: Schema.String,
  title: Schema.String,
  files: Schema.Array(ChangedFile),
  fetchedAt: Schema.String,
}) {}

/** Raw unified diff output and cache metadata for local working tree changes. */
export class LocalReviewDiff extends Schema.Class<LocalReviewDiff>("LocalReviewDiff")({
  rootPath: Schema.String,
  comparison: Schema.optionalWith(LocalReviewComparison, {
    default: () => WorkingTreeComparison.make({}),
  }),
  baseSha: Schema.String,
  headSha: Schema.String,
  diffHash: Schema.String,
  diff: Schema.String,
  fetchedAt: Schema.String,
}) {}

/** Creates the legacy working-tree-versus-HEAD review target. */
export const workingTreeReviewTarget = (rootPath: string) =>
  LocalReviewTarget.make({
    kind: "local",
    rootPath,
    comparison: WorkingTreeComparison.make({}),
  })

/** Stable cache key for one local review target. */
export const localReviewTargetKey = (target: LocalReviewTarget) =>
  target.comparison["_tag"] === "workingTree"
    ? `${target.rootPath}\u0000workingTree`
    : `${target.rootPath}\u0000branch\u0000${target.comparison.baseRef}\u0000${target.comparison.baseSha}`
