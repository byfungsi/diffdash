import { Either, Schema } from "effect"

const MAX_PUBLIC_ERROR_MESSAGE_LENGTH = 500

/** Stable renderer-facing message for failures that are not explicitly safe to disclose. */
export const UNKNOWN_TRANSPORT_ERROR_MESSAGE = "DiffDash could not complete the request."

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
        message: sanitizeTransportErrorMessage(error.message),
        operation: error.operation ?? operation,
      })
    : TransportError.make({
        code: "INTERNAL_ERROR",
        message: UNKNOWN_TRANSPORT_ERROR_MESSAGE,
        ...(operation === undefined ? {} : { operation }),
      })

/** Creates a transport-owned failure for request, response, authorization, and routing errors. */
export const transportError = (code: string, message: string, operation?: string) =>
  TransportError.make({
    code,
    message: sanitizeTransportErrorMessage(message),
    ...(operation === undefined ? {} : { operation }),
  })

/** Returns a bounded single-line message from a protocol error, or the safe fallback. */
export const safeTransportErrorMessage = (error: unknown) => {
  const decoded = Schema.decodeUnknownEither(TransportError)(error)
  return Either.isRight(decoded)
    ? sanitizeTransportErrorMessage(decoded.right.message)
    : UNKNOWN_TRANSPORT_ERROR_MESSAGE
}

/** Removes control characters and bounds an explicitly public transport message. */
export const sanitizeTransportErrorMessage = (message: string) => {
  const sanitized = [...message]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || (code >= 127 && code <= 159) ? " " : character
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
  if (sanitized.length === 0) return UNKNOWN_TRANSPORT_ERROR_MESSAGE
  return sanitized.slice(0, MAX_PUBLIC_ERROR_MESSAGE_LENGTH)
}
