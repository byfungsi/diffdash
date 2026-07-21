import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import "./load-local-env.mjs"
import { parsePublishReleaseArguments } from "./release-arguments.mjs"
import {
  assertCommandAvailable,
  commandSucceeds,
  runSyncCommand as run,
} from "./release-command.mjs"
import { createR2ClientConfiguration, requiredEnvironment } from "./release-environment.mjs"
import {
  assertTagMatchesVersion,
  createLatestMetadata,
  createReleaseProvenance,
  normalizePublicBaseUrl,
  releaseTagForVersion,
  releaseVersionFromTag,
  runWithRetries,
  selectReleaseArtifacts,
  validateReleaseAssetNames,
  validateUpdaterMetadata,
} from "./release-policy.mjs"

const cli = parsePublishReleaseArguments()
const packageJson = JSON.parse(readFileSync("packages/desktop/package.json", "utf8"))
const tag = cli.tag ?? releaseTagForVersion(packageJson.version)
assertTagMatchesVersion(tag, packageJson.version)
const version = releaseVersionFromTag(tag)
const assetsDir = path.resolve(cli.assetsDir ?? "release-assets")
const baseUrl = normalizePublicBaseUrl(requiredEnvironment("R2_PUBLIC_BASE_URL"))
const { allowPublished, metadataOnly, requireExistingR2Provenance } = cli
const releaseCommit = resolveReleaseCommit()

writeReleaseProvenance()
const assetFiles = readdirSync(assetsDir)
  .filter((file) => file !== "latest.json" && file !== "SHA256SUMS")
  .toSorted((left, right) => left.localeCompare(right))

if (assetFiles.length === 0) {
  throw new Error(
    `No release assets found in ${assetsDir}. Run pnpm release:local first or copy artifacts there.`,
  )
}
validateReleaseAssetNames([...assetFiles, "latest.json", "SHA256SUMS"], tag)
validateUpdaterAssets(assetFiles)

writeChecksums(assetFiles)
writeLatestJson()

if (metadataOnly) {
  console.log(`Generated release metadata in ${assetsDir}`)
  process.exit(0)
}

const {
  bucket: r2Bucket,
  endpoint: r2Endpoint,
  awsEnvironment: awsEnv,
} = createR2ClientConfiguration()
assertCommandAvailable("gh", ["--version"])
assertCommandAvailable("aws", ["--version"], { env: awsEnv })

publishGithubRelease()
publishR2()

console.log(`Staged ${tag} assets from ${assetsDir}`)
console.log(`Publish the GitHub draft; GitHub Actions will promote ${tag} after verification.`)

function writeChecksums(files) {
  const lines = files.map((file) => {
    const bytes = readFileSync(path.join(assetsDir, file))
    return `${createHash("sha256").update(bytes).digest("hex")}  ${file}`
  })
  writeFileSync(path.join(assetsDir, "SHA256SUMS"), `${lines.join("\n")}\n`)
}

function writeLatestJson() {
  const files = readdirSync(assetsDir)
    .filter((file) => file !== "latest.json")
    .toSorted((left, right) => left.localeCompare(right))
  const assets = files.map((file) => {
    const filePath = path.join(assetsDir, file)
    const bytes = readFileSync(filePath)
    return {
      name: file,
      size: statSync(filePath).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
  })

  writeFileSync(
    path.join(assetsDir, "latest.json"),
    `${JSON.stringify(
      createLatestMetadata({
        tag,
        baseUrl,
        generatedAt: releaseGeneratedAt(),
        assets,
      }),
      null,
      2,
    )}\n`,
  )
}

function writeReleaseProvenance() {
  const files = readdirSync(assetsDir).filter(
    (file) => file !== "latest.json" && file !== "SHA256SUMS" && file !== "release-provenance.json",
  )
  const selected = selectReleaseArtifacts(files, tag)
  const selectedNames = Object.values(selected).toSorted((left, right) => left.localeCompare(right))
  const assets = selectedNames.map((name) => {
    const assetPath = path.join(assetsDir, name)
    const bytes = readFileSync(assetPath)
    return {
      name,
      size: statSync(assetPath).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("base64"),
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

function validateUpdaterAssets(files) {
  const selected = selectReleaseArtifacts(files, tag)
  for (const arch of ["arm64", "x64"]) {
    const zip = selected[arch === "arm64" ? "macArm64Zip" : "macX64Zip"]
    const metadataName = selected[arch === "arm64" ? "macArm64Metadata" : "macX64Metadata"]
    const metadata = readFileSync(path.join(assetsDir, metadataName), "utf8")
    const integrity = updaterArtifactIntegrity(zip)
    try {
      validateUpdaterMetadata(metadata, { version, artifact: zip, ...integrity })
    } catch (cause) {
      throw new Error(`macOS ${arch} updater metadata does not reference ${zip}.`, { cause })
    }
  }

  const linuxMetadata = readFileSync(path.join(assetsDir, selected.linuxMetadata), "utf8")
  const integrity = updaterArtifactIntegrity(selected.linuxAppImage)
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

function updaterArtifactIntegrity(name) {
  const assetPath = path.join(assetsDir, name)
  const bytes = readFileSync(assetPath)
  return {
    size: statSync(assetPath).size,
    sha512: createHash("sha512").update(bytes).digest("base64"),
  }
}

function publishGithubRelease() {
  const notesPath = path.join(
    mkdtempSync(path.join(tmpdir(), "diffdash-release-notes-")),
    "release-notes.md",
  )
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
        throw new Error(`GitHub release ${tag} is already published; stage a new version instead.`)
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
  const localNames = new Set(allAssetPaths().map((assetPath) => path.basename(assetPath)))
  const unexpected = [...existingAssets.keys()].filter((name) => !localNames.has(name))
  if (unexpected.length > 0) {
    throw new Error(`GitHub release ${tag} has unexpected assets: ${unexpected.join(", ")}`)
  }
  for (const assetPath of allAssetPaths()) {
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
  const downloadDir = mkdtempSync(path.join(tmpdir(), "diffdash-github-asset-"))
  run("gh", ["release", "download", tag, "--pattern", existing.name, "--dir", downloadDir])
  if (sha256File(path.join(downloadDir, existing.name)) !== localDigest) {
    throw new Error(
      `GitHub release asset ${existing.name} has different bytes; refusing overwrite.`,
    )
  }
  console.log(`Verified existing GitHub release asset ${existing.name}.`)
}

function publishR2() {
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
  const existingNames = new Set((JSON.parse(output || "[]") ?? []).map((key) => path.basename(key)))
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
    run(
      "aws",
      [
        "s3",
        "cp",
        assetPath,
        `s3://${r2Bucket}/releases/${tag}/${name}`,
        "--cache-control",
        "public, max-age=31536000, immutable",
        "--metadata",
        `sha256=${digest}`,
        "--endpoint-url",
        r2Endpoint,
      ],
      { env: awsEnv },
    )
  }
}

function resolveReleaseCommit() {
  const tagCommit = execFileSync("git", ["rev-list", "-n", "1", tag], {
    encoding: "utf8",
  }).trim()
  const configured = process.env.RELEASE_COMMIT_SHA
  if (configured !== undefined && configured !== tagCommit) {
    throw new Error(`Configured release commit does not match ${tag}.`)
  }
  const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  if (headCommit !== tagCommit) {
    throw new Error(`Release tag ${tag} does not point at HEAD; refusing mismatched assets.`)
  }
  if (!commandSucceeds("git", ["merge-base", "--is-ancestor", tagCommit, "origin/main"])) {
    throw new Error(`Release tag ${tag} is not reachable from origin/main.`)
  }
  return tagCommit
}

function verifyExistingR2Asset(name, assetPath, localDigest) {
  const remoteDigest = execFileSync(
    "aws",
    [
      "s3api",
      "head-object",
      "--bucket",
      r2Bucket,
      "--key",
      `releases/${tag}/${name}`,
      "--query",
      "Metadata.sha256",
      "--output",
      "text",
      "--endpoint-url",
      r2Endpoint,
    ],
    { encoding: "utf8", env: awsEnv },
  ).trim()
  if (remoteDigest === localDigest) {
    console.log(`Verified existing R2 release asset ${name}.`)
    return
  }
  if (remoteDigest !== "None" && remoteDigest.length > 0) {
    throw new Error(`R2 release asset ${name} has different bytes; refusing overwrite.`)
  }
  const downloadPath = path.join(mkdtempSync(path.join(tmpdir(), "diffdash-r2-asset-")), name)
  run(
    "aws",
    [
      "s3",
      "cp",
      `s3://${r2Bucket}/releases/${tag}/${name}`,
      downloadPath,
      "--endpoint-url",
      r2Endpoint,
    ],
    { env: awsEnv },
  )
  if (sha256File(downloadPath) !== localDigest) {
    throw new Error(`R2 release asset ${name} has different bytes; refusing overwrite.`)
  }
  console.log(`Verified existing R2 release asset ${name}.`)
}

function allAssetPaths() {
  return readdirSync(assetsDir)
    .toSorted((left, right) => {
      if (left === "release-provenance.json") return -1
      if (right === "release-provenance.json") return 1
      if (left === "latest.json") return 1
      if (right === "latest.json") return -1
      return left.localeCompare(right)
    })
    .map((file) => path.join(assetsDir, file))
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}
