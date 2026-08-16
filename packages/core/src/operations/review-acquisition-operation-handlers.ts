import { Effect } from "effect"

import { CoreMethod } from "../core-contract"
import { CoreSnapshotAcquisition } from "../core-snapshot-acquisition"
import type { OperationHandlersFor } from "./operation-handlers"

type ReviewAcquisitionMethod =
  | typeof CoreMethod.acquireHostedReviewSnapshot
  | typeof CoreMethod.acquireLocalReviewSnapshot
  | typeof CoreMethod.acquireRepositoryComparisonSnapshot

/** Acquires durable hosted, local, and repository-comparison snapshot handlers. */
export const makeReviewAcquisitionOperationHandlers: Effect.Effect<
  OperationHandlersFor<ReviewAcquisitionMethod>,
  never,
  CoreSnapshotAcquisition
> = Effect.gen(function* () {
  const acquisition = yield* CoreSnapshotAcquisition
  return {
    [CoreMethod.acquireHostedReviewSnapshot]: ({ review }) => acquisition.acquireHosted(review),
    [CoreMethod.acquireLocalReviewSnapshot]: ({ target }) => acquisition.acquireLocal(target),
    [CoreMethod.acquireRepositoryComparisonSnapshot]: ({ target }) =>
      acquisition.acquireComparison(target),
  }
})
