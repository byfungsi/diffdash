import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { loadEnv } from "vite"
import { Schema } from "effect"
import { desktopMainEntryForMode } from "./electron-build-configuration"

const packageJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
)(readFileSync(resolve("package.json"), "utf8"))
const packageVersion = packageJson._tag === "Some" ? packageJson.value.version : "0.0.0"
const CoreArtifactBuildManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  buildId: Schema.String,
  entrypoint: Schema.Literal("core.mjs"),
  entrypointSha256: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  runtime: Schema.Struct({
    utility: Schema.Literal(true),
    bun: Schema.Literal(false),
  }),
})

const coreArtifactBuildIdForMode = (mode: string): string => {
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(CoreArtifactBuildManifest))(
    readFileSync(resolve(".generated/core/manifest.json"), "utf8"),
  )
  const expectedPrefix = mode === "e2e" ? "core-e2e-" : "core-production-"
  if (!manifest.buildId.startsWith(expectedPrefix)) {
    throw new Error(`Generated Core artifact does not match the ${mode} Desktop build mode.`)
  }
  return manifest.buildId
}

const internalPackages = [
  "@diffdash/agent-provider",
  "@diffdash/agent-provider-claude",
  "@diffdash/agent-provider-codex",
  "@diffdash/agent-provider-fixture",
  "@diffdash/agent-provider-opencode",
  "@diffdash/agents",
  "@diffdash/app",
  "@diffdash/core",
  "@diffdash/domain",
  "@diffdash/git-provider",
  "@diffdash/git-provider-fixture",
  "@diffdash/git-provider-github",
  "@diffdash/local-git",
  "@diffdash/persistence",
  "@diffdash/process",
  "@diffdash/protocol",
  "@diffdash/settings",
]

const appVersion = (() => {
  try {
    const tag = execFileSync(
      "git",
      ["describe", "--tags", "--exact-match", "--match", "v[0-9]*", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim()
    if (/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) return tag
  } catch {
    // Untagged development builds use the package version.
  }
  return `v${packageVersion}`
})()

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const rootEnv = loadEnv(mode, resolve("../.."), "")
  const landingEnv = loadEnv(mode, resolve("../web"), "")
  const posthogHost =
    env.VITE_POSTHOG_HOST || rootEnv.VITE_POSTHOG_HOST || landingEnv.VITE_POSTHOG_HOST || ""
  const posthogKey =
    env.VITE_POSTHOG_KEY || rootEnv.VITE_POSTHOG_KEY || landingEnv.VITE_POSTHOG_KEY || ""
  const coreArtifactBuildId = coreArtifactBuildIdForMode(mode)

  return {
    main: {
      define: {
        "process.env.DIFFDASH_CORE_BUILD_ID": JSON.stringify(coreArtifactBuildId),
        "process.env.VITE_POSTHOG_HOST": JSON.stringify(posthogHost),
        "process.env.VITE_POSTHOG_KEY": JSON.stringify(posthogKey),
      },
      plugins: [externalizeDepsPlugin({ exclude: internalPackages })],
      build: {
        rollupOptions: {
          input: { index: resolve(desktopMainEntryForMode(mode)) },
        },
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin({ exclude: internalPackages })],
      build: {
        rollupOptions: {
          input: resolve("electron/preload/index.ts"),
        },
      },
    },
    renderer: {
      root: resolve("src/renderer"),
      worker: {
        format: "es",
      },
      define: {
        "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
      },
      resolve: {
        alias: {
          "@": resolve("../app/src"),
        },
      },
      plugins: [react(), tailwindcss()],
    },
  }
})
