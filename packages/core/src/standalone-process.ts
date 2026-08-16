import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import {
  CORE_PROCESS_STARTUP_ENV,
  CORE_PROCESS_STARTUP_MAX_BYTES,
  decodeCoreProcessStartupConfiguration,
} from "@diffdash/core-rpc/process-startup"
import { CoreCommandStore } from "@diffdash/persistence/core-command-store"
import type { DatabaseError } from "@diffdash/persistence/database"
import { Clock, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { isAbsolute } from "node:path"

import { coreLifecycleLayer } from "./core-lifecycle"
import { CoreOwnershipRecovery, makeCoreOwnershipRecovery } from "./core-ownership-recovery"
import { coreApplicationRpcSocketHostLayer } from "./core-rpc-socket-host"
import { nodeDatabaseOwnerInspector, readProcessStartIdentity } from "./node-process-identity"
import { CoreConfiguration } from "./core-configuration"
import { createStandaloneCoreLayer } from "./core-layer"
import { type CoreProviderComposition, productionProviderComposition } from "./provider-composition"
import { CoreLifecycle } from "./core-lifecycle"
import { coreRuntimeServicesLayer, CoreRuntimeServices } from "./core-runtime-services"
import { makeCoreEventHubLayer, CoreEventHub } from "./core-event-hub"
import {
  coreDurableCommandLayer,
  CoreDurableCommandService,
} from "./core-durable-command-coordinator"
import { CoreOperationService } from "./core-operation-service"
import { CoreProgressiveReviewService } from "./core-review-session-rpc-handlers"
import { SnapshotRepository } from "./services/snapshot-repository"
import { SnapshotSearch } from "./services/snapshot-search"
import { toCoreStartupError } from "./core-startup-error"
import { ResourceCollection } from "./resource-collection"

/** Sanitized startup failure that cannot expose the transport credential or private paths. */
export class StandaloneCoreProcessError extends Schema.TaggedError<StandaloneCoreProcessError>()(
  "StandaloneCoreProcessError",
  {
    reason: Schema.Literals(["configuration-invalid", "host-start-failed"]),
    safeMessage: Schema.Literal("DiffDash Core could not start its private host."),
  },
) {}

const startupFailure = (reason: StandaloneCoreProcessError["reason"]) =>
  StandaloneCoreProcessError.make({
    reason,
    safeMessage: "DiffDash Core could not start its private host.",
  })

const launchStandaloneCoreProcess = Effect.fn("launchStandaloneCoreProcess")(function* (
  encodedConfiguration: Option.Option<string>,
  databaseLayerForPath: (path: string) => Layer.Layer<SqlClient.SqlClient, DatabaseError>,
  providerComposition: CoreProviderComposition,
) {
  const configuration = yield* Effect.fromOption(encodedConfiguration).pipe(
    Effect.mapError(() => startupFailure("configuration-invalid")),
    Effect.filterOrFail(
      (encoded) => Buffer.byteLength(encoded) <= CORE_PROCESS_STARTUP_MAX_BYTES,
      () => startupFailure("configuration-invalid"),
    ),
    Effect.flatMap(decodeCoreProcessStartupConfiguration),
    Effect.mapError(() => startupFailure("configuration-invalid")),
    Effect.filterOrFail(
      ({ databasePath, socketPath, statePath }) =>
        isAbsolute(databasePath) && isAbsolute(socketPath) && isAbsolute(statePath),
      () => startupFailure("configuration-invalid"),
    ),
  )

  const processStartIdentity = yield* readProcessStartIdentity(process.pid).pipe(
    Effect.mapError(() => startupFailure("host-start-failed")),
  )
  const coreConfiguration = yield* Schema.decodeUnknownEffect(CoreConfiguration)(
    configuration.coreConfiguration,
  ).pipe(
    Effect.mapError(() => startupFailure("configuration-invalid")),
    Effect.filterOrFail(
      (decoded) =>
        decoded.paths.database === configuration.databasePath &&
        decoded.paths.state === configuration.statePath,
      () => startupFailure("configuration-invalid"),
    ),
  )
  const ownershipRecovery = makeCoreOwnershipRecovery({
    databasePath: configuration.databasePath,
    pid: process.pid,
    processStartIdentity,
    inspector: nodeDatabaseOwnerInspector,
    recover: Effect.void,
  })

  const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const identity = {
    applicationInstanceId: configuration.applicationInstanceId,
    processEpoch: configuration.processEpoch,
  } as const
  const runtimeServicesLayer = coreRuntimeServicesLayer
  const hostLayer = coreApplicationRpcSocketHostLayer({
    socketPath: configuration.socketPath,
    token: configuration.token,
  }).pipe(
    Layer.provideMerge(coreLifecycleLayer(identity)),
    Layer.provideMerge(Layer.succeed(CoreOwnershipRecovery, ownershipRecovery)),
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(platformLayer),
  )

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(hostLayer)
      const lifecycle = Context.get(context, CoreLifecycle)
      const runtimeServices = Context.get(context, CoreRuntimeServices)
      const ownership = Context.get(context, CoreOwnershipRecovery)

      const ownAndRun = Effect.scoped(
        lifecycle.ownershipAuthorization.pipe(
          Effect.flatMap((authorizationId) =>
            lifecycle.interruptOnDrain(
              Effect.acquireRelease(
                ownership.acquireAndRecover({ ...identity, authorizationId }),
                (lease) => lease.release,
              ),
            ),
          ),
          Effect.andThen(
            Effect.gen(function* () {
              const databaseLayer = databaseLayerForPath(coreConfiguration.paths.database)
              const eventLayer = makeCoreEventHubLayer(identity)
              const commandLayer = coreDurableCommandLayer.pipe(
                Layer.provide(CoreCommandStore.layer),
                Layer.provide(eventLayer),
                Layer.provide(databaseLayer),
              )
              const operationLayer = createStandaloneCoreLayer(
                coreConfiguration,
                databaseLayer,
                providerComposition,
              ).pipe(Layer.provideMerge(eventLayer))
              const runtimeContext = yield* Layer.build(
                Layer.mergeAll(operationLayer, commandLayer, eventLayer),
              )
              const operations = Context.get(runtimeContext, CoreOperationService)
              yield* operations.start
              const nowMs = yield* Clock.currentTimeMillis
              yield* Context.get(runtimeContext, ResourceCollection).reconcile(
                nowMs,
                nowMs + 60_000,
              )
              yield* runtimeServices.install({
                operations,
                commands: Context.get(runtimeContext, CoreDurableCommandService),
                events: Context.get(runtimeContext, CoreEventHub),
                progressiveReviews: {
                  sessions: Context.get(runtimeContext, CoreProgressiveReviewService),
                  repository: Context.get(runtimeContext, SnapshotRepository),
                  search: Context.get(runtimeContext, SnapshotSearch),
                },
              })
              yield* lifecycle.completeRecovery
              return yield* Effect.never
            }),
          ),
          Effect.tapError((error) =>
            runtimeServices
              .fail(toCoreStartupError(error))
              .pipe(Effect.andThen(lifecycle.fail), Effect.ignore),
          ),
        ),
      )
      const exit = yield* Effect.exit(ownAndRun)
      yield* lifecycle.completeShutdown
      if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
    }),
  ).pipe(Effect.mapError(() => startupFailure("host-start-failed")))
})

/** Runs standalone Core with process-derived persisted ownership and recovery. */
export const runStandaloneCoreProcess = (
  databaseLayerForPath: (path: string) => Layer.Layer<SqlClient.SqlClient, DatabaseError>,
  providerComposition: CoreProviderComposition = productionProviderComposition,
): void => {
  const encodedConfiguration = Option.fromNullishOr(process.env[CORE_PROCESS_STARTUP_ENV])
  delete process.env[CORE_PROCESS_STARTUP_ENV]
  NodeRuntime.runMain(
    launchStandaloneCoreProcess(encodedConfiguration, databaseLayerForPath, providerComposition),
    { disableErrorReporting: true },
  )
}
