import {
  isReviewAnchorInParsedDiff,
  ReviewThreadAnchorInvalidError,
  ReviewThreadRevisionChangedError,
} from "@diffdash/domain/review-thread"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import { ReviewTurnStore } from "@diffdash/persistence/review-turn-store"
import { ReviewAgentService } from "../services/review-agent"
import { ReviewThreadAnchorMapper } from "../services/review-thread-anchor-mapper"
import { Effect } from "effect"

import { CoreMethod } from "../core-contract"
import type { OperationHandlersFor } from "./operation-handlers"
import type { ReviewResolution } from "./review-resolution"
import type { WalkthroughOperations } from "./walkthrough-operations"

type ThreadMethod =
  | typeof CoreMethod.addReviewThreadUserMessage
  | typeof CoreMethod.createReviewThread
  | typeof CoreMethod.getReviewThread
  | typeof CoreMethod.listReviewThreads
  | typeof CoreMethod.runReviewThreadAgent

/** Acquires thread persistence, mapping, and agent-turn handlers. */
export const makeThreadOperationHandlers = (
  reviews: ReviewResolution,
  walkthroughs: WalkthroughOperations,
): Effect.Effect<
  OperationHandlersFor<ThreadMethod>,
  never,
  ReviewAgentService | ReviewThreadAnchorMapper | ReviewThreadStore | ReviewTurnStore
> =>
  Effect.gen(function* () {
    const reviewAgents = yield* ReviewAgentService
    const threadMapper = yield* ReviewThreadAnchorMapper
    const threads = yield* ReviewThreadStore
    const turns = yield* ReviewTurnStore

    return {
      [CoreMethod.addReviewThreadUserMessage]: (request) => threads.addUserMessage(request),
      [CoreMethod.createReviewThread]: (request) =>
        Effect.gen(function* () {
          const { repo, snapshot, prNumber } = yield* reviews.resolve(request.target)
          if (
            snapshot.baseRevision !== request.expectedBaseRevision ||
            snapshot.headRevision !== request.expectedHeadRevision
          ) {
            return yield* ReviewThreadRevisionChangedError.make({
              expectedBaseRevision: request.expectedBaseRevision,
              expectedHeadRevision: request.expectedHeadRevision,
              currentBaseRevision: snapshot.baseRevision,
              currentHeadRevision: snapshot.headRevision,
            })
          }
          if (!isReviewAnchorInParsedDiff(request.anchor, snapshot.parsedDiff)) {
            return yield* ReviewThreadAnchorInvalidError.make({
              reviewKey: snapshot.reviewKey,
            })
          }
          return yield* threads.create({
            repoId: repo.id,
            reviewKey: snapshot.reviewKey,
            prNumber,
            baseRevision: snapshot.baseRevision,
            headRevision: snapshot.headRevision,
            anchor: request.anchor,
            bodyMarkdown: request.bodyMarkdown,
          })
        }),
      [CoreMethod.getReviewThread]: ({ threadId }) => threads.get(threadId),
      [CoreMethod.listReviewThreads]: ({ target }) =>
        Effect.gen(function* () {
          const { repo, snapshot } = yield* reviews.resolve(target)
          return yield* threadMapper.mapReview({
            repoId: repo.id,
            reviewKey: snapshot.reviewKey,
            baseRevision: snapshot.baseRevision,
            headRevision: snapshot.headRevision,
            parsedDiff: snapshot.parsedDiff,
          })
        }),
      [CoreMethod.runReviewThreadAgent]: (request, options) =>
        Effect.gen(function* () {
          const mapping = yield* turns.validateTarget({
            threadId: request.threadId,
            target: request.target,
            repoId: request.repoId,
            reviewKey: request.reviewKey,
            baseRevision: request.expectedBaseRevision,
            headRevision: request.expectedHeadRevision,
          })
          const { repo, snapshot } = yield* reviews.resolve(request.target)
          const walkthrough = yield* walkthroughs.getCached(repo.id, snapshot)
          return yield* reviewAgents.runThreadTurn({
            threadId: request.threadId,
            repoId: repo.id,
            target: request.target,
            mapping,
            snapshot,
            cwd: repo.localPath,
            walkthrough,
            onProgress: (stage) => Effect.sync(() => options.onReviewThreadAgentProgress?.(stage)),
          })
        }),
    } satisfies OperationHandlersFor<ThreadMethod>
  })
