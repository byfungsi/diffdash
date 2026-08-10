import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  ReleaseArtifactMatrix,
  ReleaseCatalog,
} from "../../packages/download-worker/src/release-catalog.js"
import "./load-local-env.mjs"
import { parsePromoteReleaseArguments } from "./release-arguments.mjs"
import { assertCommandAvailable, commandSucceeds } from "./release-command.mjs"
import { createR2ClientConfiguration, requiredEnvironment } from "./release-environment.mjs"
import { deriveReleaseContext } from "./release-context.mjs"
import { R2ReleaseStore } from "./r2-release-store.mjs"
import {
  assertPromotionDoesNotDowngrade,
  assertReleaseTag,
  assertStableReleaseTag,
  createStableMetadata,
  releasePrefixesToPrune,
  validateReleaseAssetNames,
  validateReleaseProvenance,
} from "./release-policy.mjs"
import { verifyPublicRelease } from "./release-verification.mjs"
import { withTemporaryDirectory } from "./temporary-directory.mjs"

const cli = parsePromoteReleaseArguments()
const context = deriveReleaseContext({
  requestedTag: cli.tag,
  configuredCommit: process.env.RELEASE_COMMIT_SHA,
  publicOrigin: requiredEnvironment("R2_PUBLIC_BASE_URL"),
})
const { tag } = context

if (process.env.GITHUB_ACTIONS !== "true") {
  throw new Error(
    "Stable promotion must run in GitHub Actions. Dispatch the Release workflow with promote enabled.",
  )
}

const r2Configuration = createR2ClientConfiguration()
const r2Store = new R2ReleaseStore(r2Configuration)

assertReleaseTag(tag)
assertStableReleaseTag(tag)
assertCommandAvailable("gh", ["--version"])
assertCommandAvailable("aws", ["--version"], { env: r2Configuration.awsEnvironment })

const release = JSON.parse(
  execFileSync("gh", ["release", "view", tag, "--json", "assets,isDraft,isPrerelease,tagName"], {
    encoding: "utf8",
    env: process.env,
  }),
)
if (release.tagName !== tag) throw new Error(`GitHub release tag does not match ${tag}.`)
if (release.isDraft) throw new Error(`GitHub release ${tag} is still a draft.`)
if (release.isPrerelease) throw new Error(`Stable promotion does not accept prerelease ${tag}.`)

const githubAssetInventory = Object.freeze(
  release.assets.map((asset) => Object.freeze({ ...asset })),
)
const githubArtifactMatrix = ReleaseArtifactMatrix.create({
  tag,
  assets: githubAssetInventory,
})
const assetNames = githubArtifactMatrix.inventory.map((asset) => asset.name)
validateReleaseAssetNames(assetNames, tag)
await withTemporaryDirectory(path.join(tmpdir(), "diffdash-promote-"), async (promotionDir) => {
  validateR2Assets(githubArtifactMatrix.inventory, promotionDir)

  const stablePath = path.join(promotionDir, "stable.json")
  writeFileSync(
    stablePath,
    `${JSON.stringify(createStableMetadata({ tag, promotedAt: new Date().toISOString() }), null, 2)}\n`,
  )

  const previousStable = r2Store.backupPointer(
    "stable.json",
    path.join(promotionDir, "previous-stable.json"),
  )
  if (previousStable.existed) {
    const currentStable = ReleaseCatalog.decodeStableManifest(
      JSON.parse(readFileSync(previousStable.backupPath, "utf8")),
    )
    assertPromotionDoesNotDowngrade(tag, currentStable.tag)
  }
  const previousLatest = r2Store.backupPointer(
    "latest.json",
    path.join(promotionDir, "previous-latest.json"),
  )
  try {
    r2Store.copyCandidateLatestToPointer(tag)
    r2Store.uploadPointer("stable.json", stablePath)
    await verifyPublicRelease({ tag, baseUrl: context.publicOrigin })
  } catch (cause) {
    const rollbackErrors = []
    for (const pointer of [previousLatest, previousStable]) {
      try {
        r2Store.restorePointer(pointer)
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
})

function validateR2Assets(assets, promotionDir) {
  const r2Names = new Set(r2Store.listCandidateKeys(tag).map((key) => path.basename(key)))
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
  const latest = ReleaseCatalog.decodeVersionedLatestManifest(
    JSON.parse(readFileSync(latestPath, "utf8")),
    {
      expectedTag: tag,
      publicOrigin: context.publicOrigin,
    },
  )
  const manifestAssets = new Map(latest.assets.map((asset) => [asset.name, asset]))
  const provenancePath = path.join(promotionDir, "release-provenance.json")
  downloadR2Asset("release-provenance.json", provenancePath)
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"))
  if (!commandSucceeds("git", ["merge-base", "--is-ancestor", context.commit, "origin/main"])) {
    throw new Error(`Release tag ${tag} is not reachable from origin/main.`)
  }
  validateReleaseProvenance(provenance, { tag, commit: context.commit, assets })
  for (const asset of assets) {
    const digest = githubAssetDigest(asset)
    if (asset.name !== "latest.json") {
      const manifest = manifestAssets.get(asset.name)
      if (manifest?.size !== asset.size || manifest.sha256 !== digest) {
        throw new Error(`GitHub and R2 metadata differ for ${asset.name}.`)
      }
    }
    verifyR2AssetBytes(
      asset,
      digest,
      promotionDir,
      asset.name === "latest.json" ? latestPath : undefined,
    )
  }
}

function verifyR2AssetBytes(asset, digest, promotionDir, downloadedPath) {
  const head = r2Store.headCandidate(tag, asset.name)
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
  r2Store.downloadCandidate(tag, name, destination)
}

function pruneR2() {
  const prefixes = r2Store.listReleasePrefixes()
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
  for (const prefix of releasePrefixesToPrune(prefixes, publishedTags, tag)) {
    r2Store.deleteReleasePrefix(prefix)
  }
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}
