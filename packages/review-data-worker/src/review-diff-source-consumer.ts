import { Effect, Match, Schema, Stream } from "effect"

import {
  ReviewDiffByteCompletion,
  ReviewDiffByteStreamValidator,
  UnifiedBytesMethod,
  type ReviewDiffAcquisition,
  type ReviewDiffSource,
  type ReviewDiffSourceError,
} from "@diffdash/git-provider"

import type { ReviewDataWorkerClient, ReviewDataWorkerResponse } from "./worker-runtime"

/** Failure while relaying a validated review source into its disposable worker. */
export class ReviewDataWorkerFailure extends Schema.TaggedError<ReviewDataWorkerFailure>()(
  "ReviewDataWorkerFailure",
  { message: Schema.String },
) {}

/**
 * Relays the committed bounded `ReviewDiffSource` stream with one acknowledged chunk in flight.
 * Source ownership remains with the caller so fallback policy can close it at the acquisition scope.
 */
export const consumeReviewDiffSource = Effect.fn("consumeReviewDiffSource")(function* (
  source: ReviewDiffSource,
  acquisition: ReviewDiffAcquisition,
  worker: ReviewDataWorkerClient,
): Effect.fn.Return<void, ReviewDiffSourceError | ReviewDataWorkerFailure> {
  const method = source.offer.methods.find(Schema.is(UnifiedBytesMethod))
  if (method === undefined)
    return yield* ReviewDataWorkerFailure.make({
      message: "Review data worker requires a bounded unifiedBytes source",
    })
  const validator = new ReviewDiffByteStreamValidator(
    acquisition.generation,
    acquisition.expectedRevision,
    source.offer.semanticIdentity,
    method.maxChunkBytes,
  )
  yield* source
    .unifiedBytes(acquisition)
    .pipe(
      Stream.runForEach((event) =>
        validator
          .accept(event)
          .pipe(
            Effect.flatMap((validated) =>
              Schema.is(ReviewDiffByteCompletion)(validated)
                ? Effect.void
                : relay(
                    worker.sendChunk(validated.bytes),
                    "Review data worker rejected a source chunk",
                  ),
            ),
          ),
      ),
    )
  yield* validator.finish()
  return yield* relay(worker.finish(), "Review data worker failed to finish the source")
})

const relay = (
  response: Promise<ReviewDataWorkerResponse>,
  failureMessage: string,
): Effect.Effect<void, ReviewDataWorkerFailure> =>
  Effect.tryPromise({
    try: () => response,
    catch: () => ReviewDataWorkerFailure.make({ message: failureMessage }),
  }).pipe(
    Effect.flatMap((result) =>
      Match.value(result).pipe(
        Match.tags({
          Accepted: () => Effect.void,
          Finished: () => Effect.void,
        }),
        Match.orElse(() => ReviewDataWorkerFailure.make({ message: failureMessage })),
      ),
    ),
  )
