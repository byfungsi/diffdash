import {
  decodeTransportError,
  TransportError,
  transportError,
  UNKNOWN_TRANSPORT_ERROR_MESSAGE,
} from "@diffdash/protocol/transport-error"
import { Cause, Effect, Queue, Result, Schema, Stream } from "effect"

import type { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import type {
  CodeWorkspaceFileStreamCancellation,
  CodeWorkspaceFileStreamCancellationRegistrar,
} from "@diffdash/protocol/code-workspace-stream"
import {
  bridgeResultSchema,
  eventPayloadSchema,
  invokeResponseSchema,
  type EventPayload,
  type InvokeResponse,
  type RendererBridgeResult,
} from "@diffdash/protocol/ipc"
import { rendererFailureInput } from "@/shared/errors"

/** Typed renderer failure preserving the public transport diagnostics when they are available. */
export type RendererApiError = TransportError

/** Invokes one preload operation and restores its schema type after contextBridge cloning. */
export const invokePreload = <Channel extends InvokeChannel, Value>(
  channel: Channel,
  invoke: () => Promise<Value>,
): Effect.Effect<InvokeResponse<Channel>, RendererApiError> =>
  invokePreloadCancelable(channel, () => invoke())

/** Invokes one preload operation and runs its registered cancellation on Effect interruption. */
export const invokePreloadCancelable = <Channel extends InvokeChannel, Value>(
  channel: Channel,
  invoke: (registerCancellation: CodeWorkspaceFileStreamCancellationRegistrar) => Promise<Value>,
): Effect.Effect<InvokeResponse<Channel>, RendererApiError> =>
  Effect.callback<InvokeResponse<Channel>, RendererApiError>((resume) => {
    let cancel: CodeWorkspaceFileStreamCancellation = () => undefined
    const registerCancellation: CodeWorkspaceFileStreamCancellationRegistrar = (current) => {
      cancel = current
    }
    try {
      void invoke(registerCancellation).then(
        (response) => resume(decodeInvokeResponse(channel, response)),
        (error) => resume(Effect.fail(rendererApiError(channel, error))),
      )
    } catch (error) {
      resume(Effect.fail(rendererApiError(channel, error)))
    }
    return Effect.sync(() => cancel())
  })

const decodeInvokeResponse = <Channel extends InvokeChannel, Value>(
  channel: Channel,
  response: Value,
): Effect.Effect<InvokeResponse<Channel>, RendererApiError> =>
  Schema.decodeUnknownEffect(boundaryBridgeResultSchema)(response).pipe(
    Effect.mapError(() => invalidRendererResponse(channel)),
    Effect.flatMap((result) =>
      boundaryBridgeResultSchema.match(result, {
        Failure: (failure) => {
          const error = decodeTransportError(rendererFailureInput(failure.error))
          return Effect.fail(error ?? invalidRendererResponse(channel))
        },
        Success: (success) =>
          Schema.decodeUnknownEffect(typedInvokeResponseSchema(channel))(success.value).pipe(
            Effect.mapError(() => invalidRendererResponse(channel)),
          ),
      }),
    ),
  )

/** Invokes a preload-owned aggregate operation whose internal IPC response is not renderer-visible. */
export const invokePreloadVoid = (
  operation: string,
  invoke: () => Promise<RendererBridgeResult<void>>,
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
      return boundaryBridgeResultSchema.match(decoded.success, {
        Failure: (failure) =>
          Effect.fail(
            decodeTransportError(rendererFailureInput(failure.error)) ??
              transportError("INVALID_RESPONSE", `Invalid response for ${operation}`, operation),
          ),
        Success: (success) =>
          Schema.decodeUnknownEffect(Schema.Null)(success.value).pipe(
            Effect.asVoid,
            Effect.mapError(() =>
              transportError(
                "INVALID_RESPONSE",
                `Preload aggregate response did not satisfy the renderer schema for ${operation}`,
                operation,
              ),
            ),
          ),
      })
    }),
  )

/** Restores and scopes one callback-based preload event as a renderer-local stream. */
export const preloadEventStream = <Channel extends EventChannel>(
  channel: Channel,
  subscribe: (
    listener: (result: RendererBridgeResult<EventPayload<Channel>>) => void,
  ) => () => void,
  initial?: Effect.Effect<EventPayload<Channel>, RendererApiError>,
): Stream.Stream<EventPayload<Channel>, RendererApiError> =>
  Stream.callback((queue) => {
    let initialized = initial === undefined
    const pending: EventPayload<Channel>[] = []
    const subscription = Effect.acquireRelease(
      Effect.sync(() => {
        const unsubscribe = subscribe((result) => {
          Result.match(decodePreloadEventResult(channel, result), {
            onFailure: (error) => Queue.failCauseUnsafe(queue, Cause.fail(error)),
            onSuccess: (value) => {
              if (initialized) Queue.offerUnsafe(queue, value)
              else pending.push(value)
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

/** Subscribes to one preload event after decoding its complete renderer boundary envelope. */
export const subscribePreloadEvent = <Channel extends EventChannel>(
  channel: Channel,
  subscribe: (
    listener: (result: RendererBridgeResult<EventPayload<Channel>>) => void,
  ) => () => void,
  listener: (event: EventPayload<Channel>) => void,
): (() => void) =>
  subscribe((result) => {
    Result.match(decodePreloadEventResult(channel, result), {
      onFailure: () => undefined,
      onSuccess: listener,
    })
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

const decodePreloadEventResult = <Channel extends EventChannel>(
  channel: Channel,
  result: RendererBridgeResult<EventPayload<Channel>>,
): Result.Result<EventPayload<Channel>, RendererApiError> => {
  const decodedEnvelope = Schema.decodeUnknownResult(boundaryBridgeResultSchema)(result)
  if (Result.isFailure(decodedEnvelope)) {
    return Result.fail(transportError("INVALID_EVENT", `Invalid event for ${channel}`, channel))
  }
  return boundaryBridgeResultSchema.match(decodedEnvelope.success, {
    Failure: (failure) =>
      Result.fail(
        decodeTransportError(failure.error) ??
          transportError("INVALID_EVENT", `Invalid event for ${channel}`, channel),
      ),
    Success: (success) =>
      Schema.decodeUnknownResult(typedEventPayloadSchema(channel))(success.value).pipe(
        Result.mapError(() =>
          transportError("INVALID_EVENT", `Invalid event for ${channel}`, channel),
        ),
      ),
  })
}

const invalidRendererResponse = (channel: InvokeChannel): RendererApiError =>
  transportError(
    "INVALID_RESPONSE",
    `Preload response did not satisfy the renderer schema for ${channel}`,
    channel,
  )

const boundaryBridgeResultSchema = bridgeResultSchema(Schema.Any)
