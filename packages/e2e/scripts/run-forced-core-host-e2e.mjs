import { spawnSync } from "node:child_process"
import { withDesktopBuildLease } from "./desktop-build-lease.mjs"

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
const criticalFlowPattern = [
  "routes a hosted review through the non-GitHub fixture provider",
  "runs an explicit Claude walkthrough successfully",
  "reports an explicit Claude walkthrough failure through contextBridge and clipboard",
  "falls back from invalid Claude walkthrough output to Codex in Auto mode",
  "skips unavailable Claude and falls back to Codex in Auto mode",
  "recovers a running walkthrough after renderer reload",
  "kills the provider child and persists interruption after Core termination",
  "FUN-133 AC: runs a fixture review turn through codex",
  "opens and forwards immutable repository comparisons through Electron",
].join("|")

await withDesktopBuildLease(async () => {
  run(pnpm, ["--filter", "@diffdash/desktop", "build:e2e"])

  for (const host of ["bun", "utility"]) {
    run(
      pnpm,
      [
        "--filter",
        "@diffdash/e2e",
        "exec",
        "playwright",
        "test",
        "--project=desktop",
        `--output=test-results/forced-${host}`,
        "--grep",
        criticalFlowPattern,
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
