import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import {
  type GetStoredWalkthrough,
  type StartWalkthroughOperation,
  type WalkthroughOperationAccepted,
  WalkthroughOperationId,
  WalkthroughOperationResult,
} from "@diffdash/core"
import {
  ApplicationInstanceId,
  DatabaseOwnershipAuthorizationId,
  HostRequestContext,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import { AuthorizeDatabaseOwnershipRequest } from "@diffdash/core-rpc/lifecycle"
import {
  CancelledAgentRun,
  CompletedAgentRun,
  FailedAgentRun,
  InterruptedAgentRun,
  RunningAgentRun,
  StartReviewAgentOperationRequest,
} from "@diffdash/core-rpc/review-agent"
import {
  CancelWalkthroughRequest,
  GetStoredWalkthroughRequest,
  GetWalkthroughOperationRequest,
  StartWalkthroughRequest,
  CurrentWalkthroughPromptVersion,
  WalkthroughIdempotencyKey,
  WalkthroughReviewGeneration,
  type WalkthroughOperationSnapshot,
} from "@diffdash/core-rpc/walkthrough"
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

type ReviewThreadTarget = StartWalkthroughOperation["target"]
type StoredWalkthrough = Extract<
  WalkthroughOperationResult,
  { readonly _tag: "completed" }
>["walkthrough"]

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
    const accepted = await invoke((client) => client.runReviewThreadAgent(reviewAgentRequest))
    options?.onReviewThreadAgentProgress?.("reviewing")
    const waitForCompletion = async (): Promise<void> => {
      const operation = await invoke((client) =>
        client.getReviewAgentOperation({ ...requestContext(), runId: accepted.runId }),
      )
      if (Schema.is(RunningAgentRun)(operation)) {
        await runtime.runPromise(Effect.sleep("100 millis"))
        return waitForCompletion()
      }
      if (Schema.is(FailedAgentRun)(operation)) throw new Error(operation.error)
      if (Schema.is(CancelledAgentRun)(operation)) {
        throw new Error("Review agent operation was cancelled.")
      }
      if (Schema.is(InterruptedAgentRun)(operation)) {
        throw new Error("Review agent operation was interrupted.")
      }
      if (!Schema.is(CompletedAgentRun)(operation)) {
        throw new Error("Review agent operation ended in an unsupported state.")
      }
    }
    await waitForCompletion()
    options?.onReviewThreadAgentProgress?.("restoring-workspace")
    return invoke((client) =>
      client.getReviewThread({
        ...requestContext(),
        threadId: reviewAgentRequest.threadId,
      }),
    )
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

  const walkthroughGeneration = async (
    target: ReviewThreadTarget,
  ): Promise<WalkthroughReviewGeneration> => {
    const current = session
    if (current?.client === undefined) throw new Error("DiffDash Core is not started.")
    const context = requestContext()
    const manifest =
      target.kind === "hosted"
        ? await runtime.runPromise(
            current.client.acquireHostedReviewSnapshot({
              ...context,
              review: target.review,
            }),
          )
        : target.kind === "local"
          ? await runtime.runPromise(
              current.client.acquireLocalReviewSnapshot({
                ...context,
                target,
              }),
            )
          : await runtime.runPromise(
              current.client.acquireRepositoryComparisonSnapshot({
                ...context,
                target,
              }),
            )
    return WalkthroughReviewGeneration.make({
      kind: target.kind,
      projectId: manifest.projectId,
      snapshotId: manifest.snapshotId,
      reviewKey: manifest.reviewKey,
      baseRevision: manifest.baseRevision,
      headRevision: manifest.headRevision,
    })
  }

  const storedWalkthrough = (
    snapshot: Extract<WalkthroughOperationSnapshot, { readonly state: "completed" }>,
    target?: ReviewThreadTarget,
  ): StoredWalkthrough => ({
    repoId: snapshot.reviewGeneration.projectId,
    prNumber: target?.kind === "hosted" ? target.review.number : null,
    reviewKey: snapshot.reviewGeneration.reviewKey,
    baseSha: snapshot.reviewGeneration.baseRevision,
    headSha: snapshot.reviewGeneration.headRevision,
    promptVersion: snapshot.promptVersion,
    walkthrough: snapshot.stored.walkthrough,
    createdAt: snapshot.stored.createdAt,
  })

  const walkthroughResult = (
    snapshot: WalkthroughOperationSnapshot,
    target?: ReviewThreadTarget,
  ): WalkthroughOperationResult => {
    switch (snapshot.state) {
      case "completed":
        return { _tag: "completed", walkthrough: storedWalkthrough(snapshot, target) }
      case "cancelled":
        return { _tag: "cancelled" }
      case "superseded":
        return {
          _tag: "superseded",
          supersededByOperationId: snapshot.supersededByOperationId,
        }
      case "interrupted":
        return { _tag: "interrupted" }
      case "failed":
        throw new Error(snapshot.failure.safeMessage)
      case "active":
        throw new Error("Walkthrough operation is still active.")
    }
  }

  const operationTargets = new Map<WalkthroughOperationId, ReviewThreadTarget>()

  const readWalkthroughResult = async (
    operationId: WalkthroughOperationId,
  ): Promise<WalkthroughOperationResult> => {
    const current = session
    if (current?.client === undefined) throw new Error("DiffDash Core is not started.")
    for (;;) {
      const snapshot = await runtime.runPromise(
        current.client.getWalkthroughOperation(
          GetWalkthroughOperationRequest.make({ ...requestContext(), operationId }),
        ),
      )
      if (snapshot.state !== "active") {
        return walkthroughResult(snapshot, operationTargets.get(operationId))
      }
      await runtime.runPromise(Effect.sleep("100 millis"))
    }
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
    walkthroughs: {
      start: async (input: StartWalkthroughOperation): Promise<WalkthroughOperationAccepted> => {
        const current = session
        if (current?.client === undefined) throw new Error("DiffDash Core is not started.")
        const accepted = await runtime.runPromise(
          current.client.startWalkthrough(
            StartWalkthroughRequest.make({
              ...requestContext(),
              reviewGeneration: await walkthroughGeneration(input.target),
              regenerate: input.regenerate,
              idempotencyKey: WalkthroughIdempotencyKey.make(`w:${randomUUID()}`),
            }),
          ),
        )
        operationTargets.set(accepted.operationId, input.target)
        return { operationId: accepted.operationId }
      },
      getOperation: readWalkthroughResult,
      cancel: async (operationId) => {
        const current = session
        if (current?.client === undefined) throw new Error("DiffDash Core is not started.")
        const result = await runtime.runPromise(
          current.client.cancelWalkthrough(
            CancelWalkthroughRequest.make({ ...requestContext(), operationId }),
          ),
        )
        return walkthroughResult(result.operation, operationTargets.get(operationId))
      },
      getStored: async (input: GetStoredWalkthrough) => {
        const current = session
        if (current?.client === undefined) throw new Error("DiffDash Core is not started.")
        const generation = await walkthroughGeneration(input.target)
        if (
          (input.expectedBaseRevision !== null &&
            generation.baseRevision !== input.expectedBaseRevision) ||
          (input.expectedHeadRevision !== null &&
            generation.headRevision !== input.expectedHeadRevision)
        ) {
          return null
        }
        const result = await runtime.runPromise(
          current.client.getStoredWalkthrough(
            GetStoredWalkthroughRequest.make({
              ...requestContext(),
              reviewGeneration: generation,
              promptVersion: CurrentWalkthroughPromptVersion,
            }),
          ),
        )
        if (result.status === "notFound") return null
        return {
          repoId: result.stored.reviewGeneration.projectId,
          prNumber: input.target.kind === "hosted" ? input.target.review.number : null,
          reviewKey: result.stored.reviewGeneration.reviewKey,
          baseSha: result.stored.reviewGeneration.baseRevision,
          headSha: result.stored.reviewGeneration.headRevision,
          promptVersion: result.stored.promptVersion,
          walkthrough: result.stored.walkthrough,
          createdAt: result.stored.createdAt,
        }
      },
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
