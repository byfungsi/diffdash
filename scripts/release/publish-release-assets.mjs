import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
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
  releaseTagForVersion,
  releaseVersionFromTag,
  runWithRetries,
  selectReleaseArtifacts,
} from "./release-policy.mjs"

const cli = parsePublishReleaseArguments()
const packageJson = JSON.parse(readFileSync("packages/desktop/package.json", "utf8"))
const tag = cli.tag ?? releaseTagForVersion(packageJson.version)
assertTagMatchesVersion(tag, packageJson.version)
const version = releaseVersionFromTag(tag)
const assetsDir = path.resolve(cli.assetsDir ?? "release-assets")
const baseUrl = normalizePublicBaseUrl(requiredEnvironment("R2_PUBLIC_BASE_URL"))
const {
  bucket: r2Bucket,
  endpoint: r2Endpoint,
  awsEnvironment: awsEnv,
} = createR2ClientConfiguration()
const { metadataOnly } = cli

const assetFiles = readdirSync(assetsDir)
  .filter((file) => file !== "latest.json" && file !== "SHA256SUMS")
  .toSorted((left, right) => left.localeCompare(right))

if (assetFiles.length === 0) {
  throw new Error(
    `No release assets found in ${assetsDir}. Run pnpm release:local first or copy artifacts there.`,
  )
}
validateUpdaterAssets(assetFiles)

assertCommandAvailable("gh", ["--version"])
assertCommandAvailable("aws", ["--version"], { env: awsEnv })

writeChecksums(assetFiles)
writeLatestJson()

if (metadataOnly) {
  console.log(`Generated release metadata in ${assetsDir}`)
  process.exit(0)
}

publishGithubRelease()
publishR2()

console.log(`Staged ${tag} assets from ${assetsDir}`)
console.log(`Publish the GitHub draft, then run: pnpm release:promote -- --tag ${tag}`)

function normalizePublicBaseUrl(value) {
  const trimmed = value.trim().replace(/\/+$/, "")
  if (/^https?:\/\//.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

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
        generatedAt: new Date().toISOString(),
        assets,
      }),
      null,
      2,
    )}\n`,
  )
}

function validateUpdaterAssets(files) {
  const selected = selectReleaseArtifacts(files, tag)
  for (const arch of ["arm64", "x64"]) {
    const zip = selected[arch === "arm64" ? "macArm64Zip" : "macX64Zip"]
    const metadataName = selected[arch === "arm64" ? "macArm64Metadata" : "macX64Metadata"]
    const metadata = readFileSync(path.join(assetsDir, metadataName), "utf8")
    if (!metadata.includes(`version: ${version}`) || !metadata.includes(zip)) {
      throw new Error(`macOS ${arch} updater metadata does not reference ${zip}.`)
    }
  }

  const linuxMetadata = readFileSync(path.join(assetsDir, selected.linuxMetadata), "utf8")
  if (
    !linuxMetadata.includes(`version: ${version}`) ||
    !linuxMetadata.includes(selected.linuxAppImage)
  ) {
    throw new Error(`Linux updater metadata does not reference ${selected.linuxAppImage}.`)
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
  if (releaseExists) {
    const release = JSON.parse(
      execFileSync("gh", ["release", "view", tag, "--json", "isDraft"], { encoding: "utf8" }),
    )
    if (!release.isDraft) {
      throw new Error(`GitHub release ${tag} is already published; stage a new version instead.`)
    }
    run("gh", ["release", "edit", tag, "--title", tag, "--notes-file", notesPath])
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

  for (const assetPath of allAssetPaths()) {
    runWithRetries(() => run("gh", ["release", "upload", tag, assetPath, "--clobber"]), {
      attempts: 3,
      onRetry: (attempt, attempts) =>
        console.warn(`Command failed; retrying attempt ${attempt}/${attempts}.`),
    })
  }
}

function publishR2() {
  run(
    "aws",
    [
      "s3",
      "cp",
      assetsDir,
      `s3://${r2Bucket}/releases/${tag}/`,
      "--recursive",
      "--cache-control",
      "public, max-age=31536000, immutable",
      "--endpoint-url",
      r2Endpoint,
    ],
    { env: awsEnv },
  )
}

function allAssetPaths() {
  return readdirSync(assetsDir)
    .toSorted((left, right) => left.localeCompare(right))
    .map((file) => path.join(assetsDir, file))
}
