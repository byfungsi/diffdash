import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { parseCreateReleaseTagArguments } from "./release-arguments.mjs"
import { releaseTagForVersion } from "./release-policy.mjs"

parseCreateReleaseTagArguments()
const packageJson = JSON.parse(readFileSync("packages/desktop/package.json", "utf8"))
const version = packageJson.version
const tag = releaseTagForVersion(version)
const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })

if (status.trim().length > 0) {
  throw new Error("Commit release version changes before creating a release tag.")
}

try {
  execFileSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], { stdio: "ignore" })
  throw new Error(`Tag ${tag} already exists.`)
} catch (error) {
  if (error instanceof Error && error.message.includes("already exists")) {
    throw error
  }
}

execFileSync("git", ["tag", "-a", tag, "-m", `Release ${tag}`], { stdio: "inherit" })
console.log(`Created ${tag}`)
