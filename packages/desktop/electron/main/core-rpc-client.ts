import * as NodeSocket from "@effect/platform-node/NodeSocket"
import type {
  CoreHealthIdentityMismatchFailure,
  CoreTransportAuthenticationFailure,
} from "@diffdash/core-rpc/failure"
import { CoreHealth } from "@diffdash/core-rpc/lifecycle"
import type {
  ApplicationInstanceId,
  CoreProcessEpoch,
  HostRequestContext,
} from "@diffdash/core-rpc/identity"
import {
  AuthenticatedCoreControlRpcs,
  CORE_RPC_INCOMPLETE_BUFFER_BYTES,
  CORE_TRANSPORT_TOKEN_HEADER,
} from "@diffdash/core-rpc/transport"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as Socket from "effect/unstable/socket/Socket"

/** Host-side rejection when health does not identify the exact launched Core epoch. */
export class CoreRpcHealthVerificationError extends Schema.TaggedError<CoreRpcHealthVerificationError>()(
  "CoreRpcHealthVerificationError",
  {
    expectedApplicationInstanceId: Schema.String,
    expectedProcessEpoch: Schema.String,
    actualApplicationInstanceId: Schema.String,
    actualProcessEpoch: Schema.String,
  },
) {}

/** Private host configuration for one authenticated Core RPC connection. */
export interface CoreRpcClientOptions {
  readonly socketPath: string
  readonly token: Redacted.Redacted
  readonly applicationInstanceId: ApplicationInstanceId
  readonly processEpoch: CoreProcessEpoch
}

/** Authenticated Electron-side client for the Core control plane. */
export class CoreRpcClient extends Context.Service<
  CoreRpcClient,
  {
    readonly health: (
      request: HostRequestContext,
    ) => Effect.Effect<
      CoreHealth,
      | CoreRpcHealthVerificationError
      | CoreHealthIdentityMismatchFailure
      | CoreTransportAuthenticationFailure
      | RpcClientError
    >
  }
>()("@diffdash/desktop/CoreRpcClient") {}

/** Verifies that a health value belongs to the exact Core process Electron launched. */
export const verifyCoreHealth = (
  options: Pick<CoreRpcClientOptions, "applicationInstanceId" | "processEpoch">,
  response: CoreHealth,
): Effect.Effect<CoreHealth, CoreRpcHealthVerificationError> =>
  response.applicationInstanceId === options.applicationInstanceId &&
  response.processEpoch === options.processEpoch
    ? Effect.succeed(CoreHealth.make(response))
    : CoreRpcHealthVerificationError.make({
        expectedApplicationInstanceId: options.applicationInstanceId,
        expectedProcessEpoch: options.processEpoch,
        actualApplicationInstanceId: response.applicationInstanceId,
        actualProcessEpoch: response.processEpoch,
      })

/** Connects to one private Core socket and verifies every health response identity. */
export const coreRpcClientLayer = (options: CoreRpcClientOptions) => {
  const socketLayer = Layer.effect(
    Socket.Socket,
    NodeSocket.makeNet({ path: options.socketPath, openTimeout: "1 second" }),
  )
  const protocolLayer = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(socketLayer),
    Layer.provide(
      RpcSerialization.layerMsgPackWith({
        useRecords: true,
        maxBufferSize: CORE_RPC_INCOMPLETE_BUFFER_BYTES,
      }),
    ),
  )

  return Layer.effect(
    CoreRpcClient,
    Effect.gen(function* () {
      const client = yield* RpcClient.make(AuthenticatedCoreControlRpcs)

      const health = Effect.fn("CoreRpcClient.health")(function* (request: HostRequestContext) {
        const response = yield* client["Core.health"](request).pipe(
          RpcClient.withHeaders({
            [CORE_TRANSPORT_TOKEN_HEADER]: Redacted.value(options.token),
          }),
        )
        return yield* verifyCoreHealth(options, response)
      })

      return CoreRpcClient.of({ health })
    }),
  ).pipe(Layer.provide(protocolLayer))
}
