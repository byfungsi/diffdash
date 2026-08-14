import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "@diffdash/core-rpc/identity"
import { CORE_PROCESS_STARTUP_ENV } from "@diffdash/core-rpc/process-startup"
import { TempResources } from "@diffdash/process/temp-resource"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema } from "effect"
import { execFileSync, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { CoreArtifactManifest, verifyCoreArtifact } from "./core-artifact"
import { bootstrapCoreHost } from "./core-host-bootstrap"
import {
  startCoreProcess,
  type CoreProcessHandle,
  type CoreProcessSpawner,
} from "./core-process-launcher"

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
  it.live("launches the generated Core artifact to authenticated health", () =>
    Effect.gen(function* () {
      const tempResources = yield* TempResources
      execFileSync(process.execPath, ["scripts/build-core-artifact.mjs"], {
        cwd: resolve("."),
        stdio: "ignore",
      })
      const artifactDirectory = resolve(".generated/core")
      const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(CoreArtifactManifest))(
        readFileSync(join(artifactDirectory, "manifest.json"), "utf8"),
      )
      const artifact = yield* verifyCoreArtifact({
        artifactDirectory,
        expectedBuildId: manifest.buildId,
      })
      const temporaryDirectory = yield* tempResources.makeTempDirectoryScoped({
        prefix: "dd-core-process-parent-",
      })
      const statePath = join(temporaryDirectory, "state.json")

      const session = yield* bootstrapCoreHost({
        artifact,
        applicationInstanceId: ApplicationInstanceId.make("app-real-process"),
        temporaryDirectory,
        generateProcessEpoch: () => CoreProcessEpoch.make("epoch-real-process"),
        generateRequestId: () => HostRequestId.make("h:real-process-health"),
        generateToken: () => Redacted.make("real-process-token-with-at-least-32-bytes"),
        startTransport: (configuration) =>
          startCoreProcess({ configuration, statePath, spawner: nodeProcessSpawner }),
      })

      expect(session.health).toEqual({
        applicationInstanceId: "app-real-process",
        processEpoch: "epoch-real-process",
        lifecycle: "awaitingOwnership",
      })
    }).pipe(Effect.provide(dependencies)),
  )

  it.effect("sanitizes a process that exits before creating its socket", () =>
    Effect.gen(function* () {
      const tempResources = yield* TempResources
      const temporaryDirectory = yield* tempResources.makeTempDirectoryScoped({
        prefix: "dd-core-process-parent-",
      })
      const artifactDirectory = resolve(".generated/core")
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
      const failure = yield* bootstrapCoreHost({
        artifact,
        applicationInstanceId: ApplicationInstanceId.make("app-failed-process"),
        temporaryDirectory,
        startTransport: (configuration) =>
          startCoreProcess({
            configuration,
            statePath: privateStatePath,
            spawner: immediateExitSpawner,
          }),
      }).pipe(Effect.flip)

      expect(failure.stage).toBe("preparingRuntime")
      expect(JSON.stringify(failure)).not.toContain(privateStatePath)
      expect(JSON.stringify(failure)).not.toContain(artifact.entrypointPath)
    }).pipe(Effect.provide(dependencies)),
  )
})
