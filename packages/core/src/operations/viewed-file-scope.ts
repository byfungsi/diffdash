import {
  makeRepositoryComparisonReviewKey,
  type RepositoryComparisonRef,
  type RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import type { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import { LocalViewedFileScope } from "@diffdash/persistence/viewed-file-store"
import { Match, Option } from "effect"

/** Builds the exact persisted viewed-file identity for one local review. */
export const localViewedFileScope = (
  repoId: ReviewProjectId,
  target: Extract<ReviewThreadTarget, { readonly kind: "local" }>,
  sourceBranch: RepositoryComparisonRef | null,
): LocalViewedFileScope => {
  const sourceIdentity = Option.match(Option.fromNullishOr(sourceBranch), {
    onNone: () => "detached",
    onSome: (branch) => `branch:${branch}`,
  })
  const comparison = Match.valueTags(target.comparison, {
    workingTree: () => ({ comparisonKind: "workingTree" as const, comparisonTarget: "" }),
    branch: ({ branchName }) => ({
      comparisonKind: "branch" as const,
      comparisonTarget: branchName,
    }),
  })
  return LocalViewedFileScope.make({
    repoId,
    sourceIdentity,
    ...comparison,
  })
}

/** Builds the exact persisted viewed-file identity for one immutable repository comparison. */
export const comparisonViewedFileScope = (
  repoId: ReviewProjectId,
  target: RepositoryComparisonTarget,
): LocalViewedFileScope =>
  LocalViewedFileScope.make({
    repoId,
    sourceIdentity: `comparison:${makeRepositoryComparisonReviewKey(target)}`,
    comparisonKind: "repositoryComparison",
    comparisonTarget: target.headSha,
  })
