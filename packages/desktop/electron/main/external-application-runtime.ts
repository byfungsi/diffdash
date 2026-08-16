import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import {
  CoreMethod,
  type CoreOperationOptions,
  type CoreMethod as CoreMethodType,
  type CoreMethodInput,
  type CoreOperationOutput,
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
import { Effect, Exit, Layer, Schema, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
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
import { startCoreUtilityProcessManaged } from "./core-utility-process-launcher"
import type { DesktopHostConfiguration } from "./desktop-host-configuration"

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

  async function execute<Method extends CoreMethodType>(
    method: Method,
    input: CoreMethodInput<Method>,
    options?: CoreOperationOptions,
  ): Promise<CoreOperationOutput<Method>>
  async function execute(
    method: CoreMethodType,
    input: CoreMethodInput<CoreMethodType>,
    options?: CoreOperationOptions,
  ): Promise<CoreOperationOutput<CoreMethodType>> {
    const current = session
    if (current?.client === undefined) throw new Error("DiffDash Core is not started.")
    const client = current.client
    const request = { ...requestContext(), ...input }
    if (method === CoreMethod.runReviewThreadAgent) {
      const reviewAgentRequest = Schema.decodeUnknownSync(StartReviewAgentOperationRequest)(request)
      const accepted = await runtime.runPromise(
        client.execute(CoreMethod.runReviewThreadAgent, reviewAgentRequest),
      )
      options?.onReviewThreadAgentProgress?.("reviewing")
      const waitForCompletion = async (): Promise<void> => {
        const operation = await runtime.runPromise(
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
      return runtime.runPromise(
        client.execute(CoreMethod.getReviewThread, {
          ...requestContext(),
          threadId: reviewAgentRequest.threadId,
        }),
      )
    }
    return runtime.runPromise(client.execute(method, request))
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
            current.client.execute(CoreMethod.acquireHostedReviewSnapshot, {
              ...context,
              review: target.review,
            }),
          )
        : target.kind === "local"
          ? await runtime.runPromise(
              current.client.execute(CoreMethod.acquireLocalReviewSnapshot, {
                ...context,
                target,
              }),
            )
          : await runtime.runPromise(
              current.client.execute(CoreMethod.acquireRepositoryComparisonSnapshot, {
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
        const bootstrap = (
          startTransport: Parameters<typeof bootstrapCoreHost>[0]["startTransport"],
        ): CoreHostCandidate["start"] =>
          bootstrapCoreHost({
            artifact,
            applicationInstanceId,
            temporaryDirectory: configuration.core.paths.temporaryDirectory,
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
          temporaryDirectory: configuration.core.paths.temporaryDirectory,
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

  return {
    start,
    execute,
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
    dispose,
  }
}

const requestContextFor = (session: CoreHostBootstrapSession): HostRequestContext =>
  HostRequestContext.make({
    applicationInstanceId: session.applicationInstanceId,
    processEpoch: session.processEpoch,
    requestId: HostRequestId.make(`h:${randomUUID()}`),
  })
