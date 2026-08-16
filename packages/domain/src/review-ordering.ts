import { Array, Order } from "effect"

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
