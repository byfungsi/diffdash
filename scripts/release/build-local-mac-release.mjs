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
import { parseMacReleaseArguments } from "./release-arguments.mjs"
import { runSyncCommand } from "./release-command.mjs"
import { requiredEnvironment } from "./release-environment.mjs"

const cli = parseMacReleaseArguments()
const desktopRoot = path.resolve("packages/desktop")
const packageJson = JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8"))
const version = packageJson.version
const productName = packageJson.productName ?? packageJson.name
const releaseAssetsDir = path.resolve(cli.assetsDir ?? "release-assets")
const requestedArch = cli.arch ?? process.env.RELEASE_MAC_ARCH ?? nativeArch()
const archs = requestedArch === "all" ? ["arm64", "x64"] : [requestedArch]
const { packageExisting, skipNotarize, submissionId } = cli

if (process.platform !== "darwin") {
  throw new Error("Local macOS release builds must run on macOS.")
}

for (const arch of archs) {
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`Unsupported macOS arch ${JSON.stringify(arch)}. Use arm64, x64, or all.`)
  }
}

requiredEnvironment("APPLE_API_KEY")
requiredEnvironment("APPLE_API_KEY_ID")
requiredEnvironment("APPLE_API_ISSUER")
normalizeCscName()

if (process.env.CSC_LINK !== undefined) {
  requiredEnvironment("CSC_KEY_PASSWORD")
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
  runSyncCommand("pnpm", ["assets:icons"])
  runSyncCommand("pnpm", ["native:electron"])
  runSyncCommand("pnpm", ["build"])
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
    runSyncCommand(
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
      { cwd: desktopRoot },
    )
  }

  verifyAppUpdateConfig(appPath)

  if (skipNotarize) {
    console.log(`Skipping notarization for ${appPath}`)
  } else {
    console.log(`Notarizing and stapling ${appPath}`)
    const notarizeArgs = ["scripts/release/notarize-app.mjs", appPath]
    if (submissionId !== undefined) {
      notarizeArgs.push("--submission-id", submissionId)
    }
    runSyncCommand("node", notarizeArgs)
  }

  console.log(`Packaging macOS ${arch} DMG`)
  rmSync(artifactPath, { force: true })
  runSyncCommand(
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
    { cwd: desktopRoot },
  )

  console.log(`Packaging macOS ${arch} updater ZIP`)
  rmSync(zipPath, { force: true })
  rmSync(blockmapPath, { force: true })
  rmSync(metadataPath, { force: true })
  runSyncCommand(
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
    { cwd: desktopRoot },
  )

  verifyApp(appPath)

  if (!existsSync(artifactPath)) {
    throw new Error(`Expected DMG was not created: ${artifactPath}`)
  }
  if (!existsSync(zipPath)) throw new Error(`Expected updater ZIP was not created: ${zipPath}`)
  if (!existsSync(blockmapPath)) {
    throw new Error(`Expected macOS updater blockmap was not created: ${blockmapPath}`)
  }
  if (!existsSync(metadataPath)) {
    throw new Error(`Expected macOS updater metadata was not created: ${metadataPath}`)
  }
  const metadata = readFileSync(metadataPath, "utf8")
  if (!metadata.includes(path.basename(zipPath)) || !metadata.includes(`version: ${version}`)) {
    throw new Error(`macOS updater metadata does not reference ${path.basename(zipPath)}`)
  }

  copyFileSync(artifactPath, path.join(releaseAssetsDir, path.basename(artifactPath)))
  copyFileSync(zipPath, path.join(releaseAssetsDir, path.basename(zipPath)))
  copyFileSync(blockmapPath, path.join(releaseAssetsDir, path.basename(blockmapPath)))
  copyFileSync(metadataPath, path.join(releaseAssetsDir, `latest-mac-${arch}.yml`))
  console.log(`Copied ${path.basename(artifactPath)} to ${releaseAssetsDir}`)
  console.log(`Copied macOS ${arch} updater artifacts to ${releaseAssetsDir}`)
}

console.log(`Local macOS release assets are ready in ${releaseAssetsDir}`)

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
  runSyncCommand("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath])
  runSyncCommand("spctl", ["-a", "-vv", "--type", "exec", appPath])
  runSyncCommand("xcrun", ["stapler", "validate", appPath])
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
