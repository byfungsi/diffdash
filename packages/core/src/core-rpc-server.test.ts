import {
  AuthenticatedCoreServerRpcs,
  CORE_TRANSPORT_TOKEN_HEADER,
} from "@diffdash/core-rpc/transport"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  DatabaseOwnershipAuthorizationId,
  HostRequestContext,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import { AuthorizeDatabaseOwnershipRequest } from "@diffdash/core-rpc/lifecycle"
import { AppState as SharedAppState } from "@diffdash/domain/app-state"
import { AppState } from "@diffdash/settings/app-state"
import { describe, expect, it } from "@effect/vitest"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Redacted,
  Ref,
  Scope,
} from "effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import type { FromClientEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"

import { CoreLifecycle, coreLifecycleLayer } from "./core-lifecycle"
import { coreRpcServerLayer } from "./core-rpc-server"

const CoreServerRpcs = AuthenticatedCoreServerRpcs

const identity = {
  applicationInstanceId: ApplicationInstanceId.make("app-1"),
  processEpoch: CoreProcessEpoch.make("epoch-1"),
} as const

const request = HostRequestContext.make({
  ...identity,
  requestId: HostRequestId.make("h:request-1"),
})

const authorizationRequest = AuthorizeDatabaseOwnershipRequest.make({
  ...request,
  authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-1"),
})

const state = SharedAppState.make({ onboardingCompleted: true })
const transportToken = "test-core-transport-token-32-bytes"

const authenticated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  RpcClient.withHeaders(effect, { [CORE_TRANSPORT_TOKEN_HEADER]: transportToken })

const roundtrip = <Message>(
  parser: RpcSerialization.Parser,
  message: Message,
): ReadonlyArray<Message> => {
  const encoded = parser.encode(message)
  if (encoded === undefined) return []
  // SAFETY: This test encodes a native Effect RPC message and immediately decodes the same bytes
  // with an isolated parser for the same direction; RpcClient and RpcServer validate method payloads
  // and exits before exposing them to handlers or callers.
  return parser.decode(encoded) as ReadonlyArray<Message>
}

const protocolPairLayer = Layer.effectContext(
  Effect.gen(function* () {
    const serialization = RpcSerialization.makeMsgPack({ maxBufferSize: 4_096 })
    const clientParser = serialization.makeUnsafe()
    const serverParser = serialization.makeUnsafe()
    const serverInbound =
      yield* Deferred.make<(clientId: number, message: FromClientEncoded) => Effect.Effect<void>>()
    const clientInbound =
      yield* Deferred.make<(clientId: number, message: FromServerEncoded) => Effect.Effect<void>>()
    const disconnects = yield* Queue.unbounded<number>()

    const clientProtocol = yield* RpcClient.Protocol.make((writeResponse) =>
      Deferred.succeed(clientInbound, writeResponse).pipe(
        Effect.as({
          send: (clientId, message) =>
            Deferred.await(serverInbound).pipe(
              Effect.flatMap((writeRequest) =>
                Effect.forEach(
                  roundtrip<FromClientEncoded>(serverParser, message),
                  (decoded) => writeRequest(clientId, decoded),
                  { discard: true },
                ),
              ),
            ),
          supportsAck: true,
          supportsTransferables: false,
        }),
      ),
    )
    const serverProtocol = yield* RpcServer.Protocol.make((writeRequest) =>
      Deferred.succeed(serverInbound, writeRequest).pipe(
        Effect.as({
          disconnects,
          send: (clientId, message) =>
            Deferred.await(clientInbound).pipe(
              Effect.flatMap((writeResponse) =>
                Effect.forEach(
                  roundtrip<FromServerEncoded>(clientParser, message),
                  (decoded) => writeResponse(clientId, decoded),
                  { discard: true },
                ),
              ),
            ),
          end: (clientId) => Queue.offer(disconnects, clientId).pipe(Effect.asVoid),
          clientIds: Effect.succeed(new Set([0])),
          initialMessage: Effect.succeed(Option.none()),
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: false,
        }),
      ),
    )

    return Context.empty().pipe(
      Context.add(RpcClient.Protocol, clientProtocol),
      Context.add(RpcServer.Protocol, serverProtocol),
    )
  }),
)

const makeTestLayer = (get: Effect.Effect<SharedAppState>) => {
  const lifecycleLayer = coreLifecycleLayer(identity)
  const appStateLayer = Layer.succeed(
    AppState,
    AppState.of({
      get,
      save: (next) => Effect.succeed(next),
    }),
  )
  const dependenciesLayer = Layer.mergeAll(lifecycleLayer, appStateLayer, protocolPairLayer)

  return coreRpcServerLayer({ token: Redacted.make(transportToken) }).pipe(
    Layer.provideMerge(dependenciesLayer),
  )
}

describe("Core RPC server", () => {
  it.effect("requires health before ownership authorization", () =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(CoreServerRpcs)
      const rejected = yield* authenticated(
        client["Core.authorizeDatabaseOwnership"](authorizationRequest),
      ).pipe(Effect.flip)

      expect(rejected).toMatchObject({
        _tag: "CoreTransportAuthenticationFailure",
        code: "CORE_TRANSPORT_AUTHENTICATION_FAILED",
      })
      expect(yield* authenticated(client["Core.health"](request))).toMatchObject({
        lifecycle: "awaitingOwnership",
      })
    }).pipe(Effect.provide(makeTestLayer(Effect.succeed(state)))),
  )

  it.effect("rejects an invalid transport token without consuming the valid credential", () =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(CoreServerRpcs)
      const rejected = yield* RpcClient.withHeaders(client["Core.health"](request), {
        [CORE_TRANSPORT_TOKEN_HEADER]: "wrong-token",
      }).pipe(Effect.flip)

      expect(rejected).toEqual({
        _tag: "CoreTransportAuthenticationFailure",
        code: "CORE_TRANSPORT_AUTHENTICATION_FAILED",
        retryClass: "notRetryable",
        safeMessage: "DiffDash Core rejected an unauthenticated host connection.",
      })
      expect(yield* authenticated(client["Core.health"](request))).toMatchObject({
        ...identity,
        lifecycle: "awaitingOwnership",
      })
    }).pipe(Effect.provide(makeTestLayer(Effect.succeed(state)))),
  )

  it.effect("shares lifecycle state across serialized control and business RPC", () =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(CoreServerRpcs)

      expect(yield* authenticated(client["Core.health"](request))).toEqual({
        ...identity,
        lifecycle: "awaitingOwnership",
      })
      const rejected = yield* authenticated(client["AppState.get"](request)).pipe(Effect.flip)
      expect(rejected).toMatchObject({
        _tag: "CoreLifecycleRejectedFailure",
        lifecycle: "awaitingOwnership",
      })

      const lifecycle = yield* CoreLifecycle
      yield* authenticated(client["Core.authorizeDatabaseOwnership"](authorizationRequest))
      expect(yield* authenticated(client["Core.health"](request))).toMatchObject({
        lifecycle: "recovering",
      })
      yield* lifecycle.completeRecovery

      expect(yield* authenticated(client["AppState.get"](request))).toEqual(state)
    }).pipe(Effect.provide(makeTestLayer(Effect.succeed(state)))),
  )

  it.effect("rejects a stale epoch before serialized business work reaches storage", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0)
      const testLayer = makeTestLayer(
        Ref.update(reads, (count) => count + 1).pipe(Effect.as(state)),
      )

      return yield* Effect.gen(function* () {
        const client = yield* RpcClient.make(CoreServerRpcs)
        yield* authenticated(client["Core.health"](request))
        const staleRequest = HostRequestContext.make({
          ...request,
          processEpoch: CoreProcessEpoch.make("epoch-stale"),
        })
        const failure = yield* authenticated(client["AppState.get"](staleRequest)).pipe(Effect.flip)

        expect(failure).toMatchObject({
          _tag: "CoreIdentityMismatchFailure",
          ...identity,
        })
        expect(yield* Ref.get(reads)).toBe(0)
      }).pipe(Effect.provide(testLayer))
    }),
  )

  it.effect("interrupts admitted business work when serialized shutdown begins", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const testLayer = makeTestLayer(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      )

      return yield* Effect.gen(function* () {
        const lifecycle = yield* CoreLifecycle
        const client = yield* RpcClient.make(CoreServerRpcs)
        yield* authenticated(client["Core.health"](request))
        yield* authenticated(client["Core.authorizeDatabaseOwnership"](authorizationRequest))
        yield* lifecycle.completeRecovery

        const requestFiber = yield* authenticated(client["AppState.get"](request)).pipe(
          Effect.forkScoped,
        )
        yield* Deferred.await(started)
        expect(yield* authenticated(client["Core.shutdown"](request))).toMatchObject({
          lifecycle: "draining",
        })
        yield* Deferred.await(interrupted)
        yield* Fiber.interrupt(requestFiber)
      }).pipe(Effect.provide(testLayer))
    }),
  )

  it.effect("interrupts active requests when the composed server scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const serverScope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(
        makeTestLayer(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        ),
        serverScope,
      )
      const client = yield* RpcClient.make(CoreServerRpcs).pipe(Effect.provide(context))
      const lifecycle = Context.get(context, CoreLifecycle)
      yield* authenticated(client["Core.health"](request))
      yield* authenticated(client["Core.authorizeDatabaseOwnership"](authorizationRequest))
      yield* lifecycle.completeRecovery
      const requestFiber = yield* authenticated(client["AppState.get"](request)).pipe(
        Effect.forkScoped,
      )
      yield* Deferred.await(started)

      yield* Scope.close(serverScope, Exit.void)
      yield* Deferred.await(interrupted)
      yield* Fiber.interrupt(requestFiber)
    }),
  )
})
