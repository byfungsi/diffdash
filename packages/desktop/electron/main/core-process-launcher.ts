import {
  CORE_PROCESS_STARTUP_MAX_BYTES,
  CoreProcessStartupConfiguration,
  encodeCoreProcessStartupConfiguration,
} from "@diffdash/core-rpc/process-startup"
import { Effect, FileSystem, Schema } from "effect"
import { CoreConfiguration } from "@diffdash/core"

import type { CoreHostTransportConfiguration } from "./core-host-bootstrap"

/** Sanitized failure while starting or stopping the standalone Core process. */
export class CoreProcessLaunchError extends Schema.TaggedError<CoreProcessLaunchError>()(
  "CoreProcessLaunchError",
  {
    reason: Schema.Literals([
      "configuration-invalid",
      "spawn-failed",
      "exited-before-listening",
      "listen-timeout",
    ]),
    safeMessage: Schema.Literal("DiffDash could not launch its private Core process."),
  },
) {}

/** Process lifetime handle retained by the scoped launcher. */
export interface CoreProcessHandle {
  readonly awaitExit: Effect.Effect<number>
  readonly kill: () => boolean
}

/** Exact inputs supplied to a platform-specific Core process spawner. */
export interface CoreProcessSpawnOptions {
  readonly entrypointPath: string
  readonly encodedStartupConfiguration: string
}

/** Platform-specific process creation seam used by Electron and real-process tests. */
export interface CoreProcessSpawner {
  readonly spawn: (options: CoreProcessSpawnOptions) => CoreProcessHandle
}

/** Inputs required to launch one verified Core process epoch. */
export interface StartCoreProcessOptions {
  readonly configuration: CoreHostTransportConfiguration
  readonly databasePath: string
  readonly statePath: string
  readonly coreConfiguration: CoreConfiguration
  readonly spawner: CoreProcessSpawner
  readonly entrypointPath?: string
  readonly listenTimeout?: number
}

const launchFailure = (reason: CoreProcessLaunchError["reason"]) =>
  CoreProcessLaunchError.make({
    reason,
    safeMessage: "DiffDash could not launch its private Core process.",
  })

const waitForSocket = Effect.fn("waitForCoreSocket")(function* (socketPath: string) {
  const fileSystem = yield* FileSystem.FileSystem
  while (true) {
    const exists = yield* fileSystem
      .exists(socketPath)
      .pipe(Effect.catch(() => Effect.succeed(false)))
    if (exists) return
    yield* Effect.sleep("10 millis")
  }
})

/** Launches one verified Core process and retains it for the enclosing transport scope. */
export const startCoreProcess = Effect.fn("startCoreProcess")(function* (
  options: StartCoreProcessOptions,
) {
  yield* startCoreProcessManaged(options)
})

/** Launches one verified Core process and exposes its scoped lifetime handle to a supervisor. */
export const startCoreProcessManaged = Effect.fn("startCoreProcessManaged")(function* (
  options: StartCoreProcessOptions,
) {
  const encodedCoreConfiguration = yield* Schema.encodeEffect(CoreConfiguration)(
    options.coreConfiguration,
  ).pipe(Effect.mapError(() => launchFailure("configuration-invalid")))
  const startupConfiguration = CoreProcessStartupConfiguration.make({
    schemaVersion: 1,
    applicationInstanceId: options.configuration.applicationInstanceId,
    processEpoch: options.configuration.processEpoch,
    socketPath: options.configuration.socketPath,
    databasePath: options.databasePath,
    statePath: options.statePath,
    coreConfiguration: encodedCoreConfiguration,
    token: options.configuration.token,
  })
  const encodedStartupConfiguration = yield* encodeCoreProcessStartupConfiguration(
    startupConfiguration,
  ).pipe(Effect.mapError(() => launchFailure("configuration-invalid")))
  if (Buffer.byteLength(encodedStartupConfiguration) > CORE_PROCESS_STARTUP_MAX_BYTES) {
    return yield* launchFailure("configuration-invalid")
  }

  const processHandle = yield* Effect.try({
    try: () =>
      options.spawner.spawn({
        entrypointPath: options.entrypointPath ?? options.configuration.artifact.entrypointPath,
        encodedStartupConfiguration,
      }),
    catch: () => launchFailure("spawn-failed"),
  })
  yield* Effect.addFinalizer(() =>
    Effect.sync(processHandle.kill).pipe(
      Effect.andThen(processHandle.awaitExit),
      Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.void }),
      Effect.asVoid,
    ),
  )

  const listening = waitForSocket(options.configuration.socketPath).pipe(
    Effect.timeoutOrElse({
      duration: options.listenTimeout ?? 5_000,
      orElse: () => Effect.fail(launchFailure("listen-timeout")),
    }),
  )
  const exited = processHandle.awaitExit.pipe(
    Effect.flatMap(() => Effect.fail(launchFailure("exited-before-listening"))),
  )
  yield* Effect.raceFirst(listening, exited)
  return processHandle
})
