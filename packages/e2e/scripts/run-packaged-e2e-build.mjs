import { spawnSync } from "node:child_process"
import { withDesktopBuildLease } from "./desktop-build-lease.mjs"

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

await withDesktopBuildLease(async () => {
  run(pnpm, ["--filter", "@diffdash/desktop", "assets:icons"])
  run(pnpm, ["--filter", "@diffdash/desktop", "build:e2e"])
  run(process.execPath, ["scripts/build-packaged-e2e.mjs"])
})

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.error !== undefined) throw result.error
  if (result.signal !== null) throw new Error(`${command} exited with signal ${result.signal}`)
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 1}`)
}
