import { Schema } from "effect"

/** Local changes compared with the checkout's current HEAD. */
export const WorkingTreeComparison = Schema.TaggedStruct("workingTree", {})

/** Local worktree compared with one resolved local or remote-tracking branch. */
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
