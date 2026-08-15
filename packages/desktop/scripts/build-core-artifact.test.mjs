import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { Worker } from "node:worker_threads"

import { buildCoreArtifact } from "./build-core-artifact.mjs"

const execFilePromise = promisify(execFile)

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

  assert.deepEqual(await readdir(production.outputDirectory), [
    "core.mjs",
    "manifest.json",
    "review-worker-bun.mjs",
    "review-worker-node.mjs",
  ])
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
  assert.match(manifest.reviewWorker.buildId, /^review-worker-v1-[a-f0-9]{20}-[a-f0-9]{20}$/u)
  await Promise.all(
    ["node", "bun"].map(async (host) => {
      const worker = await readFile(
        resolve(production.outputDirectory, manifest.reviewWorker[host].entrypoint),
      )
      assert.equal(
        createHash("sha256").update(worker).digest("hex"),
        manifest.reviewWorker[host].entrypointSha256,
      )
      assert.doesNotMatch(worker.toString("utf8"), /(?:node|bun):sqlite|child_process/u)
    }),
  )
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

test("runs the generated parser protocol in a real Node worker", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "dd-review-worker-node-"))
  const artifact = await buildIn(directory, "artifact", "production")
  const worker = new Worker(resolve(artifact.outputDirectory, "review-worker-node.mjs"))
  try {
    const heartbeat = waitForMessage(worker, (message) => message?._tag === "Heartbeat")
    worker.postMessage({ _tag: "Heartbeat", requestId: 1 })
    assert.deepEqual(await heartbeat, { _tag: "Heartbeat", requestId: 1 })

    const accepted = waitForMessage(worker, (message) => message?._tag === "Accepted")
    worker.postMessage({
      _tag: "Chunk",
      requestId: 2,
      bytes: new TextEncoder().encode(
        "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
      ),
    })
    assert.deepEqual(await accepted, { _tag: "Accepted", requestId: 2 })

    const rejected = waitForMessage(worker, (message) => message?._tag === "Failed")
    worker.postMessage({ _tag: "Chunk", requestId: 3, bytes: new Uint8Array(64 * 1_024 + 1) })
    assert.match((await rejected).message, /chunkTooLarge/u)
  } finally {
    await worker.terminate()
  }
})

test("runs the generated parser protocol in a real Bun worker when Bun is available", async (t) => {
  const bun = process.env.HOME === undefined ? null : resolve(process.env.HOME, ".bun/bin/bun")
  if (bun === null) return t.skip("Bun is unavailable")
  try {
    await execFilePromise(bun, ["--version"])
  } catch {
    return t.skip("Bun is unavailable")
  }

  const directory = await mkdtemp(resolve(tmpdir(), "dd-review-worker-bun-"))
  const artifact = await buildIn(directory, "artifact", "production")
  const runner = resolve(directory, "runner.mjs")
  await writeFile(
    runner,
    `
      const worker = new Worker(${JSON.stringify(resolve(artifact.outputDirectory, "review-worker-bun.mjs"))}, { type: "module" });
      const timeout = setTimeout(() => { worker.terminate(); process.exit(2); }, 5000);
      worker.onmessage = (event) => {
        if (event.data?._tag !== "Heartbeat") return;
        clearTimeout(timeout);
        worker.terminate();
        process.exit(event.data.requestId === 1 ? 0 : 3);
      };
      worker.onerror = () => process.exit(4);
      worker.postMessage({ _tag: "Heartbeat", requestId: 1 });
    `,
  )
  await execFilePromise(bun, ["--no-install", runner])
})

const waitForMessage = (worker, predicate) =>
  new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => reject(new Error("Worker response timed out")), 5_000)
    const receive = (message) => {
      if (!predicate(message)) return
      clearTimeout(timeout)
      worker.off("message", receive)
      resolveMessage(message)
    }
    worker.on("message", receive)
  })
