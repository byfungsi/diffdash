import * as NodeSocket from "@effect/platform-node/NodeSocket"
import type { CoreMethod, CoreMethodInput, CoreOperationOutput } from "@diffdash/core"
import type { CoreApplicationFailure } from "@diffdash/core-rpc/application-rpc"
import type {
  CoreAuthorizeDatabaseOwnershipFailure,
  CoreHealthIdentityMismatchFailure,
  CoreTransportAuthenticationFailure,
} from "@diffdash/core-rpc/failure"
import type {
  CoreCommandAcknowledgement,
  CoreCommandListRequest,
  CoreCommandListResult,
  CoreCommandQueryRequest,
  CoreCommandQueryResult,
  CoreCommandSnapshot,
  CoreEventReplayRequest,
  CoreEventReplayResult,
  CoreStateDeliveryFailure,
} from "@diffdash/core-rpc/event"
import {
  type AuthorizeDatabaseOwnershipRequest,
  CoreHealth,
  type DatabaseOwnershipAuthorized,
  type CoreShutdownAcknowledged,
} from "@diffdash/core-rpc/lifecycle"
import type { CoreShutdownFailure } from "@diffdash/core-rpc/failure"
import type {
  ReviewAgentOperationAccepted,
  ReviewAgentOperationRequest,
  ReviewAgentOperationSnapshot,
  ReviewAgentStartFailure,
  ReviewAgentGetOperationFailure,
} from "@diffdash/core-rpc/review-agent"
import type {
  CancelWalkthroughRequest,
  GetStoredWalkthroughRequest,
  GetStoredWalkthroughResult,
  GetWalkthroughOperationRequest,
  StartWalkthroughRequest,
  WalkthroughCancelFailure,
  WalkthroughCancelAdmissionFailure,
  WalkthroughCancelResult,
  WalkthroughGetOperationFailure,
  WalkthroughGetOperationAdmissionFailure,
  WalkthroughGetStoredFailure,
  WalkthroughGetStoredAdmissionFailure,
  WalkthroughOperationAccepted,
  WalkthroughOperationSnapshot,
  WalkthroughStartFailure,
  WalkthroughStartAdmissionFailure,
} from "@diffdash/core-rpc/walkthrough"
import type {
  ApplicationInstanceId,
  CoreProcessEpoch,
  HostRequestContext,
} from "@diffdash/core-rpc/identity"
import {
  AuthenticatedCoreHostClientRpcs,
  CORE_RPC_INCOMPLETE_BUFFER_BYTES,
  CORE_TRANSPORT_TOKEN_HEADER,
} from "@diffdash/core-rpc/transport"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as Socket from "effect/unstable/socket/Socket"

type CoreRpcApplicationRequest<Method extends CoreMethod> = HostRequestContext &
  CoreMethodInput<Method>

type CoreRpcApplicationOutput<Method extends CoreMethod> = Method extends "ReviewThreads.runAgent"
  ? ReviewAgentOperationAccepted
  : CoreOperationOutput<Method>

type CoreRpcApplicationFailure =
  | CoreApplicationFailure
  | ReviewAgentStartFailure
  | CoreTransportAuthenticationFailure
  | RpcClientError

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
    readonly authorizeDatabaseOwnership: (
      request: AuthorizeDatabaseOwnershipRequest,
    ) => Effect.Effect<
      DatabaseOwnershipAuthorized,
      CoreAuthorizeDatabaseOwnershipFailure | CoreTransportAuthenticationFailure | RpcClientError
    >
    readonly execute: <Method extends CoreMethod>(
      method: Method,
      request: CoreRpcApplicationRequest<Method>,
    ) => Effect.Effect<CoreRpcApplicationOutput<Method>, CoreRpcApplicationFailure>
    readonly getReviewAgentOperation: (
      request: ReviewAgentOperationRequest,
    ) => Effect.Effect<
      ReviewAgentOperationSnapshot,
      ReviewAgentGetOperationFailure | CoreTransportAuthenticationFailure | RpcClientError
    >
    readonly startWalkthrough: (
      request: StartWalkthroughRequest,
    ) => Effect.Effect<
      WalkthroughOperationAccepted,
      | WalkthroughStartFailure
      | WalkthroughStartAdmissionFailure
      | CoreTransportAuthenticationFailure
      | RpcClientError
    >
    readonly getWalkthroughOperation: (
      request: GetWalkthroughOperationRequest,
    ) => Effect.Effect<
      WalkthroughOperationSnapshot,
      | WalkthroughGetOperationFailure
      | WalkthroughGetOperationAdmissionFailure
      | CoreTransportAuthenticationFailure
      | RpcClientError
    >
    readonly cancelWalkthrough: (
      request: CancelWalkthroughRequest,
    ) => Effect.Effect<
      WalkthroughCancelResult,
      | WalkthroughCancelFailure
      | WalkthroughCancelAdmissionFailure
      | CoreTransportAuthenticationFailure
      | RpcClientError
    >
    readonly getStoredWalkthrough: (
      request: GetStoredWalkthroughRequest,
    ) => Effect.Effect<
      GetStoredWalkthroughResult,
      | WalkthroughGetStoredFailure
      | WalkthroughGetStoredAdmissionFailure
      | CoreTransportAuthenticationFailure
      | RpcClientError
    >
    readonly shutdown: (
      request: HostRequestContext,
    ) => Effect.Effect<
      CoreShutdownAcknowledged,
      CoreShutdownFailure | CoreTransportAuthenticationFailure | RpcClientError
    >
  }
>()("@diffdash/desktop/CoreRpcClient") {}

/** Authenticated host client for reconnect-safe events and durable command state. */
export class CoreStateDeliveryRpcClient extends Context.Service<
  CoreStateDeliveryRpcClient,
  {
    /** Replays retained hints or explicitly requires authoritative resynchronization. */
    readonly replayEvents: (
      request: CoreEventReplayRequest,
    ) => Effect.Effect<
      CoreEventReplayResult,
      CoreStateDeliveryFailure | CoreTransportAuthenticationFailure | RpcClientError
    >
    /** Queries one durable command from authoritative Core storage. */
    readonly getCommand: (
      request: CoreCommandQueryRequest,
    ) => Effect.Effect<
      CoreCommandQueryResult,
      CoreStateDeliveryFailure | CoreTransportAuthenticationFailure | RpcClientError
    >
    /** Lists a bounded page of terminal commands awaiting acknowledgement. */
    readonly listUnacknowledgedCommands: (
      request: CoreCommandListRequest,
    ) => Effect.Effect<
      CoreCommandListResult,
      CoreStateDeliveryFailure | CoreTransportAuthenticationFailure | RpcClientError
    >
    /** Acknowledges exactly the current terminal version of one durable command. */
    readonly acknowledgeCommand: (
      request: CoreCommandAcknowledgement,
    ) => Effect.Effect<
      CoreCommandSnapshot,
      CoreStateDeliveryFailure | CoreTransportAuthenticationFailure | RpcClientError
    >
  }
>()("@diffdash/desktop/CoreStateDeliveryRpcClient") {}

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

  return Layer.effectContext(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(AuthenticatedCoreHostClientRpcs, { flatten: true })

      const authenticated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          RpcClient.withHeaders({
            [CORE_TRANSPORT_TOKEN_HEADER]: Redacted.value(options.token),
          }),
        )

      const health = Effect.fn("CoreRpcClient.health")(function* (request: HostRequestContext) {
        const response = yield* authenticated(client("Core.health", request))
        return yield* verifyCoreHealth(options, response)
      })
      const authorizeDatabaseOwnership = Effect.fn("CoreRpcClient.authorizeDatabaseOwnership")(
        (request: AuthorizeDatabaseOwnershipRequest) =>
          authenticated(client("Core.authorizeDatabaseOwnership", request)),
      )
      // SAFETY: The authenticated catalog contains every CoreMethod with the same request/output
      // correlation. Effect's flattened client loses that correlation for a generic tag subset.
      // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
      const applicationClient = client as CoreRpcClient["Service"]["execute"]
      const execute: CoreRpcClient["Service"]["execute"] = (method, request) =>
        authenticated(applicationClient(method, request))
      const getReviewAgentOperation = Effect.fn("CoreRpcClient.getReviewAgentOperation")(
        (request: ReviewAgentOperationRequest) =>
          authenticated(client("ReviewAgents.getOperation", request)),
      )
      const startWalkthrough = Effect.fn("CoreRpcClient.startWalkthrough")(
        (request: StartWalkthroughRequest) => authenticated(client("Walkthroughs.start", request)),
      )
      const getWalkthroughOperation = Effect.fn("CoreRpcClient.getWalkthroughOperation")(
        (request: GetWalkthroughOperationRequest) =>
          authenticated(client("Walkthroughs.getOperation", request)),
      )
      const cancelWalkthrough = Effect.fn("CoreRpcClient.cancelWalkthrough")(
        (request: CancelWalkthroughRequest) =>
          authenticated(client("Walkthroughs.cancel", request)),
      )
      const getStoredWalkthrough = Effect.fn("CoreRpcClient.getStoredWalkthrough")(
        (request: GetStoredWalkthroughRequest) =>
          authenticated(client("Walkthroughs.getStored", request)),
      )
      const shutdown = Effect.fn("CoreRpcClient.shutdown")((request: HostRequestContext) =>
        authenticated(client("Core.shutdown", request)),
      )

      const replayEvents = Effect.fn("CoreRpcClient.replayEvents")(
        (request: CoreEventReplayRequest) => authenticated(client("CoreEvents.replay", request)),
      )
      const getCommand = Effect.fn("CoreRpcClient.getCommand")((request: CoreCommandQueryRequest) =>
        authenticated(client("CoreCommands.get", request)),
      )
      const listUnacknowledgedCommands = Effect.fn("CoreRpcClient.listUnacknowledgedCommands")(
        (request: CoreCommandListRequest) =>
          authenticated(client("CoreCommands.listUnacknowledged", request)),
      )
      const acknowledgeCommand = Effect.fn("CoreRpcClient.acknowledgeCommand")(
        (request: CoreCommandAcknowledgement) =>
          authenticated(client("CoreCommands.acknowledge", request)),
      )

      return Context.empty().pipe(
        Context.add(
          CoreRpcClient,
          CoreRpcClient.of({
            authorizeDatabaseOwnership,
            cancelWalkthrough,
            execute,
            getReviewAgentOperation,
            getStoredWalkthrough,
            getWalkthroughOperation,
            health,
            shutdown,
            startWalkthrough,
          }),
        ),
        Context.add(
          CoreStateDeliveryRpcClient,
          CoreStateDeliveryRpcClient.of({
            acknowledgeCommand,
            getCommand,
            listUnacknowledgedCommands,
            replayEvents,
          }),
        ),
      )
    }),
  ).pipe(Layer.provide(protocolLayer))
}
