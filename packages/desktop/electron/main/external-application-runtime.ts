import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { CoreEventReplayCursor, CoreEventSequence } from "@diffdash/core-rpc/event"
import {
  ApplicationInstanceId,
  DatabaseOwnershipAuthorizationId,
  HostRequestContext,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import { AuthorizeDatabaseOwnershipRequest } from "@diffdash/core-rpc/lifecycle"
import { StartReviewAgentOperationRequest } from "@diffdash/core-rpc/review-agent"
import {
  CancelWalkthroughRequest,
  GetStoredWalkthroughRequest,
  GetWalkthroughOperationRequest,
  StartWalkthroughRequest,
  CurrentWalkthroughPromptVersion,
  WalkthroughIdempotencyKey,
} from "@diffdash/core-rpc/walkthrough"
import {
  WalkthroughStartBridgeFailure,
  WalkthroughStartBridgeResult,
  type WalkthroughBridgeStartRequest,
} from "@diffdash/protocol/walkthrough-operation"
import {
  WalkthroughCancelBridgeFailure,
  WalkthroughCancelBridgeResult,
  WalkthroughGetStoredBridgeFailure,
  WalkthroughGetStoredBridgeResult,
  WalkthroughGetOperationBridgeFailure,
  WalkthroughGetOperationBridgeResult,
  WalkthroughOperationBridgeHint,
} from "@diffdash/protocol/walkthrough-operation-state"
import { TempResources } from "@diffdash/process/temp-resource"
import { Effect, Exit, Layer, Schema, Scope, Stream } from "effect"
import { randomUUID } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { ApplicationRuntime } from "./application-runtime"
import { makeBunRuntimeQualificationHooks } from "./bun-runtime-qualification-hooks"
import { verifyPackagedCoreArtifact } from "./core-artifact"
import {
  discoverBunRuntimeCandidates,
  qualifyBunRuntime,
  startCoreBunProcess,
} from "./core-bun-runtime"
import { bootstrapCoreHost, type CoreHostBootstrapSession } from "./core-host-bootstrap"
import { makeCoreHostFallbackLatch } from "./core-host-fallback-latch"
import {
  bunQualificationCandidateError,
  coreHostStartupCandidateError,
  selectCoreHost,
  type CoreHostCandidate,
} from "./core-host-selection"
import { makeCoreHostCrashCircuit, superviseReadyCoreHost } from "./core-host-supervisor"
import type { CoreProcessHandle } from "./core-process-launcher"
import type { CoreRpcClient } from "./core-rpc-client"
import { startCoreUtilityProcessManaged } from "./core-utility-process-launcher"
import type { DesktopHostConfiguration } from "./desktop-host-configuration"
import { createProgressiveReviewApiGateway } from "./progressive-review-api-gateway"

const platformLayer = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  TempResources.layer.pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
)

/** Creates the production Electron adapter backed exclusively by standalone Core RPC. */
export const createExternalApplicationRuntime = (
  configuration: DesktopHostConfiguration,
  e2eCoreEnvironmentNames: ReadonlyArray<string> = [],
): ApplicationRuntime => {
  const runtime = { runPromise: Effect.runPromise }
  let session: CoreHostBootstrapSession | null = null
  let applicationScope: Scope.Closeable | null = null
  let startPromise: Promise<void> | null = null
  let disposing = false
  const crashCircuitPromise = runtime.runPromise(
    makeCoreHostCrashCircuit({ maximumCrashes: 3, windowMilliseconds: 60_000 }),
  )

  const requestContext = (): HostRequestContext => {
    if (session === null) throw new Error("DiffDash Core is not started.")
    return HostRequestContext.make({
      applicationInstanceId: session.applicationInstanceId,
      processEpoch: session.processEpoch,
      requestId: HostRequestId.make(`h:${randomUUID()}`),
    })
  }

  const invoke = <A, E>(
    operation: (client: CoreRpcClient["Service"]) => Effect.Effect<A, E>,
  ): Promise<A> => {
    const current = session
    if (current?.client === undefined) throw new Error("DiffDash Core is not started.")
    return runtime.runPromise(operation(current.client))
  }

  const runReviewThreadAgent: ApplicationRuntime["core"]["runReviewThreadAgent"] = async (
    input,
    options,
  ) => {
    const reviewAgentRequest = Schema.decodeUnknownSync(StartReviewAgentOperationRequest)({
      ...requestContext(),
      ...input,
    })
    options?.onReviewThreadAgentProgress?.("reviewing")
    const thread = await invoke((client) => client.runReviewThreadAgent(reviewAgentRequest))
    options?.onReviewThreadAgentProgress?.("restoring-workspace")
    return thread
  }

  const core: ApplicationRuntime["core"] = {
    analyticsCapture: (input) =>
      invoke((client) => client.analyticsCapture({ ...requestContext(), ...input })),
    analyticsStart: (input) =>
      invoke((client) => client.analyticsStart({ ...requestContext(), ...input })),
    agentProvidersGetCatalog: (input) =>
      invoke((client) => client.agentProvidersGetCatalog({ ...requestContext(), ...input })),
    appDiagnostics: (input) =>
      invoke((client) => client.appDiagnostics({ ...requestContext(), ...input })),
    appInstallDiffDashCli: (input) =>
      invoke((client) => client.appInstallDiffDashCli({ ...requestContext(), ...input })),
    appOpenLocalRepositoryFile: (input) =>
      invoke((client) => client.appOpenLocalRepositoryFile({ ...requestContext(), ...input })),
    appOpenRepositoryComparisonFile: (input) =>
      invoke((client) => client.appOpenRepositoryComparisonFile({ ...requestContext(), ...input })),
    appOpenRepositoryFile: (input) =>
      invoke((client) => client.appOpenRepositoryFile({ ...requestContext(), ...input })),
    appStateGet: (input) =>
      invoke((client) => client.appStateGet({ ...requestContext(), ...input })),
    appStateUpdate: (input) =>
      invoke((client) => client.appStateUpdate({ ...requestContext(), ...input })),
    listProviders: (input) =>
      invoke((client) => client.listProviders({ ...requestContext(), ...input })),
    submitHostedReviewDecision: (input) =>
      invoke((client) => client.submitHostedReviewDecision({ ...requestContext(), ...input })),
    getHostedReviewDecision: (input) =>
      invoke((client) => client.getHostedReviewDecision({ ...requestContext(), ...input })),
    listHostedReviews: (input) =>
      invoke((client) => client.listHostedReviews({ ...requestContext(), ...input })),
    listAssignedHostedReviews: (input) =>
      invoke((client) => client.listAssignedHostedReviews({ ...requestContext(), ...input })),
    listHostedRepositorySearchScopes: (input) =>
      invoke((client) =>
        client.listHostedRepositorySearchScopes({ ...requestContext(), ...input }),
      ),
    searchHostedRepositories: (input) =>
      invoke((client) => client.searchHostedRepositories({ ...requestContext(), ...input })),
    resolveLocalBranch: (input) =>
      invoke((client) => client.resolveLocalBranch({ ...requestContext(), ...input })),
    resolveLastCommit: (input) =>
      invoke((client) => client.resolveLastCommit({ ...requestContext(), ...input })),
    resolveRepositoryComparison: (input) =>
      invoke((client) => client.resolveRepositoryComparison({ ...requestContext(), ...input })),
    acquireHostedReviewSnapshot: (input) =>
      invoke((client) => client.acquireHostedReviewSnapshot({ ...requestContext(), ...input })),
    acquireLocalReviewSnapshot: (input) =>
      invoke((client) => client.acquireLocalReviewSnapshot({ ...requestContext(), ...input })),
    acquireRepositoryComparisonSnapshot: (input) =>
      invoke((client) =>
        client.acquireRepositoryComparisonSnapshot({ ...requestContext(), ...input }),
      ),
    favoriteRemoteRepository: (input) =>
      invoke((client) => client.favoriteRemoteRepository({ ...requestContext(), ...input })),
    forgetRepository: (input) =>
      invoke((client) => client.forgetRepository({ ...requestContext(), ...input })),
    installRepository: (input) =>
      invoke((client) => client.installRepository({ ...requestContext(), ...input })),
    linkRepository: (input) =>
      invoke((client) => client.linkRepository({ ...requestContext(), ...input })),
    listRepositories: (input) =>
      invoke((client) => client.listRepositories({ ...requestContext(), ...input })),
    openProject: (input) =>
      invoke((client) => client.openProject({ ...requestContext(), ...input })),
    repairRepositoryIdentities: (input) =>
      invoke((client) => client.repairRepositoryIdentities({ ...requestContext(), ...input })),
    resourceDiagnostics: (input) =>
      invoke((client) => client.resourceDiagnostics({ ...requestContext(), ...input })),
    clearDisposableResources: (input) =>
      invoke((client) => client.clearDisposableResources({ ...requestContext(), ...input })),
    e2eReviewLifecycleDiagnostics: () =>
      invoke((client) => client.e2eReviewLifecycleDiagnostics(requestContext())),
    e2eHoldNextReviewAcquisition: () =>
      invoke((client) => client.e2eHoldNextReviewAcquisition(requestContext())),
    setRepositoryFavorite: (input) =>
      invoke((client) => client.setRepositoryFavorite({ ...requestContext(), ...input })),
    projectWorkspaceGet: (input) =>
      invoke((client) => client.projectWorkspaceGet({ ...requestContext(), ...input })),
    projectWorkspaceSave: (input) =>
      invoke((client) => client.projectWorkspaceSave({ ...requestContext(), ...input })),
    addReviewThreadUserMessage: (input) =>
      invoke((client) => client.addReviewThreadUserMessage({ ...requestContext(), ...input })),
    createReviewThread: (input) =>
      invoke((client) => client.createReviewThread({ ...requestContext(), ...input })),
    getReviewThread: (input) =>
      invoke((client) => client.getReviewThread({ ...requestContext(), ...input })),
    listReviewThreads: (input) =>
      invoke((client) => client.listReviewThreads({ ...requestContext(), ...input })),
    runReviewThreadAgent,
    settingsGet: (input) =>
      invoke((client) => client.settingsGet({ ...requestContext(), ...input })),
    settingsUpdate: (input) =>
      invoke((client) => client.settingsUpdate({ ...requestContext(), ...input })),
    listViewedFiles: (input) =>
      invoke((client) => client.listViewedFiles({ ...requestContext(), ...input })),
    listLocalViewedFiles: (input) =>
      invoke((client) => client.listLocalViewedFiles({ ...requestContext(), ...input })),
    setViewedFile: (input) =>
      invoke((client) => client.setViewedFile({ ...requestContext(), ...input })),
    setLocalViewedFile: (input) =>
      invoke((client) => client.setLocalViewedFile({ ...requestContext(), ...input })),
    listRepositoryComparisonViewedFiles: (input) =>
      invoke((client) =>
        client.listRepositoryComparisonViewedFiles({ ...requestContext(), ...input }),
      ),
    setRepositoryComparisonViewedFile: (input) =>
      invoke((client) =>
        client.setRepositoryComparisonViewedFile({ ...requestContext(), ...input }),
      ),
  }

  let eventCursor: CoreEventReplayCursor | null = null

  const readReplayedWalkthroughHints = async (): Promise<
    readonly WalkthroughOperationBridgeHint[]
  > => {
    const current = session
    if (current?.stateDeliveryClient === undefined) return []
    const cursor =
      eventCursor?.processEpoch === current.processEpoch
        ? eventCursor
        : CoreEventReplayCursor.make({
            processEpoch: current.processEpoch,
            sequence: CoreEventSequence.make(0),
          })
    const replay = await runtime.runPromise(
      current.stateDeliveryClient.replayEvents({ context: requestContext(), cursor }),
    )
    if (replay.kind === "resyncRequired") {
      eventCursor = CoreEventReplayCursor.make({
        processEpoch: replay.processEpoch,
        sequence: CoreEventSequence.make(0),
      })
      return []
    }
    const latest = replay.events.at(-1)?.metadata.sequence ?? cursor.sequence
    eventCursor = CoreEventReplayCursor.make({
      processEpoch: replay.processEpoch,
      sequence: latest,
    })
    return replay.events.flatMap((hint) => {
      const subject = hint.metadata.subject
      if (
        (subject.kind !== "operation" && subject.kind !== "generationOperation") ||
        hint.kind === "commandCommitted"
      ) {
        return []
      }
      return [
        Schema.decodeUnknownSync(WalkthroughOperationBridgeHint)({
          applicationInstanceId: hint.metadata.applicationInstanceId,
          processEpoch: hint.metadata.processEpoch,
          sequence: hint.metadata.sequence,
          operationId: subject.operationId,
          stateVersion: hint.stateVersion,
          kind: hint.kind,
        }),
      ]
    })
  }
  let replayPromise: Promise<readonly WalkthroughOperationBridgeHint[]> = Promise.resolve([])
  const replayWalkthroughHints = () => {
    const next = replayPromise.then(readReplayedWalkthroughHints, readReplayedWalkthroughHints)
    replayPromise = next
    return next
  }

  const start = (): Promise<void> => {
    if (startPromise !== null) return startPromise
    const launch = runtime.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        applicationScope = scope
        let processHandle: CoreProcessHandle | null = null
        const moduleDirectory = dirname(fileURLToPath(import.meta.url))
        const artifactDirectory = configuration.application.packaged
          ? join(process.resourcesPath, "core")
          : resolve(moduleDirectory, "../../.generated/core")
        const artifact = yield* verifyPackagedCoreArtifact(artifactDirectory)
        const applicationInstanceId = ApplicationInstanceId.make(randomUUID())
        const privateRuntimeDirectory = tmpdir()
        const bootstrap = (
          startTransport: Parameters<typeof bootstrapCoreHost>[0]["startTransport"],
        ): CoreHostCandidate["start"] =>
          bootstrapCoreHost({
            artifact,
            applicationInstanceId,
            temporaryDirectory: privateRuntimeDirectory,
            startTransport,
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provide(platformLayer),
            Effect.mapError(() => coreHostStartupCandidateError()),
          )
        const utilityCandidate: CoreHostCandidate = {
          host: "utility",
          qualify: Effect.void,
          start: bootstrap((transport) =>
            startCoreUtilityProcessManaged({
              configuration: transport,
              databasePath: configuration.core.paths.database,
              statePath: configuration.core.paths.state,
              coreConfiguration: configuration.core,
            }).pipe(
              Effect.tap((handle) =>
                Effect.sync(() => {
                  processHandle = handle
                }),
              ),
              Effect.asVoid,
            ),
          ),
        }
        const bunQualificationHooks = makeBunRuntimeQualificationHooks({
          applicationCwd: artifactDirectory,
          artifact,
          coreConfiguration: configuration.core,
          environment: process.env,
          temporaryDirectory: privateRuntimeDirectory,
        })
        const bunCandidates = discoverBunRuntimeCandidates({
          environment: process.env,
          homeDirectory: homedir(),
          platform: process.platform,
        }).map(
          (candidate): CoreHostCandidate => ({
            host: "bun",
            qualify: qualifyBunRuntime(
              candidate,
              {
                minimumVersion: artifact.runtime.bun.minimumVersion,
                architecture: configuration.application.architecture,
              },
              bunQualificationHooks,
            ).pipe(Effect.asVoid, Effect.mapError(bunQualificationCandidateError)),
            start: bootstrap((transport) =>
              startCoreBunProcess({
                applicationCwd: artifactDirectory,
                bunExecutablePath: candidate.executablePath,
                configuration: transport,
                databasePath: configuration.core.paths.database,
                environment: process.env,
                additionalAllowedEnvironmentNames: e2eCoreEnvironmentNames,
                statePath: configuration.core.paths.state,
                coreConfiguration: configuration.core,
              }).pipe(
                Effect.tap((handle) =>
                  Effect.sync(() => {
                    processHandle = handle
                  }),
                ),
                Effect.asVoid,
              ),
            ),
          }),
        )
        const latch = makeCoreHostFallbackLatch(
          join(dirname(configuration.core.paths.state), "core-no-fallback.json"),
        )
        const selected = yield* selectCoreHost(
          configuration.policies.coreHostMode,
          [...bunCandidates, utilityCandidate],
          latch,
        )
        const established = selected.session
        const client = established.client
        if (client === undefined) return yield* Effect.die("DiffDash Core client is unavailable.")
        yield* selected.authorizeDatabaseOwnership(
          AuthorizeDatabaseOwnershipRequest.make({
            applicationInstanceId: established.applicationInstanceId,
            processEpoch: established.processEpoch,
            requestId: HostRequestId.make(`h:${randomUUID()}`),
            authorizationId: DatabaseOwnershipAuthorizationId.make(randomUUID()),
          }),
        )
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const health = yield* client.health(
            HostRequestContext.make({
              applicationInstanceId: established.applicationInstanceId,
              processEpoch: established.processEpoch,
              requestId: HostRequestId.make(`h:${randomUUID()}`),
            }),
          )
          if (health.lifecycle === "ready") {
            session = established
            if (processHandle === null) return yield* Effect.die("DiffDash Core handle is missing.")
            const crashCircuit = yield* Effect.promise(() => crashCircuitPromise)
            const supervisedProcess = processHandle
            void runtime
              .runPromise(
                superviseReadyCoreHost({
                  host: selected.host,
                  process: supervisedProcess,
                  isDraining: Effect.sync(() => disposing),
                  cleanupAfterHostDeath: Effect.sync(() => {
                    if (session === established) session = null
                    if (applicationScope === scope) applicationScope = null
                  }).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
                  crashCircuit,
                }),
              )
              .then((result) => {
                if (result.outcome !== "restart-eligible" || disposing) return
                startPromise = null
                void start().catch(() => undefined)
              })
              .catch(() => undefined)
            return
          }
          if (health.lifecycle === "failed" || health.lifecycle === "draining") {
            return yield* Effect.die("DiffDash Core failed before becoming ready.")
          }
          yield* Effect.sleep("10 millis")
        }
        return yield* Effect.die("DiffDash Core did not become ready before startup timed out.")
      }).pipe(Effect.provide(platformLayer)),
    )
    startPromise = launch.catch((error) => {
      startPromise = null
      throw error
    })
    return startPromise
  }

  const dispose = async (): Promise<void> => {
    disposing = true
    const current = session
    session = null
    if (current !== null) {
      await runtime
        .runPromise(current.client?.shutdown(requestContextFor(current)) ?? Effect.void)
        .catch(() => undefined)
    }
    if (applicationScope !== null) {
      await runtime.runPromise(Scope.close(applicationScope, Exit.void)).catch(() => undefined)
      applicationScope = null
    }
  }

  const progressiveReviews = createProgressiveReviewApiGateway(
    {
      openSession: (request) =>
        requireClient().then((client) => runtime.runPromise(client.openReviewSession(request))),
      currentSession: (request) =>
        requireClient().then((client) => runtime.runPromise(client.currentReviewSession(request))),
      closeSession: (request) =>
        requireClient().then((client) => runtime.runPromise(client.closeReviewSession(request))),
      inventory: (request) =>
        requireClient().then((client) => runtime.runPromise(client.reviewInventory(request))),
      readRange: (request) =>
        requireClient().then((client) => runtime.runPromise(client.readReviewRange(request))),
      waitForRange: (request) =>
        requireClient().then((client) => runtime.runPromise(client.waitForReviewRange(request))),
      resolveTarget: (request) =>
        requireClient().then((client) => runtime.runPromise(client.resolveReviewTarget(request))),
      search: (request) => ({
        async *[Symbol.asyncIterator]() {
          const client = await requireClient()
          yield* Stream.toAsyncIterable(client.searchReview(request))
        },
      }),
    },
    requestContext,
  )

  const requireClient = async () => {
    const client = session?.client
    if (client === undefined) throw new Error("DiffDash Core is not started.")
    return client
  }

  return {
    start,
    core,
    walkthroughOperations: {
      start: async (input: WalkthroughBridgeStartRequest) => {
        const current = session
        if (current?.client === undefined) throw new Error("DiffDash Core is not started.")
        try {
          const accepted = await runtime.runPromise(
            current.client.startWalkthrough(
              StartWalkthroughRequest.make({
                ...requestContext(),
                target: input.target,
                regenerate: input.regenerate,
                idempotencyKey: WalkthroughIdempotencyKey.make(input.idempotencyKey),
              }),
            ),
          )
          return Schema.decodeUnknownSync(WalkthroughStartBridgeResult)({
            _tag: "Success",
            value: accepted,
          })
        } catch (error) {
          return {
            _tag: "Failure" as const,
            error: Schema.decodeUnknownSync(WalkthroughStartBridgeFailure)(error),
          }
        }
      },
      getOperation: async ({ operationId }) => {
        const current = session
        if (current?.client === undefined) throw new Error("DiffDash Core is not started.")
        const context = requestContext()
        try {
          const operation = await runtime.runPromise(
            current.client.getWalkthroughOperation(
              GetWalkthroughOperationRequest.make({ ...context, operationId }),
            ),
          )
          return Schema.decodeUnknownSync(WalkthroughGetOperationBridgeResult)({
            _tag: "Success",
            value: { ...context, operationId, operation },
          })
        } catch (error) {
          return {
            _tag: "Failure" as const,
            error: Schema.decodeUnknownSync(WalkthroughGetOperationBridgeFailure)(error),
          }
        }
      },
      cancel: async ({ operationId }) => {
        const current = session
        if (current?.client === undefined) throw new Error("DiffDash Core is not started.")
        const context = requestContext()
        try {
          const result = await runtime.runPromise(
            current.client.cancelWalkthrough(
              CancelWalkthroughRequest.make({ ...context, operationId }),
            ),
          )
          return Schema.decodeUnknownSync(WalkthroughCancelBridgeResult)({
            _tag: "Success",
            value: { ...context, operationId, status: result.status, operation: result.operation },
          })
        } catch (error) {
          return {
            _tag: "Failure" as const,
            error: Schema.decodeUnknownSync(WalkthroughCancelBridgeFailure)(error),
          }
        }
      },
      getStored: async ({ target }) => {
        const current = session
        if (current?.client === undefined) throw new Error("DiffDash Core is not started.")
        try {
          const result = await runtime.runPromise(
            current.client.getStoredWalkthrough(
              GetStoredWalkthroughRequest.make({
                ...requestContext(),
                target,
                promptVersion: CurrentWalkthroughPromptVersion,
              }),
            ),
          )
          return Schema.decodeUnknownSync(WalkthroughGetStoredBridgeResult)(
            result.status === "found"
              ? { _tag: "Success", value: { status: "found", stored: result.stored } }
              : { _tag: "Success", value: { status: "notFound" } },
          )
        } catch (error) {
          return {
            _tag: "Failure" as const,
            error: Schema.decodeUnknownSync(WalkthroughGetStoredBridgeFailure)(error),
          }
        }
      },
      replayHints: replayWalkthroughHints,
    },
    progressiveReviews,
    dispose,
  }
}

const requestContextFor = (session: CoreHostBootstrapSession): HostRequestContext =>
  HostRequestContext.make({
    applicationInstanceId: session.applicationInstanceId,
    processEpoch: session.processEpoch,
    requestId: HostRequestId.make(`h:${randomUUID()}`),
  })
