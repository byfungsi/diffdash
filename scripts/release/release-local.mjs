import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import "./load-local-env.mjs"
import { parseLocalReleaseArguments } from "./release-arguments.mjs"
import { runSyncCommand } from "./release-command.mjs"
import { assertTagMatchesVersion, releaseTagForVersion } from "./release-policy.mjs"

const cli = parseLocalReleaseArguments()
const packageJson = JSON.parse(readFileSync("packages/desktop/package.json", "utf8"))
const tag = cli.tag ?? releaseTagForVersion(packageJson.version)
const releaseAssetsDir = path.resolve(cli.assetsDir ?? "release-assets")
const macArch = cli.macArch ?? process.env.RELEASE_MAC_ARCH ?? "all"
const { skipChecks, skipMac, skipLinux, skipPublish, allowPublished } = cli

assertTagMatchesVersion(tag, packageJson.version)

const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
if (status.length > 0) {
  throw new Error("Working tree must be clean before building or publishing release artifacts.")
}

const tagCommit = execFileSync("git", ["rev-list", "-n", "1", tag], { encoding: "utf8" }).trim()
const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
if (tagCommit !== headCommit) {
  throw new Error(
    `Release tag ${tag} does not point at HEAD. Refusing to build or publish mismatched local artifacts.`,
  )
}

runSyncCommand("node", ["scripts/release/extract-release-notes.mjs", tag])

if (!skipChecks) {
  runSyncCommand("pnpm", ["release:check"])
}

if (!skipMac) {
  const macArgs = ["scripts/release/build-local-mac-release.mjs", "--assets-dir", releaseAssetsDir]
  if (macArch !== undefined && macArch.trim().length > 0) {
    macArgs.push("--arch", macArch)
  }
  runSyncCommand("node", macArgs)
}

if (!skipLinux) {
  runSyncCommand("node", [
    "scripts/release/build-local-linux-release.mjs",
    "--assets-dir",
    releaseAssetsDir,
  ])
}

if (!skipPublish) {
  const publishArgs = [
    "scripts/release/publish-release-assets.mjs",
    "--tag",
    tag,
    "--assets-dir",
    releaseAssetsDir,
  ]
  if (allowPublished) publishArgs.push("--allow-published")
  runSyncCommand("node", publishArgs)
}

console.log(`Local release candidate flow completed for ${tag}`)
if (!skipPublish) {
  console.log(`Publish the GitHub draft; GitHub Actions will promote ${tag} after verification.`)
}
