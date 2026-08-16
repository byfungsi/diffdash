import { spawnSync } from "node:child_process"
import { withDesktopBuildLease } from "./desktop-build-lease.mjs"

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

await withDesktopBuildLease(async () => {
  run(pnpm, ["--filter", "@diffdash/desktop", "build:e2e"])

  for (const host of ["bun", "utility"]) {
    run(
      pnpm,
      [
        "exec",
        "playwright",
        "test",
        "--project=desktop",
        "--grep",
        "reports an explicit Claude walkthrough failure through contextBridge and clipboard",
      ],
      {
        DIFFDASH_E2E_CORE_HOST: host,
        DIFFDASH_E2E_FORCED_CORE_HOST_GATE: "1",
      },
    )
  }
})

function run(command, args, environment = {}) {
  const result = spawnSync(command, args, {
    env: { ...process.env, ...environment },
    stdio: "inherit",
  })
  if (result.error !== undefined) throw result.error
  if (result.signal !== null) throw new Error(`${command} exited with signal ${result.signal}`)
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 1}`)
}
