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
const desktopRoot = path.resolve("packages/desktop")
const packageJson = JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8"))
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
  const artifactPath = path.join(desktopRoot, "dist", `${productName}-${version}-mac-${arch}.dmg`)
  const zipPath = path.join(desktopRoot, "dist", `${productName}-${version}-mac-${arch}.zip`)
  const blockmapPath = `${zipPath}.blockmap`
  const metadataPath = path.join(desktopRoot, "dist", "latest-mac.yml")

  if (packageExisting) {
    if (!existsSync(appPath)) {
      throw new Error(`Existing macOS app was not found: ${appPath}`)
    }
    console.log(`Packaging existing macOS ${arch} app`)
  } else {
    console.log(`Building signed macOS ${arch} app`)
    run(
      "pnpm",
      [
        "exec",
        "electron-builder",
        "--config",
        electronBuilderConfig,
        "--mac",
        "zip",
        `--${arch}`,
        "--publish=never",
      ],
      desktopRoot,
    )
  }

  verifyAppUpdateConfig(appPath)

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
  rmSync(artifactPath, { force: true })
  run(
    "pnpm",
    [
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
    ],
    desktopRoot,
  )

  console.log(`Packaging macOS ${arch} updater ZIP`)
  rmSync(zipPath, { force: true })
  rmSync(blockmapPath, { force: true })
  rmSync(metadataPath, { force: true })
  run(
    "pnpm",
    [
      "exec",
      "electron-builder",
      "--config",
      electronBuilderConfig,
      "--prepackaged",
      appPath,
      "--mac",
      "zip",
      `--${arch}`,
      "--publish=never",
    ],
    desktopRoot,
  )

  verifyApp(appPath)

  if (!existsSync(artifactPath)) {
    throw new Error(`Expected DMG was not created: ${artifactPath}`)
  }
  if (!existsSync(zipPath)) throw new Error(`Expected updater ZIP was not created: ${zipPath}`)
  if (!existsSync(metadataPath)) {
    throw new Error(`Expected macOS updater metadata was not created: ${metadataPath}`)
  }
  const metadata = readFileSync(metadataPath, "utf8")
  if (!metadata.includes(path.basename(zipPath)) || !metadata.includes(`version: ${version}`)) {
    throw new Error(`macOS updater metadata does not reference ${path.basename(zipPath)}`)
  }

  copyFileSync(artifactPath, path.join(releaseAssetsDir, path.basename(artifactPath)))
  copyFileSync(zipPath, path.join(releaseAssetsDir, path.basename(zipPath)))
  if (existsSync(blockmapPath)) {
    copyFileSync(blockmapPath, path.join(releaseAssetsDir, path.basename(blockmapPath)))
  }
  copyFileSync(metadataPath, path.join(releaseAssetsDir, `latest-mac-${arch}.yml`))
  console.log(`Copied ${path.basename(artifactPath)} to ${releaseAssetsDir}`)
  console.log(`Copied macOS ${arch} updater artifacts to ${releaseAssetsDir}`)
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
  return path.join(
    desktopRoot,
    "dist",
    arch === "x64" ? "mac" : `mac-${arch}`,
    `${productName}.app`,
  )
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

function verifyAppUpdateConfig(appPath) {
  const updateConfigPath = path.join(appPath, "Contents", "Resources", "app-update.yml")
  if (!existsSync(updateConfigPath)) {
    throw new Error(`Packaged macOS app is missing updater configuration: ${updateConfigPath}`)
  }

  const updateConfig = readFileSync(updateConfigPath, "utf8")
  if (!/^provider:\s*generic\s*$/m.test(updateConfig)) {
    throw new Error("Packaged macOS updater configuration is missing the generic provider.")
  }
  if (!/^updaterCacheDirName:\s*\S+\s*$/m.test(updateConfig)) {
    throw new Error("Packaged macOS updater configuration is missing updaterCacheDirName.")
  }
  console.log(`Verified updater configuration: ${updateConfigPath}`)
}

function run(command, commandArgs, cwd) {
  console.log(`$ ${command} ${commandArgs.map(shellQuote).join(" ")}`)
  execFileSync(command, commandArgs, { cwd, env: process.env, stdio: "inherit" })
}

function shellQuote(value) {
  return /[^A-Za-z0-9_./:=@-]/.test(value) ? JSON.stringify(value) : value
}
