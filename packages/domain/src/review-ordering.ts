import type { ReviewSnapshot } from "./review-context"
import { Array, Order } from "effect"

type ReviewFile = ReviewSnapshot["parsedDiff"]["files"][number]

/** Orders review files deterministically for every review projection. */
export const orderedReviewFiles = (snapshot: ReviewSnapshot) =>
  Array.sort(
    snapshot.parsedDiff.files,
    Order.combineAll<ReviewFile>([
      Order.mapInput(Order.String, (file) => file.path),
      Order.mapInput(Order.String, (file) => file.oldPath ?? ""),
      Order.mapInput(Order.String, (file) => file.fileId),
    ]),
  )

/** Orders diff hunks deterministically by source location and stable identity. */
export const orderedReviewHunks = <
  Hunk extends { readonly id: string; readonly oldStart: number; readonly newStart: number },
>(
  hunks: readonly Hunk[],
) =>
  Array.sort(
    hunks,
    Order.combineAll<Hunk>([
      Order.mapInput(Order.Number, (hunk) => hunk.oldStart),
      Order.mapInput(Order.Number, (hunk) => hunk.newStart),
      Order.mapInput(Order.String, (hunk) => hunk.id),
    ]),
  )
