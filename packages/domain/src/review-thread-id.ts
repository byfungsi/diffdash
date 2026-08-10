import { Schema } from "effect"

/** Persistent identity for one local DiffDash review thread. */
export const ReviewThreadId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("ReviewThreadId"),
)

/** Persistent identity for one local DiffDash review thread. */
export type ReviewThreadId = typeof ReviewThreadId.Type
