import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import "./load-local-env.mjs"
import { parseLinuxReleaseArguments } from "./release-arguments.mjs"
import { assertCommandAvailable, runSyncCommand } from "./release-command.mjs"

const cli = parseLinuxReleaseArguments()
const workspacePackageJson = JSON.parse(readFileSync("package.json", "utf8"))
const packageJson = JSON.parse(readFileSync("packages/desktop/package.json", "utf8"))
const releaseAssetsDir = path.resolve(cli.assetsDir ?? "release-assets")
const platform = cli.platform ?? process.env.RELEASE_LINUX_PLATFORM ?? "linux/amd64"
const image = cli.image ?? process.env.RELEASE_LINUX_IMAGE ?? "node:22-trixie"
const pnpmVersion = workspacePackageJson.packageManager?.startsWith("pnpm@")
  ? workspacePackageJson.packageManager.slice("pnpm@".length)
  : "10.26.1"

assertCommandAvailable("docker", ["--version"])
mkdirSync(releaseAssetsDir, { recursive: true })

const tempRoot = path.join(releaseAssetsDir, ".tmp")
rmSync(tempRoot, { force: true, recursive: true })
mkdirSync(tempRoot, { recursive: true })

try {
  const tempDir = mkdtempSync(path.join(tempRoot, "linux-release-"))
  const sourceDir = path.join(tempDir, "source")
  mkdirSync(sourceDir, { recursive: true })

  const archivePath = path.join(tempDir, "source.tar")
  const archive = execFileSync("git", ["archive", "--format=tar", "HEAD"], {
    maxBuffer: 1024 * 1024 * 1024,
  })
  writeFileSync(archivePath, archive)
  runSyncCommand("tar", ["-xf", archivePath, "-C", sourceDir])
  writeHomepageMetadata(sourceDir)

  const dockerCommand = [
    "set -eu",
    "apt-get update",
    "apt-get install -y --no-install-recommends ca-certificates git python3 make g++ pkg-config fakeroot dpkg",
    "corepack enable",
    `corepack prepare pnpm@${pnpmVersion} --activate`,
    "pnpm install --frozen-lockfile",
    "pnpm assets:icons",
    "pnpm native:electron",
    "pnpm build",
    "pnpm --dir packages/desktop exec electron-builder --linux AppImage deb --x64 --publish=never",
  ].join(" && ")

  runSyncCommand("docker", [
    "run",
    "--rm",
    "--platform",
    platform,
    "-v",
    `${sourceDir}:/workspace`,
    "-w",
    "/workspace",
    "-e",
    "CI=1",
    "-e",
    "ELECTRON_CACHE=/tmp/electron-cache",
    "-e",
    "ELECTRON_BUILDER_CACHE=/tmp/electron-builder-cache",
    image,
    "bash",
    "-lc",
    dockerCommand,
  ])

  const distDir = path.join(sourceDir, "packages/desktop/dist")
  if (!existsSync(distDir)) {
    throw new Error("Docker Linux build did not create a dist directory.")
  }

  const artifactTypes = [
    { extension: ".AppImage", label: "AppImage" },
    { extension: ".deb", label: "deb" },
  ]
  const artifactFiles = readdirSync(distDir).filter(
    (file) =>
      artifactTypes.some(({ extension }) => file.endsWith(extension)) ||
      file.endsWith(".blockmap") ||
      file === "latest-linux.yml",
  )

  for (const { extension, label } of artifactTypes) {
    if (!artifactFiles.some((file) => file.endsWith(extension))) {
      throw new Error(`Docker Linux build did not create a ${label} artifact.`)
    }
  }
  const appImage = artifactFiles.find((file) => file.endsWith(".AppImage"))
  const metadataPath = path.join(distDir, "latest-linux.yml")
  if (appImage === undefined || !existsSync(metadataPath)) {
    throw new Error("Docker Linux build did not create AppImage updater metadata.")
  }
  const metadata = readFileSync(metadataPath, "utf8")
  if (!metadata.includes(appImage) || !metadata.includes(`version: ${packageJson.version}`)) {
    throw new Error(`Linux updater metadata does not reference ${appImage}.`)
  }

  for (const file of artifactFiles) {
    copyFileSync(path.join(distDir, file), path.join(releaseAssetsDir, file))
    console.log(`Copied ${file} to ${releaseAssetsDir}`)
  }

  console.log(`Local Linux release assets are ready in ${releaseAssetsDir}`)
} finally {
  rmSync(tempRoot, { force: true, recursive: true })
}

function writeHomepageMetadata(sourceDir) {
  if (typeof packageJson.homepage !== "string" || packageJson.homepage.trim().length === 0) return

  const packageJsonPath = path.join(sourceDir, "packages/desktop/package.json")
  const sourcePackageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"))
  sourcePackageJson.homepage = packageJson.homepage
  writeFileSync(packageJsonPath, `${JSON.stringify(sourcePackageJson, null, 2)}\n`)
}
