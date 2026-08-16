import { Schema } from "effect"

import { ChangedFile, HostedRepositoryLocator, makeHostedRepositoryKey } from "./git-provider"
import { RepositoryComparisonRef } from "./repository-comparison-ref"
import { ReviewKey, ReviewRevision } from "./review-identity"

export { RepositoryComparisonRef } from "./repository-comparison-ref"

/** Full normalized SHA-1 or SHA-256 Git commit object identity. */
export const GitCommitSha = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)),
  Schema.brand("GitCommitSha"),
)

/** Full normalized SHA-1 or SHA-256 Git commit object identity. */
export type GitCommitSha = typeof GitCommitSha.Type

/** Immutable repository comparison resolved from two requested Git revisions. */
export class RepositoryComparisonTarget extends Schema.Class<RepositoryComparisonTarget>(
  "RepositoryComparisonTarget",
)({
  kind: Schema.Literal("repositoryComparison"),
  repository: HostedRepositoryLocator,
  baseRef: RepositoryComparisonRef,
  headRef: RepositoryComparisonRef,
  baseSha: GitCommitSha,
  headSha: GitCommitSha,
  mergeBaseSha: GitCommitSha,
}) {}

/** Renderer-safe metadata for one exact immutable repository comparison. */
export class RepositoryComparisonDetail extends Schema.Class<RepositoryComparisonDetail>(
  "RepositoryComparisonDetail",
)({
  target: RepositoryComparisonTarget,
  title: Schema.String,
  files: Schema.Array(ChangedFile),
  fetchedAt: Schema.String,
}) {}

/** Creates the durable identity for one exact repository comparison. */
export const makeRepositoryComparisonReviewKey = (target: RepositoryComparisonTarget) =>
  ReviewKey.make(
    [
      "repository-comparison:v1",
      makeHostedRepositoryKey(target.repository),
      target.baseSha,
      target.headSha,
      target.mergeBaseSha,
    ].join(":"),
  )

/** Returns the effective rendered base revision for a repository comparison. */
export const repositoryComparisonBaseRevision = (target: RepositoryComparisonTarget) =>
  ReviewRevision.make(target.mergeBaseSha)

/** Returns the immutable rendered head revision for a repository comparison. */
export const repositoryComparisonHeadRevision = (target: RepositoryComparisonTarget) =>
  ReviewRevision.make(target.headSha)
