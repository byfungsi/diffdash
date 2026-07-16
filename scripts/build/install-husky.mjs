import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

if (!existsSync(".git")) {
  console.log("Skipping Husky install because .git is not present.")
  process.exit(0)
}

const result = spawnSync("husky", [], {
  shell: process.platform === "win32",
  stdio: "inherit",
})

process.exit(result.status ?? 1)
