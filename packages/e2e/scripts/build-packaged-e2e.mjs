import { spawnSync } from "node:child_process"

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
const target =
  process.platform === "darwin"
    ? ["--mac", "zip"]
    : process.platform === "linux"
      ? ["--linux", "AppImage"]
      : process.platform === "win32"
        ? ["--win", "nsis"]
        : null

if (target === null) throw new Error(`Unsupported packaged E2E platform: ${process.platform}`)

const result = spawnSync(pnpm, ["exec", "electron-builder", ...target, "--publish=never"], {
  cwd: new URL("../../desktop", import.meta.url),
  env: {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  },
  stdio: "inherit",
})

if (result.error !== undefined) throw result.error
if (result.signal !== null) throw new Error(`electron-builder exited with signal ${result.signal}`)
process.exit(result.status ?? 1)
