import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import "./load-local-env.mjs"
import { parsePromoteReleaseArguments } from "./release-arguments.mjs"
import { assertCommandAvailable, runSyncCommand as run } from "./release-command.mjs"
import { createR2ClientConfiguration } from "./release-environment.mjs"
import {
  assertReleaseTag,
  createStableMetadata,
  isStableReleasePrefix,
  releaseTagForVersion,
  retainedReleasePrefixes,
  validateReleaseAssetNames,
} from "./release-policy.mjs"

const cli = parsePromoteReleaseArguments()
const packageJson = JSON.parse(readFileSync("packages/desktop/package.json", "utf8"))
const tag = cli.tag ?? releaseTagForVersion(packageJson.version)
const {
  bucket: r2Bucket,
  endpoint: r2Endpoint,
  awsEnvironment: awsEnv,
} = createR2ClientConfiguration()

assertReleaseTag(tag)
assertCommandAvailable("gh", ["--version"])
assertCommandAvailable("aws", ["--version"], { env: awsEnv })

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
  `${JSON.stringify(createStableMetadata({ tag, promotedAt: new Date().toISOString() }), null, 2)}\n`,
)

copyVersionLatestJson()
uploadStablePointer(stablePath)
pruneR2()

console.log(`Promoted ${tag} to the stable DiffDash update channel.`)

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
    if (keep.has(prefix) || !isStableReleasePrefix(prefix)) continue
    run(
      "aws",
      ["s3", "rm", `s3://${r2Bucket}/${prefix}`, "--recursive", "--endpoint-url", r2Endpoint],
      { env: awsEnv },
    )
  }
}
