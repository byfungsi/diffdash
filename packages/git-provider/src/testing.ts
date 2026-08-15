import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Result, Schema, Stream } from "effect"

import {
  HostedReviewNumber,
  makeHostedRepositoryKey,
  makeHostedReviewKey,
} from "@diffdash/domain/git-provider"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import type { GitProviderRegistration } from "./git-provider"
import {
  BufferedBytesMethod,
  FilePagesMethod,
  MaterializedGitMethod,
  ReviewDiffAcquisition,
  ReviewDiffByteCompletion,
  ReviewDiffByteStreamValidator,
  ReviewDiffGeneration,
  ReviewDiffMethodUnsupported,
  ReviewDiffPageValidator,
  UnifiedBytesMethod,
  validateReviewDiffBufferedBytes,
  validateReviewDiffSourceOffer,
  type ReviewDiffFile,
  type ReviewDiffSource,
} from "./review-diff-source"

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
        const checkout = yield* provider.checkoutSpec(
          review.locator,
          ReviewRevision.make("provider-conformance-revision"),
        )
        expect(checkout.review).toEqual(review.locator)
        expect(checkout.revision).toBe("provider-conformance-revision")
      }),
    )
  })
}

/** Shared expected values required by the bounded review diff source conformance suite. */
export interface ReviewDiffSourceConformanceFixtures {
  readonly create: () => ReviewDiffSource
  readonly createCancellable: () => {
    readonly source: ReviewDiffSource
    readonly closed: () => boolean
  }
  readonly expectedBytes: Uint8Array
  readonly expectedFiles: readonly ReviewDiffFile[]
}

const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((bytes, chunk) => bytes + chunk.byteLength, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

/** Registers reusable behavioral checks for every bounded review diff acquisition method. */
export const reviewDiffSourceConformance = (
  name: string,
  fixtures: ReviewDiffSourceConformanceFixtures,
): void => {
  describe(`${name} review diff source conformance`, () => {
    it.effect("validates the offer and derives one identity across all offered methods", () =>
      Effect.gen(function* () {
        const source = fixtures.create()
        yield* validateReviewDiffSourceOffer(source.offer)
        const identities = new Set<string>()

        for (const [index, method] of source.offer.methods.entries()) {
          const acquisition = ReviewDiffAcquisition.make({
            generation: ReviewDiffGeneration.make(`conformance-${index}`),
            expectedRevision: source.offer.expectedRevision,
          })
          if (Schema.is(UnifiedBytesMethod)(method)) {
            const events = yield* source.unifiedBytes(acquisition).pipe(Stream.runCollect)
            const completion = Array.from(events).find((event): event is ReviewDiffByteCompletion =>
              Schema.is(ReviewDiffByteCompletion)(event),
            )
            expect(completion).toBeDefined()
            if (completion !== undefined) identities.add(completion.semanticIdentity)
          } else if (Schema.is(FilePagesMethod)(method)) {
            const validator = new ReviewDiffPageValidator(
              acquisition.generation,
              acquisition.expectedRevision,
              source.offer.semanticIdentity,
              method,
            )
            let pageOrdinal = 0
            while (pageOrdinal < 10_000) {
              const page = yield* source.filePage(acquisition, pageOrdinal)
              yield* validator.accept(page)
              identities.add(page.semanticIdentity)
              if (page.complete) break
              pageOrdinal += 1
            }
            yield* validator.finish()
          } else if (Schema.is(MaterializedGitMethod)(method)) {
            identities.add((yield* source.materializedGit(acquisition)).semanticIdentity)
          } else if (Schema.is(BufferedBytesMethod)(method)) {
            identities.add((yield* source.bufferedBytes(acquisition)).semanticIdentity)
          }
        }

        expect(identities).toEqual(new Set([source.offer.semanticIdentity]))
        yield* source.close
      }),
    )

    it.effect("enforces unified chunk boundaries and terminal completeness", () =>
      Effect.gen(function* () {
        const source = fixtures.create()
        const method = source.offer.methods.find((candidate): candidate is UnifiedBytesMethod =>
          Schema.is(UnifiedBytesMethod)(candidate),
        )
        const acquisition = ReviewDiffAcquisition.make({
          generation: ReviewDiffGeneration.make("conformance-unified"),
          expectedRevision: source.offer.expectedRevision,
        })
        if (method === undefined) {
          const unsupported = yield* source
            .unifiedBytes(acquisition)
            .pipe(Stream.runDrain, Effect.result)
          expect(Result.isFailure(unsupported)).toBe(true)
          if (Result.isFailure(unsupported))
            expect(unsupported.failure).toBeInstanceOf(ReviewDiffMethodUnsupported)
          return
        }

        const chunks: Uint8Array[] = []
        let completion: ReviewDiffByteCompletion | undefined
        const validator = new ReviewDiffByteStreamValidator(
          acquisition.generation,
          acquisition.expectedRevision,
          source.offer.semanticIdentity,
          method.maxChunkBytes,
        )
        const events = yield* source.unifiedBytes(acquisition).pipe(Stream.runCollect)
        for (const event of events) {
          const validated = yield* validator.accept(event)
          if (Schema.is(ReviewDiffByteCompletion)(validated)) completion = validated
          else chunks.push(validated.bytes)
        }
        yield* validator.finish()
        expect(completion).toBeDefined()
        expect(completion?.totalBytes).toBe(fixtures.expectedBytes.byteLength)
        expect(concatBytes(chunks)).toEqual(fixtures.expectedBytes)
        yield* source.close
      }),
    )

    it.effect("returns complete ordered file pages or typed unsupported", () =>
      Effect.gen(function* () {
        const source = fixtures.create()
        const method = source.offer.methods.find((candidate): candidate is FilePagesMethod =>
          Schema.is(FilePagesMethod)(candidate),
        )
        const acquisition = ReviewDiffAcquisition.make({
          generation: ReviewDiffGeneration.make("conformance-pages"),
          expectedRevision: source.offer.expectedRevision,
        })
        if (method === undefined) {
          const unsupported = yield* Effect.result(source.filePage(acquisition, 0))
          expect(Result.isFailure(unsupported)).toBe(true)
          if (Result.isFailure(unsupported))
            expect(unsupported.failure).toBeInstanceOf(ReviewDiffMethodUnsupported)
          return
        }

        const validator = new ReviewDiffPageValidator(
          acquisition.generation,
          acquisition.expectedRevision,
          source.offer.semanticIdentity,
          method,
        )
        const files: ReviewDiffFile[] = []
        for (let pageOrdinal = 0; pageOrdinal < 10_000; pageOrdinal += 1) {
          const page = yield* source.filePage(acquisition, pageOrdinal)
          yield* validator.accept(page)
          files.push(...page.files)
          if (page.complete) break
        }
        yield* validator.finish()
        expect(files).toEqual(fixtures.expectedFiles)
        yield* source.close
      }),
    )

    it.effect("enforces the complete buffer cap and exact Git metadata", () =>
      Effect.gen(function* () {
        const source = fixtures.create()
        const buffered = source.offer.methods.find((candidate): candidate is BufferedBytesMethod =>
          Schema.is(BufferedBytesMethod)(candidate),
        )
        const materialized = source.offer.methods.some(Schema.is(MaterializedGitMethod))
        const acquisition = ReviewDiffAcquisition.make({
          generation: ReviewDiffGeneration.make("conformance-terminal-methods"),
          expectedRevision: source.offer.expectedRevision,
        })

        const bufferResult = yield* Effect.result(source.bufferedBytes(acquisition))
        if (buffered === undefined) {
          expect(Result.isFailure(bufferResult)).toBe(true)
        } else {
          expect(Result.isSuccess(bufferResult)).toBe(true)
          if (Result.isSuccess(bufferResult)) {
            const value = yield* validateReviewDiffBufferedBytes(
              bufferResult.success,
              buffered.maxBytes,
            )
            expect(value.bytes).toEqual(fixtures.expectedBytes)
          }
        }

        const gitResult = yield* Effect.result(source.materializedGit(acquisition))
        expect(Result.isSuccess(gitResult)).toBe(materialized)
        if (Result.isSuccess(gitResult)) {
          expect(gitResult.success.revision).toBe(source.offer.expectedRevision)
          expect(gitResult.success.semanticIdentity).toBe(source.offer.semanticIdentity)
        }
        yield* source.close
      }),
    )

    it.effect("allows deterministic cleanup after any acquisition", () =>
      Effect.gen(function* () {
        const source = fixtures.create()
        yield* source.close
      }),
    )

    it.effect("closes an in-progress source when acquisition is cancelled", () =>
      Effect.gen(function* () {
        const { source, closed } = fixtures.createCancellable()
        const acquisition = ReviewDiffAcquisition.make({
          generation: ReviewDiffGeneration.make("conformance-cancelled"),
          expectedRevision: source.offer.expectedRevision,
        })
        const fiber = yield* source
          .unifiedBytes(acquisition)
          .pipe(Stream.runDrain, Effect.forkChild)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        expect(closed()).toBe(true)
      }),
    )
  })
}
