import { execFileSync } from "node:child_process"
import { constants } from "node:fs"
import { access, chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"

test("FUN-141 AC: verifies final packaged composition and provider persistence", async ({
  browserName: _browserName,
}, testInfo) => {
  testInfo.setTimeout(90_000)
  const packaged = packagedAppPaths()
  await verifyPackagedResources(packaged)

  const fakeBin = testInfo.outputPath("fake-bin")
  const gitLog = testInfo.outputPath("git-runs.log")
  const sourceRepo = testInfo.outputPath("source-repo")
  const remoteRepo = testInfo.outputPath("fixture.git")
  const worktreePool = testInfo.outputPath("worktree-pool")
  const userData = testInfo.outputPath("user-data")
  const xdgConfigHome = testInfo.outputPath("xdg-config")
  await Promise.all([
    mkdir(fakeBin, { recursive: true }),
    mkdir(userData, { recursive: true }),
    mkdir(join(xdgConfigHome, "diffdash"), { recursive: true }),
  ])
  await installPackagedFakeCli(fakeBin)
  const revisions = await installFixtureRepository(sourceRepo, remoteRepo)
  await writeFile(
    join(xdgConfigHome, "diffdash", "state.json"),
    JSON.stringify({ onboardingCompleted: true }),
    "utf8",
  )
  await writeFile(
    join(xdgConfigHome, "diffdash", "settings.json"),
    JSON.stringify({
      version: 2,
      appearance: "dark",
      routes: { walkthrough: "fixture-agent", reviewThread: "fixture-agent" },
      models: { "fixture-agent": "fixture-model" },
      autoQuality: "balanced",
      telemetryEnabled: false,
    }),
    "utf8",
  )

  const launchOptions = {
    executablePath: packaged.executable,
    args: [`--user-data-dir=${userData}`],
    env: {
      ...process.env,
      DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
      DIFFDASH_E2E_DISABLE_UPDATES: "1",
      DIFFDASH_E2E_FAKE_AGENT_PROVIDER: "1",
      DIFFDASH_E2E_FAKE_GIT_PROVIDER: "1",
      DIFFDASH_E2E_FAKE_GIT_BASE_SHA: revisions.base,
      DIFFDASH_E2E_FAKE_GIT_HEAD_SHA: revisions.head,
      DIFFDASH_E2E_FAKE_GIT_REMOTE: remoteRepo,
      DIFFDASH_E2E_HIDDEN: "1",
      DIFFDASH_REMOTE_WORKTREE_POOL_PATH: worktreePool,
      FAKE_GIT_LOG: gitLog,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      REAL_GIT_PATH: realGitPath,
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
    if (packaged.cli !== null) {
      expect(execFileSync(packaged.cli, ["--help"], { encoding: "utf8" })).toContain(
        "Usage: diffdash [path]",
      )
    }

    const window = await app.firstWindow()
    expect(
      await window.evaluate(() => globalThis.window.open("file:///tmp/blocked-popup")),
    ).toBeNull()
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    expect(
      await app.evaluate(async ({ BrowserWindow }) => {
        const targetWindow = BrowserWindow.getAllWindows()[0]
        if (targetWindow === undefined) throw new Error("Packaged BrowserWindow was not found")
        targetWindow.webContents.openDevTools({ mode: "detach" })
        await new Promise((resolve) => setTimeout(resolve, 100))
        return targetWindow.webContents.isDevToolsOpened()
      }),
    ).toBe(false)
    expect(
      await window.evaluate(async () => {
        const providers = await globalThis.window.diffDash.providers.list()
        const catalog = await globalThis.window.diffDash.agentProviders.getCatalog()
        const settings = await globalThis.window.diffDash.settings.get()
        const fixtureGit = providers.find(({ id }) => id === "fixture")
        if (fixtureGit === undefined) throw new Error("Fixture Git provider was not registered")
        const results = await globalThis.window.diffDash.hostedRepositories.searchRepositories({
          providerId: fixtureGit.id,
          query: "service",
          namespaces: [],
        })
        const result = results[0]
        if (result === undefined) throw new Error("Fixture repository was not discovered")
        await globalThis.window.diffDash.repositories.favoriteRemote(result)
        const repositories = await globalThis.window.diffDash.repositories.list()
        const updater = await globalThis.window.diffDash.updates.getState()
        return {
          agent: catalog.providers.find(({ id }) => id === "fixture-agent"),
          git: fixtureGit,
          repository: repositories.find(({ provider }) => provider === "fixture"),
          routes: settings.routes,
          updater,
        }
      }),
    ).toEqual({
      agent: expect.objectContaining({
        id: "fixture-agent",
        capabilities: expect.arrayContaining([
          expect.objectContaining({ capability: "review-thread", status: "ready" }),
        ]),
        defaults: { reviewThreadModel: "fixture-model", walkthroughModel: "fixture-model" },
      }),
      git: expect.objectContaining({
        id: "fixture",
        displayName: "Fixture Forge",
        capabilities: expect.objectContaining({ reviewDecisions: false }),
      }),
      repository: expect.objectContaining({
        provider: "fixture",
        owner: "platform/backend",
        name: "service",
        isFavorite: true,
      }),
      routes: { walkthrough: "fixture-agent", reviewThread: "fixture-agent" },
      updater: expect.not.objectContaining({ reason: "development" }),
    })

    const fixtureReview = window.getByRole("button", {
      name: /Open requested review #73: Fixture merge request flow/,
    })
    await expect(fixtureReview).toBeVisible()
    await fixtureReview.click()
    await expect(window.getByRole("heading", { name: "Fixture merge request flow" })).toBeVisible()
    await expect(window.getByText("src/fixture.ts").first()).toBeVisible()

    const gutterNumber = window
      .locator("diffs-container [data-column-number]")
      .filter({ hasText: "1" })
      .first()
    await gutterNumber.dispatchEvent("pointermove", {
      bubbles: true,
      composed: true,
      pointerType: "mouse",
    })
    const utility = window.locator("diffs-container [data-utility-button]")
    await expect(utility).toBeVisible()
    const pointerEvent = {
      bubbles: true,
      button: 0,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
    }
    await utility.dispatchEvent("pointerdown", pointerEvent)
    await utility.dispatchEvent("pointerup", pointerEvent)
    await window.getByRole("textbox", { name: "Thread message" }).fill("Review fixture line")
    await window.getByRole("button", { name: "Comment" }).click()
    await expect(window.getByText("Fixture review response")).toBeVisible({ timeout: 20_000 })

    await app.close()
    const database = await stat(join(userData, "diffdash.sqlite"))
    expect(database.size).toBeGreaterThan(0)

    app = await electron.launch(launchOptions)
    expect(await app.evaluate(({ app: runtimeApp }) => runtimeApp.isPackaged)).toBe(true)
    const restartedWindow = await app.firstWindow()
    const persistedSettings = JSON.parse(
      await readFile(join(xdgConfigHome, "diffdash", "settings.json"), "utf8"),
    ) as unknown
    expect(persistedSettings).toEqual(
      expect.objectContaining({
        routes: { walkthrough: "fixture-agent", reviewThread: "fixture-agent" },
        models: expect.objectContaining({ "fixture-agent": "fixture-model" }),
      }),
    )
    expect(await readFile(gitLog, "utf8")).toContain("clone --bare --")

    expect(
      await restartedWindow.evaluate(async () => {
        const appState = await globalThis.window.diffDash.appState.get()
        const settings = await globalThis.window.diffDash.settings.get()
        const repositories = await globalThis.window.diffDash.repositories.list()
        return {
          onboardingCompleted: appState.onboardingCompleted,
          routes: settings.routes,
          repositories: repositories.map((repository) => ({
            provider: repository.provider,
            owner: repository.owner,
            name: repository.name,
            isFavorite: repository.isFavorite,
          })),
        }
      }),
    ).toEqual({
      onboardingCompleted: true,
      routes: { walkthrough: "fixture-agent", reviewThread: "fixture-agent" },
      repositories: [
        {
          provider: "fixture",
          owner: "platform/backend",
          name: "service",
          isFavorite: true,
        },
      ],
    })
    const reopenedReview = restartedWindow.getByRole("button", {
      name: /Open (?:requested review|MR) #73/,
    })
    await expect(reopenedReview).toBeVisible()
    await reopenedReview.click()
    await restartedWindow.getByRole("button", { name: "src/fixture.ts:1 · old" }).click()
    await expect(restartedWindow.getByText("Fixture review response")).toBeVisible()
  } finally {
    await app.close().catch(() => undefined)
  }
})

type PackagedAppPaths = {
  readonly executable: string
  readonly resources: string
  readonly cli: string | null
  readonly icon: string | null
}

const packagedAppPaths = (): PackagedAppPaths => {
  const dist = join(process.cwd(), "../desktop/dist")
  if (process.platform === "darwin") {
    const output = process.arch === "arm64" ? "mac-arm64" : "mac"
    const contents = join(dist, output, "DiffDash.app", "Contents")
    return {
      executable: join(contents, "MacOS", "DiffDash"),
      resources: join(contents, "Resources"),
      cli: join(contents, "Resources", "bin", "diffdash"),
      icon: join(contents, "Resources", "icon.icns"),
    }
  }
  if (process.platform === "linux") {
    const output = process.arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked"
    const root = join(dist, output)
    return {
      executable: join(root, "diffdash-desktop"),
      resources: join(root, "resources"),
      cli: join(root, "resources", "bin", "diffdash"),
      icon: null,
    }
  }
  if (process.platform === "win32") {
    const output = process.arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked"
    const root = join(dist, output)
    return {
      executable: join(root, "DiffDash.exe"),
      resources: join(root, "resources"),
      cli: null,
      icon: null,
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
    ...(packaged.icon === null ? [] : [assertFile(packaged.icon)]),
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
  execFileSync(realGitPath, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

const realGitPath = execFileSync("/usr/bin/env", ["sh", "-c", "command -v git"], {
  encoding: "utf8",
}).trim()

const installFixtureRepository = async (source: string, remote: string) => {
  await mkdir(join(source, "src"), { recursive: true })
  execGit(source, "init")
  await writeFile(join(source, "src", "fixture.ts"), "old fixture\n", "utf8")
  execGit(source, "add", ".")
  commit(source, "fixture base")
  const base = execGit(source, "rev-parse", "HEAD")
  await writeFile(join(source, "src", "fixture.ts"), "new fixture\n", "utf8")
  execGit(source, "add", ".")
  commit(source, "fixture head")
  const head = execGit(source, "rev-parse", "HEAD")
  execGit(process.cwd(), "clone", "--bare", source, remote)
  execGit(source, "push", remote, `HEAD:refs/merge-requests/73/head`)
  return { base, head }
}

const commit = (cwd: string, message: string) =>
  execGit(
    cwd,
    "-c",
    "user.name=DiffDash Test",
    "-c",
    "user.email=test@diffdash.dev",
    "commit",
    "-m",
    message,
  )

const installPackagedFakeCli = async (directory: string) => {
  await Promise.all([
    writeExecutable(join(directory, "git"), fakeGitScript),
    writeExecutable(join(directory, "gh"), fakeGhScript),
    writeExecutable(join(directory, "codex"), fakeVersionScript("codex")),
    writeExecutable(join(directory, "claude"), fakeVersionScript("claude")),
    writeExecutable(join(directory, "opencode"), fakeVersionScript("opencode")),
  ])
}

const writeExecutable = async (path: string, content: string) => {
  await writeFile(path, content, "utf8")
  await chmod(path, 0o755)
}

const fakeVersionScript = (name: string) => `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' '${name} 1.0.0'
  exit 0
fi
printf '%s\\n' 'Unhandled fake ${name} call' >&2
exit 1
`

const fakeGitScript = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "\${FAKE_GIT_LOG:?}"
exec "\${REAL_GIT_PATH:?}" "$@"
`

const fakeGhScript = `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' 'gh version 2.76.1'
  exit 0
fi
if [ "\${1:-}" = "auth" ] && [ "\${2:-}" = "status" ]; then
  printf '%s\\n' 'Logged in to github.com'
  exit 0
fi
if [ "\${1:-}" = "search" ] && [ "\${2:-}" = "repos" ] && [ "\${3:-}" = "--help" ]; then
  printf '%s\\n' 'Search for repositories on GitHub.'
  exit 0
fi
if [ "\${1:-}" = "api" ] && [ "\${2:-}" = "graphql" ]; then
  printf '%s\\n' '{"data":{"search":{"nodes":[]}}}'
  exit 0
fi
if [ "\${1:-}" = "search" ] || [ "\${1:-}" = "pr" ]; then
  printf '%s\\n' '[]'
  exit 0
fi
printf '%s\\n' 'Unhandled fake gh call' >&2
exit 1
`
