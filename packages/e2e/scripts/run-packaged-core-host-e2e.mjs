import { spawnSync } from "node:child_process"

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

for (const host of ["bun", "utility"]) {
  const result = spawnSync(pnpm, ["exec", "playwright", "test", "--project=packaged"], {
    env: {
      ...process.env,
      DIFFDASH_E2E_CORE_HOST: host,
      DIFFDASH_E2E_PACKAGED_FORCED_CORE_HOST_GATE: "1",
    },
    stdio: "inherit",
  })
  if (result.error !== undefined) throw result.error
  if (result.signal !== null) throw new Error(`Packaged ${host} gate exited with ${result.signal}`)
  if (result.status !== 0) {
    throw new Error(`Packaged ${host} gate exited with status ${result.status ?? 1}`)
  }
}
