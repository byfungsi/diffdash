#!/usr/bin/env node
import { spawn } from "node:child_process"
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const args = process.argv.slice(2)
const executablePath = fileURLToPath(import.meta.url)
const packageRoot = resolve(dirname(executablePath), "..")
const mainEntry = resolve(packageRoot, "out/main/index.js")
const usage =
  "Usage: diffdash [path]\n       diffdash install [path]\n       diffdash pr [pr-number]\n       diffdash diff [branch-name]\n       diffdash last-commit | lc\n       diffdash compare <base> <head> [--repository=<repository>]\n       diffdash repair\n       diffdash --install-cli [directory]\n"
const CLI_ARGUMENT = "--diffdash-cli-v1"
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(usage)
  process.exit(0)
}

const installCliRequested =
  args[0] === "--install-cli" || args[0]?.startsWith("--install-cli=") === true
if (installCliRequested) {
  installCli(args, 0)
  process.exit(0)
}

const launchArguments = [`${CLI_ARGUMENT}=${process.cwd()}`, "--", ...args]

if (existsSync(mainEntry)) {
  const electronPath = await resolveElectronPath()
  if (electronPath === null) {
    process.stderr.write(
      "Could not find Electron. Run `pnpm install` before using the source CLI.\n",
    )
    process.exit(1)
  }

  const child = spawn(electronPath, [packageRoot, ...launchArguments], {
    detached: true,
    stdio: "ignore",
  })

  child.unref()
  process.exit(0)
}

if (process.platform === "darwin") {
  const child = spawn("open", ["-a", "DiffDash", "--args", ...launchArguments], {
    stdio: "inherit",
  })

  child.on("exit", (code) => process.exit(code ?? 0))
} else {
  process.stderr.write(
    "DiffDash is not built yet. Run `pnpm build` before using the CLI from source.\n",
  )
  process.exit(1)
}

async function resolveElectronPath() {
  try {
    const electron = await import("electron")
    return electron.default
  } catch {
    return null
  }
}

function installCli(inputArgs, installIndex) {
  const targetDirectory = installTargetDirectory(inputArgs, installIndex)
  if (targetDirectory === null) {
    process.stderr.write(
      "Could not find a writable directory in PATH. Re-run with `diffdash --install-cli /path/to/bin`.\n",
    )
    process.exit(1)
  }

  mkdirSync(targetDirectory, { recursive: true })
  chmodSync(executablePath, 0o755)

  const linkPath = resolve(targetDirectory, "diffdash")
  if (existsSync(linkPath)) {
    const existing = lstatSync(linkPath)
    if (existing.isSymbolicLink()) {
      const linkedPath = resolve(dirname(linkPath), readlinkSync(linkPath))
      if (linkedPath === executablePath) {
        process.stdout.write(`diffdash CLI is already installed at ${linkPath}\n`)
        return
      }
    }

    process.stderr.write(`${linkPath} already exists. Remove it or choose another directory.\n`)
    process.exit(1)
  }

  symlinkSync(executablePath, linkPath)
  process.stdout.write(`Installed diffdash CLI at ${linkPath}\n`)
}

function installTargetDirectory(inputArgs, installIndex) {
  const installArg = inputArgs[installIndex]
  const explicitFromEquals = installArg?.startsWith("--install-cli=")
    ? installArg.slice("--install-cli=".length)
    : null
  const explicitFromNext = explicitFromEquals === null ? inputArgs[installIndex + 1] : null
  const explicitDirectory = explicitFromEquals ?? explicitFromNext
  if (
    explicitDirectory !== undefined &&
    explicitDirectory !== null &&
    explicitDirectory.length > 0
  ) {
    return resolve(process.cwd(), explicitDirectory)
  }

  return firstWritablePathDirectory()
}

function firstWritablePathDirectory() {
  const pathDirectories = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0)
  const pathDirectorySet = new Set(pathDirectories.map((entry) => resolve(entry)))
  const preferredDirectories = [
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
  const candidates = [
    ...preferredDirectories.filter((entry) => pathDirectorySet.has(resolve(entry))),
    ...pathDirectories,
  ]

  for (const candidate of candidates) {
    const resolvedCandidate = resolve(candidate)
    if (canWriteDirectory(resolvedCandidate)) return resolvedCandidate
  }

  return null
}

function canWriteDirectory(directory) {
  try {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true })
    }
    accessSync(directory, constants.W_OK)
    return true
  } catch {
    return false
  }
}
