import {
  eventPayloadSchema,
  FailureEnvelope,
  invokeRequestSchema,
  invokeResponseSchema,
  successEnvelope,
} from "@diffdash/protocol/ipc"
import type { EventPayload, InvokeRequest, InvokeResponse } from "@diffdash/protocol/ipc"
import type { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import { transportError } from "@diffdash/protocol/transport-error"
import { Schema } from "effect"

/** Narrow ipcRenderer surface consumed by the schema-validated preload transport. */
export interface RendererIpc {
  readonly invoke: (channel: string, request: unknown) => Promise<unknown>
  readonly on: (channel: string, listener: (event: unknown, payload: unknown) => void) => void
  readonly removeListener: (
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ) => void
}

/** Creates the renderer side of the protocol transport without exposing Electron primitives. */
export const createRendererTransport = (ipc: RendererIpc) => ({
  invoke: async <Channel extends InvokeChannel>(
    channel: Channel,
    request: InvokeRequest<Channel>,
  ): Promise<InvokeResponse<Channel>> => {
    let encodedRequest: unknown
    try {
      encodedRequest = Schema.encodeUnknownSync(invokeRequestSchema(channel))(request)
    } catch {
      throw rendererTransportError("INVALID_REQUEST", "Invalid request", channel)
    }

    let rawResponse: unknown
    try {
      rawResponse = await ipc.invoke(channel, encodedRequest)
    } catch (cause) {
      throw rendererTransportError("IPC_FAILURE", ipcErrorMessage(cause), channel)
    }

    let envelope
    try {
      envelope = Schema.decodeUnknownSync(
        Schema.Union(successEnvelope(invokeResponseSchema(channel)), FailureEnvelope),
      )(rawResponse)
    } catch {
      throw rendererTransportError("INVALID_RESPONSE", "Invalid response", channel)
    }
    if (envelope["_tag"] === "Failure") {
      throw rendererTransportError(
        envelope.error.code,
        envelope.error.message,
        channel,
        envelope.error.operation,
      )
    }
    return envelope.value
  },

  subscribe: <Channel extends EventChannel>(
    channel: Channel,
    listener: (payload: EventPayload<Channel>) => void,
  ) => {
    const wrapped = (_event: unknown, rawPayload: unknown) => {
      try {
        listener(Schema.decodeUnknownSync(eventPayloadSchema(channel))(rawPayload))
      } catch {
        // Invalid host events are isolated from renderer state and future subscriptions.
      }
    }
    ipc.on(channel, wrapped)
    return () => ipc.removeListener(channel, wrapped)
  },
})

const ipcErrorMessage = (cause: unknown) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause)

const rendererTransportError = (
  code: string,
  message: string,
  channel: InvokeChannel,
  operation: string = channel,
) => transportError(code, `${channel} failed: ${message}`, operation)
