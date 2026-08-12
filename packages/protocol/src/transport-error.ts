import { AgentProviderId } from "@diffdash/domain/agent-provider"
import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import { AgentProviderFailure } from "@diffdash/domain/provider-failure"
import { Predicate, Result, Schema, SchemaGetter } from "effect"

type TransportErrorInput = Schema.Json | object | bigint | symbol | undefined

const MAX_PUBLIC_ERROR_MESSAGE_LENGTH = 500
const MAX_PUBLIC_ERROR_OPERATION_LENGTH = 200
const MAX_PUBLIC_ERROR_CODE_LENGTH = 100
const LEGACY_BRIDGE_TRANSPORT_ERROR_PREFIX = "DIFFDASH_TRANSPORT_ERROR_V1:"
const PUBLIC_REASON_ERROR_CODES = new Set([
  "LocalReviewTargetError",
  "RepositoryLinkError",
  "RepositoryComparisonSourceError",
  "ReviewTurnRejectedError",
  "ReviewTurnTargetError",
])
const DiagnosticTag = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/u)),
)
const DiagnosticStackFrame = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(MAX_PUBLIC_ERROR_OPERATION_LENGTH)),
  Schema.check(Schema.isPattern(/^at [A-Za-z_$][A-Za-z0-9_$.<>-]*$/u)),
)
const ProviderDiagnosticSummary = Schema.Literals([
  "Authentication or authorization failure reported.",
  "Rate limit or quota failure reported.",
  "Network or connection failure reported.",
  "Provider diagnostics were redacted.",
  "No provider diagnostics were emitted.",
  "Unexpected walkthrough failure.",
])
const TransportDiagnosticOperation = Schema.String.pipe(
  Schema.decodeTo(DiagnosticOperation, {
    decode: SchemaGetter.transform((operation) =>
      sanitizeTransportErrorMessage(operation).slice(0, MAX_PUBLIC_ERROR_OPERATION_LENGTH),
    ),
    encode: SchemaGetter.transform((operation) => operation),
  }),
)

/** Stable renderer-facing message for failures that are not explicitly safe to disclose. */
export const UNKNOWN_TRANSPORT_ERROR_MESSAGE = "DiffDash could not complete the request."

/** Bounded, already-redacted process diagnostics safe to include in a user-copied report. */
export class TransportErrorDiagnosticTrace extends Schema.Class<TransportErrorDiagnosticTrace>(
  "TransportErrorDiagnosticTrace",
)({
  provider: AgentProviderId.pipe(
    Schema.check(Schema.isMaxLength(100)),
    Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
  ),
  errorTag: DiagnosticTag,
  causeTag: DiagnosticTag,
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(DiagnosticTag),
  reason: ProviderDiagnosticSummary,
  stderr: ProviderDiagnosticSummary,
  stackFrames: Schema.Array(DiagnosticStackFrame).pipe(Schema.check(Schema.isMaxLength(8))),
}) {}

/** User-safe, serializable failure that may cross a process boundary. */
export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  code: Schema.NonEmptyString,
  message: Schema.String,
  operation: Schema.optional(TransportDiagnosticOperation),
  diagnostic: Schema.optional(TransportErrorDiagnosticTrace),
  providerFailure: Schema.optional(AgentProviderFailure),
}) {}

/** Plain structured-clone-safe representation used by the Electron failure envelope. */
export const TransportErrorPayload = Schema.Struct({
  _tag: Schema.Literal("TransportError"),
  code: Schema.NonEmptyString,
  message: Schema.String,
  operation: Schema.optional(TransportDiagnosticOperation),
  diagnostic: Schema.optional(TransportErrorDiagnosticTrace),
  providerFailure: Schema.optional(AgentProviderFailure),
})

/** Converts an unknown boundary failure without exposing its stack or cause. */
export const toTransportError = <Input extends TransportErrorInput>(
  error: Input extends TransportErrorInput ? Input : never,
  operation?: string,
) => {
  const decoded = decodeTransportError(error)
  return decoded === null
    ? normalizedTransportError({
        code: "INTERNAL_ERROR",
        message: UNKNOWN_TRANSPORT_ERROR_MESSAGE,
        operation,
      })
    : normalizedTransportError({
        code: decoded.code,
        message: decoded.message,
        operation: decoded.operation ?? operation,
        diagnostic: decoded.diagnostic,
        providerFailure: decoded.providerFailure,
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
    operation,
    diagnostic,
    providerFailure,
  })

/** Structurally decodes either a protocol value or its standard Error bridge encoding. */
export const decodeTransportError = <Input extends TransportErrorInput>(
  error: Input extends TransportErrorInput ? Input : never,
): TransportError | null => {
  const direct = Schema.decodeUnknownResult(TransportError)(error)
  if (Result.isSuccess(direct)) return normalizedTransportError(direct.success)

  const payload = Schema.decodeUnknownResult(TransportErrorPayload)(error)
  if (Result.isSuccess(payload)) return normalizedTransportError(payload.success)

  const message = errorMessage(error)
  if (message === null) return null
  const markerIndex = message.lastIndexOf(LEGACY_BRIDGE_TRANSPORT_ERROR_PREFIX)
  if (markerIndex < 0) return null
  try {
    const encoded = JSON.parse(
      message.slice(markerIndex + LEGACY_BRIDGE_TRANSPORT_ERROR_PREFIX.length),
    )
    const bridged = Schema.decodeUnknownResult(TransportError)(encoded)
    return Result.isSuccess(bridged) ? normalizedTransportError(bridged.success) : null
  } catch {
    return null
  }
}

/** Returns whether an error-like value carries the protocol bridge marker, even if malformed. */
export const hasBridgeTransportErrorEncoding = <Input extends TransportErrorInput>(
  error: Input extends TransportErrorInput ? Input : never,
): boolean => errorMessage(error)?.includes(LEGACY_BRIDGE_TRANSPORT_ERROR_PREFIX) === true

/** Returns a bounded single-line message from a protocol error, or the safe fallback. */
export const safeTransportErrorMessage = <Input extends TransportErrorInput>(
  error: Input extends TransportErrorInput ? Input : never,
) => {
  const decoded = decodeTransportError(error)
  return decoded === null
    ? UNKNOWN_TRANSPORT_ERROR_MESSAGE
    : sanitizeTransportErrorMessage(decoded.message)
}

/** Identifies the narrow transport failures that are safe to retry idempotently. */
export const isTransientTransportError = <Input extends TransportErrorInput>(
  error: Input extends TransportErrorInput ? Input : never,
): boolean => {
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
      : DiagnosticOperation.make(
          sanitizeTransportErrorMessage(error.operation).slice(
            0,
            MAX_PUBLIC_ERROR_OPERATION_LENGTH,
          ),
        )
  const properties: {
    readonly code: string
    readonly message: string
    operation?: DiagnosticOperation
    diagnostic?: TransportErrorDiagnosticTrace
    providerFailure?: AgentProviderFailure
  } = {
    code: /^[A-Za-z0-9._:-]+$/.test(error.code)
      ? error.code.slice(0, MAX_PUBLIC_ERROR_CODE_LENGTH)
      : "INTERNAL_ERROR",
    message: sanitizeTransportErrorMessage(error.message),
  }
  if (operation !== undefined) properties.operation = operation
  if (error.diagnostic !== undefined) properties.diagnostic = error.diagnostic
  if (error.providerFailure !== undefined) properties.providerFailure = error.providerFailure
  return TransportError.make(properties)
}

const errorMessage = <Input extends TransportErrorInput>(
  error: Input extends TransportErrorInput ? Input : never,
): string | null => {
  if (!Predicate.isReadonlyObject(error)) return null
  const message = error.message
  return Predicate.isString(message) ? message : null
}
