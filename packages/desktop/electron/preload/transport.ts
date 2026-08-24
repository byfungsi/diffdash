import {
  bridgeResult,
  EventContract,
  FailureEnvelope,
  InvokeContract,
  successEnvelope,
} from "@diffdash/protocol/ipc"
import { assertJsonPayloadWithinBudget } from "@diffdash/protocol/payload-budget"
import type { EncodedBridgeResult, InvokeRequest } from "@diffdash/protocol/ipc"
import type { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import type { TransportErrorDiagnosticTrace } from "@diffdash/protocol/transport-error"
import {
  decodeTransportError,
  safeTransportErrorMessage,
  transportError,
  TransportErrorCodec,
  TransportErrorPayload,
} from "@diffdash/protocol/transport-error"
import { Predicate, Schema } from "effect"

type RendererPayload = Parameters<typeof assertJsonPayloadWithinBudget>[0]
type ElectronBoundaryValue = unknown

/** Narrow ipcRenderer surface consumed by the schema-validated preload transport. */
export interface RendererIpc {
  readonly invoke: (
    channel: string,
    request: ElectronBoundaryValue,
  ) => Promise<ElectronBoundaryValue>
  readonly on: (
    channel: string,
    listener: (event: ElectronBoundaryValue, payload: ElectronBoundaryValue) => void,
  ) => void
  readonly removeListener: (
    channel: string,
    listener: (event: ElectronBoundaryValue, payload: ElectronBoundaryValue) => void,
  ) => void
}

/** Creates the renderer side of the protocol transport without exposing Electron primitives. */
export const createRendererTransport = (ipc: RendererIpc) => ({
  invoke: async <Channel extends InvokeChannel>(
    channel: Channel,
    request: InvokeRequest<Channel>,
  ): Promise<EncodedBridgeResult> => {
    let encodedRequest: RendererPayload
    try {
      encodedRequest = toRendererPayload(encodeRequest(channel, request))
      assertJsonPayloadWithinBudget(
        encodedRequest,
        InvokeContract[channel].maxRequestBytes,
        channel,
      )
    } catch (error) {
      const transport = decodeTransportError(toTransportFailure(error))
      return failureResult(
        transport ?? rendererTransportError("INVALID_REQUEST", "Invalid request", channel),
      )
    }

    let rawResponse: RendererPayload
    try {
      rawResponse = toRendererPayload(await ipc.invoke(channel, encodedRequest))
    } catch (cause) {
      return failureResult(
        rendererTransportError(
          "IPC_FAILURE",
          safeTransportErrorMessage(toTransportFailure(cause)),
          channel,
        ),
      )
    }

    try {
      assertJsonPayloadWithinBudget(rawResponse, InvokeContract[channel].maxResponseBytes, channel)
      const encoded = Schema.decodeUnknownSync(
        Schema.toEncoded(bridgeResult(InvokeContract[channel].response)),
      )(rawResponse)
      return encoded
    } catch (error) {
      return failureResult(
        decodeTransportError(toTransportFailure(error)) ??
          rendererTransportError(
            "INVALID_RESPONSE",
            `Encoded response did not satisfy the preload schema for ${channel}`,
            channel,
          ),
      )
    }
  },

  subscribe: (channel: EventChannel, listener: (result: EncodedBridgeResult) => void) => {
    const wrapped = (_event: ElectronBoundaryValue, rawPayload: ElectronBoundaryValue) => {
      try {
        const payload = toRendererPayload(rawPayload)
        assertJsonPayloadWithinBudget(payload, EventContract[channel].maxPayloadBytes, channel)
        const payloadSchema = EventContract[channel].payload
        listener(
          Schema.encodeSync(bridgeResult(payloadSchema))(
            successEnvelope(payloadSchema).make({
              value: Schema.decodeUnknownSync(payloadSchema)(payload),
            }),
          ),
        )
      } catch (error) {
        listener(
          failureResult(
            decodeTransportError(toTransportFailure(error)) ??
              rendererTransportError("INVALID_EVENT", "Invalid event", channel),
          ),
        )
      }
    }
    ipc.on(channel, wrapped)
    return () => ipc.removeListener(channel, wrapped)
  },
})

const encodeRequest = <Channel extends InvokeChannel>(
  channel: Channel,
  request: InvokeRequest<Channel>,
) => {
  const schema = InvokeContract[channel].request
  try {
    return Schema.encodeUnknownSync(schema)(request)
  } catch {
    return Schema.encodeUnknownSync(schema)(Schema.decodeUnknownSync(schema)(request))
  }
}

const rendererTransportError = (
  code: string,
  message: string,
  channel: InvokeChannel | EventChannel,
  operation: string = channel,
  diagnostic?: TransportErrorDiagnosticTrace,
) => transportError(code, `${channel} failed: ${message}`, operation, diagnostic)

const failureResult = (error: ReturnType<typeof transportError>): EncodedBridgeResult =>
  Schema.encodeSync(FailureEnvelope)(
    FailureEnvelope.make({
      error: Schema.decodeUnknownSync(TransportErrorPayload)(
        Schema.encodeSync(TransportErrorCodec)(error),
      ),
    }),
  )

const toRendererPayload = (value: ElectronBoundaryValue): RendererPayload => {
  if (Schema.is(Schema.Json)(value)) return value
  if (Predicate.isObjectOrArray(value)) return value
  if (Predicate.isBigInt(value) || Predicate.isSymbol(value)) return value
  return undefined
}

const toTransportFailure = (
  value: ElectronBoundaryValue,
): Parameters<typeof decodeTransportError>[0] => {
  if (Schema.is(Schema.Json)(value)) return value
  if (Predicate.isObjectOrArray(value)) return value
  if (Predicate.isBigInt(value) || Predicate.isSymbol(value)) return value
  return undefined
}
