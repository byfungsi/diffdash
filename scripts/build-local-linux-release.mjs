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

const args = process.argv.slice(2)
const packageJson = JSON.parse(readFileSync("package.json", "utf8"))
const releaseAssetsDir = path.resolve(readOption("--assets-dir") ?? "release-assets")
const platform = readOption("--platform") ?? process.env.RELEASE_LINUX_PLATFORM ?? "linux/amd64"
const image = readOption("--image") ?? process.env.RELEASE_LINUX_IMAGE ?? "node:22-bookworm"
const pnpmVersion = packageJson.packageManager?.startsWith("pnpm@")
  ? packageJson.packageManager.slice("pnpm@".length)
  : "10.26.1"

assertCommand("docker", ["--version"])
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
  run("tar", ["-xf", archivePath, "-C", sourceDir])

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
    "pnpm exec electron-builder --linux deb --x64 --publish=never",
  ].join(" && ")

  run("docker", [
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

  const distDir = path.join(sourceDir, "dist")
  if (!existsSync(distDir)) {
    throw new Error("Docker Linux build did not create a dist directory.")
  }

  const debFiles = readdirSync(distDir).filter((file) => file.endsWith(".deb"))
  if (debFiles.length === 0) {
    throw new Error("Docker Linux build did not create a .deb artifact.")
  }

  for (const file of debFiles) {
    copyFileSync(path.join(distDir, file), path.join(releaseAssetsDir, file))
    console.log(`Copied ${file} to ${releaseAssetsDir}`)
  }

  console.log(`Local Linux release assets are ready in ${releaseAssetsDir}`)
} finally {
  rmSync(tempRoot, { force: true, recursive: true })
}

function readOption(name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined

  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`)
  }
  return value
}

function assertCommand(command, commandArgs) {
  try {
    execFileSync(command, commandArgs, { stdio: "ignore" })
  } catch {
    throw new Error(`Required command is not available or failed: ${command}`)
  }
}

function run(command, commandArgs) {
  console.log(`$ ${command} ${commandArgs.map(shellQuote).join(" ")}`)
  execFileSync(command, commandArgs, { env: process.env, stdio: "inherit" })
}

function shellQuote(value) {
  return /[^A-Za-z0-9_./:=@-]/.test(value) ? JSON.stringify(value) : value
}
