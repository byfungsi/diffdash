import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import "./load-local-env.mjs"
import { parsePromoteReleaseArguments } from "./release-arguments.mjs"
import {
  assertCommandAvailable,
  commandSucceeds,
  runSyncCommand as run,
} from "./release-command.mjs"
import { createR2ClientConfiguration, requiredEnvironment } from "./release-environment.mjs"
import {
  assertPromotionDoesNotDowngrade,
  assertReleaseTag,
  assertStableReleaseTag,
  createStableMetadata,
  isStableReleasePrefix,
  releaseTagForVersion,
  retainedReleasePrefixes,
  validateReleaseAssetNames,
  validateReleaseProvenance,
} from "./release-policy.mjs"
import { verifyPublicRelease } from "./release-verification.mjs"

const cli = parsePromoteReleaseArguments()
const packageJson = JSON.parse(readFileSync("packages/desktop/package.json", "utf8"))
const tag = cli.tag ?? releaseTagForVersion(packageJson.version)

if (process.env.GITHUB_ACTIONS !== "true") {
  throw new Error(
    "Stable promotion must run in GitHub Actions. Dispatch the Release workflow with promote enabled.",
  )
}

const {
  bucket: r2Bucket,
  endpoint: r2Endpoint,
  awsEnvironment: awsEnv,
} = createR2ClientConfiguration()

assertReleaseTag(tag)
assertStableReleaseTag(tag)
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
const promotionDir = mkdtempSync(path.join(tmpdir(), "diffdash-promote-"))
validateR2Assets(release.assets)

const stablePath = path.join(promotionDir, "stable.json")
writeFileSync(
  stablePath,
  `${JSON.stringify(createStableMetadata({ tag, promotedAt: new Date().toISOString() }), null, 2)}\n`,
)

const previousStable = backupPointer("stable.json")
if (previousStable.existed) {
  const currentStable = JSON.parse(readFileSync(previousStable.backupPath, "utf8"))
  assertPromotionDoesNotDowngrade(tag, currentStable.tag)
}
const previousLatest = backupPointer("latest.json")
try {
  copyVersionLatestJson()
  uploadStablePointer(stablePath)
  await verifyPublicRelease({ tag, baseUrl: requiredEnvironment("R2_PUBLIC_BASE_URL") })
} catch (cause) {
  const rollbackErrors = []
  for (const pointer of [previousLatest, previousStable]) {
    try {
      restorePointer(pointer)
    } catch (error) {
      rollbackErrors.push(error)
    }
  }
  if (rollbackErrors.length > 0) {
    // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError retains the promotion cause and rollback failures.
    throw new AggregateError(
      [cause, ...rollbackErrors],
      `Promotion and rollback failed for ${tag}.`,
      { cause },
    )
  }
  throw cause
}
pruneR2()

console.log(`Promoted ${tag} to the stable DiffDash update channel.`)

function validateR2Assets(assets) {
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
  const names = assets.map((asset) => asset.name)
  const expectedNames = new Set(names)
  const missing = names.filter((name) => !r2Names.has(name))
  if (missing.length > 0) throw new Error(`R2 is missing ${tag} assets: ${missing.join(", ")}`)
  const unexpected = [...r2Names].filter((name) => !expectedNames.has(name))
  if (unexpected.length > 0) {
    throw new Error(`R2 has unexpected ${tag} assets: ${unexpected.join(", ")}`)
  }

  const latestPath = path.join(promotionDir, "version-latest.json")
  downloadR2Asset("latest.json", latestPath)
  const latest = JSON.parse(readFileSync(latestPath, "utf8"))
  const manifestAssets = new Map(latest.assets.map((asset) => [asset.name, asset]))
  const provenancePath = path.join(promotionDir, "release-provenance.json")
  downloadR2Asset("release-provenance.json", provenancePath)
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"))
  const tagCommit = execFileSync("git", ["rev-list", "-n", "1", tag], {
    encoding: "utf8",
  }).trim()
  const releaseCommit = process.env.RELEASE_COMMIT_SHA ?? tagCommit
  if (releaseCommit !== tagCommit) {
    throw new Error(`Configured release commit does not match ${tag}.`)
  }
  if (!commandSucceeds("git", ["merge-base", "--is-ancestor", tagCommit, "origin/main"])) {
    throw new Error(`Release tag ${tag} is not reachable from origin/main.`)
  }
  validateReleaseProvenance(provenance, { tag, commit: releaseCommit, assets })
  for (const asset of assets) {
    const digest = githubAssetDigest(asset)
    if (asset.name !== "latest.json") {
      const manifest = manifestAssets.get(asset.name)
      if (manifest?.size !== asset.size || manifest.sha256 !== digest) {
        throw new Error(`GitHub and R2 metadata differ for ${asset.name}.`)
      }
    }
    verifyR2AssetBytes(asset, digest, asset.name === "latest.json" ? latestPath : undefined)
  }
}

function verifyR2AssetBytes(asset, digest, downloadedPath) {
  const head = JSON.parse(
    execFileSync(
      "aws",
      [
        "s3api",
        "head-object",
        "--bucket",
        r2Bucket,
        "--key",
        `releases/${tag}/${asset.name}`,
        "--output",
        "json",
        "--endpoint-url",
        r2Endpoint,
      ],
      { encoding: "utf8", env: awsEnv },
    ),
  )
  if (head.ContentLength !== asset.size) {
    throw new Error(`R2 release asset ${asset.name} has an unexpected size.`)
  }
  const metadataDigest = head.Metadata?.sha256
  if (metadataDigest !== undefined && metadataDigest !== digest) {
    throw new Error(`R2 release asset ${asset.name} has an unexpected digest.`)
  }
  if (metadataDigest === digest) return

  const localPath =
    downloadedPath ?? path.join(promotionDir, `verify-${asset.name.replaceAll("/", "-")}`)
  if (downloadedPath === undefined) downloadR2Asset(asset.name, localPath)
  if (sha256File(localPath) !== digest) {
    throw new Error(`R2 release asset ${asset.name} has different bytes from GitHub.`)
  }
}

function githubAssetDigest(asset) {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(asset.digest ?? "")
  if (match === null) throw new Error(`GitHub release asset ${asset.name} has no SHA-256 digest.`)
  return match[1]
}

function downloadR2Asset(name, destination) {
  run(
    "aws",
    [
      "s3",
      "cp",
      `s3://${r2Bucket}/releases/${tag}/${name}`,
      destination,
      "--endpoint-url",
      r2Endpoint,
    ],
    { env: awsEnv },
  )
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

function backupPointer(name) {
  const backupPath = path.join(promotionDir, `previous-${name}`)
  const count = Number(
    execFileSync(
      "aws",
      [
        "s3api",
        "list-objects-v2",
        "--bucket",
        r2Bucket,
        "--prefix",
        name,
        "--query",
        `length(Contents[?Key=='${name}'])`,
        "--output",
        "text",
        "--endpoint-url",
        r2Endpoint,
      ],
      { encoding: "utf8", env: awsEnv },
    ),
  )
  if (count === 0) return { name, backupPath, existed: false }
  if (count !== 1) throw new Error(`Could not determine the existing R2 ${name} pointer.`)
  execFileSync(
    "aws",
    ["s3", "cp", `s3://${r2Bucket}/${name}`, backupPath, "--endpoint-url", r2Endpoint],
    { env: awsEnv, stdio: "ignore" },
  )
  return { name, backupPath, existed: true }
}

function restorePointer({ name, backupPath, existed }) {
  if (!existed) {
    run("aws", ["s3", "rm", `s3://${r2Bucket}/${name}`, "--endpoint-url", r2Endpoint], {
      env: awsEnv,
    })
    return
  }
  run(
    "aws",
    [
      "s3",
      "cp",
      backupPath,
      `s3://${r2Bucket}/${name}`,
      "--cache-control",
      name === "stable.json" ? "no-store" : "public, max-age=60",
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
  const releases = JSON.parse(
    execFileSync(
      "gh",
      ["release", "list", "--limit", "1000", "--json", "tagName,isDraft,isPrerelease"],
      { encoding: "utf8", env: process.env },
    ),
  )
  const publishedTags = new Set(
    releases
      .filter((candidate) => !candidate.isDraft && !candidate.isPrerelease)
      .map((candidate) => candidate.tagName),
  )
  const publishedPrefixes = prefixes.filter((prefix) =>
    publishedTags.has(prefix.slice("releases/".length, -1)),
  )
  const keep = retainedReleasePrefixes(publishedPrefixes, tag)
  for (const prefix of prefixes) {
    const prefixTag = prefix.slice("releases/".length, -1)
    if (keep.has(prefix) || !isStableReleasePrefix(prefix) || !publishedTags.has(prefixTag)) {
      continue
    }
    run(
      "aws",
      ["s3", "rm", `s3://${r2Bucket}/${prefix}`, "--recursive", "--endpoint-url", r2Endpoint],
      { env: awsEnv },
    )
  }
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}
