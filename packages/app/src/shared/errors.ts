import {
  decodeTransportError,
  isPublicReasonTransportErrorCode,
  transportError,
  UNKNOWN_TRANSPORT_ERROR_MESSAGE,
} from "@diffdash/protocol/transport-error"
import { Match, Predicate, Schema } from "effect"

import { TransportError } from "@diffdash/protocol/transport-error"

/** Bounded renderer failure inputs accepted at browser and contextBridge edges. */
export type RendererFailure = TransportError | Error | { readonly message: string }
type RendererFailureValue = Schema.Json | object | bigint | symbol | undefined

const rendererFailureValue = <Value>(value: Value): RendererFailureValue => {
  if (Schema.is(Schema.Json)(value)) return value
  if (Predicate.isObject(value)) return value
  if (Predicate.isBigInt(value)) return value
  if (Predicate.isSymbol(value)) return value
  return undefined
}

/** Narrows an untrusted rejection to the bridge-compatible failure input shape. */
export const rendererFailureInput = <Value>(error: Value): RendererFailure => {
  return Match.value(rendererFailureValue(error)).pipe(
    Match.when(Predicate.isError, (value) => value),
    Match.when(Predicate.isObject, (value) => {
      const object: object = value
      const transport = decodeTransportError(object)
      if (transport !== null) return transport
      return "message" in object && Predicate.isString(object.message)
        ? { message: object.message }
        : { message: UNKNOWN_TRANSPORT_ERROR_MESSAGE }
    }),
    Match.when(Predicate.isString, (value) => ({ message: value })),
    Match.orElse(() => ({ message: UNKNOWN_TRANSPORT_ERROR_MESSAGE })),
  )
}

const PRELOAD_OPERATION_PREFIX = /^[A-Za-z][A-Za-z0-9._:-]* failed:\s*/u

/** Formats an unknown renderer failure for user-facing status text. */
export const formatError = <Value>(error: Value, fallback: string): string => {
  const input = rendererFailureInput(error)
  const transport = decodeTransportError(input)
  if (transport !== null) {
    const message = transport.message.replace(PRELOAD_OPERATION_PREFIX, "")
    return isPublicReasonTransportErrorCode(transport.code) ? `${fallback}: ${message}` : message
  }
  const message = rendererFailureMessage(input)
  if (message !== null) {
    return cleanErrorMessage(message, fallback)
  }
  return fallback
}

/** Normalizes an untrusted renderer rejection into the transport failure contract. */
export const rendererTransportError = <Value>(error: Value, operation?: string): TransportError => {
  const knownTransport = Match.value(rendererFailureValue(error)).pipe(
    Match.when(Schema.is(TransportError), (value) => value),
    Match.orElse(() => null),
  )
  if (knownTransport !== null) return knownTransport
  const transport = decodeTransportError(rendererFailureInput(error))
  if (transport !== null) return transport
  return transportError(
    "RENDERER_API_FAILURE",
    rendererFailureMessage(rendererFailureInput(error)) ?? UNKNOWN_TRANSPORT_ERROR_MESSAGE,
    operation,
  )
}

const rendererFailureMessage = <Value>(error: Value): string | null => {
  return Match.value(rendererFailureValue(error)).pipe(
    Match.when(Predicate.isError, (value) => (value.message.length > 0 ? value.message : null)),
    Match.when(Predicate.isObject, (value) =>
      "message" in value && Predicate.isString(value.message) && value.message.length > 0
        ? value.message
        : null,
    ),
    Match.orElse(() => null),
  )
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
