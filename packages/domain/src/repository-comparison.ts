import { Schema } from "effect"

import { HostedRepositoryLocator, makeHostedRepositoryKey } from "./git-provider"
import { ReviewKey, ReviewRevision } from "./review-identity"

const forbiddenGitRevisionCharacters = new Set(["~", "^", ":", "?", "*", "[", "\\"])

const isSafeGitRevisionInput = (input: string): boolean => {
  if (
    input.length === 0 ||
    input.length > 255 ||
    input === "@" ||
    input.startsWith("-") ||
    input.startsWith(".") ||
    input.endsWith(".") ||
    input.endsWith("/") ||
    input.includes("..") ||
    input.includes("//") ||
    input.includes("@{") ||
    input.split("/").some((component) => component.startsWith(".") || component.endsWith(".lock"))
  ) {
    return false
  }

  return [...input].every((character) => {
    const codePoint = character.codePointAt(0)
    return (
      codePoint !== undefined &&
      codePoint > 0x20 &&
      codePoint !== 0x7f &&
      !forbiddenGitRevisionCharacters.has(character)
    )
  })
}

/** Safe branch, tag, or full commit input for one repository comparison. */
export const RepositoryComparisonRef = Schema.String.pipe(
  Schema.filter(isSafeGitRevisionInput, { message: () => "Invalid Git revision" }),
  Schema.brand("RepositoryComparisonRef"),
)

/** Safe branch, tag, or full commit input for one repository comparison. */
export type RepositoryComparisonRef = typeof RepositoryComparisonRef.Type

/** Full normalized SHA-1 or SHA-256 Git commit object identity. */
export const GitCommitSha = Schema.String.pipe(
  Schema.pattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
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
