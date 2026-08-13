import { execFileSync } from "node:child_process"
import { parseCreateReleaseTagArguments } from "./release-arguments.mjs"
import { deriveReleaseContext } from "./release-context.mjs"

parseCreateReleaseTagArguments()
const { tag } = deriveReleaseContext({ commitRef: "HEAD" })
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
