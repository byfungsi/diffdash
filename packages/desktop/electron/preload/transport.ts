import { bridgeResult, EventContract, InvokeContract } from "@diffdash/protocol/ipc"
import { assertJsonPayloadWithinBudget } from "@diffdash/protocol/payload-budget"
import type {
  BridgeResult,
  EventPayload,
  InvokeRequest,
  InvokeResponse,
} from "@diffdash/protocol/ipc"
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
  ): Promise<BridgeResult<InvokeResponse<Channel>>> => {
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

    let envelope
    try {
      assertJsonPayloadWithinBudget(rawResponse, InvokeContract[channel].maxResponseBytes, channel)
      envelope = Schema.decodeUnknownSync(bridgeResult(InvokeContract[channel].response))(
        rawResponse,
      )
    } catch (error) {
      return failureResult(
        decodeTransportError(toTransportFailure(error)) ??
          rendererTransportError("INVALID_RESPONSE", "Invalid response", channel),
      )
    }
    return envelope
  },

  subscribe: <Channel extends EventChannel>(
    channel: Channel,
    listener: (result: BridgeResult<EventPayload<Channel>>) => void,
  ) => {
    const wrapped = (_event: ElectronBoundaryValue, rawPayload: ElectronBoundaryValue) => {
      try {
        const payload = toRendererPayload(rawPayload)
        assertJsonPayloadWithinBudget(payload, EventContract[channel].maxPayloadBytes, channel)
        listener({
          _tag: "Success",
          value: Schema.decodeUnknownSync(EventContract[channel].payload)(payload),
        })
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

const failureResult = <Value>(error: ReturnType<typeof transportError>): BridgeResult<Value> => {
  return {
    _tag: "Failure",
    error: Schema.decodeUnknownSync(TransportErrorPayload)(
      Schema.encodeSync(TransportErrorCodec)(error),
    ),
  }
}

const toRendererPayload = <A>(value: A): RendererPayload => {
  if (Schema.is(Schema.Json)(value)) return value
  if (Predicate.isObjectOrArray(value)) return value
  if (Predicate.isBigInt(value) || Predicate.isSymbol(value)) return value
  return undefined
}

const toTransportFailure = <A>(value: A): Parameters<typeof decodeTransportError>[0] => {
  if (Schema.is(Schema.Json)(value)) return value
  if (Predicate.isObjectOrArray(value)) return value
  if (Predicate.isBigInt(value) || Predicate.isSymbol(value)) return value
  return undefined
}
