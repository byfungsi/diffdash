import { Schema } from "effect"

/** User-safe, serializable failure that may cross a process boundary. */
export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  code: Schema.String,
  message: Schema.String,
  operation: Schema.optional(Schema.String),
}) {}

/** Converts an unknown boundary failure without exposing its stack or cause. */
export const toTransportError = (error: unknown, operation?: string) =>
  TransportError.make({
    code: "INTERNAL_ERROR",
    message: error instanceof Error && error.message.length > 0 ? error.message : "Unknown error",
    ...(operation === undefined ? {} : { operation }),
  })
