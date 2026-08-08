import {
  decodeTransportError,
  TransportError,
  transportError,
  UNKNOWN_TRANSPORT_ERROR_MESSAGE,
} from "@diffdash/protocol/transport-error"
import { Cause, Effect, Queue, Result, Schema, Stream } from "effect"

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
      Schema.decodeUnknownEffect(typedInvokeResponseSchema(channel))(
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
  initial?: Effect.Effect<EventPayload<Channel>, RendererApiError>,
): Stream.Stream<EventPayload<Channel>, RendererApiError> =>
  Stream.callback((queue) => {
    let initialized = initial === undefined
    const pending: EventPayload<Channel>[] = []
    const subscription = Effect.acquireRelease(
      Effect.sync(() => {
        const unsubscribe = subscribe((payload) => {
          const decoded = Schema.decodeUnknownResult(typedEventPayloadSchema(channel))(payload)
          if (Result.isFailure(decoded)) {
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(transportError("INVALID_EVENT", `Invalid event for ${channel}`, channel)),
            )
            return
          }
          if (initialized) Queue.offerUnsafe(queue, decoded.success)
          else pending.push(decoded.success)
        })
        return unsubscribe
      }),
      (unsubscribe) => Effect.sync(unsubscribe),
    )
    if (initial === undefined) return subscription
    return subscription.pipe(
      Effect.tap(() =>
        initial.pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              Queue.offerUnsafe(queue, value)
              initialized = true
              for (const pendingValue of pending) Queue.offerUnsafe(queue, pendingValue)
              pending.length = 0
            }),
          ),
        ),
      ),
    )
  })

/** Converts an unknown rejected preload Promise into a stable renderer failure. */
export const rendererApiError = (operation: string, error: unknown): RendererApiError => {
  const transport = decodeTransportError(error)
  if (transport !== null) return transport
  return transportError("RENDERER_API_FAILURE", UNKNOWN_TRANSPORT_ERROR_MESSAGE, operation)
}

const typedInvokeResponseSchema = <Channel extends InvokeChannel>(channel: Channel) =>
  // SAFETY: The protocol registry indexes each channel to the schema defining InvokeResponse<Channel>.
  invokeResponseSchema(channel) as Schema.Codec<InvokeResponse<Channel>, unknown>

const typedEventPayloadSchema = <Channel extends EventChannel>(channel: Channel) =>
  // SAFETY: The protocol registry indexes each channel to the schema defining EventPayload<Channel>.
  eventPayloadSchema(channel) as Schema.Codec<EventPayload<Channel>, unknown>
