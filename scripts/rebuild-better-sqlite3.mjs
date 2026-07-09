import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)
const betterSqlitePackagePath = require.resolve("better-sqlite3/package.json")
const betterSqliteDirectory = dirname(betterSqlitePackagePath)
const betterSqliteBinaryPath = join(
  betterSqliteDirectory,
  "build",
  "Release",
  "better_sqlite3.node",
)
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
const rebuild = spawn(pnpm, ["rebuild", "better-sqlite3"], {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
})
const output = []

rebuild.stdout.on("data", (chunk) => {
  output.push(chunk)
  process.stdout.write(chunk)
})

rebuild.stderr.on("data", (chunk) => {
  output.push(chunk)
  process.stderr.write(chunk)
})

rebuild.on("error", (error) => {
  console.error(error)
  process.exit(1)
})

rebuild.on("close", (code, signal) => {
  if (code === 0 && signal === null) {
    return
  }

  const outputText = Buffer.concat(output).toString("utf8")
  const isNodeGypCleanupFailure =
    outputText.includes("ENOENT") &&
    outputText.includes("node_gyp_bins") &&
    outputText.includes("SOLINK_MODULE(target) Release/better_sqlite3.node") &&
    existsSync(betterSqliteBinaryPath)

  if (isNodeGypCleanupFailure) {
    console.warn(
      "Ignoring node-gyp node_gyp_bins cleanup failure because better_sqlite3.node was built.",
    )
    return
  }

  if (signal !== null) {
    console.error(`better-sqlite3 rebuild exited with signal ${signal}`)
    process.exit(1)
  }

  process.exit(code ?? 1)
})
