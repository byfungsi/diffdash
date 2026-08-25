import { Effect, Schema, Stream } from "effect"

import { HostedReviewLocator } from "@diffdash/domain/git-provider"
import { LocalReviewTarget } from "@diffdash/domain/local-review"
import { RepositoryComparisonTarget } from "@diffdash/domain/repository-comparison"
import { ReviewDiffIdentity, ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"

/** Maximum bytes in one source stream element. D-08 may lower this after benchmarking. */
export const REVIEW_DIFF_MAX_CHUNK_BYTES = 64 * 1024

/** Maximum UTF-8 bytes in one canonical diff line. */
export const REVIEW_DIFF_MAX_LINE_BYTES = 256 * 1024

const PositiveInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const NonNegativeInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const NonEmptyBoundedString = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(512)),
)

/** Fresh identity for exactly one source acquisition or fallback attempt. */
export const ReviewDiffGeneration = NonEmptyBoundedString.pipe(Schema.brand("ReviewDiffGeneration"))

/** Fresh identity for exactly one source acquisition or fallback attempt. */
export type ReviewDiffGeneration = typeof ReviewDiffGeneration.Type

/** Stable identity for canonical diff semantics independent of acquisition method. */
export const ReviewDiffSemanticIdentity = ReviewDiffIdentity

/** Stable identity for canonical diff semantics independent of acquisition method. */
export type ReviewDiffSemanticIdentity = typeof ReviewDiffSemanticIdentity.Type

/** Provider facts which determine storage safety without selecting a source method. */
export class ReviewDiffSourceFacts extends Schema.Class<ReviewDiffSourceFacts>(
  "ReviewDiffSourceFacts",
)({
  origin: Schema.Literals(["remote", "local"]),
  revisionKind: Schema.Literals(["immutableGit", "mutable", "untracked"]),
  reproducible: Schema.Boolean,
  complete: Schema.Boolean,
  declaredBytes: Schema.NullOr(NonNegativeInteger),
}) {}

/** Backend eligibility derived only from source mutability and reproducibility facts. */
export const ReviewDiffStorageRequirement = Schema.Literals([
  "managedCompleteSpool",
  "exactGitEligible",
])

/** Backend eligibility derived only from source mutability and reproducibility facts. */
export type ReviewDiffStorageRequirement = typeof ReviewDiffStorageRequirement.Type

/** Hosted provider target and immutable review identity for one source. */
export class HostedReviewDiffSourceTarget extends Schema.TaggedClass<HostedReviewDiffSourceTarget>()(
  "hosted",
  {
    reviewKey: ReviewKey,
    review: HostedReviewLocator,
  },
) {}

/** Local checkout target and immutable review identity for one source. */
export class LocalReviewDiffSourceTarget extends Schema.TaggedClass<LocalReviewDiffSourceTarget>()(
  "local",
  {
    reviewKey: ReviewKey,
    target: LocalReviewTarget,
  },
) {}

/** Exact repository comparison target and immutable review identity for one source. */
export class RepositoryComparisonDiffSourceTarget extends Schema.TaggedClass<RepositoryComparisonDiffSourceTarget>()(
  "repositoryComparison",
  {
    reviewKey: ReviewKey,
    target: RepositoryComparisonTarget,
  },
) {}

/** Browser- and runtime-neutral target identity for bounded review acquisition. */
export const ReviewDiffSourceTarget = Schema.Union([
  HostedReviewDiffSourceTarget,
  LocalReviewDiffSourceTarget,
  RepositoryComparisonDiffSourceTarget,
])

/** Browser- and runtime-neutral target identity for bounded review acquisition. */
export type ReviewDiffSourceTarget = typeof ReviewDiffSourceTarget.Type

/** Selects safe storage eligibility independently from source method negotiation. */
export const reviewDiffStorageRequirement = (
  facts: ReviewDiffSourceFacts,
): ReviewDiffStorageRequirement =>
  facts.origin === "local" &&
  facts.revisionKind === "immutableGit" &&
  facts.reproducible &&
  facts.complete
    ? "exactGitEligible"
    : "managedCompleteSpool"

/** Declares bounded unified byte streaming support. */
export class UnifiedBytesMethod extends Schema.TaggedClass<UnifiedBytesMethod>()("unifiedBytes", {
  maxChunkBytes: PositiveInteger,
}) {}

/** One ordered acquisition method offered by a review source. */
export const ReviewDiffSourceMethod = UnifiedBytesMethod

/** One ordered acquisition method offered by a review source. */
export type ReviewDiffSourceMethod = typeof ReviewDiffSourceMethod.Type

/** Provider-neutral source offer for one expected review revision. */
export class ReviewDiffSourceOffer extends Schema.Class<ReviewDiffSourceOffer>(
  "ReviewDiffSourceOffer",
)({
  target: ReviewDiffSourceTarget,
  expectedRevision: ReviewRevision,
  semanticIdentity: ReviewDiffSemanticIdentity,
  methods: Schema.Array(ReviewDiffSourceMethod),
  facts: ReviewDiffSourceFacts,
}) {}

/** Input shared by every acquisition method. */
export class ReviewDiffAcquisition extends Schema.Class<ReviewDiffAcquisition>(
  "ReviewDiffAcquisition",
)({
  generation: ReviewDiffGeneration,
  expectedRevision: ReviewRevision,
}) {}

/** One bounded byte chunk copied from a source-owned buffer. */
export interface ReviewDiffByteChunk {
  readonly bytes: Uint8Array
}

/** Successful terminal metadata for a unified byte stream. */
export class ReviewDiffByteCompletion extends Schema.Class<ReviewDiffByteCompletion>(
  "ReviewDiffByteCompletion",
)({
  generation: ReviewDiffGeneration,
  revision: ReviewRevision,
  semanticIdentity: ReviewDiffSemanticIdentity,
  totalBytes: NonNegativeInteger,
}) {}

const sourceErrorFields = {
  generation: ReviewDiffGeneration,
  method: Schema.Literal("unifiedBytes"),
  message: Schema.String,
} as const

/** A source emitted an element that exceeds its declared or SDK hard limit. */
export class ReviewDiffLimitExceeded extends Schema.TaggedError<ReviewDiffLimitExceeded>()(
  "ReviewDiffLimitExceeded",
  { ...sourceErrorFields, limit: PositiveInteger, actual: NonNegativeInteger },
) {}

/** A unified byte stream violates terminal ordering, identity, or byte-count rules. */
export class InvalidReviewDiffByteStream extends Schema.TaggedError<InvalidReviewDiffByteStream>()(
  "InvalidReviewDiffByteStream",
  sourceErrorFields,
) {}

/** A source ended before its declared complete result was delivered. */
export class ReviewDiffTruncated extends Schema.TaggedError<ReviewDiffTruncated>()(
  "ReviewDiffTruncated",
  sourceErrorFields,
) {}

/** The source revision changed while an acquisition was in progress. */
export class ReviewDiffRevisionChanged extends Schema.TaggedError<ReviewDiffRevisionChanged>()(
  "ReviewDiffRevisionChanged",
  { ...sourceErrorFields, expectedRevision: ReviewRevision, actualRevision: ReviewRevision },
) {}

/** An acquisition attempted to reuse an identity from an earlier attempt or fallback. */
export class ReviewDiffGenerationReused extends Schema.TaggedError<ReviewDiffGenerationReused>()(
  "ReviewDiffGenerationReused",
  { generation: ReviewDiffGeneration, message: Schema.String },
) {}

/** The provider failed while reading or closing a source. */
export class ReviewDiffSourceFailure extends Schema.TaggedError<ReviewDiffSourceFailure>()(
  "ReviewDiffSourceFailure",
  { ...sourceErrorFields, causeTag: Schema.optional(NonEmptyBoundedString) },
) {}

/** The provider could not make a complete generated diff available. */
export class ReviewDiffAvailabilityFailure extends Schema.TaggedError<ReviewDiffAvailabilityFailure>()(
  "ReviewDiffAvailabilityFailure",
  {
    ...sourceErrorFields,
    category: Schema.Literals([
      "providerGenerationLimit",
      "authenticationRequired",
      "authorizationRequired",
      "transientProviderFailure",
    ]),
    diagnosticCode: Schema.optional(NonEmptyBoundedString),
  },
) {}

/** Expected failures exposed by provider-neutral review diff sources. */
export type ReviewDiffSourceError =
  | ReviewDiffLimitExceeded
  | InvalidReviewDiffByteStream
  | ReviewDiffTruncated
  | ReviewDiffRevisionChanged
  | ReviewDiffGenerationReused
  | ReviewDiffAvailabilityFailure
  | ReviewDiffSourceFailure

/** Provider-neutral bounded source contract implemented by concrete Git adapters. */
export interface ReviewDiffSource {
  readonly offer: ReviewDiffSourceOffer
  readonly unifiedBytes: (
    acquisition: ReviewDiffAcquisition,
  ) => Stream.Stream<ReviewDiffByteChunk | ReviewDiffByteCompletion, ReviewDiffSourceError>
  readonly close: Effect.Effect<void, ReviewDiffSourceFailure>
}

/** Validates one stream chunk before it can enter a queue or downstream parser. */
export const validateReviewDiffByteChunk = (
  generation: ReviewDiffGeneration,
  chunk: ReviewDiffByteChunk,
  advertisedMaximum = REVIEW_DIFF_MAX_CHUNK_BYTES,
): Effect.Effect<ReviewDiffByteChunk, ReviewDiffLimitExceeded> => {
  const limit = Math.min(advertisedMaximum, REVIEW_DIFF_MAX_CHUNK_BYTES)
  return chunk.bytes.byteLength > 0 && chunk.bytes.byteLength <= limit
    ? Effect.succeed({ bytes: chunk.bytes.slice() })
    : ReviewDiffLimitExceeded.make({
        generation,
        method: "unifiedBytes",
        message: "Review diff chunk exceeded its strict byte bound",
        limit,
        actual: chunk.bytes.byteLength,
      })
}

/** Stateful validator for bounded chunks followed by exactly one coherent terminal record. */
export class ReviewDiffByteStreamValidator {
  readonly #generation: ReviewDiffGeneration
  readonly #expectedRevision: ReviewRevision
  readonly #semanticIdentity: ReviewDiffSemanticIdentity
  readonly #maxChunkBytes: number
  #totalBytes = 0
  #complete = false

  constructor(
    generation: ReviewDiffGeneration,
    expectedRevision: ReviewRevision,
    semanticIdentity: ReviewDiffSemanticIdentity,
    maxChunkBytes = REVIEW_DIFF_MAX_CHUNK_BYTES,
  ) {
    this.#generation = generation
    this.#expectedRevision = expectedRevision
    this.#semanticIdentity = semanticIdentity
    this.#maxChunkBytes = maxChunkBytes
  }

  /** Validates one ordered stream element before downstream publication. */
  readonly accept = Effect.fn("ReviewDiffByteStreamValidator.accept")(function* (
    this: ReviewDiffByteStreamValidator,
    event: ReviewDiffByteChunk | ReviewDiffByteCompletion,
  ) {
    const invalid = (message: string) =>
      InvalidReviewDiffByteStream.make({
        generation: this.#generation,
        method: "unifiedBytes",
        message,
      })
    if (this.#complete) return yield* invalid("Review diff bytes followed terminal metadata")
    if (Schema.is(ReviewDiffByteCompletion)(event)) {
      if (event.generation !== this.#generation)
        return yield* invalid("Review diff byte completion used another generation")
      if (event.revision !== this.#expectedRevision)
        return yield* ReviewDiffRevisionChanged.make({
          generation: this.#generation,
          method: "unifiedBytes",
          message: "Review diff revision changed during byte acquisition",
          expectedRevision: this.#expectedRevision,
          actualRevision: event.revision,
        })
      if (event.semanticIdentity !== this.#semanticIdentity)
        return yield* invalid("Review diff byte completion changed canonical semantic identity")
      if (event.totalBytes !== this.#totalBytes)
        return yield* invalid("Review diff byte completion reported an incorrect total")
      this.#complete = true
      return event
    }

    const chunk = yield* validateReviewDiffByteChunk(this.#generation, event, this.#maxChunkBytes)
    this.#totalBytes += chunk.bytes.byteLength
    return chunk
  })

  /** Requires an explicit terminal record after the last bounded chunk. */
  readonly finish = (): Effect.Effect<void, ReviewDiffTruncated> =>
    this.#complete
      ? Effect.void
      : ReviewDiffTruncated.make({
          generation: this.#generation,
          method: "unifiedBytes",
          message: "Review diff byte stream ended before terminal metadata",
        })
}

/** Tracks acquisition generations so retries, cancellation, overflow, and fallback cannot reuse one. */
export class ReviewDiffGenerationTracker {
  readonly #used = new Set<ReviewDiffGeneration>()

  /** Begins a fresh generation or rejects a previously used identity. */
  readonly begin = (
    generation: ReviewDiffGeneration,
  ): Effect.Effect<ReviewDiffGeneration, ReviewDiffGenerationReused> => {
    if (this.#used.has(generation))
      return ReviewDiffGenerationReused.make({
        generation,
        message: "Review diff acquisition generation was reused",
      })
    this.#used.add(generation)
    return Effect.succeed(generation)
  }
}

/** Requires exactly one unified byte method within the SDK hard chunk bound. */
export const validateReviewDiffSourceOffer = (
  offer: ReviewDiffSourceOffer,
): Effect.Effect<ReviewDiffSourceOffer, ReviewDiffSourceFailure> => {
  const method = offer.methods[0]
  return offer.methods.length !== 1 || method === undefined
    ? ReviewDiffSourceFailure.make({
        generation: ReviewDiffGeneration.make("offer-validation"),
        method: "unifiedBytes",
        message: "Review diff source offer must contain exactly one unified byte method",
      })
    : method.maxChunkBytes > REVIEW_DIFF_MAX_CHUNK_BYTES
      ? ReviewDiffSourceFailure.make({
          generation: ReviewDiffGeneration.make("offer-validation"),
          method: "unifiedBytes",
          message: "Review diff source offer exceeds the SDK hard chunk bound",
        })
      : Effect.succeed(offer)
}
