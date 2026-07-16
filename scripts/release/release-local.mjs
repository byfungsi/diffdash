import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import "./load-local-env.mjs"

const args = process.argv.slice(2)
const packageJson = JSON.parse(readFileSync("packages/desktop/package.json", "utf8"))
const tag = readOption("--tag") ?? `v${packageJson.version}`
const releaseAssetsDir = path.resolve(readOption("--assets-dir") ?? "release-assets")
const macArch = readOption("--mac-arch") ?? process.env.RELEASE_MAC_ARCH ?? "all"
const skipChecks = hasFlag("--skip-checks")
const skipMac = hasFlag("--skip-mac")
const skipLinux = hasFlag("--skip-linux")
const skipPublish = hasFlag("--skip-publish")
const allowDirty = hasFlag("--allow-dirty")
const requireTagAtHead = hasFlag("--require-tag-at-head")

if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(`Release tag must look like v<semver>, got ${JSON.stringify(tag)}`)
}

const expectedTag = `v${packageJson.version}`
if (tag !== expectedTag) {
  throw new Error(`Release tag ${tag} does not match package version ${packageJson.version}.`)
}

if (!allowDirty) {
  const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
  if (status.length > 0) {
    throw new Error(
      "Working tree must be clean before releasing. Commit/stash changes or pass --allow-dirty for testing only.",
    )
  }
}

const tagCommit = execFileSync("git", ["rev-list", "-n", "1", tag], { encoding: "utf8" }).trim()
const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
if (tagCommit !== headCommit) {
  const message = `Release tag ${tag} does not point at HEAD. Local artifacts will be built from the current checkout.`
  if (requireTagAtHead) {
    throw new Error(message)
  }
  console.warn(`Warning: ${message}`)
}

run("node", ["scripts/release/extract-release-notes.mjs", tag])

if (!skipChecks) {
  run("pnpm", ["release:check"])
}

if (!skipMac) {
  const macArgs = ["scripts/release/build-local-mac-release.mjs", "--assets-dir", releaseAssetsDir]
  if (macArch !== undefined && macArch.trim().length > 0) {
    macArgs.push("--arch", macArch)
  }
  run("node", macArgs)
}

if (!skipLinux) {
  run("node", ["scripts/release/build-local-linux-release.mjs", "--assets-dir", releaseAssetsDir])
}

if (!skipPublish) {
  run("node", [
    "scripts/release/publish-release-assets.mjs",
    "--tag",
    tag,
    "--assets-dir",
    releaseAssetsDir,
  ])
}

console.log(`Local release candidate flow completed for ${tag}`)
if (!skipPublish) {
  console.log(`Publish the GitHub draft, then run: pnpm release:promote -- --tag ${tag}`)
}

function hasFlag(name) {
  return args.includes(name)
}

function readOption(name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined

  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`)
  }
  return value
}

function run(command, commandArgs) {
  console.log(`$ ${command} ${commandArgs.map(shellQuote).join(" ")}`)
  execFileSync(command, commandArgs, { env: process.env, stdio: "inherit" })
}

function shellQuote(value) {
  return /[^A-Za-z0-9_./:=@-]/.test(value) ? JSON.stringify(value) : value
}
