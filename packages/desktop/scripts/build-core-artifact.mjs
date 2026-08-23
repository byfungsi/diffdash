import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"
import { Array as EffectArray, Order, Schema } from "effect"
import { CoreArtifactManifest } from "../electron/main/core-artifact-manifest.ts"

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

/** Selects the Bun-native fail-closed Core entrypoint for a Desktop build mode. */
export const bunCoreArtifactEntryForMode = (mode) =>
  mode === "e2e"
    ? resolve(workspaceDirectory, "packages/core/src/standalone-bun.e2e.ts")
    : resolve(workspaceDirectory, "packages/core/src/standalone-bun.ts")

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
    const bunEntrypointPath = resolve(stagingDirectory, "core-bun.mjs")
    const languageDirectory = resolve(stagingDirectory, "language/typescript")
    const languageProviderRequire = createRequire(
      resolve(workspaceDirectory, "packages/language-provider-typescript/package.json"),
    )
    const languageServerSource = languageProviderRequire.resolve(
      "typescript-language-server/lib/cli.mjs",
    )
    const tsserverSource = languageProviderRequire.resolve("typescript/lib/tsserver.js")
    const treeSitterSource = languageProviderRequire.resolve("@vscode/tree-sitter-wasm")
    await mkdir(languageDirectory, { recursive: true })
    const languageServerBuild = await build({
      absWorkingDir: workspaceDirectory,
      bundle: true,
      entryPoints: [languageServerSource],
      format: "esm",
      legalComments: "none",
      logLevel: "silent",
      metafile: true,
      outfile: resolve(languageDirectory, "lib/cli.mjs"),
      platform: "node",
      sourcemap: false,
      target: "node22",
      treeShaking: true,
    })
    await cp(
      resolve(dirname(dirname(languageServerSource)), "package.json"),
      resolve(languageDirectory, "package.json"),
    )
    await cp(
      resolve(dirname(dirname(tsserverSource)), "lib"),
      resolve(languageDirectory, "typescript/lib"),
      {
        recursive: true,
      },
    )
    await cp(
      resolve(dirname(dirname(tsserverSource)), "package.json"),
      resolve(languageDirectory, "typescript/package.json"),
    )
    await Promise.all(
      [
        "tree-sitter.wasm",
        "tree-sitter-javascript.wasm",
        "tree-sitter-typescript.wasm",
        "tree-sitter-tsx.wasm",
      ].map((asset) =>
        cp(resolve(dirname(treeSitterSource), asset), resolve(languageDirectory, asset)),
      ),
    )
    const languageTreeHash = createHash("sha256")
    const languageEntries = await readdir(languageDirectory, {
      withFileTypes: true,
      recursive: true,
    })
    assert(
      EffectArray.every(languageEntries, (entry) => entry.isDirectory() || entry.isFile()),
      "Core artifact assets must contain only files",
    )
    const languageFiles = EffectArray.map(
      EffectArray.filter(languageEntries, (entry) => entry.isFile()),
      (entry) =>
        relative(languageDirectory, resolve(entry.parentPath, entry.name)).split(sep).join("/"),
    )
    const languageFileContents = await Promise.all(
      EffectArray.map(
        EffectArray.sortWith(languageFiles, (path) => path, Order.String),
        async (relativePath) => ({
          relativePath,
          bytes: await readFile(resolve(languageDirectory, relativePath)),
        }),
      ),
    )
    for (const { relativePath, bytes } of languageFileContents) {
      languageTreeHash.update(relativePath)
      languageTreeHash.update("\0")
      languageTreeHash.update(bytes)
    }
    const languageTreeSha256 = languageTreeHash.digest("hex")
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
    const buildCore = (entryPoint, outfile, target, external = []) =>
      build({
        absWorkingDir: workspaceDirectory,
        banner: {
          js: 'import { createRequire as __diffdashCreateRequire } from "node:module"; const require = __diffdashCreateRequire(import.meta.url);',
        },
        bundle: true,
        entryPoints: [entryPoint],
        external,
        define: {
          DIFFDASH_REVIEW_WORKER_BUILD_ID: JSON.stringify(reviewWorkerBuildId),
          DIFFDASH_REVIEW_WORKER_NODE_SHA256: JSON.stringify(nodeWorkerSha256),
          DIFFDASH_REVIEW_WORKER_BUN_SHA256: JSON.stringify(bunWorkerSha256),
          "process.env.DIFFDASH_TYPESCRIPT_LANGUAGE_TREE_SHA256":
            JSON.stringify(languageTreeSha256),
        },
        format: "esm",
        legalComments: "none",
        logLevel: "silent",
        metafile: true,
        outfile,
        platform: "node",
        sourcemap: false,
        target,
        treeShaking: true,
      })
    const buildResult = await buildCore(
      coreArtifactEntryForMode(normalizedMode),
      entrypointPath,
      "node22",
    )
    const bunBuildResult = await buildCore(
      bunCoreArtifactEntryForMode(normalizedMode),
      bunEntrypointPath,
      "es2022",
      ["bun:sqlite"],
    )
    const entrypoint = await readFile(entrypointPath)
    const entrypointSha256 = createHash("sha256").update(entrypoint).digest("hex")
    const bunEntrypointSha256 = createHash("sha256")
      .update(await readFile(bunEntrypointPath))
      .digest("hex")
    const manifest = {
      schemaVersion: 1,
      buildId: `core-${desktopPackage.version}-${normalizedMode}-${process.platform}-${process.arch}-${entrypointSha256.slice(0, 20)}-${languageTreeSha256.slice(0, 20)}`,
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
      language: {
        typescript: {
          root: "language/typescript",
          treeSha256: languageTreeSha256,
        },
      },
      runtime: {
        utility: true,
        bun: {
          minimumVersion: minimumBunVersion,
          architecture: process.arch,
          entrypoint: "core-bun.mjs",
          entrypointSha256: bunEntrypointSha256,
        },
      },
    }
    const manifestText = Schema.encodeSync(Schema.fromJsonString(CoreArtifactManifest))(manifest)
    await writeFile(resolve(stagingDirectory, "manifest.json"), `${manifestText}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })

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
          ...bunBuildResult.metafile.inputs,
          ...nodeWorkerBuild.metafile.inputs,
          ...bunWorkerBuild.metafile.inputs,
          ...languageServerBuild.metafile.inputs,
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
const outputDirectoryArgument = process.argv.find((argument) =>
  argument.startsWith("--output-directory="),
)
const requestedOutputDirectory =
  outputDirectoryArgument === undefined
    ? undefined
    : resolve(outputDirectoryArgument.slice("--output-directory=".length))
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildCoreArtifact({ mode: requestedMode, outputDirectory: requestedOutputDirectory })
}
