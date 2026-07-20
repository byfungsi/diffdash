import { Context, Effect, Layer, Schema } from "effect"

import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import type { LocalReviewSnapshot } from "@diffdash/domain/review-context"
import { HostedReviewSnapshot } from "@diffdash/domain/review-context"
import {
  makeReviewDiffIdentity,
  makeReviewKey,
  makeReviewSnapshotId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import type { HostedReviewLocator } from "@diffdash/domain/git-provider"
import type { LocalReviewTarget } from "@diffdash/domain/local-review"
import { GitService } from "@diffdash/local-git/local-git"
import { GitProvider } from "./git-provider"

/** Test seam for observing hosted unified-diff parsing without module mocking. */
interface ReviewContextLayerOptions {
  readonly parseDiff?: typeof parseUnifiedDiff
}

/** A typed failure to acquire one coherent review metadata and diff snapshot. */
export class ReviewContextError extends Schema.TaggedError<ReviewContextError>()(
  "ReviewContextError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Main-process service that captures immutable local and provider review snapshots. */
export class ReviewContextService extends Context.Tag("@diffdash/ReviewContextService")<
  ReviewContextService,
  {
    readonly getHostedReviewSnapshot: (
      review: HostedReviewLocator,
    ) => Effect.Effect<HostedReviewSnapshot, ReviewContextError>
    readonly getLocalReviewSnapshot: (
      target: LocalReviewTarget,
    ) => Effect.Effect<LocalReviewSnapshot, ReviewContextError>
  }
>() {
  /** Builds the hosted snapshot acquisition layer. */
  static readonly layerWith = (options: ReviewContextLayerOptions = {}) =>
    Layer.effect(
      ReviewContextService,
      Effect.gen(function* () {
        const gitProvider = yield* GitProvider
        const git = yield* GitService
        const parseDiff = options.parseDiff ?? parseUnifiedDiff

        return ReviewContextService.of({
          getHostedReviewSnapshot: Effect.fn("ReviewContextService.getHostedReviewSnapshot")(
            function* (review) {
              for (let attempt = 1; attempt <= 2; attempt += 1) {
                const detailBefore = yield* gitProvider
                  .getHostedReview(review)
                  .pipe(Effect.mapError(snapshotOperationError("hosted.detailBefore")))
                const diff = yield* gitProvider
                  .getHostedReviewDiff(review)
                  .pipe(Effect.mapError(snapshotOperationError("hosted.diff")))
                const detailAfter = yield* gitProvider
                  .refreshHostedReview(review)
                  .pipe(Effect.mapError(snapshotOperationError("hosted.detailAfter")))
                const baseRevision = detailAfter.summary.base.revision
                const headRevision = detailAfter.summary.head.revision

                if (
                  baseRevision !== null &&
                  headRevision !== null &&
                  detailBefore.summary.base.revision === baseRevision &&
                  detailBefore.summary.head.revision === headRevision &&
                  diff.headRevision === headRevision
                ) {
                  const reviewKey = makeReviewKey(review)
                  const typedBaseRevision = ReviewRevision.make(baseRevision)
                  const typedHeadRevision = ReviewRevision.make(headRevision)
                  return HostedReviewSnapshot.make({
                    snapshotId: makeReviewSnapshotId({
                      reviewKey,
                      baseRevision: typedBaseRevision,
                      headRevision: typedHeadRevision,
                      diffIdentity: makeReviewDiffIdentity(diff.diff),
                    }),
                    reviewKey,
                    baseRevision: typedBaseRevision,
                    headRevision: typedHeadRevision,
                    detail: detailAfter,
                    diff,
                    parsedDiff: parseDiff(diff.diff),
                  })
                }
              }

              return yield* ReviewContextError.make({
                operation: "hosted.snapshot",
                reason: "Hosted review changed while its snapshot was being loaded",
                cause: new Error(
                  "Review revisions did not remain stable across metadata and diff reads",
                ),
              })
            },
          ),
          getLocalReviewSnapshot: Effect.fn("ReviewContextService.getLocalReviewSnapshot")(
            function (target) {
              return git
                .getLocalReviewSnapshot(target)
                .pipe(Effect.mapError(snapshotOperationError("local.snapshot")))
            },
          ),
        })
      }),
    )

  static readonly layer = ReviewContextService.layerWith()
}

const snapshotOperationError = (operation: string) => (cause: unknown) =>
  ReviewContextError.make({
    operation,
    reason: "Unable to load review context",
    cause,
  })
