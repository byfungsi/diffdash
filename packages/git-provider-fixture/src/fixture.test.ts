import { describe, expect, it } from "@effect/vitest"
import { Effect, Either } from "effect"

import {
  GitProviderOperationError,
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
      const diff = yield* provider.getReviewDiff(review.locator)
      const checkout = yield* provider.checkoutSpec(review.locator)

      expect(detail.summary.title).toBe("Fixture merge request flow")
      expect(detail.files[0]?.path).toBe("src/fixture.ts")
      expect(diff.diff).toContain("+new fixture")
      expect(checkout.fetchRef).toBe("refs/merge-requests/73/head")
    }),
  )

  it.effect("rejects a same-provider locator for another repository or review", () =>
    Effect.gen(function* () {
      const provider = createFixtureGitProvider()
      const repositoryResult = yield* Effect.either(
        provider.listReviews(
          makeHostedRepositoryLocator("fixture", "platform/backend", "other-service"),
        ),
      )
      const reviewResult = yield* Effect.either(
        provider.getReview(makeHostedReviewLocator("fixture", "platform/backend", "service", 74)),
      )

      expect(Either.isLeft(repositoryResult)).toBe(true)
      expect(Either.isLeft(reviewResult)).toBe(true)
      if (Either.isLeft(repositoryResult)) {
        expect(repositoryResult.left).toBeInstanceOf(GitProviderOperationError)
      }
      if (Either.isLeft(reviewResult)) {
        expect(reviewResult.left).toBeInstanceOf(GitProviderOperationError)
      }
    }),
  )
})
