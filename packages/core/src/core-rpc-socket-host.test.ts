import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import {
  AuthenticatedCoreServerRpcs,
  CORE_RPC_INCOMPLETE_BUFFER_BYTES,
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
import { TempResources } from "@diffdash/process/temp-resource"
import { AppState } from "@diffdash/settings/app-state"
import { describe, expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Redacted, Scope } from "effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as Socket from "effect/unstable/socket/Socket"
import { chmodSync, statSync } from "node:fs"
import { createConnection, type Socket as NodeNetSocket } from "node:net"

import { CoreLifecycle, coreLifecycleLayer } from "./core-lifecycle"
import { coreRpcSocketHostLayer } from "./core-rpc-socket-host"
import { CoreAuthenticatedHostSession } from "./core-transport-authentication"

const identity = {
  applicationInstanceId: ApplicationInstanceId.make("app-socket"),
  processEpoch: CoreProcessEpoch.make("epoch-socket"),
} as const

const request = HostRequestContext.make({
  ...identity,
  requestId: HostRequestId.make("h:socket-health"),
})

const token = "private-socket-token-with-32-bytes"
const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const tempResourcesLayer = TempResources.layer.pipe(Layer.provide(platformLayer))

const makeClientProtocolLayer = (socketPath: string) => {
  const socketLayer = Layer.effect(
    Socket.Socket,
    NodeSocket.makeNet({ path: socketPath, openTimeout: "1 second" }),
  )
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(socketLayer),
    Layer.provide(
      RpcSerialization.layerMsgPackWith({
        useRecords: true,
        maxBufferSize: CORE_RPC_INCOMPLETE_BUFFER_BYTES,
      }),
    ),
  )
}

const makeClient = (socketPath: string, scope: Scope.Scope) =>
  Effect.gen(function* () {
    const context = yield* Layer.buildWithScope(makeClientProtocolLayer(socketPath), scope)
    return yield* RpcClient.make(AuthenticatedCoreServerRpcs).pipe(
      Effect.provide(context),
      Effect.provideService(Scope.Scope, scope),
    )
  })

const openRawSocket = (socketPath: string) =>
  Effect.acquireRelease(
    Effect.callback<NodeNetSocket, Error>((resume, signal) => {
      const socket = createConnection(socketPath)
      const onError = (error: Error) => resume(Effect.fail(error))
      signal.addEventListener("abort", () => socket.destroy(), { once: true })
      socket.once("error", onError)
      socket.once("connect", () => {
        socket.off("error", onError)
        resume(Effect.succeed(socket))
      })
    }),
    (socket) => Effect.sync(() => socket.destroy()),
  )

const awaitRawSocketClose = (socket: NodeNetSocket) =>
  socket.destroyed
    ? Effect.void
    : Effect.callback<void>((resume) => {
        socket.once("close", () => resume(Effect.void))
      })

describe("Core RPC Unix socket host", () => {
  it.effect("rejects a socket outside a private runtime directory before binding", () =>
    Effect.gen(function* () {
      const tempResources = yield* TempResources
      const runtimeDirectory = yield* tempResources.makeTempDirectoryScoped({ prefix: "dd-core-" })
      chmodSync(runtimeDirectory, 0o755)
      const failure = yield* Layer.build(
        coreRpcSocketHostLayer({
          socketPath: `${runtimeDirectory}/core.sock`,
          token: Redacted.make(token),
        }).pipe(
          Layer.provideMerge(coreLifecycleLayer(identity)),
          Layer.provideMerge(
            Layer.succeed(
              AppState,
              AppState.of({
                get: Effect.never,
                save: (state) => Effect.succeed(state),
              }),
            ),
          ),
          Layer.provideMerge(platformLayer),
        ),
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "CoreRpcSocketSecurityError",
        reason: "runtime-directory-not-private",
      })
    }).pipe(Effect.provide(tempResourcesLayer)),
  )

  it.effect("authenticates one host over a private native MessagePack socket", () =>
    Effect.gen(function* () {
      const tempResources = yield* TempResources
      const runtimeDirectory = yield* tempResources.makeTempDirectoryScoped({
        prefix: "dd-core-",
      })
      const socketPath = `${runtimeDirectory}/core.sock`
      const serverScope = yield* Scope.make()
      const requestStarted = yield* Deferred.make<void>()
      const requestInterrupted = yield* Deferred.make<void>()
      const appStateLayer = Layer.succeed(
        AppState,
        AppState.of({
          get: Deferred.succeed(requestStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(requestInterrupted, undefined)),
          ),
          save: (state) => Effect.succeed(state),
        }),
      )
      const hostLayer = coreRpcSocketHostLayer({
        socketPath,
        token: Redacted.make(token),
      }).pipe(
        Layer.provideMerge(coreLifecycleLayer(identity)),
        Layer.provideMerge(appStateLayer),
        Layer.provideMerge(platformLayer),
      )
      const serverContext = yield* Layer.buildWithScope(hostLayer, serverScope)

      expect(statSync(runtimeDirectory).mode & 0o777).toBe(0o700)
      expect(statSync(socketPath).mode & 0o777).toBe(0o600)

      // Exercise native MessagePack framing directly without introducing a DiffDash frame.
      const slowloris = yield* openRawSocket(socketPath)
      slowloris.write(Buffer.from([0xdb, 0x00, 0x10, 0x00, 0x00]))
      const malformed = yield* openRawSocket(socketPath)
      malformed.write(Buffer.from([0xc1]))
      const excessive = yield* openRawSocket(socketPath)
      const excessiveClosed = yield* awaitRawSocketClose(excessive).pipe(Effect.forkScoped)
      excessive.write(Buffer.from([0xdb, 0x00, 0x10, 0x00, 0x00]))
      excessive.write(Buffer.alloc(CORE_RPC_INCOMPLETE_BUFFER_BYTES + 1, 0x61))
      yield* Fiber.join(excessiveClosed)

      const firstClientScope = yield* Scope.make()
      const firstClient = yield* makeClient(socketPath, firstClientScope)
      const health = yield* firstClient["Core.health"](request).pipe(
        RpcClient.withHeaders({ [CORE_TRANSPORT_TOKEN_HEADER]: token }),
      )
      expect(health).toEqual({ ...identity, lifecycle: "awaitingOwnership" })
      const staleHealth = yield* firstClient["Core.health"](
        HostRequestContext.make({
          ...request,
          processEpoch: CoreProcessEpoch.make("epoch-stale"),
        }),
      ).pipe(Effect.flip)
      expect(staleHealth).toMatchObject({ code: "CORE_REQUEST_IDENTITY_MISMATCH" })
      const authorization = AuthorizeDatabaseOwnershipRequest.make({
        ...request,
        authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-socket"),
      })
      yield* firstClient["Core.authorizeDatabaseOwnership"](authorization)
      expect(yield* firstClient["Core.authorizeDatabaseOwnership"](authorization)).toMatchObject({
        lifecycle: "recovering",
      })
      const lifecycle = Context.get(serverContext, CoreLifecycle)
      yield* lifecycle.completeRecovery
      yield* lifecycle.completeRecovery
      const requestFiber = yield* firstClient["AppState.get"](request).pipe(Effect.forkScoped)
      yield* Deferred.await(requestStarted)
      yield* Scope.close(firstClientScope, Exit.void)
      yield* Deferred.await(requestInterrupted)
      yield* Context.get(serverContext, CoreAuthenticatedHostSession).awaitDeath
      yield* Fiber.interrupt(requestFiber)

      const secondClientScope = yield* Scope.make()
      const secondClient = yield* makeClient(socketPath, secondClientScope)
      const rejected = yield* secondClient["Core.health"](request).pipe(
        RpcClient.withHeaders({ [CORE_TRANSPORT_TOKEN_HEADER]: token }),
        Effect.flip,
      )
      expect(rejected).toMatchObject({
        _tag: "CoreTransportAuthenticationFailure",
        code: "CORE_TRANSPORT_AUTHENTICATION_FAILED",
      })
      expect(JSON.stringify(rejected)).not.toContain(token)
      expect(JSON.stringify(rejected)).not.toContain(socketPath)

      yield* Scope.close(secondClientScope, Exit.void)
      yield* Scope.close(serverScope, Exit.void)
    }).pipe(Effect.provide(tempResourcesLayer)),
  )
})
