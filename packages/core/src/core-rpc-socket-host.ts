import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { CORE_RPC_INCOMPLETE_BUFFER_BYTES } from "@diffdash/core-rpc/transport"
import { Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import * as SocketServer from "effect/unstable/socket/SocketServer"

import { coreRpcServerLayer } from "./core-rpc-server"
import type { CoreTransportAuthenticationOptions } from "./core-transport-authentication"

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

/** Runs Core RPC over one private native Unix domain socket. */
export const coreRpcSocketHostLayer = (options: CoreRpcSocketHostOptions) => {
  const socketServerLayer = Layer.effect(
    SocketServer.SocketServer,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      if (Buffer.byteLength(Redacted.value(options.token)) < 32) {
        return yield* CoreRpcSocketSecurityError.make({ reason: "transport-token-too-short" })
      }
      if (Buffer.byteLength(options.socketPath) > 103) {
        return yield* CoreRpcSocketSecurityError.make({ reason: "socket-path-too-long" })
      }
      const runtimeDirectory = path.dirname(options.socketPath)
      const runtimeDirectoryInfo = yield* fileSystem.stat(runtimeDirectory)
      if (
        runtimeDirectoryInfo.type !== "Directory" ||
        (runtimeDirectoryInfo.mode & 0o777) !== 0o700
      ) {
        return yield* CoreRpcSocketSecurityError.make({
          reason: "runtime-directory-not-private",
        })
      }
      const server = yield* NodeSocketServer.make({ path: options.socketPath })
      yield* fileSystem.chmod(options.socketPath, 0o600)
      return server
    }),
  )
  const protocolLayer = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide(socketServerLayer),
    Layer.provide(
      RpcSerialization.layerMsgPackWith({
        useRecords: true,
        maxBufferSize: CORE_RPC_INCOMPLETE_BUFFER_BYTES,
      }),
    ),
  )

  return coreRpcServerLayer(options).pipe(Layer.provideMerge(protocolLayer))
}
