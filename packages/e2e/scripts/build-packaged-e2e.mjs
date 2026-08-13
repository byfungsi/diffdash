import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

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

const desktopDirectory = fileURLToPath(new URL("../../desktop", import.meta.url))
const result = spawnSync(
  pnpm,
  ["exec", "electron-builder", ...target, "--config.appId=com.usediffdash.e2e", "--publish=never"],
  {
    cwd: desktopDirectory,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    },
    stdio: "inherit",
  },
)

if (result.error !== undefined) throw result.error
if (result.signal !== null) throw new Error(`electron-builder exited with signal ${result.signal}`)
if (result.status !== 0) process.exit(result.status ?? 1)

if (process.platform === "darwin") {
  const outputDirectory = join(desktopDirectory, "dist")
  const appDirectory = readdirSync(outputDirectory, { withFileTypes: true }).find(
    (entry) => entry.isDirectory() && entry.name.startsWith("mac"),
  )
  if (appDirectory === undefined) throw new Error("Packaged macOS application was not found")
  const signed = spawnSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", join(outputDirectory, appDirectory.name, "DiffDash.app")],
    { stdio: "inherit" },
  )
  if (signed.error !== undefined) throw signed.error
  if (signed.status !== 0) process.exit(signed.status ?? 1)
}
