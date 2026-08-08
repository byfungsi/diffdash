import {
  decodeTransportError,
  isPublicReasonTransportErrorCode,
} from "@diffdash/protocol/transport-error"

const PRELOAD_OPERATION_PREFIX = /^[A-Za-z][A-Za-z0-9._:-]* failed:\s*/u

/** Formats an unknown renderer failure for user-facing status text. */
export const formatError = (error: unknown, fallback: string) => {
  const transport = decodeTransportError(error)
  if (transport !== null) {
    const message = transport.message.replace(PRELOAD_OPERATION_PREFIX, "")
    return isPublicReasonTransportErrorCode(transport.code) ? `${fallback}: ${message}` : message
  }
  if (error instanceof Error && error.message.length > 0) {
    return cleanErrorMessage(error.message, fallback)
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message
    if (typeof message === "string" && message.length > 0) {
      return cleanErrorMessage(message, fallback)
    }
  }
  return fallback
}

const cleanErrorMessage = (message: string, fallback: string) => {
  const missingCommand = /spawn\s+([^\s]+)\s+ENOENT/.exec(message)
  if (missingCommand?.[1]) return `${fallback}: ${missingCommand[1]} was not found.`

  const structuredReason = /"reason"\s*:\s*"([^"]+)"/.exec(message)
  if (structuredReason?.[1]) return `${fallback}: ${structuredReason[1]}`

  const taggedError = /\)\s+\w+Error:\s+([^{}\n]+)/.exec(message)
  if (taggedError?.[1]) return taggedError[1].trim()

  return message
}
