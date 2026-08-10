import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  ReleaseArtifactMatrix,
  ReleaseCatalog,
} from "../../packages/download-worker/src/release-catalog.js"
import "./load-local-env.mjs"
import { parsePublishReleaseArguments } from "./release-arguments.mjs"
import {
  assertCommandAvailable,
  commandSucceeds,
  runSyncCommand as run,
} from "./release-command.mjs"
import { createR2ClientConfiguration, requiredEnvironment } from "./release-environment.mjs"
import { deriveReleaseContext } from "./release-context.mjs"
import { R2ReleaseStore } from "./r2-release-store.mjs"
import {
  createReleaseProvenance,
  runWithRetries,
  validateReleaseAssetNames,
  validateUpdaterMetadata,
} from "./release-policy.mjs"
import { withTemporaryDirectorySync } from "./temporary-directory.mjs"

const cli = parsePublishReleaseArguments()
const context = deriveReleaseContext({
  requestedTag: cli.tag,
  configuredCommit: process.env.RELEASE_COMMIT_SHA,
  assetsDirectory: cli.assetsDir ?? "release-assets",
  publicOrigin: requiredEnvironment("R2_PUBLIC_BASE_URL"),
})
const { tag, packageVersion: version, assetsDirectory: assetsDir, publicOrigin: baseUrl } = context
const { allowPublished, metadataOnly, requireExistingR2Provenance } = cli
const releaseCommit = context.commit
assertReleaseCommitIsPublishable()

const provenanceInputs = inspectAssets(
  new Set(["latest.json", "SHA256SUMS", "release-provenance.json"]),
  context.assetNames,
)
writeReleaseProvenance(provenanceInputs)
const checksumInputs = inspectAssets(new Set(["latest.json", "SHA256SUMS"]))

if (checksumInputs.length === 0) {
  throw new Error(
    `No release assets found in ${assetsDir}. Run pnpm release:local first or copy artifacts there.`,
  )
}
validateReleaseAssetNames(
  [...checksumInputs.map(({ name }) => name), "latest.json", "SHA256SUMS"],
  tag,
)
validateUpdaterAssets(checksumInputs)

writeChecksums(checksumInputs)
writeLatestJson(inspectAssets(new Set(["latest.json"])))
const publishInventory = inspectAssets()

if (metadataOnly) {
  console.log(`Generated release metadata in ${assetsDir}`)
  process.exit(0)
}

const r2Configuration = createR2ClientConfiguration()
const r2Store = new R2ReleaseStore(r2Configuration)
assertCommandAvailable("gh", ["--version"])
assertCommandAvailable("aws", ["--version"], { env: r2Configuration.awsEnvironment })

publishGithubRelease()
publishR2()

console.log(`Staged ${tag} assets from ${assetsDir}`)
console.log(`Publish the GitHub draft; GitHub Actions will promote ${tag} after verification.`)

function writeChecksums(inventory) {
  const lines = inventory.map(({ name, sha256 }) => `${sha256}  ${name}`)
  writeFileSync(path.join(assetsDir, "SHA256SUMS"), `${lines.join("\n")}\n`)
}

function writeLatestJson(inventory) {
  writeFileSync(
    path.join(assetsDir, "latest.json"),
    `${JSON.stringify(
      ReleaseCatalog.createVersionedLatestManifest({
        tag,
        publicOrigin: baseUrl,
        generatedAt: releaseGeneratedAt(),
        assets: inventory.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
      }),
      null,
      2,
    )}\n`,
  )
}

function writeReleaseProvenance(inventory) {
  const byName = new Map(inventory.map((asset) => [asset.name, asset]))
  const selected = ReleaseArtifactMatrix.create({ tag, assets: inventory }).roles
  const selectedNames = Object.values(selected).toSorted((left, right) => left.localeCompare(right))
  const assets = selectedNames.map((name) => {
    const asset = byName.get(name)
    if (asset === undefined) throw new Error(`Release inventory is missing ${name}.`)
    return {
      name,
      size: asset.size,
      sha256: asset.sha256,
      sha512: asset.sha512,
    }
  })
  writeFileSync(
    path.join(assetsDir, "release-provenance.json"),
    `${JSON.stringify(
      createReleaseProvenance({
        tag,
        commit: releaseCommit,
        generatedAt: releaseGeneratedAt(),
        assets,
      }),
      null,
      2,
    )}\n`,
  )
}

function releaseGeneratedAt() {
  const existingPath = path.join(assetsDir, "latest.json")
  if (existsSync(existingPath)) {
    const existing = JSON.parse(readFileSync(existingPath, "utf8"))
    if (existing.tag === tag && typeof existing.generatedAt === "string") {
      return existing.generatedAt
    }
  }
  const configured = process.env.RELEASE_GENERATED_AT
  const value =
    configured ??
    execFileSync("git", ["show", "-s", "--format=%cI", releaseCommit], {
      encoding: "utf8",
    }).trim()
  const generatedAt = new Date(value)
  if (Number.isNaN(generatedAt.valueOf())) {
    throw new Error(`Could not determine a valid generated timestamp for ${tag}.`)
  }
  return generatedAt.toISOString()
}

function validateUpdaterAssets(inventory) {
  const byName = new Map(inventory.map((asset) => [asset.name, asset]))
  const selected = ReleaseArtifactMatrix.create({ tag, assets: inventory }).roles
  for (const arch of ["arm64", "x64"]) {
    const zip = selected[arch === "arm64" ? "macArm64Zip" : "macX64Zip"]
    const metadataName = selected[arch === "arm64" ? "macArm64Metadata" : "macX64Metadata"]
    const metadata = readFileSync(path.join(assetsDir, metadataName), "utf8")
    const integrity = updaterArtifactIntegrity(byName, zip)
    try {
      validateUpdaterMetadata(metadata, { version, artifact: zip, ...integrity })
    } catch (cause) {
      throw new Error(`macOS ${arch} updater metadata does not reference ${zip}.`, { cause })
    }
  }

  const linuxMetadata = readFileSync(path.join(assetsDir, selected.linuxMetadata), "utf8")
  const integrity = updaterArtifactIntegrity(byName, selected.linuxAppImage)
  try {
    validateUpdaterMetadata(linuxMetadata, {
      version,
      artifact: selected.linuxAppImage,
      ...integrity,
    })
  } catch (cause) {
    throw new Error(`Linux updater metadata does not reference ${selected.linuxAppImage}.`, {
      cause,
    })
  }
}

function updaterArtifactIntegrity(inventory, name) {
  const asset = inventory.get(name)
  if (asset === undefined) throw new Error(`Release inventory is missing ${name}.`)
  return { size: asset.size, sha512: asset.sha512 }
}

function publishGithubRelease() {
  return withTemporaryDirectorySync(
    path.join(tmpdir(), "diffdash-release-notes-"),
    (notesDirectory) => {
      const notesPath = path.join(notesDirectory, "release-notes.md")
      const notes = execFileSync("node", ["scripts/release/extract-release-notes.mjs", tag], {
        encoding: "utf8",
      })
      writeFileSync(notesPath, notes)

      const releaseExists = commandSucceeds("gh", ["release", "view", tag])
      let release = null
      if (releaseExists) {
        release = JSON.parse(
          execFileSync("gh", ["release", "view", tag, "--json", "assets,isDraft"], {
            encoding: "utf8",
          }),
        )
        if (!release.isDraft) {
          if (!allowPublished) {
            throw new Error(
              `GitHub release ${tag} is already published; stage a new version instead.`,
            )
          }
          console.log(`Adding verified assets to already-published GitHub release ${tag}.`)
        } else {
          run("gh", ["release", "edit", tag, "--title", tag, "--notes-file", notesPath])
        }
      } else {
        run("gh", [
          "release",
          "create",
          tag,
          "--draft",
          "--verify-tag",
          "--title",
          tag,
          "--notes-file",
          notesPath,
        ])
      }

      const existingAssets = new Map((release?.assets ?? []).map((asset) => [asset.name, asset]))
      const localPaths = allAssetPaths()
      const localNames = new Set(localPaths.map((assetPath) => path.basename(assetPath)))
      const unexpected = [...existingAssets.keys()].filter((name) => !localNames.has(name))
      if (unexpected.length > 0) {
        throw new Error(`GitHub release ${tag} has unexpected assets: ${unexpected.join(", ")}`)
      }
      for (const assetPath of localPaths) {
        const existing = existingAssets.get(path.basename(assetPath))
        if (existing !== undefined) {
          verifyExistingGithubAsset(existing, assetPath)
          continue
        }
        runWithRetries(
          () => {
            try {
              run("gh", ["release", "upload", tag, assetPath])
            } catch (cause) {
              const uploaded = findGithubAsset(path.basename(assetPath))
              if (uploaded === undefined) throw cause
              verifyExistingGithubAsset(uploaded, assetPath)
            }
          },
          {
            attempts: 3,
            onRetry: (attempt, attempts) =>
              console.warn(`Command failed; retrying attempt ${attempt}/${attempts}.`),
          },
        )
      }
    },
  )
}

function findGithubAsset(name) {
  const current = JSON.parse(
    execFileSync("gh", ["release", "view", tag, "--json", "assets"], { encoding: "utf8" }),
  )
  return current.assets.find((asset) => asset.name === name)
}

function verifyExistingGithubAsset(existing, assetPath) {
  const localSize = statSync(assetPath).size
  const localDigest = sha256File(assetPath)
  if (existing.size !== localSize) {
    throw new Error(
      `GitHub release asset ${existing.name} has different bytes; refusing overwrite.`,
    )
  }
  if (existing.digest === `sha256:${localDigest}`) {
    console.log(`Verified existing GitHub release asset ${existing.name}.`)
    return
  }
  withTemporaryDirectorySync(path.join(tmpdir(), "diffdash-github-asset-"), (downloadDir) => {
    run("gh", ["release", "download", tag, "--pattern", existing.name, "--dir", downloadDir])
    if (sha256File(path.join(downloadDir, existing.name)) !== localDigest) {
      throw new Error(
        `GitHub release asset ${existing.name} has different bytes; refusing overwrite.`,
      )
    }
  })
  console.log(`Verified existing GitHub release asset ${existing.name}.`)
}

function publishR2() {
  const existingNames = new Set(r2Store.listCandidateKeys(tag).map((key) => path.basename(key)))
  const localPaths = allAssetPaths()
  const localNames = new Set(localPaths.map((assetPath) => path.basename(assetPath)))
  const unexpected = [...existingNames].filter((name) => !localNames.has(name))
  if (unexpected.length > 0) {
    throw new Error(`R2 release ${tag} has unexpected assets: ${unexpected.join(", ")}`)
  }
  if (requireExistingR2Provenance) {
    const provenanceName = "release-provenance.json"
    if (!existingNames.has(provenanceName)) {
      throw new Error(`R2 release ${tag} has no trusted provenance; refusing candidate repair.`)
    }
    const provenancePath = path.join(assetsDir, provenanceName)
    verifyExistingR2Asset(provenanceName, provenancePath, sha256File(provenancePath))
  }
  for (const assetPath of localPaths) {
    const name = path.basename(assetPath)
    const digest = sha256File(assetPath)
    if (existingNames.has(name)) {
      verifyExistingR2Asset(name, assetPath, digest)
      continue
    }
    r2Store.uploadCandidate(tag, name, assetPath, digest)
  }
}

function assertReleaseCommitIsPublishable() {
  const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  if (headCommit !== releaseCommit) {
    throw new Error(`Release tag ${tag} does not point at HEAD; refusing mismatched assets.`)
  }
  if (!commandSucceeds("git", ["merge-base", "--is-ancestor", releaseCommit, "origin/main"])) {
    throw new Error(`Release tag ${tag} is not reachable from origin/main.`)
  }
}

function verifyExistingR2Asset(name, assetPath, localDigest) {
  const remoteDigest = r2Store.headCandidate(tag, name).Metadata?.sha256 ?? "None"
  if (remoteDigest === localDigest) {
    console.log(`Verified existing R2 release asset ${name}.`)
    return
  }
  if (remoteDigest !== "None" && remoteDigest.length > 0) {
    throw new Error(`R2 release asset ${name} has different bytes; refusing overwrite.`)
  }
  withTemporaryDirectorySync(path.join(tmpdir(), "diffdash-r2-asset-"), (downloadDirectory) => {
    const downloadPath = path.join(downloadDirectory, name)
    r2Store.downloadCandidate(tag, name, downloadPath)
    if (sha256File(downloadPath) !== localDigest) {
      throw new Error(`R2 release asset ${name} has different bytes; refusing overwrite.`)
    }
  })
  console.log(`Verified existing R2 release asset ${name}.`)
}

function allAssetPaths() {
  return publishInventory
    .toSorted((left, right) => {
      if (left.name === "release-provenance.json") return -1
      if (right.name === "release-provenance.json") return 1
      if (left.name === "latest.json") return 1
      if (right.name === "latest.json") return -1
      return left.name.localeCompare(right.name)
    })
    .map(({ path: assetPath }) => assetPath)
}

function inspectAssets(excluded = new Set(), names = readdirSync(assetsDir)) {
  return Object.freeze(
    names
      .filter((name) => !excluded.has(name))
      .toSorted((left, right) => left.localeCompare(right))
      .map((name) => {
        const assetPath = path.join(assetsDir, name)
        const bytes = readFileSync(assetPath)
        return Object.freeze({
          name,
          path: assetPath,
          size: statSync(assetPath).size,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sha512: createHash("sha512").update(bytes).digest("base64"),
        })
      }),
  )
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}
