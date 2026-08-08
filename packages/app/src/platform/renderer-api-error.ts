import {
  decodeTransportError,
  TransportError,
  transportError,
  UNKNOWN_TRANSPORT_ERROR_MESSAGE,
} from "@diffdash/protocol/transport-error"
import { Effect, Either, Schema, Stream } from "effect"

import type { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import {
  eventPayloadSchema,
  invokeResponseSchema,
  type EventPayload,
  type InvokeResponse,
} from "@diffdash/protocol/ipc"

/** Typed renderer failure preserving the public transport diagnostics when they are available. */
export type RendererApiError = TransportError

/** Invokes one preload operation and restores its schema type after contextBridge cloning. */
export const invokePreload = <Channel extends InvokeChannel>(
  channel: Channel,
  invoke: () => Promise<unknown>,
): Effect.Effect<InvokeResponse<Channel>, RendererApiError> =>
  Effect.tryPromise({
    try: invoke,
    catch: (error) => rendererApiError(channel, error),
  }).pipe(
    Effect.flatMap((response) =>
      Schema.decodeUnknown(invokeResponseSchema(channel))(
        response === undefined ? null : response,
      ).pipe(
        Effect.mapError(() =>
          transportError("INVALID_RESPONSE", `Invalid response for ${channel}`, channel),
        ),
      ),
    ),
  )

/** Restores and scopes one callback-based preload event as a renderer-local stream. */
export const preloadEventStream = <Channel extends EventChannel>(
  channel: Channel,
  subscribe: (listener: (payload: unknown) => void) => () => void,
): Stream.Stream<EventPayload<Channel>, RendererApiError> =>
  Stream.asyncScoped((emit) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        subscribe((payload) => {
          const decoded = Schema.decodeUnknownEither(eventPayloadSchema(channel))(payload)
          if (Either.isLeft(decoded)) {
            void emit.fail(transportError("INVALID_EVENT", `Invalid event for ${channel}`, channel))
            return
          }
          void emit.single(decoded.right)
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  )

/** Converts an unknown rejected preload Promise into a stable renderer failure. */
export const rendererApiError = (operation: string, error: unknown): RendererApiError => {
  const transport = decodeTransportError(error)
  if (transport !== null) return transport
  return transportError("RENDERER_API_FAILURE", UNKNOWN_TRANSPORT_ERROR_MESSAGE, operation)
}
