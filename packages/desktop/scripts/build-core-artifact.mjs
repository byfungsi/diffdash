import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceDirectory = resolve(desktopDirectory, "../..")
const desktopPackage = JSON.parse(await readFile(resolve(desktopDirectory, "package.json"), "utf8"))
const minimumBunVersion = "1.2.0"

/** @typedef {"production" | "e2e"} CoreArtifactMode */

/** Selects the fail-closed Core entrypoint for a Desktop build mode. */
export const coreArtifactEntryForMode = (mode) =>
  mode === "e2e"
    ? resolve(workspaceDirectory, "packages/core/src/standalone.e2e.ts")
    : resolve(workspaceDirectory, "packages/core/src/standalone.ts")

/** Builds and atomically promotes one exact standalone Core artifact. */
export const buildCoreArtifact = async ({
  mode,
  outputDirectory = resolve(desktopDirectory, ".generated/core"),
}) => {
  const normalizedMode = mode === "e2e" ? "e2e" : "production"
  const stagingDirectory = `${outputDirectory}.staging-${randomUUID()}`
  const previousDirectory = `${outputDirectory}.previous-${randomUUID()}`
  const entrypointPath = resolve(stagingDirectory, "core.mjs")
  await mkdir(stagingDirectory, { recursive: true })

  let previousMoved = false
  try {
    const workerBuild = async (entryPoint, outfile, platform) =>
      build({
        absWorkingDir: workspaceDirectory,
        bundle: true,
        entryPoints: [entryPoint],
        format: "esm",
        legalComments: "none",
        logLevel: "silent",
        metafile: true,
        outfile,
        platform,
        sourcemap: false,
        target: "es2022",
        treeShaking: true,
      })
    const nodeWorkerPath = resolve(stagingDirectory, "review-worker-node.mjs")
    const bunWorkerPath = resolve(stagingDirectory, "review-worker-bun.mjs")
    const nodeWorkerBuild = await workerBuild(
      resolve(workspaceDirectory, "packages/review-data-worker/src/node-worker-entrypoint.ts"),
      nodeWorkerPath,
      "node",
    )
    const bunWorkerBuild = await workerBuild(
      resolve(workspaceDirectory, "packages/review-data-worker/src/bun-worker-entrypoint.ts"),
      bunWorkerPath,
      "neutral",
    )
    const nodeWorkerSha256 = createHash("sha256")
      .update(await readFile(nodeWorkerPath))
      .digest("hex")
    const bunWorkerSha256 = createHash("sha256")
      .update(await readFile(bunWorkerPath))
      .digest("hex")
    const reviewWorkerBuildId = `review-worker-v1-${nodeWorkerSha256.slice(0, 20)}-${bunWorkerSha256.slice(0, 20)}`
    const buildResult = await build({
      absWorkingDir: workspaceDirectory,
      banner: {
        js: 'import { createRequire as __diffdashCreateRequire } from "node:module"; const require = __diffdashCreateRequire(import.meta.url);',
      },
      bundle: true,
      entryPoints: [coreArtifactEntryForMode(normalizedMode)],
      define: {
        DIFFDASH_REVIEW_WORKER_BUILD_ID: JSON.stringify(reviewWorkerBuildId),
        DIFFDASH_REVIEW_WORKER_NODE_SHA256: JSON.stringify(nodeWorkerSha256),
        DIFFDASH_REVIEW_WORKER_BUN_SHA256: JSON.stringify(bunWorkerSha256),
      },
      format: "esm",
      legalComments: "none",
      logLevel: "silent",
      metafile: true,
      outfile: entrypointPath,
      platform: "node",
      sourcemap: false,
      target: "node22",
      treeShaking: true,
    })
    const entrypoint = await readFile(entrypointPath)
    const entrypointSha256 = createHash("sha256").update(entrypoint).digest("hex")
    const manifest = {
      schemaVersion: 1,
      buildId: `core-${desktopPackage.version}-${normalizedMode}-${process.platform}-${process.arch}-${entrypointSha256.slice(0, 40)}`,
      desktop: {
        version: desktopPackage.version,
        mode: normalizedMode,
        platform: process.platform,
        architecture: process.arch,
      },
      entrypoint: "core.mjs",
      entrypointSha256,
      reviewWorker: {
        buildId: reviewWorkerBuildId,
        node: { entrypoint: "review-worker-node.mjs", entrypointSha256: nodeWorkerSha256 },
        bun: { entrypoint: "review-worker-bun.mjs", entrypointSha256: bunWorkerSha256 },
      },
      runtime: {
        utility: true,
        bun: {
          minimumVersion: minimumBunVersion,
          architecture: process.arch,
        },
      },
    }
    await writeFile(
      resolve(stagingDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    )

    try {
      await rename(outputDirectory, previousDirectory)
      previousMoved = true
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
    await rename(stagingDirectory, outputDirectory)
    if (previousMoved) await rm(previousDirectory, { recursive: true, force: true })
    return {
      manifest,
      metafile: {
        inputs: {
          ...buildResult.metafile.inputs,
          ...nodeWorkerBuild.metafile.inputs,
          ...bunWorkerBuild.metafile.inputs,
        },
      },
      outputDirectory,
    }
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true })
    if (previousMoved) {
      await rm(outputDirectory, { recursive: true, force: true })
      await rename(previousDirectory, outputDirectory)
    }
    throw error
  }
}

const requestedMode = process.argv.includes("--mode=e2e") ? "e2e" : "production"
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildCoreArtifact({ mode: requestedMode })
}
