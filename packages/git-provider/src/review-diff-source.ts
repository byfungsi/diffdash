import { Effect, Match, Schema, Stream } from "effect"

import { DiffFileStatus } from "@diffdash/domain/diff"
import { HostedReviewLocator } from "@diffdash/domain/git-provider"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  ReviewDiffIdentity,
  ReviewFilePatchHash,
  ReviewRevision,
} from "@diffdash/domain/review-identity"

/** Maximum bytes in one source stream element. D-08 may lower this after benchmarking. */
export const REVIEW_DIFF_MAX_CHUNK_BYTES = 64 * 1024

/** Maximum canonical payload bytes in one complete file page. */
export const REVIEW_DIFF_MAX_PAGE_BYTES = 2 * 1024 * 1024

/** Maximum changed files in one complete file page. */
export const REVIEW_DIFF_MAX_PAGE_ITEMS = 256

/** Maximum UTF-8 bytes in one canonical diff line. */
export const REVIEW_DIFF_MAX_LINE_BYTES = 256 * 1024

/** Maximum complete in-memory source result. */
export const REVIEW_DIFF_MAX_BUFFERED_BYTES = 8 * 1024 * 1024

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

/** Declares complete canonical file-page support. */
export class FilePagesMethod extends Schema.TaggedClass<FilePagesMethod>()("filePages", {
  maxPageBytes: PositiveInteger,
  maxPageItems: PositiveInteger,
  maxLineBytes: PositiveInteger,
}) {}

/** Declares exact immutable Git materialization support. */
export class MaterializedGitMethod extends Schema.TaggedClass<MaterializedGitMethod>()(
  "materializedGit",
  {},
) {}

/** Declares a complete byte result with a hard maximum. */
export class BufferedBytesMethod extends Schema.TaggedClass<BufferedBytesMethod>()(
  "bufferedBytes",
  {
    maxBytes: PositiveInteger,
  },
) {}

/** One ordered acquisition method offered by a review source. */
export const ReviewDiffSourceMethod = Schema.Union([
  UnifiedBytesMethod,
  FilePagesMethod,
  MaterializedGitMethod,
  BufferedBytesMethod,
])

/** One ordered acquisition method offered by a review source. */
export type ReviewDiffSourceMethod = typeof ReviewDiffSourceMethod.Type

/** Provider-neutral source offer for one expected review revision. */
export class ReviewDiffSourceOffer extends Schema.Class<ReviewDiffSourceOffer>(
  "ReviewDiffSourceOffer",
)({
  review: HostedReviewLocator,
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

/** Canonical line kind inside one normalized hunk. */
export const ReviewDiffLineKind = Schema.Literals(["context", "addition", "deletion"])

/** Canonical line kind inside one normalized hunk. */
export type ReviewDiffLineKind = typeof ReviewDiffLineKind.Type

/** One canonical line without a unified-diff marker prefix. */
export class ReviewDiffLine extends Schema.Class<ReviewDiffLine>("ReviewDiffLine")({
  kind: ReviewDiffLineKind,
  content: Schema.String,
  noNewlineAtEnd: Schema.Boolean,
}) {}

/** One complete canonical hunk. */
export class ReviewDiffHunk extends Schema.Class<ReviewDiffHunk>("ReviewDiffHunk")({
  oldStart: PositiveInteger,
  oldLines: NonNegativeInteger,
  newStart: PositiveInteger,
  newLines: NonNegativeInteger,
  section: Schema.String,
  lines: Schema.Array(ReviewDiffLine),
}) {}

/** One complete canonical changed file. */
export class ReviewDiffFile extends Schema.Class<ReviewDiffFile>("ReviewDiffFile")({
  ordinal: NonNegativeInteger,
  identity: ReviewFilePatchHash,
  oldPath: Schema.NullOr(RepositoryRelativePath),
  path: RepositoryRelativePath,
  oldMode: Schema.NullOr(Schema.String),
  newMode: Schema.NullOr(Schema.String),
  status: DiffFileStatus,
  binary: Schema.Boolean,
  hunks: Schema.Array(ReviewDiffHunk),
}) {}

/** One complete, bounded page of canonical changed files. */
export class ReviewDiffFilePage extends Schema.Class<ReviewDiffFilePage>("ReviewDiffFilePage")({
  generation: ReviewDiffGeneration,
  revision: ReviewRevision,
  semanticIdentity: ReviewDiffSemanticIdentity,
  pageOrdinal: NonNegativeInteger,
  firstFileOrdinal: NonNegativeInteger,
  byteCount: NonNegativeInteger,
  itemCount: NonNegativeInteger,
  files: Schema.Array(ReviewDiffFile),
  complete: Schema.Boolean,
  nextPageOrdinal: Schema.NullOr(NonNegativeInteger),
}) {}

/** Exact Git object identities sufficient to reproduce canonical diff semantics. */
export class ReviewDiffMaterializedGit extends Schema.Class<ReviewDiffMaterializedGit>(
  "ReviewDiffMaterializedGit",
)({
  generation: ReviewDiffGeneration,
  revision: ReviewRevision,
  semanticIdentity: ReviewDiffSemanticIdentity,
  repositoryIdentity: NonEmptyBoundedString,
  baseObject: NonEmptyBoundedString,
  headObject: NonEmptyBoundedString,
  diffPolicyIdentity: NonEmptyBoundedString,
}) {}

/** Complete byte result whose allocation is constrained by an advertised hard maximum. */
export interface ReviewDiffBufferedBytes {
  readonly generation: ReviewDiffGeneration
  readonly revision: ReviewRevision
  readonly semanticIdentity: ReviewDiffSemanticIdentity
  readonly bytes: Uint8Array
}

const sourceErrorFields = {
  generation: ReviewDiffGeneration,
  method: Schema.Literals(["unifiedBytes", "filePages", "materializedGit", "bufferedBytes"]),
  message: Schema.String,
} as const

/** Requested acquisition method is not offered for this review. */
export class ReviewDiffMethodUnsupported extends Schema.TaggedError<ReviewDiffMethodUnsupported>()(
  "ReviewDiffMethodUnsupported",
  sourceErrorFields,
) {}

/** A source emitted an element that exceeds its declared or SDK hard limit. */
export class ReviewDiffLimitExceeded extends Schema.TaggedError<ReviewDiffLimitExceeded>()(
  "ReviewDiffLimitExceeded",
  { ...sourceErrorFields, limit: PositiveInteger, actual: NonNegativeInteger },
) {}

/** A complete page violates ordering, count, continuation, or completeness rules. */
export class InvalidReviewDiffPage extends Schema.TaggedError<InvalidReviewDiffPage>()(
  "InvalidReviewDiffPage",
  { ...sourceErrorFields, pageOrdinal: NonNegativeInteger },
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

/** The source cannot represent a giant file within the selected method's hard bounds. */
export class ReviewDiffGiantFileUnsupported extends Schema.TaggedError<ReviewDiffGiantFileUnsupported>()(
  "ReviewDiffGiantFileUnsupported",
  { ...sourceErrorFields, path: RepositoryRelativePath, actualBytes: NonNegativeInteger },
) {}

/** The provider failed while reading or closing a source. */
export class ReviewDiffSourceFailure extends Schema.TaggedError<ReviewDiffSourceFailure>()(
  "ReviewDiffSourceFailure",
  { ...sourceErrorFields, causeTag: Schema.optional(NonEmptyBoundedString) },
) {}

/** Expected failures exposed by provider-neutral review diff sources. */
export type ReviewDiffSourceError =
  | ReviewDiffMethodUnsupported
  | ReviewDiffLimitExceeded
  | InvalidReviewDiffPage
  | InvalidReviewDiffByteStream
  | ReviewDiffTruncated
  | ReviewDiffRevisionChanged
  | ReviewDiffGenerationReused
  | ReviewDiffGiantFileUnsupported
  | ReviewDiffSourceFailure

/** Provider-neutral bounded source contract implemented by concrete Git adapters. */
export interface ReviewDiffSource {
  readonly offer: ReviewDiffSourceOffer
  readonly unifiedBytes: (
    acquisition: ReviewDiffAcquisition,
  ) => Stream.Stream<ReviewDiffByteChunk | ReviewDiffByteCompletion, ReviewDiffSourceError>
  readonly filePage: (
    acquisition: ReviewDiffAcquisition,
    pageOrdinal: number,
  ) => Effect.Effect<ReviewDiffFilePage, ReviewDiffSourceError>
  readonly materializedGit: (
    acquisition: ReviewDiffAcquisition,
  ) => Effect.Effect<ReviewDiffMaterializedGit, ReviewDiffSourceError>
  readonly bufferedBytes: (
    acquisition: ReviewDiffAcquisition,
  ) => Effect.Effect<ReviewDiffBufferedBytes, ReviewDiffSourceError>
  readonly close: Effect.Effect<void, ReviewDiffSourceFailure>
}

const utf8 = new TextEncoder()

/** Measures canonical file-page payload bytes without constructing a complete serialized page. */
export const measureReviewDiffFile = (file: ReviewDiffFile): number => {
  let bytes = utf8.encode(file.identity).byteLength
  bytes += utf8.encode(file.oldPath ?? "").byteLength + utf8.encode(file.path).byteLength
  bytes += utf8.encode(file.oldMode ?? "").byteLength + utf8.encode(file.newMode ?? "").byteLength
  bytes += utf8.encode(file.status).byteLength + 24
  for (const hunk of file.hunks) {
    bytes += utf8.encode(hunk.section).byteLength + 32
    for (const line of hunk.lines) bytes += utf8.encode(line.content).byteLength + 2
  }
  return bytes
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

/** Validates a complete buffered result against both advertised and SDK hard limits. */
export const validateReviewDiffBufferedBytes = (
  value: ReviewDiffBufferedBytes,
  advertisedMaximum = REVIEW_DIFF_MAX_BUFFERED_BYTES,
): Effect.Effect<ReviewDiffBufferedBytes, ReviewDiffLimitExceeded> => {
  const limit = Math.min(advertisedMaximum, REVIEW_DIFF_MAX_BUFFERED_BYTES)
  return value.bytes.byteLength <= limit
    ? Effect.succeed({ ...value, bytes: value.bytes.slice() })
    : ReviewDiffLimitExceeded.make({
        generation: value.generation,
        method: "bufferedBytes",
        message: "Review diff buffer exceeded its strict byte bound",
        limit,
        actual: value.bytes.byteLength,
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

/** Stateful validator for one ordered, complete file-page acquisition. */
export class ReviewDiffPageValidator {
  readonly #generation: ReviewDiffGeneration
  readonly #expectedRevision: ReviewRevision
  readonly #semanticIdentity: ReviewDiffSemanticIdentity
  readonly #limits: {
    readonly maxPageBytes: number
    readonly maxPageItems: number
    readonly maxLineBytes: number
  }
  #nextPageOrdinal = 0
  #nextFileOrdinal = 0
  #complete = false

  constructor(
    generation: ReviewDiffGeneration,
    expectedRevision: ReviewRevision,
    semanticIdentity: ReviewDiffSemanticIdentity,
    limits = {
      maxPageBytes: REVIEW_DIFF_MAX_PAGE_BYTES,
      maxPageItems: REVIEW_DIFF_MAX_PAGE_ITEMS,
      maxLineBytes: REVIEW_DIFF_MAX_LINE_BYTES,
    },
  ) {
    this.#generation = generation
    this.#expectedRevision = expectedRevision
    this.#semanticIdentity = semanticIdentity
    this.#limits = limits
  }

  /** Validates and advances one page, rejecting duplicate, missing, reordered, or oversized data. */
  readonly accept = Effect.fn("ReviewDiffPageValidator.accept")(function* (
    this: ReviewDiffPageValidator,
    page: ReviewDiffFilePage,
  ) {
    const invalid = (message: string) =>
      InvalidReviewDiffPage.make({
        generation: this.#generation,
        method: "filePages",
        message,
        pageOrdinal: page.pageOrdinal,
      })

    if (this.#complete) return yield* invalid("Review diff page followed a complete page")
    if (page.generation !== this.#generation)
      return yield* invalid("Review diff page used another generation")
    if (page.revision !== this.#expectedRevision)
      return yield* ReviewDiffRevisionChanged.make({
        generation: this.#generation,
        method: "filePages",
        message: "Review diff revision changed during page acquisition",
        expectedRevision: this.#expectedRevision,
        actualRevision: page.revision,
      })
    if (page.semanticIdentity !== this.#semanticIdentity)
      return yield* invalid("Review diff page changed canonical semantic identity")
    if (page.pageOrdinal !== this.#nextPageOrdinal)
      return yield* invalid("Review diff page ordinal was duplicate, missing, or reordered")
    if (page.firstFileOrdinal !== this.#nextFileOrdinal)
      return yield* invalid("Review diff file ordinal range was duplicate, missing, or reordered")
    if (
      page.files.length !== page.itemCount ||
      page.itemCount > Math.min(this.#limits.maxPageItems, REVIEW_DIFF_MAX_PAGE_ITEMS)
    )
      return yield* invalid("Review diff page item count was incorrect or oversized")
    if (page.files.some((file, index) => file.ordinal !== page.firstFileOrdinal + index))
      return yield* invalid("Review diff file ordinals were duplicate, missing, or reordered")

    const measuredBytes = page.files.reduce((total, file) => total + measureReviewDiffFile(file), 0)
    if (
      page.byteCount !== measuredBytes ||
      measuredBytes > Math.min(this.#limits.maxPageBytes, REVIEW_DIFF_MAX_PAGE_BYTES)
    )
      return yield* invalid("Review diff page byte count was incorrect or oversized")
    for (const file of page.files) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          const lineBytes = utf8.encode(line.content).byteLength
          if (lineBytes > Math.min(this.#limits.maxLineBytes, REVIEW_DIFF_MAX_LINE_BYTES))
            return yield* ReviewDiffGiantFileUnsupported.make({
              generation: this.#generation,
              method: "filePages",
              message: "Review diff file contains a line outside the page representation bound",
              path: file.path,
              actualBytes: lineBytes,
            })
        }
      }
    }

    if (
      page.complete ? page.nextPageOrdinal !== null : page.nextPageOrdinal !== page.pageOrdinal + 1
    )
      return yield* invalid("Review diff page continuation contradicted completeness")

    this.#nextPageOrdinal += 1
    this.#nextFileOrdinal += page.itemCount
    this.#complete = page.complete
    return page
  })

  /** Requires the accepted page sequence to have reached an explicit complete page. */
  readonly finish = (): Effect.Effect<void, ReviewDiffTruncated> =>
    this.#complete
      ? Effect.void
      : ReviewDiffTruncated.make({
          generation: this.#generation,
          method: "filePages",
          message: "Review diff pages ended before an explicit complete page",
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

/** Rejects duplicate method tags and method-specific limits above SDK hard bounds. */
export const validateReviewDiffSourceOffer = (
  offer: ReviewDiffSourceOffer,
): Effect.Effect<ReviewDiffSourceOffer, ReviewDiffSourceFailure> => {
  const tags = new Set<string>()
  for (const method of offer.methods) {
    const limits = Match.value(method).pipe(
      Match.tag("unifiedBytes", ({ maxChunkBytes }) => ({
        tag: "unifiedBytes" as const,
        valid: maxChunkBytes <= REVIEW_DIFF_MAX_CHUNK_BYTES,
      })),
      Match.tag("filePages", ({ maxLineBytes, maxPageBytes, maxPageItems }) => ({
        tag: "filePages" as const,
        valid:
          maxPageBytes <= REVIEW_DIFF_MAX_PAGE_BYTES &&
          maxPageItems <= REVIEW_DIFF_MAX_PAGE_ITEMS &&
          maxLineBytes <= REVIEW_DIFF_MAX_LINE_BYTES,
      })),
      Match.tag("materializedGit", () => ({ tag: "materializedGit" as const, valid: true })),
      Match.tag("bufferedBytes", ({ maxBytes }) => ({
        tag: "bufferedBytes" as const,
        valid: maxBytes <= REVIEW_DIFF_MAX_BUFFERED_BYTES,
      })),
      Match.exhaustive,
    )
    if (tags.has(limits.tag))
      return ReviewDiffSourceFailure.make({
        generation: ReviewDiffGeneration.make("offer-validation"),
        method: limits.tag,
        message: "Review diff source offer contains a duplicate method",
      })
    tags.add(limits.tag)
    if (!limits.valid)
      return ReviewDiffSourceFailure.make({
        generation: ReviewDiffGeneration.make("offer-validation"),
        method: limits.tag,
        message: "Review diff source offer exceeds an SDK hard bound",
      })
  }
  return offer.methods.length === 0
    ? ReviewDiffSourceFailure.make({
        generation: ReviewDiffGeneration.make("offer-validation"),
        method: "unifiedBytes",
        message: "Review diff source offer contains no acquisition method",
      })
    : Effect.succeed(offer)
}
