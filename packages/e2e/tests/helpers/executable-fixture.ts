import { execFile } from "node:child_process"
import { copyFile, chmod, link, mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { delimiter, dirname, join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const windowsLaunchers = new Map<string, Promise<string>>()

/** Prepends a fixture directory using the host platform's executable search delimiter. */
export const prependExecutablePath = (
  directory: string,
  currentPath = process.env.PATH ?? "",
): string => (currentPath.length === 0 ? directory : `${directory}${delimiter}${currentPath}`)

/** Installs a Node-backed executable with the launcher convention used by the host platform. */
export const installExecutableFixture = async (
  directory: string,
  name: string,
  source: string,
): Promise<string> => {
  await mkdir(directory, { recursive: true })
  const modulePath = join(directory, `${name}.fixture.mjs`)
  await writeFile(modulePath, source, "utf8")
  if (process.platform === "win32") {
    const launcher = await windowsExecutableLauncher(directory)
    const executablePath = join(directory, `${name}.exe`)
    await link(launcher, executablePath)
    return executablePath
  }
  const executablePath = join(directory, name)
  await writeFile(
    executablePath,
    `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(modulePath)} "$@"\n`,
    "utf8",
  )
  await chmod(executablePath, 0o755)
  return executablePath
}

const quoteShell = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`

const windowsExecutableLauncher = (directory: string): Promise<string> => {
  const existing = windowsLaunchers.get(directory)
  if (existing !== undefined) return existing
  const launcher = buildWindowsExecutableLauncher(directory)
  windowsLaunchers.set(directory, launcher)
  return launcher
}

const buildWindowsExecutableLauncher = async (directory: string): Promise<string> => {
  const launcherSource = join(directory, "fixture-launcher.cjs")
  const seaConfiguration = join(directory, "fixture-launcher-sea.json")
  const seaBlob = join(directory, "fixture-launcher.blob")
  const launcher = join(directory, "fixture-launcher.exe")
  await writeFile(
    launcherSource,
    `const { basename, join } = require("node:path")
const { pathToFileURL } = require("node:url")
const name = basename(process.execPath, ".exe")
const modulePath = join(__dirname, name + ".fixture.mjs")
process.argv.splice(1, 0, modulePath)
import(pathToFileURL(modulePath).href).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`,
    "utf8",
  )
  await writeFile(
    seaConfiguration,
    JSON.stringify({
      main: launcherSource,
      output: seaBlob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    }),
    "utf8",
  )
  await execFileAsync(process.execPath, ["--experimental-sea-config", seaConfiguration])
  await copyFile(process.execPath, launcher)
  const require = createRequire(import.meta.url)
  const postject = join(dirname(require.resolve("postject")), "cli.js")
  await execFileAsync(process.execPath, [
    postject,
    launcher,
    "NODE_SEA_BLOB",
    seaBlob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ])
  return launcher
}
