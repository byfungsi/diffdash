import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import {
  CORE_PROCESS_STARTUP_ENV,
  CORE_PROCESS_STARTUP_MAX_BYTES,
  decodeCoreProcessStartupConfiguration,
} from "@diffdash/core-rpc/process-startup"
import { FileStorage } from "@diffdash/settings/file-storage"
import { AppState } from "@diffdash/settings/app-state"
import { Effect, Layer, Option, Schema } from "effect"
import { isAbsolute } from "node:path"

import { coreLifecycleLayer } from "./core-lifecycle"
import { runCoreHostLifecycle } from "./core-host-lifecycle"
import {
  CoreOwnershipRecovery,
  coreOwnershipRecoveryNotConfigured,
} from "./core-ownership-recovery"
import { coreRpcSocketHostLayer } from "./core-rpc-socket-host"

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
  ownershipRecovery: CoreOwnershipRecovery["Service"],
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
      ({ socketPath, statePath }) => isAbsolute(socketPath) && isAbsolute(statePath),
      () => startupFailure("configuration-invalid"),
    ),
  )

  const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const fileStorageLayer = FileStorage.layer.pipe(Layer.provide(platformLayer))
  const appStateLayer = AppState.layer(configuration.statePath).pipe(
    Layer.provide(fileStorageLayer),
  )
  const identity = {
    applicationInstanceId: configuration.applicationInstanceId,
    processEpoch: configuration.processEpoch,
  } as const
  const hostLayer = coreRpcSocketHostLayer({
    socketPath: configuration.socketPath,
    token: configuration.token,
  }).pipe(
    Layer.provideMerge(coreLifecycleLayer(identity)),
    Layer.provideMerge(Layer.succeed(CoreOwnershipRecovery, ownershipRecovery)),
    Layer.provideMerge(appStateLayer),
    Layer.provideMerge(platformLayer),
  )

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(hostLayer)
      yield* runCoreHostLifecycle(identity).pipe(Effect.provide(context))
    }),
  ).pipe(Effect.mapError(() => startupFailure("host-start-failed")))
})

/** Runs standalone Core with the selected persisted ownership and recovery implementation. */
export const runStandaloneCoreProcess = (
  ownershipRecovery: CoreOwnershipRecovery["Service"] = coreOwnershipRecoveryNotConfigured,
): void => {
  const encodedConfiguration = Option.fromNullishOr(process.env[CORE_PROCESS_STARTUP_ENV])
  delete process.env[CORE_PROCESS_STARTUP_ENV]
  NodeRuntime.runMain(launchStandaloneCoreProcess(encodedConfiguration, ownershipRecovery), {
    disableErrorReporting: true,
  })
}
