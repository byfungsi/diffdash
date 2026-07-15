import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import "./load-local-env.mjs"
import { retainedReleasePrefixes, validateReleaseAssetNames } from "./release-policy.mjs"

const args = process.argv.slice(2)
const packageJson = JSON.parse(readFileSync("packages/desktop/package.json", "utf8"))
const tag = readOption("--tag") ?? `v${packageJson.version}`
const version = tag.replace(/^v/, "")
const r2Bucket = requiredEnv("R2_BUCKET")
const r2Endpoint = `https://${requiredEnv("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com`
const awsEnv = {
  ...process.env,
  AWS_ACCESS_KEY_ID: requiredEnv("R2_ACCESS_KEY_ID"),
  AWS_SECRET_ACCESS_KEY: requiredEnv("R2_SECRET_ACCESS_KEY"),
  AWS_DEFAULT_REGION: "auto",
  AWS_EC2_METADATA_DISABLED: "true",
}
const homebrewExpatLib = "/opt/homebrew/opt/expat/lib"

if (
  process.platform === "darwin" &&
  awsEnv.DYLD_LIBRARY_PATH === undefined &&
  existsSync(homebrewExpatLib)
) {
  awsEnv.DYLD_LIBRARY_PATH = homebrewExpatLib
}

if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(`Release tag must look like v<semver>, got ${JSON.stringify(tag)}`)
}

assertCommand("gh", ["--version"])
assertCommand("aws", ["--version"], { env: awsEnv })

const release = JSON.parse(
  execFileSync("gh", ["release", "view", tag, "--json", "assets,isDraft,isPrerelease,tagName"], {
    encoding: "utf8",
    env: process.env,
  }),
)
if (release.tagName !== tag) throw new Error(`GitHub release tag does not match ${tag}.`)
if (release.isDraft) throw new Error(`GitHub release ${tag} is still a draft.`)
if (release.isPrerelease) throw new Error(`Stable promotion does not accept prerelease ${tag}.`)

const assetNames = release.assets.map((asset) => asset.name)
validateReleaseAssetNames(assetNames, tag)
validateR2Assets(assetNames)

const stablePath = path.join(mkdtempSync(path.join(tmpdir(), "diffdash-promote-")), "stable.json")
writeFileSync(
  stablePath,
  `${JSON.stringify({ version, tag, promotedAt: new Date().toISOString() }, null, 2)}\n`,
)

copyVersionLatestJson()
uploadStablePointer(stablePath)
pruneR2()

console.log(`Promoted ${tag} to the stable DiffDash update channel.`)

function readOption(name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${name}`)
  return value
}

function requiredEnv(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function validateR2Assets(names) {
  const output = execFileSync(
    "aws",
    [
      "s3api",
      "list-objects-v2",
      "--bucket",
      r2Bucket,
      "--prefix",
      `releases/${tag}/`,
      "--query",
      "Contents[].Key",
      "--output",
      "json",
      "--endpoint-url",
      r2Endpoint,
    ],
    { encoding: "utf8", env: awsEnv },
  )
  const r2Names = new Set((JSON.parse(output || "[]") ?? []).map((key) => path.basename(key)))
  const missing = names.filter((name) => !r2Names.has(name))
  if (missing.length > 0) throw new Error(`R2 is missing ${tag} assets: ${missing.join(", ")}`)
}

function copyVersionLatestJson() {
  run(
    "aws",
    [
      "s3",
      "cp",
      `s3://${r2Bucket}/releases/${tag}/latest.json`,
      `s3://${r2Bucket}/latest.json`,
      "--cache-control",
      "public, max-age=60",
      "--content-type",
      "application/json",
      "--endpoint-url",
      r2Endpoint,
    ],
    { env: awsEnv },
  )
}

function uploadStablePointer(pointerPath) {
  run(
    "aws",
    [
      "s3",
      "cp",
      pointerPath,
      `s3://${r2Bucket}/stable.json`,
      "--cache-control",
      "no-store",
      "--content-type",
      "application/json",
      "--endpoint-url",
      r2Endpoint,
    ],
    { env: awsEnv },
  )
}

function pruneR2() {
  const output = execFileSync(
    "aws",
    [
      "s3api",
      "list-objects-v2",
      "--bucket",
      r2Bucket,
      "--prefix",
      "releases/",
      "--delimiter",
      "/",
      "--query",
      "CommonPrefixes[].Prefix",
      "--output",
      "json",
      "--endpoint-url",
      r2Endpoint,
    ],
    { encoding: "utf8", env: awsEnv },
  )
  const prefixes = JSON.parse(output || "[]") ?? []
  const keep = retainedReleasePrefixes(prefixes, tag)
  for (const prefix of prefixes) {
    if (keep.has(prefix) || !/^releases\/v?\d+\.\d+\.\d+\/$/u.test(prefix)) continue
    run(
      "aws",
      ["s3", "rm", `s3://${r2Bucket}/${prefix}`, "--recursive", "--endpoint-url", r2Endpoint],
      { env: awsEnv },
    )
  }
}

function assertCommand(command, commandArgs, options = {}) {
  try {
    execFileSync(command, commandArgs, { env: options.env ?? process.env, stdio: "ignore" })
  } catch {
    throw new Error(`Required command is not available or failed: ${command}`)
  }
}

function run(command, commandArgs, options = {}) {
  console.log(`$ ${command} ${commandArgs.map(shellQuote).join(" ")}`)
  execFileSync(command, commandArgs, { env: options.env ?? process.env, stdio: "inherit" })
}

function shellQuote(value) {
  return /[^A-Za-z0-9_./:=@-]/.test(value) ? JSON.stringify(value) : value
}
