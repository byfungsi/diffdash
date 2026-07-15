import { execFileSync } from "node:child_process"
import { constants } from "node:fs"
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"

test("boots packaged resources and preserves SQLite data across restart", async ({
  browserName: _browserName,
}, testInfo) => {
  const packaged = packagedAppPaths()
  await verifyPackagedResources(packaged)

  const localRepo = testInfo.outputPath("local-repo")
  const userData = testInfo.outputPath("user-data")
  const xdgConfigHome = testInfo.outputPath("xdg-config")
  await Promise.all([
    mkdir(localRepo, { recursive: true }),
    mkdir(userData, { recursive: true }),
    mkdir(xdgConfigHome, { recursive: true }),
  ])
  execGit(localRepo, "init")
  await writeFile(join(localRepo, "README.md"), "# Packaged E2E\n", "utf8")

  const launchOptions = {
    executablePath: packaged.executable,
    args: [`--user-data-dir=${userData}`],
    env: {
      ...process.env,
      DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
      DIFFDASH_E2E_HIDDEN: "1",
      XDG_CONFIG_HOME: xdgConfigHome,
    },
  }
  let app = await electron.launch(launchOptions)

  try {
    expect(
      await app.evaluate(({ app: runtimeApp }) => ({
        appPath: runtimeApp.getAppPath(),
        isPackaged: runtimeApp.isPackaged,
        resourcesPath: process.resourcesPath,
      })),
    ).toEqual({
      appPath: join(packaged.resources, "app.asar"),
      isPackaged: true,
      resourcesPath: packaged.resources,
    })

    const window = await app.firstWindow()
    expect(
      await window.evaluate(async (repositoryPath) => {
        await globalThis.window.diffDash.appState.update({ onboardingCompleted: true })
        const repository = await globalThis.window.diffDash.repositories.addLocal(repositoryPath)
        const repositories = await globalThis.window.diffDash.repositories.list()
        return {
          diffDashType: typeof globalThis.window.diffDash,
          localPath: repository.localPath,
          nodeProcessType: typeof Reflect.get(globalThis.window, "process"),
          nodeRequireType: typeof Reflect.get(globalThis.window, "require"),
          repositoryCount: repositories.length,
        }
      }, localRepo),
    ).toEqual({
      diffDashType: "object",
      localPath: localRepo,
      nodeProcessType: "undefined",
      nodeRequireType: "undefined",
      repositoryCount: 1,
    })

    await app.close()
    const database = await stat(join(userData, "diffdash.sqlite"))
    expect(database.size).toBeGreaterThan(0)

    app = await electron.launch(launchOptions)
    expect(await app.evaluate(({ app: runtimeApp }) => runtimeApp.isPackaged)).toBe(true)
    const restartedWindow = await app.firstWindow()
    expect(
      await restartedWindow.evaluate(async () => {
        const appState = await globalThis.window.diffDash.appState.get()
        const repositories = await globalThis.window.diffDash.repositories.list()
        return {
          onboardingCompleted: appState.onboardingCompleted,
          repositories: repositories.map((repository) => ({
            localPath: repository.localPath,
            provider: repository.provider,
          })),
        }
      }),
    ).toEqual({
      onboardingCompleted: true,
      repositories: [
        {
          localPath: localRepo,
          provider: "local",
        },
      ],
    })
  } finally {
    await app.close().catch(() => undefined)
  }
})

type PackagedAppPaths = {
  readonly executable: string
  readonly resources: string
  readonly cli: string | null
}

const packagedAppPaths = (): PackagedAppPaths => {
  const dist = join(process.cwd(), "dist")
  if (process.platform === "darwin") {
    const output = process.arch === "arm64" ? "mac-arm64" : "mac"
    const contents = join(dist, output, "DiffDash.app", "Contents")
    return {
      executable: join(contents, "MacOS", "DiffDash"),
      resources: join(contents, "Resources"),
      cli: join(contents, "Resources", "bin", "diffdash"),
    }
  }
  if (process.platform === "linux") {
    const output = process.arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked"
    const root = join(dist, output)
    return {
      executable: join(root, "diffdash-desktop"),
      resources: join(root, "resources"),
      cli: join(root, "resources", "bin", "diffdash"),
    }
  }
  if (process.platform === "win32") {
    const output = process.arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked"
    const root = join(dist, output)
    return {
      executable: join(root, "DiffDash.exe"),
      resources: join(root, "resources"),
      cli: null,
    }
  }
  throw new Error(`Unsupported packaged E2E platform: ${process.platform}`)
}

const verifyPackagedResources = async (packaged: PackagedAppPaths) => {
  await Promise.all([
    assertFile(packaged.executable),
    assertFile(join(packaged.resources, "app.asar")),
    assertFile(join(packaged.resources, "app-update.yml")),
    ...(packaged.cli === null ? [] : [assertFile(packaged.cli)]),
  ])
  if (packaged.cli !== null) await access(packaged.cli, constants.X_OK)

  const updateConfig = await readFile(join(packaged.resources, "app-update.yml"), "utf8")
  expect(updateConfig).toMatch(/^provider:\s*generic\s*$/m)
  expect(updateConfig).toMatch(/^url:\s*https:\/\/download\.usediffdash\.com\/updates\/stable\s*$/m)
  expect(updateConfig).toMatch(/^updaterCacheDirName:\s*\S+\s*$/m)

  const unpacked = join(packaged.resources, "app.asar.unpacked")
  const entries = await readdir(unpacked, { recursive: true })
  const nativeModule = entries.find((entry) => entry.endsWith("better_sqlite3.node"))
  if (nativeModule === undefined) {
    throw new Error(`Packaged better_sqlite3.node was not found under ${unpacked}`)
  }
  await assertFile(join(unpacked, nativeModule))
}

const assertFile = async (path: string) => {
  await access(path, constants.R_OK)
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Expected a non-empty packaged file at ${path}`)
  }
}

const execGit = (cwd: string, ...args: readonly string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
