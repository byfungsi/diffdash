import { AgentProviderId } from "@diffdash/agent-provider"
import { AgentProviderFailure } from "@diffdash/domain/provider-failure"
import { Either, Schema } from "effect"

const MAX_PUBLIC_ERROR_MESSAGE_LENGTH = 500
const MAX_PUBLIC_ERROR_OPERATION_LENGTH = 200
const MAX_PUBLIC_ERROR_CODE_LENGTH = 100
const BRIDGE_TRANSPORT_ERROR_PREFIX = "DIFFDASH_TRANSPORT_ERROR_V1:"
const PUBLIC_REASON_ERROR_CODES = new Set([
  "LocalReviewTargetError",
  "RepositoryLinkError",
  "RepositoryComparisonSourceError",
  "ReviewTurnRejectedError",
  "ReviewTurnTargetError",
])
const DiagnosticTag = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(100),
  Schema.pattern(/^[A-Za-z0-9._:-]+$/u),
)
const DiagnosticStackFrame = Schema.String.pipe(
  Schema.maxLength(MAX_PUBLIC_ERROR_OPERATION_LENGTH),
  Schema.pattern(/^at [A-Za-z_$][A-Za-z0-9_$.<>-]*$/u),
)
const ProviderDiagnosticSummary = Schema.Literal(
  "Authentication or authorization failure reported.",
  "Rate limit or quota failure reported.",
  "Network or connection failure reported.",
  "Provider diagnostics were redacted.",
  "No provider diagnostics were emitted.",
  "Unexpected walkthrough failure.",
)

/** Stable renderer-facing message for failures that are not explicitly safe to disclose. */
export const UNKNOWN_TRANSPORT_ERROR_MESSAGE = "DiffDash could not complete the request."

/** Bounded, already-redacted process diagnostics safe to include in a user-copied report. */
export class TransportErrorDiagnosticTrace extends Schema.Class<TransportErrorDiagnosticTrace>(
  "TransportErrorDiagnosticTrace",
)({
  provider: AgentProviderId.pipe(
    Schema.maxLength(100),
    Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  ),
  errorTag: DiagnosticTag,
  causeTag: DiagnosticTag,
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(DiagnosticTag),
  reason: ProviderDiagnosticSummary,
  stderr: ProviderDiagnosticSummary,
  stackFrames: Schema.Array(DiagnosticStackFrame).pipe(Schema.maxItems(8)),
}) {}

/** User-safe, serializable failure that may cross a process boundary. */
export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  code: Schema.NonEmptyString,
  message: Schema.String,
  operation: Schema.optional(Schema.String),
  diagnostic: Schema.optional(TransportErrorDiagnosticTrace),
  providerFailure: Schema.optional(AgentProviderFailure),
}) {}

/** Converts an unknown boundary failure without exposing its stack or cause. */
export const toTransportError = (error: unknown, operation?: string) => {
  const decoded = decodeTransportError(error)
  return decoded === null
    ? normalizedTransportError({
        code: "INTERNAL_ERROR",
        message: UNKNOWN_TRANSPORT_ERROR_MESSAGE,
        ...(operation === undefined ? {} : { operation }),
      })
    : normalizedTransportError({
        code: decoded.code,
        message: decoded.message,
        operation: decoded.operation ?? operation,
        ...(decoded.diagnostic === undefined ? {} : { diagnostic: decoded.diagnostic }),
        ...(decoded.providerFailure === undefined
          ? {}
          : { providerFailure: decoded.providerFailure }),
      })
}

/** Creates a transport-owned failure for request, response, authorization, and routing errors. */
export const transportError = (
  code: string,
  message: string,
  operation?: string,
  diagnostic?: TransportErrorDiagnosticTrace,
  providerFailure?: AgentProviderFailure,
) =>
  normalizedTransportError({
    code,
    message,
    ...(operation === undefined ? {} : { operation }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
    ...(providerFailure === undefined ? {} : { providerFailure }),
  })

/** Encodes a protocol error into a standard Error whose message survives Electron contextBridge. */
export const bridgeTransportError = (error: unknown, operation?: string): Error => {
  const encoded = Schema.encodeSync(TransportError)(toTransportError(error, operation))
  const bridgeError = new Error(`${BRIDGE_TRANSPORT_ERROR_PREFIX}${JSON.stringify(encoded)}`)
  delete bridgeError.stack
  return bridgeError
}

/** Structurally decodes either a protocol value or its standard Error bridge encoding. */
export const decodeTransportError = (error: unknown): TransportError | null => {
  const direct = Schema.decodeUnknownEither(TransportError)(error)
  if (Either.isRight(direct)) return normalizedTransportError(direct.right)

  const message = errorMessage(error)
  if (message === null) return null
  const markerIndex = message.lastIndexOf(BRIDGE_TRANSPORT_ERROR_PREFIX)
  if (markerIndex < 0) return null
  try {
    const encoded = JSON.parse(message.slice(markerIndex + BRIDGE_TRANSPORT_ERROR_PREFIX.length))
    const bridged = Schema.decodeUnknownEither(TransportError)(encoded)
    return Either.isRight(bridged) ? normalizedTransportError(bridged.right) : null
  } catch {
    return null
  }
}

/** Returns whether an error-like value carries the protocol bridge marker, even if malformed. */
export const hasBridgeTransportErrorEncoding = (error: unknown): boolean =>
  errorMessage(error)?.includes(BRIDGE_TRANSPORT_ERROR_PREFIX) === true

/** Returns a bounded single-line message from a protocol error, or the safe fallback. */
export const safeTransportErrorMessage = (error: unknown) => {
  const decoded = decodeTransportError(error)
  return decoded === null
    ? UNKNOWN_TRANSPORT_ERROR_MESSAGE
    : sanitizeTransportErrorMessage(decoded.message)
}

/** Identifies the narrow transport failures that are safe to retry idempotently. */
export const isTransientTransportError = (error: unknown): boolean => {
  const decoded = decodeTransportError(error)
  return decoded?.code === "IPC_FAILURE"
}

/** Identifies transport failures whose message is a safe domain reason requiring caller context. */
export const isPublicReasonTransportErrorCode = (code: string): boolean =>
  PUBLIC_REASON_ERROR_CODES.has(code)

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

const normalizedTransportError = (error: {
  readonly code: string
  readonly message: string
  readonly operation?: string | undefined
  readonly diagnostic?: TransportErrorDiagnosticTrace | undefined
  readonly providerFailure?: AgentProviderFailure | undefined
}) => {
  const operation =
    error.operation === undefined
      ? undefined
      : sanitizeTransportErrorMessage(error.operation).slice(0, MAX_PUBLIC_ERROR_OPERATION_LENGTH)
  return TransportError.make({
    code: /^[A-Za-z0-9._:-]+$/.test(error.code)
      ? error.code.slice(0, MAX_PUBLIC_ERROR_CODE_LENGTH)
      : "INTERNAL_ERROR",
    message: sanitizeTransportErrorMessage(error.message),
    ...(operation === undefined ? {} : { operation }),
    ...(error.diagnostic === undefined ? {} : { diagnostic: error.diagnostic }),
    ...(error.providerFailure === undefined ? {} : { providerFailure: error.providerFailure }),
  })
}

const errorMessage = (error: unknown): string | null =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : null
