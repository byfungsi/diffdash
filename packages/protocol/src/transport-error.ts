import { Schema } from "effect"

/** User-safe, serializable failure that may cross a process boundary. */
export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  code: Schema.NonEmptyString,
  message: Schema.String,
  operation: Schema.optional(Schema.String),
}) {}

/** Converts an unknown boundary failure without exposing its stack or cause. */
export const toTransportError = (error: unknown, operation?: string) =>
  error instanceof TransportError
    ? TransportError.make({
        code: error.code,
        message: error.message,
        operation: error.operation ?? operation,
      })
    : TransportError.make({
        code: recoverableErrorCode(error),
        message: recoverableErrorMessage(error),
        ...(operation === undefined ? {} : { operation }),
      })

/** Creates a transport-owned failure for request, response, authorization, and routing errors. */
export const transportError = (code: string, message: string, operation?: string) =>
  TransportError.make({
    code,
    message,
    ...(operation === undefined ? {} : { operation }),
  })

const recoverableErrorCode = (error: unknown) => {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error["_tag"] === "string" &&
    error["_tag"].length > 0
  ) {
    return error["_tag"]
  }
  return "INTERNAL_ERROR"
}

const recoverableErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    typeof error.reason === "string" &&
    error.reason.length > 0
  ) {
    return error.reason
  }
  return "Unknown error"
}
