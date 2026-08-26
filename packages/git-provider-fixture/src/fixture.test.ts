import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import {
  GitProviderOperationError,
  ReviewRevision,
  makeHostedRepositoryLocator,
  makeHostedReviewLocator,
} from "@diffdash/git-provider"
import { gitProviderConformance } from "@diffdash/git-provider/testing"
import { createFixtureGitProvider } from "./fixture"

gitProviderConformance("Fixture Forge", {
  create: createFixtureGitProvider,
  configuredRemote: "https://git.fixture.test/platform/backend/service.git",
  nestedNamespace: "platform/backend",
  repositoryName: "service",
  reviewNumber: 73,
})

describe("Fixture Forge provider", () => {
  it.effect("drives a complete provider-owned hosted review read flow", () =>
    Effect.gen(function* () {
      const provider = createFixtureGitProvider()
      const repositories = yield* provider.searchRepositories({ query: "service", namespaces: [] })
      const repository = repositories[0]
      expect(repository).toBeDefined()
      if (repository === undefined) return

      const reviews = yield* provider.listReviews(repository.locator)
      const review = reviews[0]
      expect(review).toBeDefined()
      if (review === undefined) return

      const detail = yield* provider.getReview(review.locator)
      const source = yield* provider.getReviewDiffSource(review.locator)
      const checkout = yield* provider.checkoutSpec(
        review.locator,
        ReviewRevision.make("fixture-head"),
      )

      expect(detail.summary.title).toBe("Fixture merge request flow")
      expect(detail.files[0]?.path).toBe("src/fixture.ts")
      expect(detail.mergeState.status).toBe("unavailable")
      expect(provider.descriptor.capabilities.reviewBranchUpdates).toBe(false)
      expect(provider.updateReviewBranch).toBeUndefined()
      expect(source.offer.expectedRevision).toBe(detail.summary.head.revision)
      expect(checkout.fetchRef).toBe("refs/merge-requests/73/head")
      yield* source.close
    }),
  )

  it.effect("rejects a same-provider locator for another repository or review", () =>
    Effect.gen(function* () {
      const provider = createFixtureGitProvider()
      const repositoryResult = yield* Effect.result(
        provider.listReviews(
          makeHostedRepositoryLocator("fixture", "platform/backend", "other-service"),
        ),
      )
      const reviewResult = yield* Effect.result(
        provider.getReview(makeHostedReviewLocator("fixture", "platform/backend", "service", 74)),
      )

      expect(Result.isFailure(repositoryResult)).toBe(true)
      expect(Result.isFailure(reviewResult)).toBe(true)
      if (Result.isFailure(repositoryResult)) {
        expect(repositoryResult.failure).toBeInstanceOf(GitProviderOperationError)
      }
      if (Result.isFailure(reviewResult)) {
        expect(reviewResult.failure).toBeInstanceOf(GitProviderOperationError)
      }
    }),
  )
})
