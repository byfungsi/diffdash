import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { workingTreeReviewTarget } from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { ReviewThreadScope, reviewThreadScopeIdentity } from "./review-thread-scope"

describe("reviewThreadScopeIdentity", () => {
  it("uses semantic hosted-review and revision identity", () => {
    const scope = hostedScope(51, "base-1", "head-1")

    expect(reviewThreadScopeIdentity(scope)).toBe(
      reviewThreadScopeIdentity(hostedScope(51, "base-1", "head-1")),
    )
    expect(reviewThreadScopeIdentity(scope)).not.toBe(
      reviewThreadScopeIdentity(hostedScope(52, "base-1", "head-1")),
    )
    expect(reviewThreadScopeIdentity(scope)).not.toBe(
      reviewThreadScopeIdentity(hostedScope(51, "base-1", "head-2")),
    )
  })

  it("distinguishes target kinds and unavailable revisions", () => {
    const hosted = hostedScope(51, null, null)
    const local = ReviewThreadScope.make({
      target: workingTreeReviewTarget(RepositoryCheckoutPath.make("/work/diffdash")),
      baseRevision: Option.none(),
      headRevision: Option.none(),
    })

    expect(reviewThreadScopeIdentity(hosted)).not.toBe(reviewThreadScopeIdentity(local))
    expect(reviewThreadScopeIdentity(hosted)).not.toBe(
      reviewThreadScopeIdentity(hostedScope(51, "base-known", null)),
    )
  })

  it("preserves nullable revisions only in the encoded representation", () => {
    const scope = hostedScope(51, null, "head-known")

    expect(Schema.encodeSync(ReviewThreadScope)(scope)).toMatchObject({
      baseRevision: null,
      headRevision: "head-known",
    })
    expect(
      Schema.decodeSync(ReviewThreadScope)({
        target: scope.target,
        baseRevision: null,
        headRevision: "head-known",
      }),
    ).toMatchObject({
      baseRevision: Option.none(),
      headRevision: Option.some(ReviewRevision.make("head-known")),
    })
  })
})

const hostedScope = (
  reviewNumber: number,
  baseRevision: string | null,
  headRevision: string | null,
) =>
  ReviewThreadScope.make({
    target: HostedReviewTarget.make({
      kind: "hosted",
      review: makeHostedReviewLocator("github", "fungsi", "diffdash", reviewNumber),
    }),
    baseRevision: Option.fromNullishOr(baseRevision).pipe(Option.map(ReviewRevision.make)),
    headRevision: Option.fromNullishOr(headRevision).pipe(Option.map(ReviewRevision.make)),
  })
