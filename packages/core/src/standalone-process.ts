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
import { Effect, Layer, Schema } from "effect"
import { isAbsolute } from "node:path"

import { coreLifecycleLayer } from "./core-lifecycle"
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
  encodedConfiguration: string | undefined,
) {
  if (
    encodedConfiguration === undefined ||
    Buffer.byteLength(encodedConfiguration) > CORE_PROCESS_STARTUP_MAX_BYTES
  ) {
    return yield* startupFailure("configuration-invalid")
  }
  const configuration = yield* decodeCoreProcessStartupConfiguration(encodedConfiguration).pipe(
    Effect.mapError(() => startupFailure("configuration-invalid")),
  )
  if (!isAbsolute(configuration.socketPath) || !isAbsolute(configuration.statePath)) {
    return yield* startupFailure("configuration-invalid")
  }

  const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const fileStorageLayer = FileStorage.layer.pipe(Layer.provide(platformLayer))
  const appStateLayer = AppState.layer(configuration.statePath).pipe(
    Layer.provide(fileStorageLayer),
  )
  const hostLayer = coreRpcSocketHostLayer({
    socketPath: configuration.socketPath,
    token: configuration.token,
  }).pipe(
    Layer.provideMerge(
      coreLifecycleLayer({
        applicationInstanceId: configuration.applicationInstanceId,
        processEpoch: configuration.processEpoch,
      }),
    ),
    Layer.provideMerge(appStateLayer),
    Layer.provideMerge(platformLayer),
  )

  return yield* Layer.launch(hostLayer).pipe(
    Effect.mapError(() => startupFailure("host-start-failed")),
  )
})

/** Runs the standalone Core host until Electron terminates or interrupts the process. */
export const runStandaloneCoreProcess = (): void => {
  const encodedConfiguration = process.env[CORE_PROCESS_STARTUP_ENV]
  delete process.env[CORE_PROCESS_STARTUP_ENV]
  NodeRuntime.runMain(launchStandaloneCoreProcess(encodedConfiguration), {
    disableErrorReporting: true,
  })
}
