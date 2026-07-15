import { Context, Effect, Layer, Schema } from "effect"

import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import type { LocalReviewSnapshot } from "@diffdash/domain/review-context"
import { PullRequestReviewSnapshot } from "@diffdash/domain/review-context"
import { makePullRequestReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import type { LocalReviewTarget } from "@diffdash/domain/local-review"
import { GitService } from "./git"
import { GitProvider } from "./git-provider"

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
    readonly getPullRequestSnapshot: (
      owner: string,
      name: string,
      number: number,
    ) => Effect.Effect<PullRequestReviewSnapshot, ReviewContextError>
    readonly getLocalReviewSnapshot: (
      target: LocalReviewTarget,
    ) => Effect.Effect<LocalReviewSnapshot, ReviewContextError>
  }
>() {
  static readonly layer = Layer.effect(
    ReviewContextService,
    Effect.gen(function* () {
      const gitProvider = yield* GitProvider
      const git = yield* GitService

      return ReviewContextService.of({
        getPullRequestSnapshot: Effect.fn("ReviewContextService.getPullRequestSnapshot")(
          function* (owner, name, number) {
            for (let attempt = 1; attempt <= 2; attempt += 1) {
              const detailBefore = yield* gitProvider
                .getPullRequestDetail(owner, name, number)
                .pipe(Effect.mapError(snapshotOperationError("pullRequest.detailBefore")))
              const diff = yield* gitProvider
                .getPullRequestDiff(owner, name, number)
                .pipe(Effect.mapError(snapshotOperationError("pullRequest.diff")))
              const detailAfter = yield* gitProvider
                .refreshPullRequestDetail(owner, name, number)
                .pipe(Effect.mapError(snapshotOperationError("pullRequest.detailAfter")))
              const baseRevision = detailAfter.baseRefOid
              const headRevision = detailAfter.headRefOid

              if (
                baseRevision !== null &&
                headRevision !== null &&
                detailBefore.baseRefOid === baseRevision &&
                detailBefore.headRefOid === headRevision &&
                diff.headRefOid === headRevision
              ) {
                return PullRequestReviewSnapshot.make({
                  reviewKey: makePullRequestReviewKey("github", owner, name, number),
                  baseRevision: ReviewRevision.make(baseRevision),
                  headRevision: ReviewRevision.make(headRevision),
                  detail: detailAfter,
                  diff,
                  parsedDiff: parseUnifiedDiff(diff.diff),
                })
              }
            }

            return yield* ReviewContextError.make({
              operation: "pullRequest.snapshot",
              reason: "Pull request changed while its review snapshot was being loaded",
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
}

const snapshotOperationError = (operation: string) => (cause: unknown) =>
  ReviewContextError.make({
    operation,
    reason: "Unable to load review context",
    cause,
  })
