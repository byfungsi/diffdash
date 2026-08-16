import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import {
  AuthenticatedCoreWalkthroughServerRpcs,
  CORE_RPC_INCOMPLETE_BUFFER_BYTES,
  CORE_RPC_IN_FLIGHT_BYTES,
  CORE_RPC_MAX_CONCURRENCY,
} from "@diffdash/core-rpc/transport"
import { getCoreRpcMethodPolicy, type CoreRpcMethodPolicy } from "@diffdash/core-rpc/method-policy"
import {
  CancelWalkthroughRequest,
  GetStoredWalkthroughRequest,
  GetWalkthroughOperationRequest,
  StartWalkthroughRequest,
  WalkthroughCancelAdmissionFailure,
  WalkthroughGetOperationAdmissionFailure,
  WalkthroughGetStoredAdmissionFailure,
  WalkthroughStartAdmissionFailure,
} from "@diffdash/core-rpc/walkthrough"
import { Effect, FileSystem, Layer, Match, Path, Predicate, Queue, Redacted, Schema } from "effect"
import { Option, Result } from "effect"
import * as RpcMessage from "effect/unstable/rpc/RpcMessage"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import * as SocketServer from "effect/unstable/socket/SocketServer"

import {
  coreApplicationRpcServerLayer,
  coreRpcServerLayer,
  coreWalkthroughRpcServerLayer,
} from "./core-rpc-server"
import {
  CoreAuthenticatedHostSession,
  coreAuthenticatedHostSessionLayer,
  type CoreTransportAuthenticationOptions,
} from "./core-transport-authentication"

const coreRpcSerializationLayer = RpcSerialization.layerMsgPackWith({
  useRecords: true,
  maxBufferSize: CORE_RPC_INCOMPLETE_BUFFER_BYTES,
})

/** Native Unix socket endpoint configuration for one Core process epoch. */
export interface CoreRpcSocketHostOptions extends CoreTransportAuthenticationOptions {
  readonly socketPath: string
}

/** Fail-closed rejection for a socket endpoint outside a private runtime directory. */
export class CoreRpcSocketSecurityError extends Schema.TaggedError<CoreRpcSocketSecurityError>()(
  "CoreRpcSocketSecurityError",
  {
    reason: Schema.Literals([
      "runtime-directory-not-private",
      "socket-path-too-long",
      "transport-token-too-short",
    ]),
  },
) {}

const walkthroughReservationKey = (clientId: number, requestId: string | number) =>
  `${String(clientId)}:${Predicate.isString(requestId) ? "string" : "number"}:${String(requestId)}`

const encodedBytes = (parser: RpcSerialization.Parser, value: RpcMessage.FromServerEncoded) => {
  const encoded = parser.encode(value)
  if (encoded === undefined) return 0
  return Predicate.isString(encoded) ? Buffer.byteLength(encoded) : encoded.byteLength
}

const encodedRequestPayloadBytes = (
  parser: RpcSerialization.Parser,
  request: RpcMessage.RequestEncoded,
) => {
  const encoded = parser.encode(request.payload)
  if (encoded === undefined) return 0
  return Predicate.isString(encoded) ? Buffer.byteLength(encoded) : encoded.byteLength
}

const encodedSuccessBytes = (
  parser: RpcSerialization.Parser,
  response: RpcMessage.FromServerEncoded,
) =>
  Match.valueTags(response, {
    Chunk: () => 0,
    Exit: ({ exit }) =>
      Match.valueTags(exit, {
        Failure: () => 0,
        Success: ({ value }) => {
          const encoded = parser.encode(value)
          if (encoded === undefined) return 0
          return Predicate.isString(encoded) ? Buffer.byteLength(encoded) : encoded.byteLength
        },
      }),
    Defect: () => 0,
    Pong: () => 0,
    ClientProtocolError: () => 0,
  })

interface WalkthroughRequestReservation {
  readonly policy: CoreRpcMethodPolicy
  readonly request: RpcMessage.RequestEncoded
}

/** Runs Core RPC over one private native Unix domain socket. */
const coreRpcSocketProtocolLayer = (options: CoreRpcSocketHostOptions) => {
  const socketServerLayer = Layer.effect(
    SocketServer.SocketServer,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* Effect.succeed(options).pipe(
        Effect.filterOrFail(
          ({ token }) => Buffer.byteLength(Redacted.value(token)) >= 32,
          () => CoreRpcSocketSecurityError.make({ reason: "transport-token-too-short" }),
        ),
        Effect.filterOrFail(
          ({ socketPath }) => Buffer.byteLength(socketPath) <= 103,
          () => CoreRpcSocketSecurityError.make({ reason: "socket-path-too-long" }),
        ),
      )
      const runtimeDirectory = path.dirname(options.socketPath)
      yield* fileSystem.stat(runtimeDirectory).pipe(
        Effect.filterOrFail(
          (info) => info.type === "Directory" && (info.mode & 0o777) === 0o700,
          () =>
            CoreRpcSocketSecurityError.make({
              reason: "runtime-directory-not-private",
            }),
        ),
      )
      const server = yield* NodeSocketServer.make({ path: options.socketPath })
      yield* fileSystem.chmod(options.socketPath, 0o600)
      return server
    }),
  )
  const protocolLayer = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide(socketServerLayer),
    Layer.provideMerge(coreRpcSerializationLayer),
  )

  return protocolLayer
}

const hostDeathAwareProtocolLayer = (
  options: CoreRpcSocketHostOptions,
  hostSessionLayer: Layer.Layer<CoreAuthenticatedHostSession>,
) =>
  Layer.effect(
    RpcServer.Protocol,
    Effect.gen(function* () {
      const protocol = yield* RpcServer.Protocol
      const hostSession = yield* CoreAuthenticatedHostSession
      const disconnects = yield* Queue.unbounded<number>()
      yield* Effect.forever(
        Queue.take(protocol.disconnects).pipe(
          Effect.tap((clientId) => hostSession.disconnected(clientId)),
          Effect.flatMap((clientId) => Queue.offer(disconnects, clientId)),
        ),
      ).pipe(Effect.forkScoped)
      return RpcServer.Protocol.of({ ...protocol, disconnects })
    }),
  ).pipe(
    Layer.provide(coreRpcSocketProtocolLayer(options)),
    Layer.provideMerge(hostSessionLayer),
    Layer.provideMerge(coreRpcSerializationLayer),
  )

/** Applies walkthrough request, response, concurrency, and disconnect bounds to an RPC protocol. */
export const makeBoundedWalkthroughProtocol = Effect.fn("CoreRpc.makeBoundedWalkthroughProtocol")(
  function* () {
    const protocol = yield* RpcServer.Protocol
    const serialization = yield* RpcSerialization.RpcSerialization
    const reservations = new Map<string, WalkthroughRequestReservation>()
    const disconnects = yield* Queue.unbounded<number>()
    const releaseClient = (clientId: number) => {
      const prefix = `${String(clientId)}:`
      for (const key of reservations.keys()) {
        if (key.startsWith(prefix)) reservations.delete(key)
      }
    }
    const frameFailure = (requestId: string | number, message: string) => {
      const correlated = RpcMessage.ResponseExitDieEncoded({
        requestId: RpcMessage.RequestId(requestId),
        defect: message,
      })
      return encodedBytes(serialization.makeUnsafe(), correlated) <=
        CORE_RPC_INCOMPLETE_BUFFER_BYTES
        ? correlated
        : RpcMessage.ResponseDefectEncoded("Core RPC frame budget exceeded.")
    }
    const admissionFailure = (
      request: RpcMessage.RequestEncoded,
      code: "REQUEST_TOO_LARGE" | "RESPONSE_TOO_LARGE",
    ): RpcMessage.FromServerEncoded => {
      const detail = {
        _tag: "WalkthroughPublicFailure" as const,
        code,
        providerId: null,
        modelId: null,
        retryClass: "notRetryable" as const,
        remediation: "none" as const,
        safeMessage:
          code === "REQUEST_TOO_LARGE"
            ? "The walkthrough request exceeded its size limit."
            : "The walkthrough response exceeded its size limit.",
        attempts: [],
        diagnostic: null,
      }
      const decoded = Match.value(request.tag).pipe(
        Match.when("Walkthroughs.start", () =>
          Schema.decodeUnknownResult(StartWalkthroughRequest)(request.payload).pipe(
            Result.map((payload) =>
              WalkthroughStartAdmissionFailure.make({
                ...detail,
                applicationInstanceId: payload.applicationInstanceId,
                processEpoch: payload.processEpoch,
                requestId: payload.requestId,
                method: "Walkthroughs.start",
                operationId: null,
              }),
            ),
          ),
        ),
        Match.when("Walkthroughs.getOperation", () =>
          Schema.decodeUnknownResult(GetWalkthroughOperationRequest)(request.payload).pipe(
            Result.map((payload) =>
              WalkthroughGetOperationAdmissionFailure.make({
                ...detail,
                applicationInstanceId: payload.applicationInstanceId,
                processEpoch: payload.processEpoch,
                requestId: payload.requestId,
                method: "Walkthroughs.getOperation",
                operationId: payload.operationId,
              }),
            ),
          ),
        ),
        Match.when("Walkthroughs.cancel", () =>
          Schema.decodeUnknownResult(CancelWalkthroughRequest)(request.payload).pipe(
            Result.map((payload) =>
              WalkthroughCancelAdmissionFailure.make({
                ...detail,
                applicationInstanceId: payload.applicationInstanceId,
                processEpoch: payload.processEpoch,
                requestId: payload.requestId,
                method: "Walkthroughs.cancel",
                operationId: payload.operationId,
              }),
            ),
          ),
        ),
        Match.when("Walkthroughs.getStored", () =>
          Schema.decodeUnknownResult(GetStoredWalkthroughRequest)(request.payload).pipe(
            Result.map((payload) =>
              WalkthroughGetStoredAdmissionFailure.make({
                ...detail,
                applicationInstanceId: payload.applicationInstanceId,
                processEpoch: payload.processEpoch,
                requestId: payload.requestId,
                method: "Walkthroughs.getStored",
                operationId: null,
              }),
            ),
          ),
        ),
        Match.orElse(() => Result.fail("Unsupported walkthrough request.")),
      )
      if (Result.isFailure(decoded)) {
        return frameFailure(request.id, "Core RPC rejected an invalid bounded request.")
      }
      return {
        _tag: "Exit",
        requestId: request.id,
        exit: {
          _tag: "Failure",
          cause: [{ _tag: "Fail", error: decoded.success }],
        },
      }
    }
    yield* Effect.forever(
      Queue.take(protocol.disconnects).pipe(
        Effect.tap((clientId) => Effect.sync(() => releaseClient(clientId))),
        Effect.flatMap((clientId) => Queue.offer(disconnects, clientId)),
      ),
    ).pipe(Effect.forkScoped)

    return RpcServer.Protocol.of({
      ...protocol,
      disconnects,
      run: (handler) =>
        protocol.run((clientId, message) =>
          Match.valueTags(message, {
            Request: (request) =>
              Effect.suspend(() => {
                const key = walkthroughReservationKey(clientId, request.id)
                const declaration = AuthenticatedCoreWalkthroughServerRpcs.requests.get(request.tag)
                const policy =
                  declaration === undefined
                    ? Option.none<CoreRpcMethodPolicy>()
                    : getCoreRpcMethodPolicy(declaration)
                if (reservations.has(key)) {
                  return protocol.send(
                    clientId,
                    frameFailure(request.id, "Core RPC rejected a duplicate live request ID."),
                  )
                }
                if (
                  Option.isSome(policy) &&
                  encodedRequestPayloadBytes(serialization.makeUnsafe(), request) >
                    policy.value.maxRequestBytes
                ) {
                  return protocol.send(clientId, admissionFailure(request, "REQUEST_TOO_LARGE"))
                }
                if (
                  reservations.size >= CORE_RPC_MAX_CONCURRENCY ||
                  (reservations.size + 1) * CORE_RPC_INCOMPLETE_BUFFER_BYTES >
                    CORE_RPC_IN_FLIGHT_BYTES
                ) {
                  return protocol.send(
                    clientId,
                    frameFailure(request.id, "Core RPC capacity exceeded."),
                  )
                }
                if (Option.isSome(policy)) {
                  reservations.set(key, { policy: policy.value, request })
                }
                return handler(clientId, request)
              }),
            Ack: (acknowledgement) => handler(clientId, acknowledgement),
            Interrupt: (interrupt) => handler(clientId, interrupt),
            Ping: (ping) => handler(clientId, ping),
            Eof: (eof) => handler(clientId, eof),
          }),
        ),
      send: (clientId, response, transferables) =>
        Effect.suspend(() => {
          const reservation = Match.valueTags(response, {
            Chunk: () => undefined,
            Exit: ({ requestId }) =>
              reservations.get(walkthroughReservationKey(clientId, requestId)),
            Defect: () => undefined,
            Pong: () => undefined,
            ClientProtocolError: () => undefined,
          })
          const boundedResponse =
            reservation !== undefined &&
            encodedSuccessBytes(serialization.makeUnsafe(), response) >
              reservation.policy.maxResponseBytes
              ? admissionFailure(reservation.request, "RESPONSE_TOO_LARGE")
              : encodedBytes(serialization.makeUnsafe(), response) <=
                  CORE_RPC_INCOMPLETE_BUFFER_BYTES
                ? response
                : Match.valueTags(response, {
                    Chunk: ({ requestId }) =>
                      frameFailure(requestId, "Core RPC response exceeded its frame budget."),
                    Exit: ({ requestId }) =>
                      frameFailure(requestId, "Core RPC response exceeded its frame budget."),
                    Defect: () => RpcMessage.ResponseDefectEncoded("Core RPC response exceeded."),
                    Pong: () => response,
                    ClientProtocolError: () => response,
                  })
          return protocol.send(clientId, boundedResponse, transferables)
        }).pipe(
          Effect.ensuring(
            Effect.sync(() =>
              Match.valueTags(response, {
                Chunk: () => undefined,
                Exit: ({ requestId }) =>
                  reservations.delete(walkthroughReservationKey(clientId, requestId)),
                Defect: () => undefined,
                Pong: () => undefined,
                ClientProtocolError: () => undefined,
              }),
            ),
          ),
        ),
      end: (clientId) =>
        Effect.sync(() => releaseClient(clientId)).pipe(Effect.andThen(protocol.end(clientId))),
    })
  },
)

const boundedWalkthroughSocketProtocolLayer = (
  options: CoreRpcSocketHostOptions,
  hostSessionLayer: Layer.Layer<CoreAuthenticatedHostSession>,
) =>
  Layer.effect(RpcServer.Protocol, makeBoundedWalkthroughProtocol()).pipe(
    Layer.provide(hostDeathAwareProtocolLayer(options, hostSessionLayer)),
  )

/** Runs the currently deployed control and AppState RPC audience over a private native socket. */
export const coreRpcSocketHostLayer = (options: CoreRpcSocketHostOptions) => {
  const hostSessionLayer = coreAuthenticatedHostSessionLayer
  return coreRpcServerLayer(options, hostSessionLayer).pipe(
    Layer.provideMerge(hostDeathAwareProtocolLayer(options, hostSessionLayer)),
  )
}

/** Runs the aggregate authenticated production catalog over one private native socket. */
export const coreApplicationRpcSocketHostLayer = (options: CoreRpcSocketHostOptions) => {
  const hostSessionLayer = coreAuthenticatedHostSessionLayer
  return coreApplicationRpcServerLayer(options, hostSessionLayer).pipe(
    Layer.provideMerge(hostDeathAwareProtocolLayer(options, hostSessionLayer)),
  )
}

/** Runs the durable walkthrough RPC audience when its business runtime is composed. */
export const coreWalkthroughRpcSocketHostLayer = (options: CoreRpcSocketHostOptions) => {
  const hostSessionLayer = coreAuthenticatedHostSessionLayer
  return coreWalkthroughRpcServerLayer(options, hostSessionLayer).pipe(
    Layer.provideMerge(boundedWalkthroughSocketProtocolLayer(options, hostSessionLayer)),
  )
}
