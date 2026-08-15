import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { ApplicationInstanceId } from "@diffdash/core-rpc/identity"
import { TempResources } from "@diffdash/process/temp-resource"
import { Effect, Layer } from "effect"
import { app } from "electron"

import { verifyCoreArtifact } from "./core-artifact"
import { bootstrapCoreHost } from "./core-host-bootstrap"
import { startCoreUtilityProcess } from "./core-utility-process-launcher"

const [artifactDirectory, temporaryDirectory, statePath, expectedBuildId] = process.argv.slice(2)
const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const dependencies = Layer.merge(
  TempResources.layer.pipe(Layer.provide(platformLayer)),
  platformLayer,
)

const probe = Effect.gen(function* () {
  if (
    artifactDirectory === undefined ||
    temporaryDirectory === undefined ||
    statePath === undefined ||
    expectedBuildId === undefined
  ) {
    return yield* Effect.die(new Error("Core utility process probe arguments are missing."))
  }
  const artifact = yield* verifyCoreArtifact({ artifactDirectory, expectedBuildId })
  const session = yield* bootstrapCoreHost({
    artifact,
    applicationInstanceId: ApplicationInstanceId.make("app-electron-utility-probe"),
    temporaryDirectory,
    startTransport: (configuration) =>
      startCoreUtilityProcess({
        configuration,
        databasePath: `${statePath}.sqlite`,
        statePath,
      }),
  })
  console.info(`DIFFDASH_CORE_UTILITY_PROBE_READY:${session.health.lifecycle}`)
  return undefined
}).pipe(Effect.provide(dependencies), Effect.scoped)

void app
  .whenReady()
  .then(() => Effect.runPromise(probe))
  .then(
    () => app.exit(0),
    () => {
      console.error("DIFFDASH_CORE_UTILITY_PROBE_FAILED")
      app.exit(1)
    },
  )
