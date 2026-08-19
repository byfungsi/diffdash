import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Stream } from "effect"

import {
  GitProviderId,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewLocator,
  HostedReviewNumber,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import { ReviewDiffIdentity, ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import {
  HostedReviewDiffSourceTarget,
  REVIEW_DIFF_MAX_CHUNK_BYTES,
  ReviewDiffByteCompletion,
  ReviewDiffByteStreamValidator,
  ReviewDiffGeneration,
  ReviewDiffGenerationReused,
  ReviewDiffGenerationTracker,
  ReviewDiffLimitExceeded,
  ReviewDiffSourceFacts,
  ReviewDiffSourceOffer,
  UnifiedBytesMethod,
  reviewDiffStorageRequirement,
  validateReviewDiffByteChunk,
  validateReviewDiffSourceOffer,
  type ReviewDiffSource,
} from "./review-diff-source"
import { reviewDiffSourceConformance } from "./testing"

const generation = ReviewDiffGeneration.make("generation-1")
const revision = ReviewRevision.make("revision-1")
const identity = ReviewDiffIdentity.make("diff:v1:canonical")
const review = HostedReviewLocator.make({
  repository: HostedRepositoryLocator.make({
    providerId: GitProviderId.make("fixture"),
    namespace: RepositoryNamespace.make("platform"),
    name: HostedRepositoryName.make("service"),
  }),
  number: HostedReviewNumber.make(42),
})
const bytes = new TextEncoder().encode("diff --git a/src/app.ts b/src/app.ts\n")
const offer = ReviewDiffSourceOffer.make({
  target: HostedReviewDiffSourceTarget.make({
    review,
    reviewKey: ReviewKey.make("fixture:platform/service#42"),
  }),
  expectedRevision: revision,
  semanticIdentity: identity,
  methods: [UnifiedBytesMethod.make({ maxChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES })],
  facts: ReviewDiffSourceFacts.make({
    origin: "local",
    revisionKind: "immutableGit",
    reproducible: true,
    complete: true,
    declaredBytes: bytes.byteLength,
  }),
})

const makeSource = (): ReviewDiffSource => ({
  offer,
  unifiedBytes: (request) =>
    Stream.fromIterable([
      { bytes },
      ReviewDiffByteCompletion.make({
        generation: request.generation,
        revision,
        semanticIdentity: identity,
        totalBytes: bytes.byteLength,
      }),
    ]),
  close: Effect.void,
})

reviewDiffSourceConformance("complete fixture", {
  create: makeSource,
  createCancellable: () => {
    let closed = false
    return {
      source: {
        ...makeSource(),
        unifiedBytes: () =>
          Stream.never.pipe(Stream.ensuring(Effect.sync(() => void (closed = true)))),
      },
      closed: () => closed,
    }
  },
  expectedBytes: bytes,
})

describe("review diff source boundaries", () => {
  it.effect("accepts exact byte limits, copies chunks, and rejects zero or one byte over", () =>
    Effect.gen(function* () {
      const exactInput = new Uint8Array(REVIEW_DIFF_MAX_CHUNK_BYTES)
      const exact = yield* validateReviewDiffByteChunk(generation, { bytes: exactInput })
      exactInput[0] = 1
      expect(exact.bytes[0]).toBe(0)

      for (const size of [0, REVIEW_DIFF_MAX_CHUNK_BYTES + 1]) {
        const result = yield* Effect.result(
          validateReviewDiffByteChunk(generation, { bytes: new Uint8Array(size) }),
        )
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(ReviewDiffLimitExceeded)
      }
    }),
  )

  it.effect("requires exactly one coherent byte-stream completion", () =>
    Effect.gen(function* () {
      const validator = new ReviewDiffByteStreamValidator(generation, revision, identity)
      yield* validator.accept({ bytes })
      yield* validator.accept(
        ReviewDiffByteCompletion.make({
          generation,
          revision,
          semanticIdentity: identity,
          totalBytes: bytes.byteLength,
        }),
      )
      yield* validator.finish()
      expect(Result.isFailure(yield* Effect.result(validator.accept({ bytes })))).toBe(true)

      const wrongTotal = new ReviewDiffByteStreamValidator(generation, revision, identity)
      yield* wrongTotal.accept({ bytes })
      expect(
        Result.isFailure(
          yield* Effect.result(
            wrongTotal.accept(
              ReviewDiffByteCompletion.make({
                generation,
                revision,
                semanticIdentity: identity,
                totalBytes: bytes.byteLength - 1,
              }),
            ),
          ),
        ),
      ).toBe(true)

      const truncated = yield* Effect.result(
        new ReviewDiffByteStreamValidator(generation, revision, identity).finish(),
      )
      expect(Result.isFailure(truncated)).toBe(true)
    }),
  )

  it.effect("rejects empty, duplicate, or oversized source offers", () =>
    Effect.gen(function* () {
      const invalidOffers = [
        ReviewDiffSourceOffer.make({ ...offer, methods: [] }),
        ReviewDiffSourceOffer.make({
          ...offer,
          methods: [
            UnifiedBytesMethod.make({ maxChunkBytes: 1 }),
            UnifiedBytesMethod.make({ maxChunkBytes: 1 }),
          ],
        }),
        ReviewDiffSourceOffer.make({
          ...offer,
          methods: [UnifiedBytesMethod.make({ maxChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES + 1 })],
        }),
      ]
      for (const invalidOffer of invalidOffers) {
        expect(
          Result.isFailure(yield* Effect.result(validateReviewDiffSourceOffer(invalidOffer))),
        ).toBe(true)
      }
    }),
  )

  it.effect("requires a fresh generation for every acquisition and fallback", () =>
    Effect.gen(function* () {
      const tracker = new ReviewDiffGenerationTracker()
      yield* tracker.begin(generation)
      yield* tracker.begin(ReviewDiffGeneration.make("generation-2"))
      const reused = yield* Effect.result(tracker.begin(generation))
      expect(Result.isFailure(reused)).toBe(true)
      if (Result.isFailure(reused))
        expect(reused.failure).toBeInstanceOf(ReviewDiffGenerationReused)
    }),
  )

  it("requires managed spools except for complete reproducible immutable local Git", () => {
    expect(reviewDiffStorageRequirement(offer.facts)).toBe("exactGitEligible")
    for (const facts of [
      ReviewDiffSourceFacts.make({ ...offer.facts, origin: "remote" }),
      ReviewDiffSourceFacts.make({ ...offer.facts, revisionKind: "mutable" }),
      ReviewDiffSourceFacts.make({ ...offer.facts, revisionKind: "untracked" }),
      ReviewDiffSourceFacts.make({ ...offer.facts, reproducible: false }),
      ReviewDiffSourceFacts.make({ ...offer.facts, complete: false }),
    ]) {
      expect(reviewDiffStorageRequirement(facts)).toBe("managedCompleteSpool")
    }
  })
})
