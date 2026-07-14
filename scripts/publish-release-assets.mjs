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

const args = process.argv.slice(2)
const packageJson = JSON.parse(readFileSync("package.json", "utf8"))
const tag = readOption("--tag") ?? `v${packageJson.version}`
const version = tag.startsWith("v") ? tag.slice(1) : tag
const assetsDir = path.resolve(readOption("--assets-dir") ?? "release-assets")
const baseUrl = normalizePublicBaseUrl(requiredEnv("R2_PUBLIC_BASE_URL"))
const r2Bucket = requiredEnv("R2_BUCKET")
const r2Endpoint = `https://${requiredEnv("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com`
const metadataOnly = hasFlag("--metadata-only")
const homebrewExpatLib = "/opt/homebrew/opt/expat/lib"
const awsEnv = {
  ...process.env,
  AWS_ACCESS_KEY_ID: requiredEnv("R2_ACCESS_KEY_ID"),
  AWS_SECRET_ACCESS_KEY: requiredEnv("R2_SECRET_ACCESS_KEY"),
  AWS_DEFAULT_REGION: "auto",
  AWS_EC2_METADATA_DISABLED: "true",
}

if (
  process.platform === "darwin" &&
  awsEnv.DYLD_LIBRARY_PATH === undefined &&
  existsSync(homebrewExpatLib)
) {
  awsEnv.DYLD_LIBRARY_PATH = homebrewExpatLib
}

const assetFiles = readdirSync(assetsDir)
  .filter((file) => file !== "latest.json" && file !== "SHA256SUMS")
  .toSorted((left, right) => left.localeCompare(right))

if (assetFiles.length === 0) {
  throw new Error(
    `No release assets found in ${assetsDir}. Run pnpm release:local first or copy artifacts there.`,
  )
}
validateUpdaterAssets(assetFiles)

assertCommand("gh", ["--version"])
assertCommand("aws", ["--version"], { env: awsEnv })

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

function readOption(name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined

  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`)
  }
  return value
}

function hasFlag(name) {
  return args.includes(name)
}

function normalizePublicBaseUrl(value) {
  const trimmed = value.trim().replace(/\/+$/, "")
  if (/^https?:\/\//.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

function requiredEnv(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
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
      url: `${baseUrl}/releases/${tag}/${encodeURIComponent(file)}`,
      size: statSync(filePath).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
  })

  writeFileSync(
    path.join(assetsDir, "latest.json"),
    `${JSON.stringify({ version, tag, generatedAt: new Date().toISOString(), assets }, null, 2)}\n`,
  )
}

function validateUpdaterAssets(files) {
  const requiredFiles = ["latest-mac-arm64.yml", "latest-mac-x64.yml", "latest-linux.yml"]
  for (const file of requiredFiles) {
    if (!files.includes(file)) throw new Error(`Missing required updater metadata: ${file}`)
  }

  const macArchitectures = ["arm64", "x64"]
  for (const arch of macArchitectures) {
    const zip = files.find((file) => file.endsWith(`-mac-${arch}.zip`))
    if (zip === undefined) throw new Error(`Missing macOS ${arch} updater ZIP.`)
    const metadata = readFileSync(path.join(assetsDir, `latest-mac-${arch}.yml`), "utf8")
    if (!metadata.includes(`version: ${version}`) || !metadata.includes(zip)) {
      throw new Error(`macOS ${arch} updater metadata does not reference ${zip}.`)
    }
  }

  const appImage = files.find(
    (file) =>
      (file.includes("-linux-x64") || file.includes("-linux-x86_64")) && file.endsWith(".AppImage"),
  )
  if (appImage === undefined) throw new Error("Missing Linux x64 AppImage.")
  if (!files.includes(`${appImage}.blockmap`)) throw new Error(`Missing ${appImage}.blockmap.`)
  const linuxMetadata = readFileSync(path.join(assetsDir, "latest-linux.yml"), "utf8")
  if (!linuxMetadata.includes(`version: ${version}`) || !linuxMetadata.includes(appImage)) {
    throw new Error(`Linux updater metadata does not reference ${appImage}.`)
  }
}

function publishGithubRelease() {
  const notesPath = path.join(
    mkdtempSync(path.join(tmpdir(), "diffdash-release-notes-")),
    "release-notes.md",
  )
  const notes = execFileSync("node", ["scripts/extract-release-notes.mjs", tag], {
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
    runWithRetries("gh", ["release", "upload", tag, assetPath, "--clobber"], { attempts: 3 })
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

function assertCommand(command, commandArgs, options = {}) {
  try {
    execFileSync(command, commandArgs, { env: options.env ?? process.env, stdio: "ignore" })
  } catch {
    throw new Error(`Required command is not available or failed: ${command}`)
  }
}

function commandSucceeds(command, commandArgs) {
  try {
    execFileSync(command, commandArgs, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function run(command, commandArgs, options = {}) {
  console.log(`$ ${command} ${commandArgs.map(shellQuote).join(" ")}`)
  execFileSync(command, commandArgs, { env: options.env ?? process.env, stdio: "inherit" })
}

function runWithRetries(command, commandArgs, options = {}) {
  const attempts = options.attempts ?? 3
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      run(command, commandArgs, options)
      return
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      console.warn(`Command failed; retrying attempt ${attempt + 1}/${attempts}.`)
    }
  }

  throw lastError
}

function shellQuote(value) {
  return /[^A-Za-z0-9_./:=@-]/.test(value) ? JSON.stringify(value) : value
}
