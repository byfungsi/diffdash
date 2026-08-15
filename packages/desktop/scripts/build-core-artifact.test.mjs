import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test from "node:test"

import { buildCoreArtifact } from "./build-core-artifact.mjs"

const buildIn = async (parent, name, mode) => {
  const outputDirectory = resolve(parent, name)
  return buildCoreArtifact({ mode, outputDirectory })
}

test("builds deterministic runtime-neutral production and E2E Core artifacts", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "dd-core-build-"))
  const production = await buildIn(directory, "production", "production")
  const repeated = await buildIn(directory, "production-repeated", "production")
  const e2e = await buildIn(directory, "e2e", "e2e")

  const productionEntrypoint = await readFile(resolve(production.outputDirectory, "core.mjs"))
  const repeatedEntrypoint = await readFile(resolve(repeated.outputDirectory, "core.mjs"))
  const manifestText = await readFile(resolve(production.outputDirectory, "manifest.json"), "utf8")
  const manifest = JSON.parse(manifestText)
  const e2eManifestText = await readFile(resolve(e2e.outputDirectory, "manifest.json"), "utf8")
  const productionInputs = Object.keys(production.metafile.inputs).join("\n")
  const e2eInputs = Object.keys(e2e.metafile.inputs).join("\n")

  assert.deepEqual(await readdir(production.outputDirectory), ["core.mjs", "manifest.json"])
  assert.deepEqual(productionEntrypoint, repeatedEntrypoint)
  assert.equal(
    manifestText,
    await readFile(resolve(repeated.outputDirectory, "manifest.json"), "utf8"),
  )
  assert.match(
    manifestText,
    new RegExp(
      `"buildId": "core-0\\.8\\.1-production-${process.platform}-${process.arch}-[a-f0-9]{40}"`,
      "u",
    ),
  )
  assert.deepEqual(manifest.desktop, {
    version: "0.8.1",
    mode: "production",
    platform: process.platform,
    architecture: process.arch,
  })
  assert.deepEqual(manifest.runtime, {
    utility: true,
    bun: { minimumVersion: "1.2.0", architecture: process.arch },
  })
  assert.match(
    e2eManifestText,
    new RegExp(
      `"buildId": "core-0\\.8\\.1-e2e-${process.platform}-${process.arch}-[a-f0-9]{40}"`,
      "u",
    ),
  )
  assert.match(
    manifestText,
    new RegExp(createHash("sha256").update(productionEntrypoint).digest("hex"), "u"),
  )
  assert.doesNotMatch(productionInputs, /provider-composition\.e2e|provider-fixture/u)
  assert.doesNotMatch(e2eInputs, /provider-composition\.e2e|provider-fixture/u)
  assert.doesNotMatch(productionInputs, /database-node|node:sqlite/u)
  assert.doesNotMatch(e2eInputs, /database-node|node:sqlite/u)
})
