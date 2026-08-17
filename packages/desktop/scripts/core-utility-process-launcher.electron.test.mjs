import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import electronPath from "electron"
import { build } from "esbuild"

import { buildCoreArtifact } from "./build-core-artifact.mjs"

const run = promisify(execFile)

test("launches the generated Core artifact through Electron utilityProcess", async (context) => {
  const desktopDirectory = resolve(".")
  const workspaceDirectory = resolve(desktopDirectory, "../..")
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), "dd-core-utility-fixture-"))
  const artifactDirectory = resolve(fixtureDirectory, "artifact")
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "ddcu-"))
  context.after(async () => {
    await Promise.all([
      rm(fixtureDirectory, { recursive: true, force: true }),
      rm(temporaryDirectory, { recursive: true, force: true }),
    ])
  })
  const statePath = resolve(fixtureDirectory, "state.json")
  const fixtureEntrypoint = resolve(fixtureDirectory, "fixture.mjs")
  const { manifest } = await buildCoreArtifact({
    mode: "production",
    outputDirectory: artifactDirectory,
  })

  await build({
    absWorkingDir: workspaceDirectory,
    banner: {
      js: 'import { createRequire as __diffdashCreateRequire } from "node:module"; const require = __diffdashCreateRequire(import.meta.url);',
    },
    bundle: true,
    entryPoints: [
      resolve(desktopDirectory, "electron/main/core-utility-process-launcher.fixture.ts"),
    ],
    external: ["electron"],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    outfile: fixtureEntrypoint,
    platform: "node",
    target: "node22",
  })

  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const result = await run(
    electronPath,
    [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      fixtureEntrypoint,
      artifactDirectory,
      temporaryDirectory,
      statePath,
      manifest.buildId,
    ],
    { env: environment, timeout: 20_000 },
  )

  assert.match(result.stdout, /DIFFDASH_CORE_UTILITY_PROBE_READY:awaitingOwnership/u)
  assert.doesNotMatch(result.stderr, /DIFFDASH_CORE_UTILITY_PROBE_FAILED/u)
  const packagedManifest = await readFile(resolve(artifactDirectory, "manifest.json"), "utf8")
  assert.match(packagedManifest, new RegExp(manifest.entrypointSha256, "u"))
})
