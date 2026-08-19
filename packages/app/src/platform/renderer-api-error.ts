import {
  decodeTransportError,
  TransportError,
  transportError,
  UNKNOWN_TRANSPORT_ERROR_MESSAGE,
} from "@diffdash/protocol/transport-error"
import { Cause, Effect, Match, Queue, Result, Schema, Stream } from "effect"

import type { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import {
  FailureEnvelope,
  eventPayloadSchema,
  invokeResponseSchema,
  type BridgeResult,
  type EventPayload,
  type InvokeResponse,
} from "@diffdash/protocol/ipc"
import { rendererFailureInput } from "@/shared/errors"

/** Typed renderer failure preserving the public transport diagnostics when they are available. */
export type RendererApiError = TransportError

/** Invokes one preload operation and restores its schema type after contextBridge cloning. */
export const invokePreload = <Channel extends InvokeChannel, Value>(
  channel: Channel,
  invoke: () => Promise<Value>,
): Effect.Effect<InvokeResponse<Channel>, RendererApiError> =>
  Effect.tryPromise({
    try: invoke,
    catch: (error) => rendererApiError(channel, error),
  }).pipe(
    Effect.flatMap((response) => {
      const decodedResult = Schema.decodeUnknownResult(boundaryBridgeResultSchema)(response)
      const decodedFailure = Schema.decodeUnknownResult(FailureEnvelope)(response)
      if (Result.isFailure(decodedResult) && Result.isSuccess(decodedFailure)) {
        return Effect.fail(
          transportError("INVALID_RESPONSE", `Invalid response for ${channel}`, channel),
        )
      }
      const result = Result.isSuccess(decodedResult)
        ? decodedResult.success
        : { _tag: "Success" as const, value: response }
      return Match.valueTags(result, {
        Failure: (failure) => {
          const error = decodeTransportError(rendererFailureInput(failure.error))
          return Effect.fail(
            error ?? transportError("INVALID_RESPONSE", `Invalid response for ${channel}`, channel),
          )
        },
        Success: (success) =>
          Schema.decodeUnknownEffect(typedInvokeResponseSchema(channel))(
            success.value === undefined ? null : success.value,
          ).pipe(
            Effect.mapError(() =>
              transportError("INVALID_RESPONSE", `Invalid response for ${channel}`, channel),
            ),
          ),
      })
    }),
  )

/** Invokes a preload-owned aggregate operation whose internal IPC response is not renderer-visible. */
export const invokePreloadVoid = (
  operation: string,
  invoke: () => Promise<BridgeResult<void>>,
): Effect.Effect<void, RendererApiError> =>
  Effect.tryPromise({
    try: invoke,
    catch: (error) => rendererApiError(operation, error),
  }).pipe(
    Effect.flatMap((response) => {
      const decoded = Schema.decodeUnknownResult(boundaryBridgeResultSchema)(response)
      if (Result.isFailure(decoded)) {
        return Effect.fail(
          transportError("INVALID_RESPONSE", `Invalid response for ${operation}`, operation),
        )
      }
      return Match.valueTags(decoded.success, {
        Failure: (failure) =>
          Effect.fail(
            decodeTransportError(rendererFailureInput(failure.error)) ??
              transportError("INVALID_RESPONSE", `Invalid response for ${operation}`, operation),
          ),
        Success: () => Effect.void,
      })
    }),
  )

/** Restores and scopes one callback-based preload event as a renderer-local stream. */
export const preloadEventStream = <Channel extends EventChannel>(
  channel: Channel,
  subscribe: (listener: (result: BridgeResult<EventPayload<Channel>>) => void) => () => void,
  initial?: Effect.Effect<EventPayload<Channel>, RendererApiError>,
): Stream.Stream<EventPayload<Channel>, RendererApiError> =>
  Stream.callback((queue) => {
    let initialized = initial === undefined
    const pending: EventPayload<Channel>[] = []
    const subscription = Effect.acquireRelease(
      Effect.sync(() => {
        const unsubscribe = subscribe((result) => {
          Match.valueTags(result, {
            Failure: (failure) =>
              Queue.failCauseUnsafe(
                queue,
                Cause.fail(
                  decodeTransportError(failure.error) ??
                    transportError("INVALID_EVENT", `Invalid event for ${channel}`, channel),
                ),
              ),
            Success: (success) => {
              const decoded = Schema.decodeUnknownResult(typedEventPayloadSchema(channel))(
                success.value,
              )
              if (Result.isFailure(decoded)) {
                Queue.failCauseUnsafe(
                  queue,
                  Cause.fail(
                    transportError("INVALID_EVENT", `Invalid event for ${channel}`, channel),
                  ),
                )
                return
              }
              if (initialized) Queue.offerUnsafe(queue, decoded.success)
              else pending.push(decoded.success)
            },
          })
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
export const rendererApiError = <Value>(operation: string, error: Value): RendererApiError => {
  const transport = decodeTransportError(rendererFailureInput(error))
  if (transport !== null) return transport
  return transportError("RENDERER_API_FAILURE", UNKNOWN_TRANSPORT_ERROR_MESSAGE, operation)
}

const typedInvokeResponseSchema = <Channel extends InvokeChannel>(channel: Channel) =>
  invokeResponseSchema(channel)

const typedEventPayloadSchema = <Channel extends EventChannel>(channel: Channel) =>
  eventPayloadSchema(channel)

const boundaryBridgeResultSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Success"), value: Schema.Any }),
  FailureEnvelope,
])
