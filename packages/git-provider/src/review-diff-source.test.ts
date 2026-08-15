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
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  ReviewDiffIdentity,
  ReviewFilePatchHash,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  BufferedBytesMethod,
  FilePagesMethod,
  InvalidReviewDiffPage,
  MaterializedGitMethod,
  REVIEW_DIFF_MAX_BUFFERED_BYTES,
  REVIEW_DIFF_MAX_CHUNK_BYTES,
  REVIEW_DIFF_MAX_LINE_BYTES,
  REVIEW_DIFF_MAX_PAGE_BYTES,
  REVIEW_DIFF_MAX_PAGE_ITEMS,
  ReviewDiffByteCompletion,
  ReviewDiffByteStreamValidator,
  ReviewDiffFile,
  ReviewDiffFilePage,
  ReviewDiffGeneration,
  ReviewDiffGenerationReused,
  ReviewDiffGenerationTracker,
  ReviewDiffGiantFileUnsupported,
  ReviewDiffHunk,
  ReviewDiffLimitExceeded,
  ReviewDiffLine,
  ReviewDiffMaterializedGit,
  ReviewDiffPageValidator,
  ReviewDiffRevisionChanged,
  ReviewDiffSourceFacts,
  ReviewDiffSourceOffer,
  ReviewDiffTruncated,
  UnifiedBytesMethod,
  measureReviewDiffFile,
  reviewDiffStorageRequirement,
  validateReviewDiffBufferedBytes,
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
const file = ReviewDiffFile.make({
  ordinal: 0,
  identity: ReviewFilePatchHash.make("file-patch:v1:fixture"),
  oldPath: RepositoryRelativePath.make("src/app.ts"),
  path: RepositoryRelativePath.make("src/app.ts"),
  oldMode: "100644",
  newMode: "100644",
  status: "modified",
  binary: false,
  hunks: [
    ReviewDiffHunk.make({
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      section: "render",
      lines: [
        ReviewDiffLine.make({ kind: "deletion", content: "old", noNewlineAtEnd: false }),
        ReviewDiffLine.make({ kind: "addition", content: "new", noNewlineAtEnd: true }),
      ],
    }),
  ],
})

const makePage = (
  overrides: Partial<ConstructorParameters<typeof ReviewDiffFilePage>[0]> = {},
): ReviewDiffFilePage =>
  ReviewDiffFilePage.make({
    generation,
    revision,
    semanticIdentity: identity,
    pageOrdinal: 0,
    firstFileOrdinal: 0,
    byteCount: measureReviewDiffFile(file),
    itemCount: 1,
    files: [file],
    complete: true,
    nextPageOrdinal: null,
    ...overrides,
  })

const offer = ReviewDiffSourceOffer.make({
  review,
  expectedRevision: revision,
  semanticIdentity: identity,
  methods: [
    UnifiedBytesMethod.make({ maxChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES }),
    FilePagesMethod.make({
      maxPageBytes: REVIEW_DIFF_MAX_PAGE_BYTES,
      maxPageItems: REVIEW_DIFF_MAX_PAGE_ITEMS,
      maxLineBytes: REVIEW_DIFF_MAX_LINE_BYTES,
    }),
    MaterializedGitMethod.make({}),
    BufferedBytesMethod.make({ maxBytes: REVIEW_DIFF_MAX_BUFFERED_BYTES }),
  ],
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
  filePage: (request) => Effect.succeed(makePage({ generation: request.generation })),
  materializedGit: (request) =>
    Effect.succeed(
      ReviewDiffMaterializedGit.make({
        generation: request.generation,
        revision,
        semanticIdentity: identity,
        repositoryIdentity: "fixture-repository",
        baseObject: "base-object",
        headObject: "head-object",
        diffPolicyIdentity: "diff-policy-v1",
      }),
    ),
  bufferedBytes: (request) =>
    Effect.succeed({
      generation: request.generation,
      revision,
      semanticIdentity: identity,
      bytes,
    }),
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
  expectedFiles: [file],
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

  it.effect("accepts the exact buffer cap and rejects one byte over without aliasing", () =>
    Effect.gen(function* () {
      const exactInput = new Uint8Array(REVIEW_DIFF_MAX_BUFFERED_BYTES)
      const exact = yield* validateReviewDiffBufferedBytes({
        generation,
        revision,
        semanticIdentity: identity,
        bytes: exactInput,
      })
      exactInput[0] = 1
      expect(exact.bytes[0]).toBe(0)

      const overflow = yield* Effect.result(
        validateReviewDiffBufferedBytes({
          generation,
          revision,
          semanticIdentity: identity,
          bytes: new Uint8Array(REVIEW_DIFF_MAX_BUFFERED_BYTES + 1),
        }),
      )
      expect(Result.isFailure(overflow)).toBe(true)
    }),
  )

  it.effect("accepts one exact complete page", () =>
    Effect.gen(function* () {
      const validator = new ReviewDiffPageValidator(generation, revision, identity)
      yield* validator.accept(makePage())
      yield* validator.finish()
    }),
  )

  it.effect("rejects duplicate, missing, reordered, and contradictory page metadata", () =>
    Effect.gen(function* () {
      const invalidPages = [
        makePage({ pageOrdinal: 1 }),
        makePage({ firstFileOrdinal: 1 }),
        makePage({ itemCount: 0 }),
        makePage({ byteCount: measureReviewDiffFile(file) + 1 }),
        makePage({ complete: false, nextPageOrdinal: null }),
        makePage({ complete: true, nextPageOrdinal: 1 }),
        makePage({ files: [ReviewDiffFile.make({ ...file, ordinal: 1 })] }),
      ]
      for (const page of invalidPages) {
        const result = yield* Effect.result(
          new ReviewDiffPageValidator(generation, revision, identity).accept(page),
        )
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(InvalidReviewDiffPage)
      }

      const validator = new ReviewDiffPageValidator(generation, revision, identity)
      yield* validator.accept(makePage())
      const duplicate = yield* Effect.result(validator.accept(makePage()))
      expect(Result.isFailure(duplicate)).toBe(true)
    }),
  )

  it.effect("rejects revision drift, identity drift, truncation, and enormous lines", () =>
    Effect.gen(function* () {
      const changedRevision = yield* Effect.result(
        new ReviewDiffPageValidator(generation, revision, identity).accept(
          makePage({ revision: ReviewRevision.make("revision-2") }),
        ),
      )
      expect(Result.isFailure(changedRevision)).toBe(true)
      if (Result.isFailure(changedRevision))
        expect(changedRevision.failure).toBeInstanceOf(ReviewDiffRevisionChanged)

      const changedIdentity = yield* Effect.result(
        new ReviewDiffPageValidator(generation, revision, identity).accept(
          makePage({ semanticIdentity: ReviewDiffIdentity.make("other") }),
        ),
      )
      expect(Result.isFailure(changedIdentity)).toBe(true)
      if (Result.isFailure(changedIdentity))
        expect(changedIdentity.failure).toBeInstanceOf(InvalidReviewDiffPage)

      const truncated = yield* Effect.result(
        new ReviewDiffPageValidator(generation, revision, identity).finish(),
      )
      expect(Result.isFailure(truncated)).toBe(true)
      if (Result.isFailure(truncated)) expect(truncated.failure).toBeInstanceOf(ReviewDiffTruncated)

      const giantFile = ReviewDiffFile.make({
        ...file,
        hunks: [
          ReviewDiffHunk.make({
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            section: "giant",
            lines: [
              ReviewDiffLine.make({
                kind: "context",
                content: "x".repeat(REVIEW_DIFF_MAX_LINE_BYTES + 1),
                noNewlineAtEnd: false,
              }),
            ],
          }),
        ],
      })
      const giant = yield* Effect.result(
        new ReviewDiffPageValidator(generation, revision, identity).accept(
          makePage({
            files: [giantFile],
            byteCount: measureReviewDiffFile(giantFile),
          }),
        ),
      )
      expect(Result.isFailure(giant)).toBe(true)
      if (Result.isFailure(giant))
        expect(giant.failure).toBeInstanceOf(ReviewDiffGiantFileUnsupported)
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
        ReviewDiffSourceOffer.make({
          ...offer,
          methods: [
            FilePagesMethod.make({
              maxPageBytes: REVIEW_DIFF_MAX_PAGE_BYTES + 1,
              maxPageItems: REVIEW_DIFF_MAX_PAGE_ITEMS,
              maxLineBytes: REVIEW_DIFF_MAX_LINE_BYTES,
            }),
          ],
        }),
        ReviewDiffSourceOffer.make({
          ...offer,
          methods: [BufferedBytesMethod.make({ maxBytes: REVIEW_DIFF_MAX_BUFFERED_BYTES + 1 })],
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
