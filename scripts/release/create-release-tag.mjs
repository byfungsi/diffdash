import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const packageJson = JSON.parse(readFileSync("packages/desktop/package.json", "utf8"))
const version = packageJson.version

if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package.json version must be SemVer-like, got ${JSON.stringify(version)}`)
}

const tag = `v${version}`
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
