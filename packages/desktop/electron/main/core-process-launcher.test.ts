import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  DatabaseOwnershipAuthorizationId,
  HostRequestContext,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import {
  AuthorizeDatabaseOwnershipRequest,
  type CoreLifecycleState,
} from "@diffdash/core-rpc/lifecycle"
import { CORE_PROCESS_STARTUP_ENV } from "@diffdash/core-rpc/process-startup"
import { TempResources } from "@diffdash/process/temp-resource"
import { describe, expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Exit, Layer, Redacted, Schema, Scope } from "effect"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { CoreArtifactManifest, verifyCoreArtifact } from "./core-artifact"
import { bootstrapCoreHost } from "./core-host-bootstrap"
import {
  startCoreProcess,
  startCoreProcessManaged,
  type CoreProcessHandle,
  type CoreProcessSpawner,
} from "./core-process-launcher"
import { makeCoreProcessFixtureConfiguration } from "./core-process-configuration.fixture"
import { CoreRpcClient, coreRpcClientLayer } from "./core-rpc-client"

const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const dependencies = Layer.merge(
  TempResources.layer.pipe(Layer.provide(platformLayer)),
  platformLayer,
)

const nodeProcessSpawner: CoreProcessSpawner = {
  spawn: ({ entrypointPath, encodedStartupConfiguration }) => {
    const child = spawn(process.execPath, [entrypointPath], {
      env: {
        ...process.env,
        [CORE_PROCESS_STARTUP_ENV]: encodedStartupConfiguration,
      },
      stdio: "ignore",
    })
    const exited = new Promise<number>((complete) =>
      child.once("exit", (code) => complete(code ?? -1)),
    )
    return {
      awaitExit: Effect.promise(() => exited),
      kill: () => child.kill(),
    } satisfies CoreProcessHandle
  },
}

describe("Core process launcher", () => {
  it.live(
    "launches the generated Core artifact and releases database ownership when its host disconnects",
    () =>
      Effect.gen(function* () {
        const tempResources = yield* TempResources
        const temporaryDirectory = yield* tempResources.makeTempDirectoryScoped({
          prefix: "dd-core-process-parent-",
        })
        const artifactDirectory = join(temporaryDirectory, "artifact")
        execFileSync(
          process.execPath,
          ["scripts/build-core-artifact.mjs", `--output-directory=${artifactDirectory}`],
          {
            cwd: resolve("."),
            stdio: "ignore",
          },
        )
        const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(CoreArtifactManifest))(
          readFileSync(join(artifactDirectory, "manifest.json"), "utf8"),
        )
        const artifact = yield* verifyCoreArtifact({
          artifactDirectory,
          expectedBuildId: manifest.buildId,
        })
        const statePath = join(temporaryDirectory, "state.json")
        const databasePath = join(temporaryDirectory, "diffdash.sqlite")
        const clientScope = yield* Scope.fork(yield* Effect.scope)
        const processStarted = yield* Deferred.make<CoreProcessHandle>()

        const session = yield* bootstrapCoreHost({
          artifact,
          applicationInstanceId: ApplicationInstanceId.make("app-real-process"),
          temporaryDirectory,
          generateProcessEpoch: () => CoreProcessEpoch.make("epoch-real-process"),
          generateRequestId: () => HostRequestId.make("h:real-process-health"),
          generateToken: () => Redacted.make("real-process-token-with-at-least-32-bytes"),
          makeClientLayer: (options) =>
            Layer.effect(
              CoreRpcClient,
              Layer.buildWithScope(coreRpcClientLayer(options), clientScope).pipe(
                Effect.map((context) => Context.get(context, CoreRpcClient)),
              ),
            ),
          startTransport: (configuration) =>
            startCoreProcessManaged({
              configuration,
              databasePath,
              statePath,
              coreConfiguration: makeCoreProcessFixtureConfiguration(databasePath, statePath),
              spawner: nodeProcessSpawner,
            }).pipe(
              Effect.flatMap((handle) => Deferred.succeed(processStarted, handle)),
              Effect.asVoid,
            ),
        })

        expect(session.health).toEqual({
          applicationInstanceId: "app-real-process",
          processEpoch: "epoch-real-process",
          lifecycle: "awaitingOwnership",
        })
        const authorized = yield* session.authorizeDatabaseOwnership(
          AuthorizeDatabaseOwnershipRequest.make({
            applicationInstanceId: session.applicationInstanceId,
            processEpoch: session.processEpoch,
            requestId: HostRequestId.make("h:real-process-ownership"),
            authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-real-process"),
          }),
        )
        expect(authorized.lifecycle).toBe("recovering")
        for (let attempt = 0; attempt < 100 && !existsSync(`${databasePath}.owner`); attempt += 1) {
          yield* Effect.sleep("10 millis")
        }
        expect(existsSync(`${databasePath}.owner`)).toBe(true)
        const client = session.client
        expect(client).toBeDefined()
        if (client === undefined) return
        let lifecycle: CoreLifecycleState = authorized.lifecycle
        for (let attempt = 0; attempt < 500 && lifecycle !== "ready"; attempt += 1) {
          yield* Effect.sleep("10 millis")
          lifecycle = (yield* client.health(
            HostRequestContext.make({
              applicationInstanceId: session.applicationInstanceId,
              processEpoch: session.processEpoch,
              requestId: HostRequestId.make(`h:ready-${String(attempt)}`),
            }),
          )).lifecycle
        }
        expect(lifecycle).toBe("ready")
        const state = yield* client.appStateGet(
          HostRequestContext.make({
            applicationInstanceId: session.applicationInstanceId,
            processEpoch: session.processEpoch,
            requestId: HostRequestId.make("h:app-state"),
          }),
        )
        expect(state).toMatchObject({ onboardingCompleted: false })
        // Close only the RPC client: the launcher scope must not terminate Core for this assertion.
        yield* Scope.close(clientScope, Exit.void)
        const handle = yield* Deferred.await(processStarted)
        expect(yield* handle.awaitExit.pipe(Effect.timeout("5 seconds"))).toBe(0)
        expect(existsSync(`${databasePath}.owner`)).toBe(false)
      }).pipe(Effect.provide(dependencies)),
    20_000,
  )

  // Includes a real Core artifact build, so use the same total budget as the launcher case above.
  it.effect(
    "sanitizes a process that exits before creating its socket",
    () =>
      Effect.gen(function* () {
        const tempResources = yield* TempResources
        const temporaryDirectory = yield* tempResources.makeTempDirectoryScoped({
          prefix: "dd-core-process-parent-",
        })
        const artifactDirectory = join(temporaryDirectory, "artifact")
        execFileSync(
          process.execPath,
          ["scripts/build-core-artifact.mjs", `--output-directory=${artifactDirectory}`],
          {
            cwd: resolve("."),
            stdio: "ignore",
          },
        )
        const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(CoreArtifactManifest))(
          readFileSync(join(artifactDirectory, "manifest.json"), "utf8"),
        )
        const artifact = yield* verifyCoreArtifact({
          artifactDirectory,
          expectedBuildId: manifest.buildId,
        })
        const immediateExitSpawner: CoreProcessSpawner = {
          spawn: () => ({ awaitExit: Effect.succeed(1), kill: () => false }),
        }
        const privateStatePath = join(temporaryDirectory, "private-state.json")
        const privateDatabasePath = join(temporaryDirectory, "private.sqlite")
        const failure = yield* bootstrapCoreHost({
          artifact,
          applicationInstanceId: ApplicationInstanceId.make("app-failed-process"),
          temporaryDirectory,
          startTransport: (configuration) =>
            startCoreProcess({
              configuration,
              databasePath: privateDatabasePath,
              statePath: privateStatePath,
              coreConfiguration: makeCoreProcessFixtureConfiguration(
                privateDatabasePath,
                privateStatePath,
              ),
              spawner: immediateExitSpawner,
            }),
        }).pipe(Effect.flip)

        expect(failure.stage).toBe("preparingRuntime")
        expect(JSON.stringify(failure)).not.toContain(privateStatePath)
        expect(JSON.stringify(failure)).not.toContain(artifact.entrypointPath)
      }).pipe(Effect.provide(dependencies)),
    20_000,
  )
})
