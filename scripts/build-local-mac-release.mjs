import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import "./load-local-env.mjs"

const args = process.argv.slice(2)
const packageJson = JSON.parse(readFileSync("package.json", "utf8"))
const version = packageJson.version
const productName = packageJson.productName ?? packageJson.name
const releaseAssetsDir = path.resolve(readOption("--assets-dir") ?? "release-assets")
const requestedArch = readOption("--arch") ?? process.env.RELEASE_MAC_ARCH ?? nativeArch()
const archs = requestedArch === "all" ? ["arm64", "x64"] : [requestedArch]
const packageExisting = hasFlag("--package-existing")
const skipNotarize = hasFlag("--skip-notarize")
const submissionId = readOption("--submission-id")

if (process.platform !== "darwin") {
  throw new Error("Local macOS release builds must run on macOS.")
}

for (const arch of archs) {
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`Unsupported macOS arch ${JSON.stringify(arch)}. Use arm64, x64, or all.`)
  }
}

requiredEnv("APPLE_API_KEY")
requiredEnv("APPLE_API_KEY_ID")
requiredEnv("APPLE_API_ISSUER")
normalizeCscName()

if (process.env.CSC_LINK !== undefined) {
  requiredEnv("CSC_KEY_PASSWORD")
}

const tempDir = mkdtempSync(path.join(tmpdir(), "diffdash-local-release-"))
const electronBuilderConfig = path.join(tempDir, "electron-builder-local.json")
const buildConfig = {
  ...packageJson.build,
  mac: {
    ...packageJson.build.mac,
    forceCodeSigning: true,
    notarize: false,
  },
}
writeFileSync(electronBuilderConfig, `${JSON.stringify(buildConfig, null, 2)}\n`)

if (!packageExisting) {
  rmSync(releaseAssetsDir, { force: true, recursive: true })
}
mkdirSync(releaseAssetsDir, { recursive: true })

if (!packageExisting) {
  run("pnpm", ["assets:icons"])
  run("pnpm", ["native:electron"])
  run("pnpm", ["build"])
}

for (const arch of archs) {
  const appPath = macAppPath(arch)
  const artifactPath = path.resolve("dist", `${productName}-${version}-mac-${arch}.dmg`)

  if (packageExisting) {
    if (!existsSync(appPath)) {
      throw new Error(`Existing macOS app was not found: ${appPath}`)
    }
    console.log(`Packaging existing macOS ${arch} app`)
  } else {
    console.log(`Building signed macOS ${arch} app`)
    run("pnpm", [
      "exec",
      "electron-builder",
      "--config",
      electronBuilderConfig,
      "--mac",
      "dir",
      `--${arch}`,
      "--publish=never",
    ])
  }

  if (skipNotarize) {
    console.log(`Skipping notarization for ${appPath}`)
  } else {
    console.log(`Notarizing and stapling ${appPath}`)
    const notarizeArgs = ["scripts/notarize-app.mjs", appPath]
    if (submissionId !== undefined) {
      notarizeArgs.push("--submission-id", submissionId)
    }
    run("node", notarizeArgs)
  }

  console.log(`Packaging macOS ${arch} DMG`)
  run("pnpm", [
    "exec",
    "electron-builder",
    "--config",
    electronBuilderConfig,
    "--prepackaged",
    appPath,
    "--mac",
    "dmg",
    `--${arch}`,
    "--publish=never",
  ])

  verifyApp(appPath)

  if (!existsSync(artifactPath)) {
    throw new Error(`Expected DMG was not created: ${artifactPath}`)
  }

  copyFileSync(artifactPath, path.join(releaseAssetsDir, path.basename(artifactPath)))
  console.log(`Copied ${path.basename(artifactPath)} to ${releaseAssetsDir}`)
}

console.log(`Local macOS release assets are ready in ${releaseAssetsDir}`)

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

function nativeArch() {
  if (process.arch === "arm64") return "arm64"
  if (process.arch === "x64") return "x64"
  throw new Error(`Unsupported native architecture: ${process.arch}`)
}

function macAppPath(arch) {
  return path.resolve("dist", arch === "x64" ? "mac" : `mac-${arch}`, `${productName}.app`)
}

function requiredEnv(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function normalizeCscName() {
  const name = process.env.CSC_NAME
  if (name === undefined) return

  const prefix = "Developer ID Application:"
  if (name.startsWith(prefix)) {
    process.env.CSC_NAME = name.slice(prefix.length).trim()
    console.log("Normalized CSC_NAME for Electron Builder by removing the certificate type prefix.")
  }
}

function verifyApp(appPath) {
  console.log(`Verifying signed and notarized app: ${appPath}`)
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath])
  run("spctl", ["-a", "-vv", "--type", "exec", appPath])
  run("xcrun", ["stapler", "validate", appPath])
}

function run(command, commandArgs) {
  console.log(`$ ${command} ${commandArgs.map(shellQuote).join(" ")}`)
  execFileSync(command, commandArgs, { env: process.env, stdio: "inherit" })
}

function shellQuote(value) {
  return /[^A-Za-z0-9_./:=@-]/.test(value) ? JSON.stringify(value) : value
}
