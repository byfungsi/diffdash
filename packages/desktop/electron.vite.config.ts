import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { loadEnv } from "vite"

const packageJson: unknown = JSON.parse(readFileSync(resolve("package.json"), "utf8"))
const packageVersion =
  typeof packageJson === "object" &&
  packageJson !== null &&
  "version" in packageJson &&
  typeof packageJson.version === "string"
    ? packageJson.version
    : "0.0.0"

const internalPackages = [
  "@diffdash/app",
  "@diffdash/domain",
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

  return {
    main: {
      define: {
        "process.env.VITE_POSTHOG_HOST": JSON.stringify(posthogHost),
        "process.env.VITE_POSTHOG_KEY": JSON.stringify(posthogKey),
      },
      plugins: [externalizeDepsPlugin({ exclude: internalPackages })],
      build: {
        rollupOptions: {
          input: resolve("electron/main/index.ts"),
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
