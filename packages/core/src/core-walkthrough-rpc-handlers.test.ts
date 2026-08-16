import {
  WalkthroughCancelAdmissionMiddleware,
  WalkthroughGetOperationAdmissionMiddleware,
  WalkthroughGetStoredAdmissionMiddleware,
  WalkthroughStartAdmissionMiddleware,
} from "@diffdash/core-rpc/admission"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  DatabaseOwnershipAuthorizationId,
  HostRequestContext,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import { AuthorizeDatabaseOwnershipRequest } from "@diffdash/core-rpc/lifecycle"
import {
  AuthenticatedCoreWalkthroughServerRpcs,
  CORE_RPC_INCOMPLETE_BUFFER_BYTES,
  CORE_RPC_MAX_CONCURRENCY,
  CORE_TRANSPORT_TOKEN_HEADER,
} from "@diffdash/core-rpc/transport"
import {
  CancelWalkthroughRequest,
  GetStoredWalkthroughRequest,
  GetWalkthroughOperationRequest,
  StartWalkthroughRequest,
  WalkthroughIdempotencyKey,
  WalkthroughReviewGeneration,
} from "@diffdash/core-rpc/walkthrough"
import { WalkthroughBusinessRpcs } from "@diffdash/core-rpc/walkthrough-rpc"
import {
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import {
  StoredWalkthrough,
  Walkthrough,
  WalkthroughChapterId,
  WalkthroughHunkId,
  WalkthroughStopId,
} from "@diffdash/domain/walkthrough"
import {
  WalkthroughOperation,
  WalkthroughOperationAcceptance,
  WalkthroughOperationAcceptanceEvidence,
  WalkthroughOperationCandidatePlanFingerprint,
  WalkthroughOperationId,
  WalkthroughOperationIdempotencyKey,
  WalkthroughOperationTimestamp,
} from "@diffdash/domain/walkthrough-operation"
import { TempResources } from "@diffdash/process/temp-resource"
import { describe, expect, it } from "@effect/vitest"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Scope,
} from "effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcTest from "effect/unstable/rpc/RpcTest"
import * as Socket from "effect/unstable/socket/Socket"

import { CoreLifecycle, coreLifecycleLayer } from "./core-lifecycle"
import { CoreOperationService } from "./core-operation-service"
import { coreWalkthroughRpcSocketHostLayer } from "./core-rpc-socket-host"
import { coreWalkthroughRpcHandlersLayer } from "./core-walkthrough-rpc-handlers"
import type { OperationHandlers } from "./operations/operation-handlers"

const requestIdentity = {
  applicationInstanceId: ApplicationInstanceId.make("app-handler"),
  processEpoch: CoreProcessEpoch.make("epoch-handler"),
  requestId: HostRequestId.make("h:handler"),
} as const
const reviewGeneration = WalkthroughReviewGeneration.make({
  kind: "local",
  projectId: ReviewProjectId.make("project-handler"),
  snapshotId: ReviewSnapshotId.make(`snapshot:v1:${"a".repeat(32)}`),
  reviewKey: ReviewKey.make("local:handler"),
  baseRevision: ReviewRevision.make("base-handler"),
  headRevision: ReviewRevision.make("head-handler"),
})
const target = Schema.decodeUnknownSync(StartWalkthroughRequest.fields.target)({
  kind: "local",
  rootPath: "/workspace/diffdash",
  comparison: { _tag: "workingTree" },
})
const operationId = WalkthroughOperationId.make("operation-handler")
const timestamp = WalkthroughOperationTimestamp.make("2026-08-16T00:00:00.000Z")
const evidence = WalkthroughOperationAcceptanceEvidence.make({
  acceptedRequest: requestIdentity,
  idempotencyKey: WalkthroughOperationIdempotencyKey.make("w:handler"),
  reviewGeneration,
  regenerate: false,
  configuredRoute: { mode: "auto", quality: "balanced" },
  candidatePlanFingerprint: WalkthroughOperationCandidatePlanFingerprint.make(
    `walkthrough-plan:v1:${"b".repeat(64)}`,
  ),
  attempts: [],
})
const activeOperation = Schema.decodeUnknownSync(WalkthroughOperation)({
  id: operationId,
  identity: {
    repoId: reviewGeneration.projectId,
    reviewKey: reviewGeneration.reviewKey,
    baseRevision: reviewGeneration.baseRevision,
    headRevision: reviewGeneration.headRevision,
    promptVersion: "walkthrough-v4",
  },
  acceptanceEvidence: evidence,
  state: "accepted",
  stateVersion: 1,
  regenerationOfOperationId: null,
  acceptedAt: timestamp,
  updatedAt: timestamp,
  startedAt: null,
  cancellationRequestedAt: null,
  terminalAt: null,
  supersededByOperationId: null,
  artifact: null,
  failure: null,
})
const cancelledOperation = Schema.decodeUnknownSync(WalkthroughOperation)({
  ...activeOperation,
  state: "cancelled",
  stateVersion: 2,
  cancellationRequestedAt: timestamp,
  terminalAt: timestamp,
})
const storedWalkthrough = StoredWalkthrough.make({
  repoId: reviewGeneration.projectId,
  prNumber: null,
  reviewKey: reviewGeneration.reviewKey,
  baseSha: reviewGeneration.baseRevision,
  headSha: reviewGeneration.headRevision,
  promptVersion: "walkthrough-v4",
  walkthrough: Walkthrough.make({
    title: "Stored walkthrough",
    summary: "Stored walkthrough summary.",
    chapters: [
      {
        id: WalkthroughChapterId.make("chapter-handler"),
        title: "Authentication",
        summary: "Verify the walkthrough boundary.",
        stops: [
          {
            id: WalkthroughStopId.make("stop-handler"),
            title: "Validate identity",
            summary: "Check the exact process epoch.",
            risk: "critical",
            hunkIds: [WalkthroughHunkId.make("hunk-handler")],
          },
        ],
      },
    ],
    support: [],
  }),
  createdAt: timestamp,
})

const passThroughAdmissionLayer = Layer.mergeAll(
  Layer.succeed(WalkthroughStartAdmissionMiddleware, (effect) => effect),
  Layer.succeed(WalkthroughGetOperationAdmissionMiddleware, (effect) => effect),
  Layer.succeed(WalkthroughCancelAdmissionMiddleware, (effect) => effect),
  Layer.succeed(WalkthroughGetStoredAdmissionMiddleware, (effect) => effect),
)

const unusedReviewAgents = {
  start: () => Effect.die("Unexpected review-agent start"),
  getOperation: () => Effect.die("Unexpected review-agent read"),
  cancel: () => Effect.die("Unexpected review-agent cancellation"),
}

const unavailableMethod = () => Effect.die("Unexpected named Core operation")
const unavailableMethods = {
  "Analytics.capture": unavailableMethod,
  "Analytics.start": unavailableMethod,
  "AgentProviders.getCatalog": unavailableMethod,
  "Prerequisites.get": unavailableMethod,
  "Prerequisites.installDiffDashCli": unavailableMethod,
  "FileNavigation.resolveLocalRepositoryFile": unavailableMethod,
  "FileNavigation.resolveRepositoryComparisonFile": unavailableMethod,
  "FileNavigation.resolveHostedReviewFile": unavailableMethod,
  "AppState.get": unavailableMethod,
  "AppState.update": unavailableMethod,
  "GitProviders.list": unavailableMethod,
  "HostedReviews.submitDecision": unavailableMethod,
  "HostedReviews.getDecision": unavailableMethod,
  "HostedReviews.list": unavailableMethod,
  "HostedReviews.listAssigned": unavailableMethod,
  "GitProviders.listSearchScopes": unavailableMethod,
  "GitProviders.searchRepositories": unavailableMethod,
  "LocalReviews.resolveBranch": unavailableMethod,
  "LocalReviews.resolveLastCommit": unavailableMethod,
  "RepositoryComparisons.resolve": unavailableMethod,
  "ReviewSnapshots.acquireHosted": unavailableMethod,
  "ReviewSnapshots.acquireLocal": unavailableMethod,
  "ReviewSnapshots.acquireRepositoryComparison": unavailableMethod,
  "Repositories.favoriteRemote": unavailableMethod,
  "Repositories.forget": unavailableMethod,
  "Repositories.install": unavailableMethod,
  "Repositories.link": unavailableMethod,
  "Repositories.list": unavailableMethod,
  "Repositories.openProject": unavailableMethod,
  "Repositories.repairIdentities": unavailableMethod,
  "Repositories.setFavorite": unavailableMethod,
  "ProjectWorkspace.get": unavailableMethod,
  "ProjectWorkspace.save": unavailableMethod,
  "ReviewThreads.addUserMessage": unavailableMethod,
  "ReviewThreads.create": unavailableMethod,
  "ReviewThreads.get": unavailableMethod,
  "ReviewThreads.list": unavailableMethod,
  "ReviewThreads.runAgent": unavailableMethod,
  "Settings.get": unavailableMethod,
  "Settings.update": unavailableMethod,
  "Resources.diagnostics": unavailableMethod,
  "Resources.clearDisposable": unavailableMethod,
  "ViewedFiles.listHosted": unavailableMethod,
  "ViewedFiles.listLocal": unavailableMethod,
  "ViewedFiles.setHosted": unavailableMethod,
  "ViewedFiles.setLocal": unavailableMethod,
  "ViewedFiles.listRepositoryComparison": unavailableMethod,
  "ViewedFiles.setRepositoryComparison": unavailableMethod,
} satisfies OperationHandlers

const operationsLayer = Layer.succeed(
  CoreOperationService,
  CoreOperationService.of({
    start: Effect.void,
    methods: unavailableMethods,
    reviewAgents: unusedReviewAgents,
    walkthroughs: {
      resolveGeneration: () => Effect.succeed(reviewGeneration),
      startGeneration: () =>
        Effect.succeed(
          WalkthroughOperationAcceptance.make({ created: true, operation: activeOperation }),
        ),
      getSnapshot: () => Effect.succeed(activeOperation),
      cancelSnapshot: () => Effect.succeed(cancelledOperation),
      getStored: () => Effect.die("Unexpected legacy walkthrough cache read"),
      getStoredGeneration: () => Effect.succeed(Option.some(storedWalkthrough)),
      getCached: () => Effect.die("Unexpected walkthrough cache read"),
    },
  }),
)

const testLayer = Layer.mergeAll(
  operationsLayer,
  passThroughAdmissionLayer,
  coreWalkthroughRpcHandlersLayer.pipe(Layer.provide(operationsLayer)),
)
const transportToken = "walkthrough-handler-token-32-bytes"
const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const tempResourcesLayer = TempResources.layer.pipe(Layer.provide(platformLayer))

const makeSocketClient = (socketPath: string, scope: Scope.Scope) =>
  Effect.gen(function* () {
    const socketLayer = Layer.effect(
      Socket.Socket,
      NodeSocket.makeNet({ path: socketPath, openTimeout: "1 second" }),
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
    const context = yield* Layer.buildWithScope(protocolLayer, scope)
    return yield* RpcClient.make(AuthenticatedCoreWalkthroughServerRpcs).pipe(
      Effect.provide(context),
      Effect.provideService(Scope.Scope, scope),
    )
  })

describe("Core walkthrough RPC handlers", () => {
  it.effect("projects accepted, active, cancelled, and stored state", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
      const start = yield* client["Walkthroughs.start"](
        StartWalkthroughRequest.make({
          ...requestIdentity,
          target,
          regenerate: false,
          idempotencyKey: WalkthroughIdempotencyKey.make("w:handler"),
        }),
      )
      const active = yield* client["Walkthroughs.getOperation"](
        GetWalkthroughOperationRequest.make({ ...requestIdentity, operationId }),
      )
      yield* Effect.forEach(
        Array.from({ length: CORE_RPC_MAX_CONCURRENCY + 1 }, (_, index) => index),
        (index) =>
          client["Walkthroughs.getOperation"](
            GetWalkthroughOperationRequest.make({
              ...requestIdentity,
              requestId: HostRequestId.make(`h:handler-release-${String(index)}`),
              operationId,
            }),
          ),
        { discard: true },
      )
      const cancelled = yield* client["Walkthroughs.cancel"](
        CancelWalkthroughRequest.make({ ...requestIdentity, operationId }),
      )
      const stored = yield* client["Walkthroughs.getStored"](
        GetStoredWalkthroughRequest.make({
          ...requestIdentity,
          target,
          promptVersion: "walkthrough-v4",
        }),
      )

      expect(start).toMatchObject({ operationId, stateVersion: 1, created: true })
      expect(active).toMatchObject({
        operationId,
        state: "active",
        phase: "queued",
        configuredRoute: { mode: "auto", quality: "balanced" },
      })
      expect(cancelled).toMatchObject({
        status: "cancelled",
        operation: { operationId, state: "cancelled", stateVersion: 2 },
      })
      expect(stored).toMatchObject({
        status: "found",
        stored: {
          reviewGeneration,
          promptVersion: "walkthrough-v4",
          walkthrough: { title: "Stored walkthrough" },
        },
      })
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("serves the walkthrough lifecycle through an authenticated Unix socket", () =>
    Effect.gen(function* () {
      const tempResources = yield* TempResources
      const runtimeDirectory = yield* tempResources.makeTempDirectoryScoped({
        prefix: "dd-walkthrough-",
      })
      const socketPath = `${runtimeDirectory}/core.sock`
      const serverScope = yield* Scope.make()
      const lifecycleLayer = coreLifecycleLayer(requestIdentity)
      const hostLayer = coreWalkthroughRpcSocketHostLayer({
        socketPath,
        token: Redacted.make(transportToken),
      }).pipe(
        Layer.provideMerge(lifecycleLayer),
        Layer.provideMerge(operationsLayer),
        Layer.provideMerge(platformLayer),
      )
      const serverContext = yield* Layer.buildWithScope(hostLayer, serverScope)
      const clientScope = yield* Scope.make()
      const client = yield* makeSocketClient(socketPath, clientScope)
      const healthRequest = HostRequestContext.make({
        ...requestIdentity,
        requestId: HostRequestId.make("h:walkthrough-health"),
      })

      yield* client["Core.health"](healthRequest).pipe(
        RpcClient.withHeaders({ [CORE_TRANSPORT_TOKEN_HEADER]: transportToken }),
      )
      yield* client["Core.authorizeDatabaseOwnership"](
        AuthorizeDatabaseOwnershipRequest.make({
          ...healthRequest,
          authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-walkthrough"),
        }),
      )
      yield* Context.get(serverContext, CoreLifecycle).completeRecovery

      const accepted = yield* client["Walkthroughs.start"](
        StartWalkthroughRequest.make({
          ...requestIdentity,
          target,
          regenerate: false,
          idempotencyKey: WalkthroughIdempotencyKey.make("w:handler"),
        }),
      )
      const active = yield* client["Walkthroughs.getOperation"](
        GetWalkthroughOperationRequest.make({ ...requestIdentity, operationId }),
      )
      const cancelled = yield* client["Walkthroughs.cancel"](
        CancelWalkthroughRequest.make({ ...requestIdentity, operationId }),
      )
      const stored = yield* client["Walkthroughs.getStored"](
        GetStoredWalkthroughRequest.make({
          ...requestIdentity,
          target,
          promptVersion: "walkthrough-v4",
        }),
      )

      expect(accepted).toMatchObject({ operationId, created: true })
      expect(active).toMatchObject({ state: "active", phase: "queued" })
      expect(cancelled).toMatchObject({ status: "cancelled" })
      expect(stored).toMatchObject({ status: "found" })

      yield* Scope.close(clientScope, Exit.void)
      yield* Scope.close(serverScope, Exit.void)
    }).pipe(Effect.provide(tempResourcesLayer)),
  )

  it.effect(
    "finishes an admitted cancellation after socket disconnect and during server close",
    () =>
      Effect.gen(function* () {
        const tempResources = yield* TempResources
        const runtimeDirectory = yield* tempResources.makeTempDirectoryScoped({
          prefix: "dd-walkthrough-cancel-",
        })
        const socketPath = `${runtimeDirectory}/core.sock`
        const serverScope = yield* Scope.make()
        const clientScope = yield* Scope.make()
        const cancellationStarted = yield* Deferred.make<void>()
        const releaseCancellation = yield* Deferred.make<void>()
        const cancellationCompleted = yield* Deferred.make<void>()
        const cancelled = yield* Ref.make(false)
        const cancellationOperationsLayer = Layer.succeed(
          CoreOperationService,
          CoreOperationService.of({
            start: Effect.void,
            methods: unavailableMethods,
            reviewAgents: unusedReviewAgents,
            walkthroughs: {
              resolveGeneration: () => Effect.succeed(reviewGeneration),
              startGeneration: () => Effect.die("Unexpected walkthrough start"),
              getSnapshot: () =>
                Ref.get(cancelled).pipe(
                  Effect.map((isCancelled) => (isCancelled ? cancelledOperation : activeOperation)),
                ),
              cancelSnapshot: () =>
                Deferred.succeed(cancellationStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCancellation)),
                  Effect.andThen(Ref.set(cancelled, true)),
                  Effect.andThen(Deferred.succeed(cancellationCompleted, undefined)),
                  Effect.as(cancelledOperation),
                ),
              getStored: () => Effect.die("Unexpected legacy walkthrough cache read"),
              getStoredGeneration: () => Effect.die("Unexpected walkthrough cache read"),
              getCached: () => Effect.die("Unexpected walkthrough cache read"),
            },
          }),
        )
        const lifecycleLayer = coreLifecycleLayer(requestIdentity)
        const hostLayer = coreWalkthroughRpcSocketHostLayer({
          socketPath,
          token: Redacted.make(transportToken),
        }).pipe(
          Layer.provideMerge(lifecycleLayer),
          Layer.provideMerge(cancellationOperationsLayer),
          Layer.provideMerge(platformLayer),
        )
        const serverContext = yield* Layer.buildWithScope(hostLayer, serverScope)
        const client = yield* makeSocketClient(socketPath, clientScope)
        const healthRequest = HostRequestContext.make({
          ...requestIdentity,
          requestId: HostRequestId.make("h:walkthrough-cancel-health"),
        })
        yield* client["Core.health"](healthRequest).pipe(
          RpcClient.withHeaders({ [CORE_TRANSPORT_TOKEN_HEADER]: transportToken }),
        )
        yield* client["Core.authorizeDatabaseOwnership"](
          AuthorizeDatabaseOwnershipRequest.make({
            ...healthRequest,
            authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-cancel"),
          }),
        )
        yield* Context.get(serverContext, CoreLifecycle).completeRecovery

        const cancellation = yield* client["Walkthroughs.cancel"](
          CancelWalkthroughRequest.make({
            ...requestIdentity,
            requestId: HostRequestId.make("h:walkthrough-cancel-disconnect"),
            operationId,
          }),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(cancellationStarted)
        yield* Scope.close(clientScope, Exit.void)

        const serverClose = yield* Scope.close(serverScope, Exit.void).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        expect(yield* Deferred.isDone(cancellationCompleted)).toBe(false)
        expect(Exit.isSuccess(yield* Fiber.await(cancellation))).toBe(false)

        yield* Deferred.succeed(releaseCancellation, undefined)
        yield* Deferred.await(cancellationCompleted)
        yield* Fiber.join(serverClose)
        expect(yield* Ref.get(cancelled)).toBe(true)
      }).pipe(Effect.provide(tempResourcesLayer)),
  )

  it.effect("interrupts socket start before durable acceptance", () =>
    Effect.gen(function* () {
      const tempResources = yield* TempResources
      const runtimeDirectory = yield* tempResources.makeTempDirectoryScoped({
        prefix: "dd-walkthrough-start-",
      })
      const socketPath = `${runtimeDirectory}/core.sock`
      const serverScope = yield* Scope.make()
      const clientScope = yield* Scope.make()
      const startEntered = yield* Deferred.make<void>()
      const startInterrupted = yield* Deferred.make<void>()
      const acceptanceRecorded = yield* Ref.make(false)
      const startOperationsLayer = Layer.succeed(
        CoreOperationService,
        CoreOperationService.of({
          start: Effect.void,
          methods: unavailableMethods,
          reviewAgents: unusedReviewAgents,
          walkthroughs: {
            resolveGeneration: () => Effect.succeed(reviewGeneration),
            startGeneration: () =>
              Deferred.succeed(startEntered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.andThen(Ref.set(acceptanceRecorded, true)),
                Effect.as(
                  WalkthroughOperationAcceptance.make({
                    created: true,
                    operation: activeOperation,
                  }),
                ),
                Effect.onInterrupt(() => Deferred.succeed(startInterrupted, undefined)),
              ),
            getSnapshot: () => Effect.die("Unexpected walkthrough read"),
            cancelSnapshot: () => Effect.die("Unexpected walkthrough cancellation"),
            getStored: () => Effect.die("Unexpected legacy walkthrough cache read"),
            getStoredGeneration: () => Effect.die("Unexpected walkthrough cache read"),
            getCached: () => Effect.die("Unexpected walkthrough cache read"),
          },
        }),
      )
      const lifecycleLayer = coreLifecycleLayer(requestIdentity)
      const hostLayer = coreWalkthroughRpcSocketHostLayer({
        socketPath,
        token: Redacted.make(transportToken),
      }).pipe(
        Layer.provideMerge(lifecycleLayer),
        Layer.provideMerge(startOperationsLayer),
        Layer.provideMerge(platformLayer),
      )
      const serverContext = yield* Layer.buildWithScope(hostLayer, serverScope)
      const client = yield* makeSocketClient(socketPath, clientScope)
      const healthRequest = HostRequestContext.make({
        ...requestIdentity,
        requestId: HostRequestId.make("h:walkthrough-start-before-health"),
      })
      yield* client["Core.health"](healthRequest).pipe(
        RpcClient.withHeaders({ [CORE_TRANSPORT_TOKEN_HEADER]: transportToken }),
      )
      yield* client["Core.authorizeDatabaseOwnership"](
        AuthorizeDatabaseOwnershipRequest.make({
          ...healthRequest,
          authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-start-before"),
        }),
      )
      yield* Context.get(serverContext, CoreLifecycle).completeRecovery

      const start = yield* client["Walkthroughs.start"](
        StartWalkthroughRequest.make({
          ...requestIdentity,
          requestId: HostRequestId.make("h:walkthrough-start-before"),
          target,
          regenerate: false,
          idempotencyKey: WalkthroughIdempotencyKey.make("w:start-before"),
        }),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(startEntered)
      yield* Scope.close(clientScope, Exit.void)
      yield* Deferred.await(startInterrupted).pipe(Effect.timeout("1 second"))
      expect(Exit.isSuccess(yield* Fiber.await(start))).toBe(false)
      expect(yield* Ref.get(acceptanceRecorded)).toBe(false)

      yield* Scope.close(serverScope, Exit.void)
    }).pipe(Effect.provide(tempResourcesLayer)),
  )

  it.effect("keeps the Core-owned worker alive after socket disconnect following acceptance", () =>
    Effect.gen(function* () {
      const tempResources = yield* TempResources
      const runtimeDirectory = yield* tempResources.makeTempDirectoryScoped({
        prefix: "dd-walkthrough-worker-",
      })
      const socketPath = `${runtimeDirectory}/core.sock`
      const serverScope = yield* Scope.make()
      const clientScope = yield* Scope.make()
      const acceptanceCommitted = yield* Deferred.make<void>()
      const releaseAcceptanceResponse = yield* Deferred.make<void>()
      const workerStarted = yield* Deferred.make<void>()
      const releaseWorker = yield* Deferred.make<void>()
      const workerCompleted = yield* Deferred.make<void>()
      const acceptanceRecorded = yield* Ref.make(false)
      const startOperationsLayer = Layer.effect(
        CoreOperationService,
        Effect.gen(function* () {
          const workers = yield* FiberSet.make<void, never>()
          return CoreOperationService.of({
            start: Effect.void,
            methods: unavailableMethods,
            reviewAgents: unusedReviewAgents,
            walkthroughs: {
              resolveGeneration: () => Effect.succeed(reviewGeneration),
              startGeneration: () =>
                Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* Ref.set(acceptanceRecorded, true)
                    yield* FiberSet.run(
                      workers,
                      Deferred.succeed(workerStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseWorker)),
                        Effect.andThen(Deferred.succeed(workerCompleted, undefined)),
                      ),
                    )
                    yield* Deferred.succeed(acceptanceCommitted, undefined)
                    yield* Deferred.await(releaseAcceptanceResponse)
                    return WalkthroughOperationAcceptance.make({
                      created: true,
                      operation: activeOperation,
                    })
                  }),
                ),
              getSnapshot: () => Effect.succeed(activeOperation),
              cancelSnapshot: () => Effect.die("Unexpected walkthrough cancellation"),
              getStored: () => Effect.die("Unexpected legacy walkthrough cache read"),
              getStoredGeneration: () => Effect.die("Unexpected walkthrough cache read"),
              getCached: () => Effect.die("Unexpected walkthrough cache read"),
            },
          })
        }),
      )
      const lifecycleLayer = coreLifecycleLayer(requestIdentity)
      const hostLayer = coreWalkthroughRpcSocketHostLayer({
        socketPath,
        token: Redacted.make(transportToken),
      }).pipe(
        Layer.provideMerge(lifecycleLayer),
        Layer.provideMerge(startOperationsLayer),
        Layer.provideMerge(platformLayer),
      )
      const serverContext = yield* Layer.buildWithScope(hostLayer, serverScope)
      const client = yield* makeSocketClient(socketPath, clientScope)
      const healthRequest = HostRequestContext.make({
        ...requestIdentity,
        requestId: HostRequestId.make("h:walkthrough-worker-health"),
      })
      yield* client["Core.health"](healthRequest).pipe(
        RpcClient.withHeaders({ [CORE_TRANSPORT_TOKEN_HEADER]: transportToken }),
      )
      yield* client["Core.authorizeDatabaseOwnership"](
        AuthorizeDatabaseOwnershipRequest.make({
          ...healthRequest,
          authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-worker"),
        }),
      )
      yield* Context.get(serverContext, CoreLifecycle).completeRecovery

      const start = yield* client["Walkthroughs.start"](
        StartWalkthroughRequest.make({
          ...requestIdentity,
          requestId: HostRequestId.make("h:walkthrough-worker-start"),
          target,
          regenerate: false,
          idempotencyKey: WalkthroughIdempotencyKey.make("w:worker-start"),
        }),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(acceptanceCommitted)
      yield* Deferred.await(workerStarted)
      yield* Scope.close(clientScope, Exit.void)
      yield* Deferred.succeed(releaseAcceptanceResponse, undefined)
      expect(Exit.isSuccess(yield* Fiber.await(start))).toBe(false)
      expect(yield* Ref.get(acceptanceRecorded)).toBe(true)
      expect(yield* Deferred.isDone(workerCompleted)).toBe(false)

      yield* Deferred.succeed(releaseWorker, undefined)
      yield* Deferred.await(workerCompleted)
      yield* Scope.close(serverScope, Exit.void)
    }).pipe(Effect.provide(tempResourcesLayer)),
  )

  it.effect("bounds queued socket work and interrupts it when the client disconnects", () =>
    Effect.gen(function* () {
      const tempResources = yield* TempResources
      const runtimeDirectory = yield* tempResources.makeTempDirectoryScoped({
        prefix: "dd-walkthrough-pressure-",
      })
      const socketPath = `${runtimeDirectory}/core.sock`
      const serverScope = yield* Scope.make()
      const clientScope = yield* Scope.make()
      const saturated = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const drained = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const active = yield* Ref.make(0)
      const maximumActive = yield* Ref.make(0)
      const interruptedCount = yield* Ref.make(0)
      const pressureOperationsLayer = Layer.succeed(
        CoreOperationService,
        CoreOperationService.of({
          start: Effect.void,
          methods: unavailableMethods,
          reviewAgents: unusedReviewAgents,
          walkthroughs: {
            resolveGeneration: () => Effect.succeed(reviewGeneration),
            startGeneration: () => Effect.die("Unexpected walkthrough start"),
            getSnapshot: () =>
              Effect.gen(function* () {
                const count = yield* Ref.updateAndGet(active, (value) => value + 1)
                yield* Ref.update(maximumActive, (value) => Math.max(value, count))
                if (count === CORE_RPC_MAX_CONCURRENCY) {
                  yield* Deferred.succeed(saturated, undefined)
                }
                yield* Deferred.await(release)
                return activeOperation
              }).pipe(
                Effect.onInterrupt(() =>
                  Ref.updateAndGet(interruptedCount, (value) => value + 1).pipe(
                    Effect.flatMap((count) =>
                      count === CORE_RPC_MAX_CONCURRENCY
                        ? Deferred.succeed(interrupted, undefined)
                        : Effect.void,
                    ),
                  ),
                ),
                Effect.ensuring(
                  Ref.updateAndGet(active, (value) => value - 1).pipe(
                    Effect.flatMap((count) =>
                      count === 0 ? Deferred.succeed(drained, undefined) : Effect.void,
                    ),
                  ),
                ),
              ),
            cancelSnapshot: () => Effect.die("Unexpected walkthrough cancellation"),
            getStored: () => Effect.die("Unexpected legacy walkthrough cache read"),
            getStoredGeneration: () => Effect.die("Unexpected walkthrough cache read"),
            getCached: () => Effect.die("Unexpected walkthrough cache read"),
          },
        }),
      )
      const lifecycleLayer = coreLifecycleLayer(requestIdentity)
      const hostLayer = coreWalkthroughRpcSocketHostLayer({
        socketPath,
        token: Redacted.make(transportToken),
      }).pipe(
        Layer.provideMerge(lifecycleLayer),
        Layer.provideMerge(pressureOperationsLayer),
        Layer.provideMerge(platformLayer),
      )
      const serverContext = yield* Layer.buildWithScope(hostLayer, serverScope)
      const client = yield* makeSocketClient(socketPath, clientScope)
      const healthRequest = HostRequestContext.make({
        ...requestIdentity,
        requestId: HostRequestId.make("h:walkthrough-pressure"),
      })
      yield* client["Core.health"](healthRequest).pipe(
        RpcClient.withHeaders({ [CORE_TRANSPORT_TOKEN_HEADER]: transportToken }),
      )
      yield* client["Core.authorizeDatabaseOwnership"](
        AuthorizeDatabaseOwnershipRequest.make({
          ...healthRequest,
          authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-pressure"),
        }),
      )
      yield* Context.get(serverContext, CoreLifecycle).completeRecovery

      const calls = yield* Effect.forEach(
        Array.from({ length: CORE_RPC_MAX_CONCURRENCY }, (_, index) => index),
        (index) =>
          client["Walkthroughs.getOperation"](
            GetWalkthroughOperationRequest.make({
              ...requestIdentity,
              requestId: HostRequestId.make(`h:pressure-${String(index)}`),
              operationId,
            }),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(saturated)

      expect(yield* Ref.get(maximumActive)).toBe(CORE_RPC_MAX_CONCURRENCY)
      const overflow = yield* client["Walkthroughs.getOperation"](
        GetWalkthroughOperationRequest.make({
          ...requestIdentity,
          requestId: HostRequestId.make("h:pressure-rejected"),
          operationId,
        }),
      ).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect(yield* Ref.get(maximumActive)).toBe(CORE_RPC_MAX_CONCURRENCY)
      const firstOverflowExit = yield* Fiber.await(overflow)
      expect(Exit.isFailure(firstOverflowExit)).toBe(true)
      const repeatedOverflow = yield* client["Walkthroughs.getOperation"](
        GetWalkthroughOperationRequest.make({
          ...requestIdentity,
          requestId: HostRequestId.make("h:pressure-rejected-again"),
          operationId,
        }),
      ).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect(yield* Ref.get(maximumActive)).toBe(CORE_RPC_MAX_CONCURRENCY)
      yield* Scope.close(clientScope, Exit.void)
      const repeatedOverflowExit = yield* Fiber.await(repeatedOverflow)
      expect(Exit.isFailure(repeatedOverflowExit)).toBe(true)
      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      yield* Deferred.await(drained).pipe(Effect.timeout("1 second"))
      expect(yield* Ref.get(active)).toBe(0)

      yield* Fiber.interrupt(calls)
      yield* Scope.close(serverScope, Exit.void)
    }).pipe(Effect.provide(tempResourcesLayer)),
  )
})
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
