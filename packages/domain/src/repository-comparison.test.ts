import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { makeHostedRepositoryLocator } from "./git-provider"
import {
  GitCommitSha,
  makeRepositoryComparisonReviewKey,
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
  repositoryComparisonBaseRevision,
  repositoryComparisonHeadRevision,
} from "./repository-comparison"

const sha = (character: string) => GitCommitSha.make(character.repeat(40))

const target = RepositoryComparisonTarget.make({
  kind: "repositoryComparison",
  repository: makeHostedRepositoryLocator("github", "torvalds", "linux"),
  baseRef: RepositoryComparisonRef.make("v6.0"),
  headRef: RepositoryComparisonRef.make("v6.1"),
  baseSha: sha("a"),
  headSha: sha("b"),
  mergeBaseSha: sha("c"),
})

describe("RepositoryComparisonTarget", () => {
  it("round-trips an immutable comparison target", () => {
    const encoded = Schema.encodeSync(RepositoryComparisonTarget)(target)

    expect(Schema.decodeUnknownSync(RepositoryComparisonTarget)(encoded)).toEqual(target)
  })

  it.each([
    "abc",
    "A".repeat(40),
    "g".repeat(40),
    "a".repeat(41),
  ])("rejects malformed commit SHA %s", (value) => {
    expect(() => GitCommitSha.make(value)).toThrow(/Schema validation failed/)
  })

  it("includes every immutable comparison coordinate in the review key", () => {
    const original = makeRepositoryComparisonReviewKey(target)
    const variants = [
      RepositoryComparisonTarget.make({ ...target, baseSha: sha("d") }),
      RepositoryComparisonTarget.make({ ...target, headSha: sha("d") }),
      RepositoryComparisonTarget.make({ ...target, mergeBaseSha: sha("d") }),
      RepositoryComparisonTarget.make({
        ...target,
        repository: makeHostedRepositoryLocator("github-enterprise", "torvalds", "linux"),
      }),
    ]

    expect(variants.map(makeRepositoryComparisonReviewKey)).not.toContain(original)
    expect(new Set(variants.map(makeRepositoryComparisonReviewKey)).size).toBe(variants.length)
  })

  it("keeps identity stable when names resolve to the same immutable coordinates", () => {
    const renamed = RepositoryComparisonTarget.make({
      ...target,
      baseRef: RepositoryComparisonRef.make("refs/tags/v6.0"),
      headRef: RepositoryComparisonRef.make("refs/tags/v6.1"),
    })

    expect(makeRepositoryComparisonReviewKey(renamed)).toBe(
      makeRepositoryComparisonReviewKey(target),
    )
    expect(repositoryComparisonBaseRevision(target)).toBe(target.mergeBaseSha)
    expect(repositoryComparisonHeadRevision(target)).toBe(target.headSha)
  })
})
