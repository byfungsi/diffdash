import { Effect, Schema } from "effect"

import { ChangedFile } from "./git-provider"
import { RepositoryCheckoutPath } from "./repository"
import { RepositoryComparisonRef } from "./repository-comparison"
import { ReviewDiffIdentity, ReviewRevision } from "./review-identity"

/** Local changes compared with the checkout's current HEAD. */
export const WorkingTreeComparison = Schema.TaggedStruct("workingTree", {})

/** Local checkout compared from its merge base with one resolved comparison branch. */
export const BranchComparison = Schema.TaggedStruct("branch", {
  branchName: RepositoryComparisonRef,
  baseRef: RepositoryComparisonRef,
  baseSha: ReviewRevision,
})

/** Local checkout compared from the merge base of one resolved Git revision. */
export const RevisionComparison = Schema.TaggedStruct("revision", {
  revision: RepositoryComparisonRef,
  baseSha: ReviewRevision,
})

/** Immutable local comparison between two resolved Git revisions. */
export const RevisionRangeComparison = Schema.TaggedStruct("revisionRange", {
  baseRef: RepositoryComparisonRef,
  headRef: RepositoryComparisonRef,
  baseSha: ReviewRevision,
  headSha: ReviewRevision,
  mergeBaseSha: ReviewRevision,
})

/** One immutable commit compared with its first parent, or the empty tree for a root commit. */
export const LastCommitComparison = Schema.TaggedStruct("lastCommit", {
  baseSha: ReviewRevision,
  headSha: ReviewRevision,
})

/** The comparison strategy used to build a local review. */
export const LocalReviewComparison = Schema.Union([
  WorkingTreeComparison,
  BranchComparison,
  RevisionComparison,
  RevisionRangeComparison,
  LastCommitComparison,
]).pipe(Schema.toTaggedUnion("_tag"))

/** The comparison strategy used to build a local review. */
export type LocalReviewComparison = typeof LocalReviewComparison.Type

/** Renderer-safe locator for one local review. */
export class LocalReviewTarget extends Schema.Class<LocalReviewTarget>("LocalReviewTarget")({
  kind: Schema.Literal("local"),
  rootPath: RepositoryCheckoutPath,
  comparison: LocalReviewComparison.pipe(
    Schema.withConstructorDefault(Effect.succeed(WorkingTreeComparison.make({}))),
    Schema.withDecodingDefault(Effect.succeed(WorkingTreeComparison.make({}))),
  ),
}) {}

/** Detailed metadata for reviewing local working tree changes. */
export class LocalReviewDetail extends Schema.Class<LocalReviewDetail>("LocalReviewDetail")({
  rootPath: RepositoryCheckoutPath,
  repoName: Schema.String,
  branchName: Schema.NullOr(RepositoryComparisonRef),
  comparison: LocalReviewComparison.pipe(
    Schema.withConstructorDefault(Effect.succeed(WorkingTreeComparison.make({}))),
    Schema.withDecodingDefault(Effect.succeed(WorkingTreeComparison.make({}))),
  ),
  baseSha: ReviewRevision,
  headSha: ReviewRevision,
  diffHash: ReviewDiffIdentity,
  title: Schema.String,
  files: Schema.Array(ChangedFile),
  fetchedAt: Schema.String,
}) {}

/** Creates the legacy working-tree-versus-HEAD review target. */
export const workingTreeReviewTarget = (rootPath: RepositoryCheckoutPath) =>
  LocalReviewTarget.make({
    kind: "local",
    rootPath,
    comparison: WorkingTreeComparison.make({}),
  })

/** Stable cache key for one local review target. */
export const localReviewTargetKey = (target: LocalReviewTarget) =>
  LocalReviewComparison.match(target.comparison, {
    workingTree: () => `${target.rootPath}\u0000workingTree`,
    branch: (comparison) =>
      `${target.rootPath}\u0000branch\u0000${comparison.baseRef}\u0000${comparison.baseSha}`,
    revision: (comparison) =>
      `${target.rootPath}\u0000revision\u0000${comparison.revision}\u0000${comparison.baseSha}`,
    revisionRange: (comparison) =>
      `${target.rootPath}\u0000revisionRange\u0000${comparison.baseSha}\u0000${comparison.headSha}\u0000${comparison.mergeBaseSha}`,
    lastCommit: (comparison) =>
      `${target.rootPath}\u0000lastCommit\u0000${comparison.baseSha}\u0000${comparison.headSha}`,
  })
