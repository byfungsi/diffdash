import * as NodeSocket from "@effect/platform-node/NodeSocket"
import {
  CoreMethod,
  type CoreMethod as CoreMethodType,
  type CoreMethodInput,
  type CoreOperationOutput,
} from "@diffdash/core"
import type { CoreApplicationFailure } from "@diffdash/core-rpc/application-rpc"
import type {
  AppStateReadFailure,
  AppStateGetAdmissionFailure,
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
import type {
  CoreResolvedReviewTarget,
  CoreReviewInventoryPage,
  CoreReviewInventoryRequest,
  CoreReviewRange,
  CoreReviewRangeRequest,
  CoreReviewSearchPublication,
  CoreReviewSearchRequest,
  CoreReviewSessionFailure,
  CoreReviewSessionRequest,
  CoreReviewSessionState,
  CoreReviewTargetRequest,
  OpenCoreReviewSessionRequest,
} from "@diffdash/core-rpc/review-session"
import { Context, Effect, Layer, Redacted, Schema, Stream } from "effect"
import * as Headers from "effect/unstable/http/Headers"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as Socket from "effect/unstable/socket/Socket"

type CoreRpcApplicationRequest<Method extends CoreMethodType> = HostRequestContext &
  CoreMethodInput<Method>

type CoreRpcApplicationOutput<Method extends CoreMethodType> =
  Method extends "ReviewThreads.runAgent"
    ? ReviewAgentOperationAccepted
    : CoreOperationOutput<Method>

type CoreRpcApplicationFailure =
  | CoreApplicationFailure
  | AppStateReadFailure
  | AppStateGetAdmissionFailure
  | ReviewAgentStartFailure
  | CoreTransportAuthenticationFailure
  | RpcClientError

type CoreProgressiveReviewFailure =
  | CoreReviewSessionFailure
  | CoreTransportAuthenticationFailure
  | RpcClientError

type CoreRpcApplicationClient = {
  readonly [Name in keyof typeof CoreMethod]: (
    request: CoreRpcApplicationRequest<(typeof CoreMethod)[Name]>,
  ) => Effect.Effect<CoreRpcApplicationOutput<(typeof CoreMethod)[Name]>, CoreRpcApplicationFailure>
}

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
  CoreRpcApplicationClient & {
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
    readonly openReviewSession: (
      request: OpenCoreReviewSessionRequest,
    ) => Effect.Effect<CoreReviewSessionState, CoreProgressiveReviewFailure>
    readonly currentReviewSession: (
      request: CoreReviewSessionRequest,
    ) => Effect.Effect<CoreReviewSessionState, CoreProgressiveReviewFailure>
    readonly closeReviewSession: (
      request: CoreReviewSessionRequest,
    ) => Effect.Effect<CoreReviewSessionState, CoreProgressiveReviewFailure>
    readonly reviewInventory: (
      request: CoreReviewInventoryRequest,
    ) => Effect.Effect<CoreReviewInventoryPage, CoreProgressiveReviewFailure>
    readonly readReviewRange: (
      request: CoreReviewRangeRequest,
    ) => Effect.Effect<CoreReviewRange, CoreProgressiveReviewFailure>
    readonly waitForReviewRange: (
      request: CoreReviewRangeRequest,
    ) => Effect.Effect<CoreReviewRange, CoreProgressiveReviewFailure>
    readonly resolveReviewTarget: (
      request: CoreReviewTargetRequest,
    ) => Effect.Effect<CoreResolvedReviewTarget, CoreProgressiveReviewFailure>
    readonly searchReview: (
      request: CoreReviewSearchRequest,
    ) => Stream.Stream<CoreReviewSearchPublication, CoreProgressiveReviewFailure>
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
      const authenticationHeaders = Headers.fromInput({
        [CORE_TRANSPORT_TOKEN_HEADER]: Redacted.value(options.token),
      })

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
      const applicationClient: CoreRpcApplicationClient = {
        analyticsCapture: Effect.fn("CoreRpcClient.analyticsCapture")((request) =>
          authenticated(client("Analytics.capture", request)),
        ),
        analyticsStart: Effect.fn("CoreRpcClient.analyticsStart")((request) =>
          authenticated(client("Analytics.start", request)),
        ),
        agentProvidersGetCatalog: Effect.fn("CoreRpcClient.agentProvidersGetCatalog")((request) =>
          authenticated(client("AgentProviders.getCatalog", request)),
        ),
        appDiagnostics: Effect.fn("CoreRpcClient.appDiagnostics")((request) =>
          authenticated(client("Prerequisites.get", request)),
        ),
        appInstallDiffDashCli: Effect.fn("CoreRpcClient.appInstallDiffDashCli")((request) =>
          authenticated(client("Prerequisites.installDiffDashCli", request)),
        ),
        appOpenLocalRepositoryFile: Effect.fn("CoreRpcClient.appOpenLocalRepositoryFile")(
          (request) => authenticated(client("FileNavigation.resolveLocalRepositoryFile", request)),
        ),
        appOpenRepositoryComparisonFile: Effect.fn("CoreRpcClient.appOpenRepositoryComparisonFile")(
          (request) =>
            authenticated(client("FileNavigation.resolveRepositoryComparisonFile", request)),
        ),
        appOpenRepositoryFile: Effect.fn("CoreRpcClient.appOpenRepositoryFile")((request) =>
          authenticated(client("FileNavigation.resolveHostedReviewFile", request)),
        ),
        appStateGet: Effect.fn("CoreRpcClient.appStateGet")((request) =>
          authenticated(client("AppState.get", request)),
        ),
        appStateUpdate: Effect.fn("CoreRpcClient.appStateUpdate")((request) =>
          authenticated(client("AppState.update", request)),
        ),
        listProviders: Effect.fn("CoreRpcClient.listProviders")((request) =>
          authenticated(client("GitProviders.list", request)),
        ),
        submitHostedReviewDecision: Effect.fn("CoreRpcClient.submitHostedReviewDecision")(
          (request) => authenticated(client("HostedReviews.submitDecision", request)),
        ),
        getHostedReviewDecision: Effect.fn("CoreRpcClient.getHostedReviewDecision")((request) =>
          authenticated(client("HostedReviews.getDecision", request)),
        ),
        listHostedReviews: Effect.fn("CoreRpcClient.listHostedReviews")((request) =>
          authenticated(client("HostedReviews.list", request)),
        ),
        listAssignedHostedReviews: Effect.fn("CoreRpcClient.listAssignedHostedReviews")((request) =>
          authenticated(client("HostedReviews.listAssigned", request)),
        ),
        listHostedRepositorySearchScopes: Effect.fn(
          "CoreRpcClient.listHostedRepositorySearchScopes",
        )((request) => authenticated(client("GitProviders.listSearchScopes", request))),
        searchHostedRepositories: Effect.fn("CoreRpcClient.searchHostedRepositories")((request) =>
          authenticated(client("GitProviders.searchRepositories", request)),
        ),
        resolveLocalBranch: Effect.fn("CoreRpcClient.resolveLocalBranch")((request) =>
          authenticated(client("LocalReviews.resolveBranch", request)),
        ),
        resolveLastCommit: Effect.fn("CoreRpcClient.resolveLastCommit")((request) =>
          authenticated(client("LocalReviews.resolveLastCommit", request)),
        ),
        resolveRepositoryComparison: Effect.fn("CoreRpcClient.resolveRepositoryComparison")(
          (request) => authenticated(client("RepositoryComparisons.resolve", request)),
        ),
        acquireHostedReviewSnapshot: Effect.fn("CoreRpcClient.acquireHostedReviewSnapshot")(
          (request) => authenticated(client("ReviewSnapshots.acquireHosted", request)),
        ),
        acquireLocalReviewSnapshot: Effect.fn("CoreRpcClient.acquireLocalReviewSnapshot")(
          (request) => authenticated(client("ReviewSnapshots.acquireLocal", request)),
        ),
        acquireRepositoryComparisonSnapshot: Effect.fn(
          "CoreRpcClient.acquireRepositoryComparisonSnapshot",
        )((request) =>
          authenticated(client("ReviewSnapshots.acquireRepositoryComparison", request)),
        ),
        favoriteRemoteRepository: Effect.fn("CoreRpcClient.favoriteRemoteRepository")((request) =>
          authenticated(client("Repositories.favoriteRemote", request)),
        ),
        forgetRepository: Effect.fn("CoreRpcClient.forgetRepository")((request) =>
          authenticated(client("Repositories.forget", request)),
        ),
        installRepository: Effect.fn("CoreRpcClient.installRepository")((request) =>
          authenticated(client("Repositories.install", request)),
        ),
        linkRepository: Effect.fn("CoreRpcClient.linkRepository")((request) =>
          authenticated(client("Repositories.link", request)),
        ),
        listRepositories: Effect.fn("CoreRpcClient.listRepositories")((request) =>
          authenticated(client("Repositories.list", request)),
        ),
        openProject: Effect.fn("CoreRpcClient.openProject")((request) =>
          authenticated(client("Repositories.openProject", request)),
        ),
        repairRepositoryIdentities: Effect.fn("CoreRpcClient.repairRepositoryIdentities")(
          (request) => authenticated(client("Repositories.repairIdentities", request)),
        ),
        setRepositoryFavorite: Effect.fn("CoreRpcClient.setRepositoryFavorite")((request) =>
          authenticated(client("Repositories.setFavorite", request)),
        ),
        projectWorkspaceGet: Effect.fn("CoreRpcClient.projectWorkspaceGet")((request) =>
          authenticated(client("ProjectWorkspace.get", request)),
        ),
        projectWorkspaceSave: Effect.fn("CoreRpcClient.projectWorkspaceSave")((request) =>
          authenticated(client("ProjectWorkspace.save", request)),
        ),
        addReviewThreadUserMessage: Effect.fn("CoreRpcClient.addReviewThreadUserMessage")(
          (request) => authenticated(client("ReviewThreads.addUserMessage", request)),
        ),
        createReviewThread: Effect.fn("CoreRpcClient.createReviewThread")((request) =>
          authenticated(client("ReviewThreads.create", request)),
        ),
        getReviewThread: Effect.fn("CoreRpcClient.getReviewThread")((request) =>
          authenticated(client("ReviewThreads.get", request)),
        ),
        listReviewThreads: Effect.fn("CoreRpcClient.listReviewThreads")((request) =>
          authenticated(client("ReviewThreads.list", request)),
        ),
        runReviewThreadAgent: Effect.fn("CoreRpcClient.runReviewThreadAgent")((request) =>
          authenticated(client("ReviewThreads.runAgent", request)),
        ),
        settingsGet: Effect.fn("CoreRpcClient.settingsGet")((request) =>
          authenticated(client("Settings.get", request)),
        ),
        settingsUpdate: Effect.fn("CoreRpcClient.settingsUpdate")((request) =>
          authenticated(client("Settings.update", request)),
        ),
        listViewedFiles: Effect.fn("CoreRpcClient.listViewedFiles")((request) =>
          authenticated(client("ViewedFiles.listHosted", request)),
        ),
        listLocalViewedFiles: Effect.fn("CoreRpcClient.listLocalViewedFiles")((request) =>
          authenticated(client("ViewedFiles.listLocal", request)),
        ),
        setViewedFile: Effect.fn("CoreRpcClient.setViewedFile")((request) =>
          authenticated(client("ViewedFiles.setHosted", request)),
        ),
        setLocalViewedFile: Effect.fn("CoreRpcClient.setLocalViewedFile")((request) =>
          authenticated(client("ViewedFiles.setLocal", request)),
        ),
        listRepositoryComparisonViewedFiles: Effect.fn(
          "CoreRpcClient.listRepositoryComparisonViewedFiles",
        )((request) => authenticated(client("ViewedFiles.listRepositoryComparison", request))),
        setRepositoryComparisonViewedFile: Effect.fn(
          "CoreRpcClient.setRepositoryComparisonViewedFile",
        )((request) => authenticated(client("ViewedFiles.setRepositoryComparison", request))),
      }
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
      const openReviewSession = Effect.fn("CoreRpcClient.openReviewSession")(
        (request: OpenCoreReviewSessionRequest) =>
          authenticated(client("Reviews.openSession", request)),
      )
      const currentReviewSession = Effect.fn("CoreRpcClient.currentReviewSession")(
        (request: CoreReviewSessionRequest) =>
          authenticated(client("Reviews.currentSession", request)),
      )
      const closeReviewSession = Effect.fn("CoreRpcClient.closeReviewSession")(
        (request: CoreReviewSessionRequest) =>
          authenticated(client("Reviews.closeSession", request)),
      )
      const reviewInventory = Effect.fn("CoreRpcClient.reviewInventory")(
        (request: CoreReviewInventoryRequest) =>
          authenticated(client("Reviews.inventory", request)),
      )
      const readReviewRange = Effect.fn("CoreRpcClient.readReviewRange")(
        (request: CoreReviewRangeRequest) => authenticated(client("Ranges.read", request)),
      )
      const waitForReviewRange = Effect.fn("CoreRpcClient.waitForReviewRange")(
        (request: CoreReviewRangeRequest) => authenticated(client("Ranges.wait", request)),
      )
      const resolveReviewTarget = Effect.fn("CoreRpcClient.resolveReviewTarget")(
        (request: CoreReviewTargetRequest) =>
          authenticated(client("Navigation.resolveTarget", request)),
      )
      const searchReview = (request: CoreReviewSearchRequest) =>
        client("Search.scan", request).pipe(
          Stream.provideService(RpcClient.CurrentHeaders, authenticationHeaders),
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
            ...applicationClient,
            authorizeDatabaseOwnership,
            cancelWalkthrough,
            getReviewAgentOperation,
            getStoredWalkthrough,
            getWalkthroughOperation,
            health,
            openReviewSession,
            currentReviewSession,
            closeReviewSession,
            reviewInventory,
            readReviewRange,
            waitForReviewRange,
            resolveReviewTarget,
            searchReview,
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
