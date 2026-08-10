import { Schema } from "effect"

import { toTransportError, TransportError } from "./transport-error"

const LEGACY_BRIDGE_TRANSPORT_ERROR_PREFIX = "DIFFDASH_TRANSPORT_ERROR_V1:"

/** Encodes the retired Electron error-message representation for compatibility tests. */
export const legacyBridgeTransportError = (
  error: Parameters<typeof toTransportError>[0],
  operation?: string,
): Error => {
  const encoded = Schema.encodeSync(TransportError)(toTransportError(error, operation))
  const bridgeError = new Error(`${LEGACY_BRIDGE_TRANSPORT_ERROR_PREFIX}${JSON.stringify(encoded)}`)
  delete bridgeError.stack
  return bridgeError
}
