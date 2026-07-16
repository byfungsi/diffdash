import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  HostedReviewNumber,
  makeHostedRepositoryKey,
  makeHostedReviewKey,
} from "@diffdash/domain/git-provider"
import type { GitProviderRegistration } from "./git-provider"

/** Shared fixtures required by the hosted Git provider conformance suite. */
export interface GitProviderConformanceFixtures {
  readonly create: () => GitProviderRegistration
  readonly configuredRemote: string
  readonly nestedNamespace: string
  readonly repositoryName: string
  readonly reviewNumber: number
}

/** Registers the reusable behavioral contract for a concrete Git provider. */
export const gitProviderConformance = (name: string, fixtures: GitProviderConformanceFixtures) => {
  describe(`${name} Git provider conformance`, () => {
    it.effect("exposes a coherent descriptor and configured-host remote identity", () =>
      Effect.gen(function* () {
        const provider = fixtures.create()
        const locator = yield* provider.parseRemote(fixtures.configuredRemote)
        expect(locator).not.toBeNull()
        if (locator === null) return
        expect(locator.providerId).toBe(provider.descriptor.id)
        expect(locator.namespace).toBe(fixtures.nestedNamespace)
        expect(locator.name).toBe(fixtures.repositoryName)
        expect(makeHostedRepositoryKey(locator)).toContain(`${provider.descriptor.id}:`)
      }),
    )

    it.effect("normalizes search, reviews, decisions, and checkout specifications", () =>
      Effect.gen(function* () {
        const provider = fixtures.create()
        const repositories = yield* provider.searchRepositories({ query: "", namespaces: [] })
        const repository = repositories[0]
        expect(repository).toBeDefined()
        if (repository === undefined) return
        const reviews = yield* provider.listReviews(repository.locator)
        const review = reviews[0]
        expect(review).toBeDefined()
        if (review === undefined) return
        expect(review.locator.number).toBe(HostedReviewNumber.make(fixtures.reviewNumber))
        expect(makeHostedReviewKey(review.locator)).toContain(`#${fixtures.reviewNumber}`)
        yield* provider.getReview(review.locator)
        yield* provider.getReviewDiff(review.locator)
        yield* provider.getReviewDecision(review.locator)
        yield* provider.bootstrapBareRepository(repository.locator, "/tmp/provider-conformance.git")
        const checkout = yield* provider.checkoutSpec(review.locator)
        expect(checkout.review).toEqual(review.locator)
      }),
    )
  })
}
