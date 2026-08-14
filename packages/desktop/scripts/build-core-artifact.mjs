import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceDirectory = resolve(desktopDirectory, "../..")

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
    const buildResult = await build({
      absWorkingDir: workspaceDirectory,
      banner: {
        js: 'import { createRequire as __diffdashCreateRequire } from "node:module"; const require = __diffdashCreateRequire(import.meta.url);',
      },
      bundle: true,
      entryPoints: [coreArtifactEntryForMode(normalizedMode)],
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
      buildId: `core-${normalizedMode}-${entrypointSha256.slice(0, 40)}`,
      entrypoint: "core.mjs",
      entrypointSha256,
      runtime: { utility: true, bun: false },
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
    return { manifest, metafile: buildResult.metafile, outputDirectory }
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
