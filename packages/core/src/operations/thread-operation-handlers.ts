import { randomUUID } from "node:crypto"
import { ReviewFileId, ReviewHunkId } from "@diffdash/domain/review-identity"
import {
  ReviewThreadAnchorInvalidError,
  ReviewThreadRevisionChangedError,
} from "@diffdash/domain/review-thread"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import { ReviewTurnStore } from "@diffdash/persistence/review-turn-store"
import { ReviewAgentService } from "../services/review-agent"
import { ReviewThreadAnchorMapper } from "../services/review-thread-anchor-mapper"
import { ReviewContextError } from "../services/git-provider"
import { OperationSnapshotReader } from "../services/operation-snapshot-reader"
import {
  decodeSnapshotHunkLines,
  reviewThreadHunkExcerpt,
} from "../services/operation-snapshot-projection"
import { Effect, Option } from "effect"

import { CoreMethod, type CoreOperationOptions } from "../core-contract"
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
  | OperationSnapshotReader
  | ReviewAgentService
  | ReviewThreadAnchorMapper
  | ReviewThreadStore
  | ReviewTurnStore
> =>
  Effect.gen(function* () {
    const reviewAgents = yield* ReviewAgentService
    const threadMapper = yield* ReviewThreadAnchorMapper
    const threads = yield* ReviewThreadStore
    const turns = yield* ReviewTurnStore
    const snapshotReader = yield* OperationSnapshotReader

    const open = (
      repoId: Parameters<typeof operationIdentity>[0],
      snapshot: Parameters<typeof operationIdentity>[1],
      options: CoreOperationOptions,
    ) =>
      requireRequestIdentity(options).pipe(
        Effect.flatMap((identity) =>
          snapshotReader.open(operationIdentity(repoId, snapshot, identity)),
        ),
      )

    return {
      [CoreMethod.addReviewThreadUserMessage]: (request) => threads.addUserMessage(request),
      [CoreMethod.createReviewThread]: (request, options) =>
        Effect.scoped(
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
            const handle = yield* open(repo.id, snapshot, options).pipe(
              Effect.mapError(snapshotResolutionError),
            )
            const anchorRead = yield* handle
              .readHunk(
                ReviewFileId.make(request.anchor.fileId),
                ReviewHunkId.make(request.anchor.hunkId),
              )
              .pipe(Effect.option)
            const validAnchor = yield* Option.match(anchorRead, {
              onNone: () => Effect.succeed(false),
              onSome: ({ file, hunk, bytes }) =>
                decodeSnapshotHunkLines(bytes).pipe(
                  Effect.map(
                    (lines) =>
                      file.path === request.anchor.filePath &&
                      reviewThreadHunkExcerpt(request.anchor, hunk, lines) !== null,
                  ),
                  Effect.catchTag("OperationSnapshotReaderError", () => Effect.succeed(false)),
                ),
            })
            if (!validAnchor) {
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
        ),
      [CoreMethod.getReviewThread]: ({ threadId }) => threads.get(threadId),
      [CoreMethod.listReviewThreads]: ({ target }, options) =>
        Effect.scoped(
          Effect.gen(function* () {
            const { repo, snapshot } = yield* reviews.resolve(target)
            const handle = yield* open(repo.id, snapshot, options).pipe(
              Effect.mapError(snapshotResolutionError),
            )
            return yield* threadMapper
              .mapReview({
                repoId: repo.id,
                handle,
              })
              .pipe(
                Effect.catchTag("OperationSnapshotReaderError", (error) =>
                  snapshotResolutionError(error),
                ),
              )
          }),
        ),
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
          const requestIdentity = yield* requireRequestIdentity(options)
          return yield* reviewAgents.runThreadTurn({
            threadId: request.threadId,
            repoId: repo.id,
            target: request.target,
            mapping,
            snapshotId: snapshot.snapshotId,
            applicationInstanceId: requestIdentity.applicationInstanceId,
            processEpoch: requestIdentity.processEpoch,
            cwd: repo.localPath,
            walkthrough,
            onProgress: (stage) => Effect.sync(() => options.onReviewThreadAgentProgress?.(stage)),
          })
        }),
    } satisfies OperationHandlersFor<ThreadMethod>
  })

const operationIdentity = (
  projectId: Parameters<ReviewThreadStore["Service"]["listForReview"]>[0]["repoId"],
  snapshot: {
    readonly snapshotId: Parameters<OperationSnapshotReader["Service"]["open"]>[0]["snapshotId"]
    readonly reviewKey: Parameters<OperationSnapshotReader["Service"]["open"]>[0]["reviewKey"]
  },
  requestIdentity: Required<Pick<CoreOperationOptions, "applicationInstanceId" | "processEpoch">>,
) => ({
  applicationInstanceId: requestIdentity.applicationInstanceId,
  processEpoch: requestIdentity.processEpoch,
  operationId: `thread:${randomUUID()}`,
  projectId,
  reviewKey: snapshot.reviewKey,
  snapshotId: snapshot.snapshotId,
})

const requireRequestIdentity = (options: CoreOperationOptions) =>
  options.applicationInstanceId === undefined || options.processEpoch === undefined
    ? Effect.die(new Error("Core operation request identity is required for snapshot ownership."))
    : Effect.succeed({
        applicationInstanceId: options.applicationInstanceId,
        processEpoch: options.processEpoch,
      })

const snapshotResolutionError = (cause: Error) =>
  ReviewContextError.make({
    operation: "local.snapshot",
    reason: "The durable review snapshot is unavailable.",
    cause,
  })
