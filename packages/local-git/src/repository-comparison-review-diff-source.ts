import { createHash } from "node:crypto"

import { Effect, Stream } from "effect"

import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryComparisonTarget } from "@diffdash/domain/repository-comparison"
import { ReviewDiffIdentity, ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import {
  REVIEW_DIFF_MAX_CHUNK_BYTES,
  RepositoryComparisonDiffSourceTarget,
  ReviewDiffAcquisition,
  ReviewDiffByteCompletion,
  ReviewDiffGeneration,
  ReviewDiffGenerationTracker,
  type ReviewDiffSource,
  type ReviewDiffSourceError,
  ReviewDiffSourceFacts,
  ReviewDiffSourceFailure,
  ReviewDiffSourceOffer,
  UnifiedBytesMethod,
} from "@diffdash/git-provider"
import { ProcessService, type ProcessExecutionError } from "@diffdash/process"
import { gitProcessRequest } from "./git-environment"

/** Runtime coordinates needed to open one exact repository-comparison source. */
export interface RepositoryComparisonReviewDiffSourceInput {
  readonly reviewKey: ReviewKey
  readonly target: RepositoryComparisonTarget
  readonly repositoryPath: RepositoryCheckoutPath
}

/** Opens a bounded exact-Git source for one already pinned repository comparison. */
export const makeRepositoryComparisonReviewDiffSource = Effect.fn(
  "makeRepositoryComparisonReviewDiffSource",
)(function* (
  input: RepositoryComparisonReviewDiffSourceInput,
): Effect.fn.Return<ReviewDiffSource, ReviewDiffSourceFailure, ProcessService> {
  const processes = yield* ProcessService
  const measured = yield* digestDiff(input, processes).pipe(Effect.mapError(sourceCreationFailure))
  const revision = ReviewRevision.make(input.target.headSha)
  const semanticIdentity = ReviewDiffIdentity.make(measured.digest)
  const generations = new ReviewDiffGenerationTracker()
  const offer = ReviewDiffSourceOffer.make({
    target: RepositoryComparisonDiffSourceTarget.make({
      reviewKey: input.reviewKey,
      target: input.target,
    }),
    expectedRevision: revision,
    semanticIdentity,
    methods: [UnifiedBytesMethod.make({ maxChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES })],
    facts: ReviewDiffSourceFacts.make({
      origin: "local",
      revisionKind: "immutableGit",
      reproducible: true,
      complete: true,
      declaredBytes: measured.bytes,
    }),
  })

  return {
    offer,
    unifiedBytes: (acquisition) =>
      Stream.unwrap(
        beginAcquisition(acquisition, revision, generations, "unifiedBytes").pipe(
          Effect.as(
            diffBytes(input, processes).pipe(
              Stream.mapError(sourceCreationFailure),
              Stream.map((bytes) => ({ bytes })),
              Stream.concat(
                Stream.make(
                  ReviewDiffByteCompletion.make({
                    generation: acquisition.generation,
                    revision,
                    semanticIdentity,
                    totalBytes: measured.bytes,
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    close: Effect.void,
  }
})

const digestDiff = Effect.fn("RepositoryComparisonReviewDiffSource.digestDiff")(function* (
  input: RepositoryComparisonReviewDiffSourceInput,
  processes: ProcessService["Service"],
): Effect.fn.Return<{ readonly bytes: number; readonly digest: string }, ProcessExecutionError> {
  const hash = createHash("sha256")
    .update("repositoryComparison\0")
    .update(input.target.mergeBaseSha)
    .update("\0")
    .update(input.target.headSha)
    .update("\0")
  let bytes = 0
  yield* diffBytes(input, processes).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        hash.update(chunk)
        bytes += chunk.byteLength
      }),
    ),
  )
  return { bytes, digest: hash.digest("hex") }
})

const diffBytes = (
  input: RepositoryComparisonReviewDiffSourceInput,
  processes: ProcessService["Service"],
): Stream.Stream<Uint8Array, ProcessExecutionError> =>
  processes
    .streamBytes(
      gitProcessRequest(
        [
          "-C",
          input.repositoryPath,
          "diff",
          "--no-ext-diff",
          "--no-color",
          input.target.mergeBaseSha,
          input.target.headSha,
          "--",
        ],
        {
          cwd: input.repositoryPath,
          timeoutMs: 60_000,
          stdout: { maxBytes: 1, overflow: "truncate" },
          stderr: { maxBytes: 64 * 1024, overflow: "truncate" },
          maxByteChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES,
          maxBufferedBytes: REVIEW_DIFF_MAX_CHUNK_BYTES * 2,
          maxReservedBytes: REVIEW_DIFF_MAX_CHUNK_BYTES * 2,
        },
      ),
    )
    .pipe(
      Stream.flatMap((event) =>
        event["_tag"] === "ProcessByteChunk" ? Stream.make(event.bytes) : Stream.empty,
      ),
    )

const beginAcquisition = (
  acquisition: ReviewDiffAcquisition,
  revision: ReviewRevision,
  generations: ReviewDiffGenerationTracker,
  method: "unifiedBytes",
): Effect.Effect<void, ReviewDiffSourceError> =>
  acquisition.expectedRevision === revision
    ? generations.begin(acquisition.generation).pipe(Effect.asVoid)
    : Effect.fail(sourceFailure(method, "Review diff acquisition expected another revision"))

const sourceCreationFailure = (_cause: unknown): ReviewDiffSourceFailure =>
  sourceFailure("unifiedBytes", "Git could not produce the exact repository comparison")

const sourceFailure = (method: "unifiedBytes", message: string): ReviewDiffSourceFailure =>
  ReviewDiffSourceFailure.make({
    generation: ReviewDiffGeneration.make("repository-comparison-source"),
    method,
    message,
  })
