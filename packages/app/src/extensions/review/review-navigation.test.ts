import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { BranchComparison, LocalReviewTarget } from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import { Match, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { serializeLocalReviewAtomKey } from "@/review/atoms"
import type { SelectedReviewTarget } from "@/review/review-subject"

import {
  decodeReviewNavigationState,
  encodeReviewNavigationState,
  restoreReviewNavigationState,
  reviewNavigationContribution,
} from "./review-navigation"

describe("Review navigation contribution", () => {
  it("round-trips and restores a selected review through JSON-safe state", () => {
    const selection = {
      kind: "hosted" as const,
      review: makeHostedReviewLocator("github", "fungsi", "diffdash", 101),
    }
    const encoded = encodeReviewNavigationState({ selectedReview: Option.some(selection) })
    const cloned = Schema.decodeUnknownSync(Schema.Json)(structuredClone(encoded))
    let restored = Option.none<SelectedReviewTarget>()

    restoreReviewNavigationState(cloned, {
      selectReview: (selectedReview) => {
        restored = selectedReview
      },
    })

    expect(restored).toEqual(Option.some(selection))
    expect(decodeReviewNavigationState(cloned).selectedReview).toEqual(Option.some(selection))
    expect(reviewNavigationContribution.sameState(encoded, cloned)).toBe(true)
    expect(reviewNavigationContribution.isValidState([])).toBe(false)
    expect(encodeReviewNavigationState({ selectedReview: Option.none() })).toEqual({
      selectedReview: null,
    })
  })

  it("preserves a resolved merge-base branch target", () => {
    const selection = {
      kind: "localDiff" as const,
      target: LocalReviewTarget.make({
        kind: "local",
        rootPath: RepositoryCheckoutPath.make("/workspace/diffdash"),
        comparison: BranchComparison.make({
          branchName: RepositoryComparisonRef.make("dev"),
          baseRef: RepositoryComparisonRef.make("refs/heads/dev"),
          baseSha: ReviewRevision.make("a".repeat(40)),
        }),
      }),
    }

    const decoded = decodeReviewNavigationState(
      encodeReviewNavigationState({ selectedReview: Option.some(selection) }),
    )

    expect(decoded).toEqual({ selectedReview: Option.some(selection) })
    const selectedReview = Option.getOrThrow(decoded.selectedReview)
    const localTarget = Match.value(selectedReview).pipe(
      Match.discriminatorsExhaustive("kind")({
        hosted: () => {
          throw new Error("Expected local diff review target")
        },
        localDiff: ({ target }) => target,
        repositoryComparison: () => {
          throw new Error("Expected local diff review target")
        },
      }),
    )
    expect(localTarget).toBeInstanceOf(LocalReviewTarget)
    expect(serializeLocalReviewAtomKey(localTarget)).toBe(
      serializeLocalReviewAtomKey(selection.target),
    )
  })
})
