import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import {
  CoreMethod,
  type CoreMethod as CoreMethodType,
  type CoreMethodOutput,
} from "@diffdash/core"
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
import { InvokeChannel } from "@diffdash/protocol/channels"
import type { InvokeResponse } from "@diffdash/protocol/ipc"
import { TempResources } from "@diffdash/process/temp-resource"
import { Cause, Effect, Exit, Layer, Schema, Scope, Stream } from "effect"
import { RpcClientDefect, RpcClientError } from "effect/unstable/rpc/RpcClientError"
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
const CORE_SHUTDOWN_REQUEST_TIMEOUT = "1 second"
const CORE_GRACEFUL_EXIT_TIMEOUT = "3 seconds"

/** Runs one Core client operation while preserving its expected failure as the Promise rejection. */
export const runExternalCoreOperationPromise = async <A, E>(
  operation: Effect.Effect<A, E>,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(operation)
  return Exit.match(exit, {
    onFailure: (cause) => {
      const failure = Cause.squash(cause)
      return Promise.reject(
        Schema.is(RpcClientDefect)(failure)
          ? failure.cause
          : Schema.is(RpcClientError)(failure) && Schema.is(RpcClientDefect)(failure.reason)
            ? failure.reason.cause
            : failure,
      )
    },
    onSuccess: (value) => Promise.resolve(value),
  })
}

/** Creates the production Electron adapter backed exclusively by standalone Core RPC. */
export const createExternalApplicationRuntime = (
  configuration: DesktopHostConfiguration,
  e2eCoreEnvironmentNames: ReadonlyArray<string> = [],
): ApplicationRuntime => {
  const runtime = { runPromise: Effect.runPromise }
  let session: CoreHostBootstrapSession | null = null
  let applicationScope: Scope.Closeable | null = null
  let applicationProcess: CoreProcessHandle | null = null
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

  const invokeRaw = <A, E>(
    operation: (client: CoreRpcClient["Service"]) => Effect.Effect<A, E>,
  ): Promise<A> => {
    const current = session
    if (current?.client === undefined) throw new Error("DiffDash Core is not started.")
    return runExternalCoreOperationPromise(operation(current.client))
  }

  const invokeChannel = <Channel extends InvokeChannel, E>(
    _channel: Channel,
    operation: (client: CoreRpcClient["Service"]) => Effect.Effect<InvokeResponse<Channel>, E>,
  ): Promise<InvokeResponse<Channel>> => invokeRaw(operation)

  const invoke = <Method extends CoreMethodType, E>(
    _method: Method,
    operation: (client: CoreRpcClient["Service"]) => Effect.Effect<CoreMethodOutput<Method>, E>,
  ): Promise<CoreMethodOutput<Method>> => invokeRaw(operation)

  const runReviewThreadAgent: ApplicationRuntime["core"]["runReviewThreadAgent"] = async (
    input,
    options,
  ) => {
    const reviewAgentRequest = Schema.decodeUnknownSync(StartReviewAgentOperationRequest)({
      ...requestContext(),
      ...input,
    })
    options?.onReviewThreadAgentProgress?.("reviewing")
    const thread = await invoke(CoreMethod.runReviewThreadAgent, (client) =>
      client.runReviewThreadAgent(reviewAgentRequest),
    )
    options?.onReviewThreadAgentProgress?.("restoring-workspace")
    return thread
  }

  const core: ApplicationRuntime["core"] = {
    analyticsCapture: (input) =>
      invoke(CoreMethod.analyticsCapture, (client) =>
        client.analyticsCapture({ ...requestContext(), ...input }),
      ),
    analyticsStart: (input) =>
      invoke(CoreMethod.analyticsStart, (client) =>
        client.analyticsStart({ ...requestContext(), ...input }),
      ),
    agentProvidersGetCatalog: (input) =>
      invoke(CoreMethod.agentProvidersGetCatalog, (client) =>
        client.agentProvidersGetCatalog({ ...requestContext(), ...input }),
      ),
    appDiagnostics: (input) =>
      invoke(CoreMethod.appDiagnostics, (client) =>
        client.appDiagnostics({ ...requestContext(), ...input }),
      ),
    appInstallDiffDashCli: (input) =>
      invoke(CoreMethod.appInstallDiffDashCli, (client) =>
        client.appInstallDiffDashCli({ ...requestContext(), ...input }),
      ),
    // Native file intents terminate in Electron main and never enter renderer IPC.
    appOpenLocalRepositoryFile: (input) =>
      invokeRaw((client) => client.appOpenLocalRepositoryFile({ ...requestContext(), ...input })),
    appOpenRepositoryComparisonFile: (input) =>
      invokeRaw((client) =>
        client.appOpenRepositoryComparisonFile({ ...requestContext(), ...input }),
      ),
    appOpenRepositoryFile: (input) =>
      invokeRaw((client) => client.appOpenRepositoryFile({ ...requestContext(), ...input })),
    appStateGet: (input) =>
      invoke(CoreMethod.appStateGet, (client) =>
        client.appStateGet({ ...requestContext(), ...input }),
      ),
    appStateUpdate: (input) =>
      invoke(CoreMethod.appStateUpdate, (client) =>
        client.appStateUpdate({ ...requestContext(), ...input }),
      ),
    listProviders: (input) =>
      invoke(CoreMethod.listProviders, (client) =>
        client.listProviders({ ...requestContext(), ...input }),
      ),
    submitHostedReviewDecision: (input) =>
      invoke(CoreMethod.submitHostedReviewDecision, (client) =>
        client.submitHostedReviewDecision({ ...requestContext(), ...input }),
      ),
    getHostedReviewDecision: (input) =>
      invoke(CoreMethod.getHostedReviewDecision, (client) =>
        client.getHostedReviewDecision({ ...requestContext(), ...input }),
      ),
    listHostedReviews: (input) =>
      invoke(CoreMethod.listHostedReviews, (client) =>
        client.listHostedReviews({ ...requestContext(), ...input }),
      ),
    listAssignedHostedReviews: (input) =>
      invoke(CoreMethod.listAssignedHostedReviews, (client) =>
        client.listAssignedHostedReviews({ ...requestContext(), ...input }),
      ),
    listHostedRepositorySearchScopes: (input) =>
      invoke(CoreMethod.listHostedRepositorySearchScopes, (client) =>
        client.listHostedRepositorySearchScopes({ ...requestContext(), ...input }),
      ),
    searchHostedRepositories: (input) =>
      invoke(CoreMethod.searchHostedRepositories, (client) =>
        client.searchHostedRepositories({ ...requestContext(), ...input }),
      ),
    resolveLocalBranch: (input) =>
      invoke(CoreMethod.resolveLocalBranch, (client) =>
        client.resolveLocalBranch({ ...requestContext(), ...input }),
      ),
    resolveLastCommit: (input) =>
      invoke(CoreMethod.resolveLastCommit, (client) =>
        client.resolveLastCommit({ ...requestContext(), ...input }),
      ),
    resolveRepositoryComparison: (input) =>
      invoke(CoreMethod.resolveRepositoryComparison, (client) =>
        client.resolveRepositoryComparison({ ...requestContext(), ...input }),
      ),
    acquireHostedReviewSnapshot: (input) =>
      invoke(CoreMethod.acquireHostedReviewSnapshot, (client) =>
        client.acquireHostedReviewSnapshot({ ...requestContext(), ...input }),
      ),
    acquireLocalReviewSnapshot: (input) =>
      invoke(CoreMethod.acquireLocalReviewSnapshot, (client) =>
        client.acquireLocalReviewSnapshot({ ...requestContext(), ...input }),
      ),
    acquireRepositoryComparisonSnapshot: (input) =>
      invoke(CoreMethod.acquireRepositoryComparisonSnapshot, (client) =>
        client.acquireRepositoryComparisonSnapshot({ ...requestContext(), ...input }),
      ),
    favoriteRemoteRepository: (input) =>
      invoke(CoreMethod.favoriteRemoteRepository, (client) =>
        client.favoriteRemoteRepository({ ...requestContext(), ...input }),
      ),
    forgetRepository: (input) =>
      invoke(CoreMethod.forgetRepository, (client) =>
        client.forgetRepository({ ...requestContext(), ...input }),
      ),
    installRepository: (input) =>
      invoke(CoreMethod.installRepository, (client) =>
        client.installRepository({ ...requestContext(), ...input }),
      ),
    linkRepository: (input) =>
      invoke(CoreMethod.linkRepository, (client) =>
        client.linkRepository({ ...requestContext(), ...input }),
      ),
    openCodeWorkspace: (input) =>
      invoke(CoreMethod.openCodeWorkspace, (client) =>
        client.openCodeWorkspace({ ...requestContext(), ...input }),
      ),
    heartbeatCodeWorkspace: (input) =>
      invoke(CoreMethod.heartbeatCodeWorkspace, (client) =>
        client.heartbeatCodeWorkspace({ ...requestContext(), ...input }),
      ),
    releaseCodeWorkspace: (input) =>
      invoke(CoreMethod.releaseCodeWorkspace, (client) =>
        client.releaseCodeWorkspace({ ...requestContext(), ...input }),
      ),
    listCodeWorkspaceDirectory: (input) =>
      invoke(CoreMethod.listCodeWorkspaceDirectory, (client) =>
        client.listCodeWorkspaceDirectory({ ...requestContext(), ...input }),
      ),
    searchCodeWorkspace: (input) =>
      invoke(CoreMethod.searchCodeWorkspace, (client) =>
        client.searchCodeWorkspace({ ...requestContext(), ...input }),
      ),
    readCodeWorkspaceFile: (input) =>
      invoke(CoreMethod.readCodeWorkspaceFile, (client) =>
        client.readCodeWorkspaceFile({ ...requestContext(), ...input }),
      ),
    codeWorkspaceDefinitions: (input) =>
      invoke(CoreMethod.codeWorkspaceDefinitions, (client) =>
        client.codeWorkspaceDefinitions({ ...requestContext(), ...input }),
      ),
    codeWorkspaceReferences: (input) =>
      invoke(CoreMethod.codeWorkspaceReferences, (client) =>
        client.codeWorkspaceReferences({ ...requestContext(), ...input }),
      ),
    codeWorkspaceChanges: (input) =>
      invoke(CoreMethod.codeWorkspaceChanges, (client) =>
        client.codeWorkspaceChanges({ ...requestContext(), ...input }),
      ),
    codeWorkspaceLineChanges: (input) =>
      invoke(CoreMethod.codeWorkspaceLineChanges, (client) =>
        client.codeWorkspaceLineChanges({ ...requestContext(), ...input }),
      ),
    listRepositories: (input) =>
      invoke(CoreMethod.listRepositories, (client) =>
        client.listRepositories({ ...requestContext(), ...input }),
      ),
    openProject: (input) =>
      invoke(CoreMethod.openProject, (client) =>
        client.openProject({ ...requestContext(), ...input }),
      ),
    repairRepositoryIdentities: (input) =>
      invoke(CoreMethod.repairRepositoryIdentities, (client) =>
        client.repairRepositoryIdentities({ ...requestContext(), ...input }),
      ),
    resourceDiagnostics: (input) =>
      invoke(CoreMethod.resourceDiagnostics, (client) =>
        client.resourceDiagnostics({ ...requestContext(), ...input }),
      ),
    clearDisposableResources: (input) =>
      invoke(CoreMethod.clearDisposableResources, (client) =>
        client.clearDisposableResources({ ...requestContext(), ...input }),
      ),
    e2eReviewLifecycleDiagnostics: () =>
      invokeChannel(InvokeChannel.e2eReviewLifecycleDiagnostics, (client) =>
        client.e2eReviewLifecycleDiagnostics(requestContext()),
      ),
    e2eHoldNextReviewAcquisition: () =>
      invokeChannel(InvokeChannel.e2eHoldNextReviewAcquisition, (client) =>
        client.e2eHoldNextReviewAcquisition(requestContext()),
      ),
    setRepositoryFavorite: (input) =>
      invoke(CoreMethod.setRepositoryFavorite, (client) =>
        client.setRepositoryFavorite({ ...requestContext(), ...input }),
      ),
    projectWorkspaceGet: (input) =>
      invoke(CoreMethod.projectWorkspaceGet, (client) =>
        client.projectWorkspaceGet({ ...requestContext(), ...input }),
      ),
    projectWorkspaceSave: (input) =>
      invoke(CoreMethod.projectWorkspaceSave, (client) =>
        client.projectWorkspaceSave({ ...requestContext(), ...input }),
      ),
    listOpenCodeSessions: (input) =>
      invoke(CoreMethod.listOpenCodeSessions, (client) =>
        client.listOpenCodeSessions({ ...requestContext(), ...input }),
      ),
    connectOpenCodeSession: (input) =>
      invoke(CoreMethod.connectOpenCodeSession, (client) =>
        client.connectOpenCodeSession({ ...requestContext(), ...input }),
      ),
    submitComment: (input) =>
      invoke(CoreMethod.submitComment, (client) =>
        client.submitComment({ ...requestContext(), ...input }),
      ),
    addReviewThreadUserMessage: (input) =>
      invoke(CoreMethod.addReviewThreadUserMessage, (client) =>
        client.addReviewThreadUserMessage({ ...requestContext(), ...input }),
      ),
    createReviewThread: (input) =>
      invoke(CoreMethod.createReviewThread, (client) =>
        client.createReviewThread({ ...requestContext(), ...input }),
      ),
    getReviewThread: (input) =>
      invoke(CoreMethod.getReviewThread, (client) =>
        client.getReviewThread({ ...requestContext(), ...input }),
      ),
    listReviewThreads: (input) =>
      invoke(CoreMethod.listReviewThreads, (client) =>
        client.listReviewThreads({ ...requestContext(), ...input }),
      ),
    runReviewThreadAgent,
    settingsGet: (input) =>
      invoke(CoreMethod.settingsGet, (client) =>
        client.settingsGet({ ...requestContext(), ...input }),
      ),
    settingsUpdate: (input) =>
      invoke(CoreMethod.settingsUpdate, (client) =>
        client.settingsUpdate({ ...requestContext(), ...input }),
      ),
    listViewedFiles: (input) =>
      invoke(CoreMethod.listViewedFiles, (client) =>
        client.listViewedFiles({ ...requestContext(), ...input }),
      ),
    listLocalViewedFiles: (input) =>
      invoke(CoreMethod.listLocalViewedFiles, (client) =>
        client.listLocalViewedFiles({ ...requestContext(), ...input }),
      ),
    setViewedFile: (input) =>
      invoke(CoreMethod.setViewedFile, (client) =>
        client.setViewedFile({ ...requestContext(), ...input }),
      ),
    setLocalViewedFile: (input) =>
      invoke(CoreMethod.setLocalViewedFile, (client) =>
        client.setLocalViewedFile({ ...requestContext(), ...input }),
      ),
    listRepositoryComparisonViewedFiles: (input) =>
      invoke(CoreMethod.listRepositoryComparisonViewedFiles, (client) =>
        client.listRepositoryComparisonViewedFiles({ ...requestContext(), ...input }),
      ),
    setRepositoryComparisonViewedFile: (input) =>
      invoke(CoreMethod.setRepositoryComparisonViewedFile, (client) =>
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
        ): CoreHostCandidate["start"] => {
          const options = {
            artifact,
            applicationInstanceId,
            temporaryDirectory: privateRuntimeDirectory,
            startTransport,
          }
          return bootstrapCoreHost(
            process.env.DIFFDASH_E2E_CORE_HOST === undefined
              ? options
              : {
                  ...options,
                  onStateChange: (state) => Effect.log(`[core:bootstrap] ${state}`),
                },
          ).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provide(platformLayer),
            Effect.mapError(() => coreHostStartupCandidateError()),
          )
        }
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
            applicationProcess = processHandle
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
                    if (applicationProcess === supervisedProcess) applicationProcess = null
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
    const currentProcess = applicationProcess
    session = null
    applicationProcess = null
    if (current !== null) {
      await runtime
        .runPromise(
          (current.client?.shutdown(requestContextFor(current)) ?? Effect.void).pipe(
            Effect.timeoutOrElse({
              duration: CORE_SHUTDOWN_REQUEST_TIMEOUT,
              orElse: () => Effect.void,
            }),
          ),
        )
        .catch(() => undefined)
    }
    if (currentProcess !== null) {
      await runtime.runPromise(
        currentProcess.awaitExit.pipe(
          Effect.timeoutOrElse({
            duration: CORE_GRACEFUL_EXIT_TIMEOUT,
            orElse: () => Effect.void,
          }),
          Effect.asVoid,
        ),
      )
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
