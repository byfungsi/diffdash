import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import "./load-local-env.mjs"

const args = process.argv.slice(2)
const packageJson = JSON.parse(readFileSync("package.json", "utf8"))
const tag = readOption("--tag") ?? `v${packageJson.version}`
const version = tag.startsWith("v") ? tag.slice(1) : tag
const assetsDir = path.resolve(readOption("--assets-dir") ?? "release-assets")
const baseUrl = requiredEnv("R2_PUBLIC_BASE_URL").replace(/\/+$/, "")
const r2Bucket = requiredEnv("R2_BUCKET")
const r2Endpoint = `https://${requiredEnv("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com`
const awsEnv = {
  ...process.env,
  AWS_ACCESS_KEY_ID: requiredEnv("R2_ACCESS_KEY_ID"),
  AWS_SECRET_ACCESS_KEY: requiredEnv("R2_SECRET_ACCESS_KEY"),
  AWS_DEFAULT_REGION: "auto",
  AWS_EC2_METADATA_DISABLED: "true",
}

const assetFiles = readdirSync(assetsDir)
  .filter((file) => file !== "latest.json" && file !== "SHA256SUMS")
  .toSorted((left, right) => left.localeCompare(right))

if (assetFiles.length === 0) {
  throw new Error(
    `No release assets found in ${assetsDir}. Run pnpm release:local first or copy artifacts there.`,
  )
}

assertCommand("gh", ["--version"])
assertCommand("aws", ["--version"], { env: awsEnv })

writeChecksums(assetFiles)
writeLatestJson()
publishGithubRelease()
publishR2()
pruneR2()

console.log(`Published ${tag} assets from ${assetsDir}`)

function readOption(name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined

  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`)
  }
  return value
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
    run("gh", ["release", "edit", tag, "--title", tag, "--notes-file", notesPath])
    run("gh", ["release", "upload", tag, ...allAssetPaths(), "--clobber"])
    return
  }

  run("gh", [
    "release",
    "create",
    tag,
    ...allAssetPaths(),
    "--draft",
    "--verify-tag",
    "--title",
    tag,
    "--notes-file",
    notesPath,
  ])
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
      "--exclude",
      "latest.json",
      "--cache-control",
      "public, max-age=31536000, immutable",
      "--endpoint-url",
      r2Endpoint,
    ],
    { env: awsEnv },
  )

  run(
    "aws",
    [
      "s3",
      "cp",
      path.join(assetsDir, "latest.json"),
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
  const parsed = prefixes
    .map((prefix) => {
      const match = /^releases\/v?(\d+)\.(\d+)\.(\d+)(?:[-+][^/]*)?\/$/.exec(prefix)
      if (match === null) return null
      return {
        prefix,
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
      }
    })
    .filter(Boolean)
    .toSorted(
      (left, right) =>
        right.major - left.major || right.minor - left.minor || right.patch - left.patch,
    )

  const keep = new Set(parsed.slice(0, 3).map((entry) => entry.prefix))
  const remove = parsed.filter((entry) => !keep.has(entry.prefix)).map((entry) => entry.prefix)

  for (const prefix of remove) {
    run(
      "aws",
      ["s3", "rm", `s3://${r2Bucket}/${prefix}`, "--recursive", "--endpoint-url", r2Endpoint],
      {
        env: awsEnv,
      },
    )
  }
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

function shellQuote(value) {
  return /[^A-Za-z0-9_./:=@-]/.test(value) ? JSON.stringify(value) : value
}
