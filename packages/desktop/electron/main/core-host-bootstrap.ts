import type { CoreHealth } from "@diffdash/core-rpc/lifecycle"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  HostRequestContext,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import { TempResources } from "@diffdash/process/temp-resource"
import { randomBytes, randomUUID } from "node:crypto"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect"

import { CoreRpcClient, coreRpcClientLayer, type CoreRpcClientOptions } from "./core-rpc-client"
import type {
  CoreHealthIdentityMismatchFailure,
  CoreTransportAuthenticationFailure,
} from "@diffdash/core-rpc/failure"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import type { CoreRpcHealthVerificationError } from "./core-rpc-client"
import { revalidateCoreArtifact, type VerifiedCoreArtifact } from "./core-artifact"
import type { CoreProcessLaunchError } from "./core-process-launcher"

/** Private Electron-side state while establishing one Core process epoch. */
export const CoreHostBootstrapState = Schema.Literals([
  "idle",
  "preparingRuntime",
  "transportListening",
  "authenticating",
  "epochVerified",
  "awaitingOwnership",
  "failed",
  "closed",
])

/** Private Electron-side state while establishing one Core process epoch. */
export type CoreHostBootstrapState = typeof CoreHostBootstrapState.Type

/** Sanitized bootstrap failure that never carries a socket path or credential. */
export class CoreHostBootstrapError extends Schema.TaggedError<CoreHostBootstrapError>()(
  "CoreHostBootstrapError",
  {
    stage: CoreHostBootstrapState,
    safeMessage: Schema.Literal("DiffDash could not establish its private Core connection."),
  },
) {}

/** Private values supplied to the later verified Core launcher. */
export interface CoreHostTransportConfiguration {
  readonly artifact: VerifiedCoreArtifact
  readonly socketPath: string
  readonly token: Redacted.Redacted
  readonly applicationInstanceId: ApplicationInstanceId
  readonly processEpoch: CoreProcessEpoch
}

/** Inputs and host seams required to establish one authenticated Core epoch. */
export interface CoreHostBootstrapOptions {
  readonly artifact: VerifiedCoreArtifact
  readonly applicationInstanceId: ApplicationInstanceId
  readonly temporaryDirectory: string
  readonly startTransport: (
    configuration: CoreHostTransportConfiguration,
  ) => Effect.Effect<
    void,
    CoreHostBootstrapError | CoreProcessLaunchError,
    FileSystem.FileSystem | Scope.Scope
  >
  readonly onStateChange?: (state: CoreHostBootstrapState) => Effect.Effect<void>
  readonly generateProcessEpoch?: () => CoreProcessEpoch
  readonly generateRequestId?: () => HostRequestId
  readonly generateToken?: () => Redacted.Redacted
  readonly makeClientLayer?: (
    options: CoreRpcClientOptions,
  ) => Layer.Layer<
    CoreRpcClient,
    | CoreRpcHealthVerificationError
    | CoreHealthIdentityMismatchFailure
    | CoreTransportAuthenticationFailure
    | RpcClientError
  >
}

/** Verified private Core connection retained only for the enclosing application scope. */
export interface CoreHostBootstrapSession {
  readonly applicationInstanceId: ApplicationInstanceId
  readonly processEpoch: CoreProcessEpoch
  readonly health: CoreHealth
  readonly authorizeDatabaseOwnership: CoreRpcClient["Service"]["authorizeDatabaseOwnership"]
  readonly client?: CoreRpcClient["Service"]
  readonly state: Effect.Effect<CoreHostBootstrapState>
}

/** Single-flight authority for establishing the external Core transport. */
export class CoreHostBootstrap extends Context.Service<
  CoreHostBootstrap,
  {
    readonly start: Effect.Effect<CoreHostBootstrapSession, CoreHostBootstrapError>
  }
>()("@diffdash/desktop/CoreHostBootstrap") {}

const bootstrapFailure = (stage: CoreHostBootstrapState) =>
  CoreHostBootstrapError.make({
    stage,
    safeMessage: "DiffDash could not establish its private Core connection.",
  })

/** Establishes and verifies one scoped private Core transport without activating production cutover. */
export const bootstrapCoreHost = (
  options: CoreHostBootstrapOptions,
): Effect.Effect<
  CoreHostBootstrapSession,
  CoreHostBootstrapError,
  TempResources | FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const tempResources = yield* TempResources
    const path = yield* Path.Path
    const applicationScope = yield* Effect.scope
    const transportScope = yield* Scope.fork(applicationScope)
    const stateRef = yield* Ref.make<CoreHostBootstrapState>("idle")
    const onStateChange = options.onStateChange ?? (() => Effect.void)
    const transition = Effect.fn("CoreHostBootstrap.transition")(function* (
      state: CoreHostBootstrapState,
    ) {
      yield* Ref.set(stateRef, state)
      yield* onStateChange(state)
    })
    yield* Effect.addFinalizer(() => transition("closed"))

    const bootstrap = Effect.gen(function* () {
      yield* transition("preparingRuntime")
      const runtimeDirectory = yield* tempResources.makeTempDirectoryScoped({
        parentDirectory: options.temporaryDirectory,
        prefix: "dd-core-",
      })
      const socketPath = path.join(runtimeDirectory, "core.sock")
      if (Buffer.byteLength(socketPath) > 103) {
        return yield* Effect.fail(bootstrapFailure("preparingRuntime"))
      }
      const processEpoch = options.generateProcessEpoch?.() ?? CoreProcessEpoch.make(randomUUID())
      const token = options.generateToken?.() ?? Redacted.make(randomBytes(32).toString("hex"))
      const configuration = {
        artifact: options.artifact,
        socketPath,
        token,
        applicationInstanceId: options.applicationInstanceId,
        processEpoch,
      } as const

      yield* revalidateCoreArtifact(options.artifact).pipe(
        Effect.mapError(() => bootstrapFailure("preparingRuntime")),
      )
      yield* options.startTransport(configuration)
      yield* transition("transportListening")
      yield* transition("authenticating")

      const clientContext = yield* Layer.build(
        (options.makeClientLayer ?? coreRpcClientLayer)(configuration),
      )
      const client = Context.get(clientContext, CoreRpcClient)
      const request = HostRequestContext.make({
        applicationInstanceId: options.applicationInstanceId,
        processEpoch,
        requestId: options.generateRequestId?.() ?? HostRequestId.make(`h:${randomUUID()}`),
      })
      const health = yield* client.health(request)
      if (health.lifecycle !== "awaitingOwnership") {
        return yield* Effect.fail(bootstrapFailure("authenticating"))
      }
      yield* transition("epochVerified")
      yield* transition("awaitingOwnership")

      return {
        applicationInstanceId: options.applicationInstanceId,
        processEpoch,
        health,
        authorizeDatabaseOwnership: client.authorizeDatabaseOwnership,
        client,
        state: Ref.get(stateRef),
      } satisfies CoreHostBootstrapSession
    })

    return yield* bootstrap.pipe(
      Effect.provideService(Scope.Scope, transportScope),
      Effect.catchCause((cause) =>
        Ref.get(stateRef).pipe(
          Effect.flatMap((stage) =>
            Scope.close(transportScope, Exit.failCause(cause)).pipe(
              Effect.andThen(transition("failed")),
              Effect.andThen(
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.fail(bootstrapFailure(stage)),
              ),
            ),
          ),
        ),
      ),
    )
  })

/** Provides one memoized Core bootstrap acquisition for the enclosing application scope. */
export const coreHostBootstrapLayer = (options: CoreHostBootstrapOptions) =>
  Layer.effect(
    CoreHostBootstrap,
    Effect.gen(function* () {
      const tempResources = yield* TempResources
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const scope = yield* Effect.scope
      const result = yield* Deferred.make<CoreHostBootstrapSession, CoreHostBootstrapError>()
      const startLock = yield* Semaphore.make(1)
      const started = yield* Ref.make(false)
      const acquisition = bootstrapCoreHost(options).pipe(
        Effect.provideService(TempResources, tempResources),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Scope.Scope, scope),
      )
      const launch = startLock.withPermits(1)(
        Ref.getAndSet(started, true).pipe(
          Effect.flatMap((alreadyStarted) =>
            alreadyStarted
              ? Effect.void
              : Deferred.complete(result, acquisition).pipe(Effect.forkIn(scope), Effect.asVoid),
          ),
        ),
      )
      const start = launch.pipe(Effect.andThen(Deferred.await(result)))
      return CoreHostBootstrap.of({ start })
    }),
  )
