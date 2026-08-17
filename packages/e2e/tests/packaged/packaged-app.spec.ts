import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { delimiter, join, resolve as resolvePath, sep } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"
import { installDiffDashE2eApi } from "../helpers/diffdash-bridge"
import { installExecutableFixture, prependExecutablePath } from "../helpers/executable-fixture"

test("FUN-141 AC: verifies final packaged composition and provider persistence", async ({
  browserName: _browserName,
}, testInfo) => {
  testInfo.setTimeout(90_000)
  const packaged = packagedAppPaths()
  await verifyPackagedResources(packaged)

  const fakeBin = testInfo.outputPath("fake-bin")
  const home = testInfo.outputPath("home")
  const openCodeBin = join(home, ".opencode", "bin")
  const gitLog = join(home, ".diffdash-e2e-git.log")
  const sourceRepo = testInfo.outputPath("source-repo")
  const remoteRepo = testInfo.outputPath("fixture.git")
  const worktreePool = testInfo.outputPath("worktree-pool")
  const userData = testInfo.outputPath("user-data")
  const xdgConfigHome = testInfo.outputPath("xdg-config")
  await Promise.all([
    mkdir(fakeBin, { recursive: true }),
    mkdir(openCodeBin, { recursive: true }),
    mkdir(userData, { recursive: true }),
    mkdir(join(xdgConfigHome, "diffdash"), { recursive: true }),
  ])
  await installPackagedFakeCli(fakeBin, openCodeBin)
  const revisions = await installFixtureRepository(sourceRepo, remoteRepo)
  execGit(
    home,
    "config",
    "--file",
    join(home, ".gitconfig"),
    `url.${remoteRepo}.insteadOf`,
    "https://git.fixture.test/platform/backend/service",
  )
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
      themes: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
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
      HOME: home,
      PATH: prependExecutablePath(fakeBin, process.env.PATH),
      REAL_GIT_PATH: realGitPath,
      XDG_CONFIG_HOME: xdgConfigHome,
    },
  }
  const forcedCoreHost = readForcedPackagedCoreHost()
  let forcedCoreProcessIds: ReadonlyArray<number> = []
  let app = await electron.launch(launchOptions)

  try {
    if (forcedCoreHost !== null) {
      const rootPid = app.process().pid
      if (rootPid === undefined) throw new Error("Packaged Electron process has no PID")
      await expect
        .poll(() => coreHostProcessIds(rootPid, forcedCoreHost).length, {
          timeout: 10_000,
        })
        .toBeGreaterThan(0)
      forcedCoreProcessIds = coreHostProcessIds(rootPid, forcedCoreHost)
    }
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
    await window.evaluate(installDiffDashE2eApi)
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
        const providers = await globalThis.window.diffDashForE2e.providers.list()
        const catalog = await globalThis.window.diffDashForE2e.agentProviders.getCatalog()
        const settings = await globalThis.window.diffDashForE2e.settings.get()
        const fixtureGit = providers.find(({ id }) => id === "fixture")
        if (fixtureGit === undefined) throw new Error("Fixture Git provider was not registered")
        const results =
          await globalThis.window.diffDashForE2e.hostedRepositories.searchRepositories({
            providerId: fixtureGit.id,
            query: "service",
            namespaces: [],
          })
        const result = results[0]
        if (result === undefined) throw new Error("Fixture repository was not discovered")
        await globalThis.window.diffDashForE2e.repositories.favoriteRemote(result)
        const repositories = await globalThis.window.diffDashForE2e.repositories.list()
        const updater = await globalThis.window.diffDashForE2e.updates.getState()
        return {
          agent: catalog.providers.find(({ id }) => id === "fixture-agent"),
          codeThemes: settings.codeThemes,
          diffViewMode: settings.diffViewMode,
          git: fixtureGit,
          claude: catalog.providers.find(({ id }) => id === "claude"),
          codex: catalog.providers.find(({ id }) => id === "codex"),
          opencode: catalog.providers.find(({ id }) => id === "opencode"),
          repository: repositories.find(
            ({ source }) => source._tag === "hosted" && source.locator.providerId === "fixture",
          ),
          selections: settings.selections,
          themes: settings.themes,
          updater,
        }
      }),
    ).toEqual({
      agent: expect.objectContaining({
        id: "fixture-agent",
        capabilities: expect.objectContaining({
          "review-thread": expect.objectContaining({ _tag: "Ready" }),
        }),
        defaults: { reviewThreadModel: "fixture-model", walkthroughModel: "fixture-model" },
      }),
      codeThemes: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
      diffViewMode: "auto",
      git: expect.objectContaining({
        id: "fixture",
        displayName: "Fixture Forge",
        capabilities: expect.objectContaining({ reviewDecisions: false }),
      }),
      claude: expect.objectContaining({
        id: "claude",
        capabilities: {
          walkthrough: expect.objectContaining({ _tag: "Ready" }),
          "review-thread": expect.objectContaining({ _tag: "Ready" }),
        },
      }),
      codex: expect.objectContaining({
        id: "codex",
        capabilities: {
          walkthrough: expect.objectContaining({ _tag: "Ready" }),
          "review-thread": expect.objectContaining({ _tag: "Ready" }),
        },
      }),
      opencode: expect.objectContaining({
        id: "opencode",
        capabilities: {
          walkthrough: expect.objectContaining({ _tag: "Ready" }),
          "review-thread": expect.objectContaining({ _tag: "Ready" }),
        },
      }),
      repository: expect.objectContaining({
        source: {
          _tag: "hosted",
          locator: {
            providerId: "fixture",
            namespace: "platform/backend",
            name: "service",
          },
        },
        isFavorite: true,
      }),
      selections: {
        walkthrough: {
          _tag: "Pinned",
          providerId: "fixture-agent",
          modelId: "fixture-model",
        },
        "review-thread": {
          _tag: "Pinned",
          providerId: "fixture-agent",
          modelId: "fixture-model",
        },
      },
      themes: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
      updater: expect.not.objectContaining({ reason: "development" }),
    })

    await window.getByRole("combobox", { name: "Hosted provider" }).selectOption({
      label: "Fixture Forge",
    })
    await window.getByPlaceholder("Search local and hosted projects").fill("service")
    const fixtureProject = window.getByRole("button", {
      name: "platform/backend/service Hosted",
      exact: true,
    })
    await expect(fixtureProject).toBeVisible()
    await fixtureProject.click()
    await window.evaluate(
      async ({ localPath }) =>
        Reflect.apply(globalThis.window.diffDashForE2e.repositories.link, undefined, [
          {
            repository: {
              providerId: "fixture",
              namespace: "platform/backend",
              name: "service",
            },
            localPath,
          },
        ]),
      { localPath: sourceRepo },
    )

    const fixtureReview = window.getByRole("button", {
      name: /Open review #73: Fixture merge request flow/,
    })
    await expect(fixtureReview).toBeVisible()
    await fixtureReview.click()
    await expect(window.locator("[data-review-editor-header]")).toContainText(
      "Fixture merge request flow",
    )
    await expect(window.getByText("src/fixture.ts").first()).toBeVisible()

    const fixtureDiffCard = window.locator('[data-diff-card-path="src/fixture.ts"]')
    await expect(fixtureDiffCard).toHaveAttribute("data-diff-render-mode", "highlighted")
    const addedLine = fixtureDiffCard
      .locator('diffs-container [data-content] > [data-line-type="change-addition"]')
      .filter({ hasText: "new fixture" })
      .first()
    await expect(addedLine).toBeVisible()
    const lineIndex = await addedLine.getAttribute("data-line-index")
    if (lineIndex === null) throw new Error("Fixture addition line has no rendered index")
    const gutterNumber = fixtureDiffCard
      .locator(
        `diffs-container [data-line-type="change-addition"][data-line-index="${lineIndex}"][data-column-number]`,
      )
      .last()
    const composer = window.getByRole("textbox", { name: "Thread message" })
    await expect
      .poll(
        async () => {
          if (await composer.isVisible()) return true
          await gutterNumber.evaluate((gutter) => {
            gutter.dispatchEvent(
              new PointerEvent("pointermove", {
                bubbles: true,
                composed: true,
                pointerType: "mouse",
              }),
            )
            const utility = gutter.querySelector("[data-utility-button]")
            if (utility === null) return
            const init = {
              bubbles: true,
              button: 0,
              composed: true,
              pointerId: 1,
              pointerType: "mouse",
            }
            utility.dispatchEvent(new PointerEvent("pointerdown", init))
            document.dispatchEvent(new PointerEvent("pointerup", init))
          })
          return composer.isVisible()
        },
        { timeout: 15_000 },
      )
      .toBe(true)
    await composer.fill("Review fixture line")
    await window.getByRole("button", { name: "Comment" }).click()
    await expect(window.getByText("Fixture review response")).toBeVisible({ timeout: 20_000 })

    await app.close()
    if (forcedCoreHost !== null) {
      await expect
        .poll(() => forcedCoreProcessIds.some(processIsAlive), { timeout: 5_000 })
        .toBe(false)
    }
    await expect.poll(() => databaseOwnershipIsReleased(userData), { timeout: 5_000 }).toBe(true)
    const database = await stat(join(userData, "diffdash.sqlite"))
    expect(database.size).toBeGreaterThan(0)

    app = await electron.launch(launchOptions)
    expect(await app.evaluate(({ app: runtimeApp }) => runtimeApp.isPackaged)).toBe(true)
    const restartedWindow = await app.firstWindow()
    await restartedWindow.evaluate(installDiffDashE2eApi)
    const persistedSettings = JSON.parse(
      await readFile(join(xdgConfigHome, "diffdash", "settings.json"), "utf8"),
    ) as unknown
    expect(persistedSettings).toEqual(
      expect.objectContaining({
        diffViewMode: "auto",
        layout: {
          review: { contextWidth: 304, threadDetailWidth: 432 },
        },
        version: 8,
        themes: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
        codeThemes: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
        selections: {
          walkthrough: {
            _tag: "Pinned",
            providerId: "fixture-agent",
            modelId: "fixture-model",
          },
          "review-thread": {
            _tag: "Pinned",
            providerId: "fixture-agent",
            modelId: "fixture-model",
          },
        },
      }),
    )
    expect(await readFile(gitLog, "utf8")).toContain("clone --bare --")

    expect(
      await restartedWindow.evaluate(async () => {
        const appState = await globalThis.window.diffDashForE2e.appState.get()
        const settings = await globalThis.window.diffDashForE2e.settings.get()
        const repositories = await globalThis.window.diffDashForE2e.repositories.list()
        return {
          onboardingCompleted: appState.onboardingCompleted,
          codeThemes: settings.codeThemes,
          diffViewMode: settings.diffViewMode,
          selections: settings.selections,
          repositories: repositories.map((repository) => ({
            provider:
              repository.source._tag === "hosted"
                ? repository.source.locator.providerId
                : undefined,
            owner:
              repository.source._tag === "hosted" ? repository.source.locator.namespace : undefined,
            name: repository.source._tag === "hosted" ? repository.source.locator.name : undefined,
            isFavorite: repository.isFavorite,
          })),
        }
      }),
    ).toEqual({
      onboardingCompleted: true,
      codeThemes: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
      diffViewMode: "auto",
      selections: {
        walkthrough: {
          _tag: "Pinned",
          providerId: "fixture-agent",
          modelId: "fixture-model",
        },
        "review-thread": {
          _tag: "Pinned",
          providerId: "fixture-agent",
          modelId: "fixture-model",
        },
      },
      repositories: [
        {
          provider: "fixture",
          owner: "platform/backend",
          name: "service",
          isFavorite: true,
        },
      ],
    })
    const reopenedProject = restartedWindow.getByRole("button", {
      name: "Open project platform/backend/service",
    })
    await expect(reopenedProject).toBeVisible()
    await reopenedProject.click()
    await expect(restartedWindow.locator("[data-review-editor-header]")).toContainText(
      "Fixture merge request flow",
    )
    const persistedReviewDisclosure = restartedWindow.getByRole("button", {
      name: "Review on R1",
    })
    await expect(persistedReviewDisclosure).toBeVisible()
    await persistedReviewDisclosure.click()
    await expect(restartedWindow.getByText("Fixture review response")).toBeVisible()

    const restartedRootPid = app.process().pid
    const restartedCoreProcessIds =
      forcedCoreHost === null || restartedRootPid === undefined
        ? []
        : coreHostProcessIds(restartedRootPid, forcedCoreHost)
    await app.close()
    if (forcedCoreHost !== null) {
      expect(restartedRootPid).toBeDefined()
      expect(restartedCoreProcessIds.length).toBeGreaterThan(0)
      await expect
        .poll(() => restartedCoreProcessIds.some(processIsAlive), { timeout: 5_000 })
        .toBe(false)
    }
    await expect.poll(() => databaseOwnershipIsReleased(userData), { timeout: 5_000 }).toBe(true)
    app = await electron.launch({
      ...launchOptions,
      args: [
        ...launchOptions.args,
        `--diffdash-cli-v1=${sourceRepo}`,
        "--",
        "compare",
        revisions.base,
        revisions.head,
      ],
    })
    const comparisonWindow = await app.firstWindow()
    await expect(comparisonWindow.locator("[data-review-editor-header]")).toContainText(
      `${revisions.base}...${revisions.head}`,
      { timeout: 20_000 },
    )
    await expect(comparisonWindow.getByText("src/fixture.ts").first()).toBeVisible({
      timeout: 20_000,
    })
  } finally {
    await app.close().catch(() => undefined)
  }
})

const readForcedPackagedCoreHost = (): "bun" | "utility" | null => {
  if (process.env.DIFFDASH_E2E_PACKAGED_FORCED_CORE_HOST_GATE !== "1") return null
  const host = process.env.DIFFDASH_E2E_CORE_HOST
  if (host === "bun" || host === "utility") return host
  throw new Error("The packaged Core host gate requires DIFFDASH_E2E_CORE_HOST=bun or utility")
}

const coreHostProcessIds = (rootPid: number, host: "bun" | "utility"): ReadonlyArray<number> => {
  if (process.platform === "win32") {
    throw new Error("Packaged Core host process verification is not implemented on Windows")
  }
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line)
      return match === null
        ? []
        : [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] ?? "" }]
    })
  const descendants = new Set([rootPid])
  let discovered = true
  while (discovered) {
    discovered = false
    for (const row of rows) {
      if (descendants.has(row.parentPid) && !descendants.has(row.pid)) {
        descendants.add(row.pid)
        discovered = true
      }
    }
  }
  return rows.flatMap((row) => {
    if (!descendants.has(row.pid) || row.pid === rootPid) return []
    const matches =
      host === "bun"
        ? row.command.includes("core-bun.mjs") && /(?:^|[\\/\s])bun(?:\s|$)/u.test(row.command)
        : row.command.includes("--type=utility") && row.command.includes("node.mojom.NodeService")
    return matches ? [row.pid] : []
  })
}

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

const databaseOwnershipIsReleased = async (userData: string): Promise<boolean> => {
  try {
    await access(join(userData, "diffdash.sqlite.owner"))
    return false
  } catch {
    return true
  }
}

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
  const coreDirectory = join(packaged.resources, "core")
  const coreEntrypoint = join(coreDirectory, "core.mjs")
  const coreManifest = join(coreDirectory, "manifest.json")
  await Promise.all([
    assertFile(packaged.executable),
    assertFile(join(packaged.resources, "app.asar")),
    assertFile(join(packaged.resources, "app-update.yml")),
    assertFile(coreEntrypoint),
    assertFile(coreManifest),
    ...(packaged.cli === null ? [] : [assertFile(packaged.cli)]),
    ...(packaged.icon === null ? [] : [assertFile(packaged.icon)]),
  ])
  if (packaged.cli !== null) await access(packaged.cli, constants.X_OK)

  const manifest = parseCoreArtifactManifest(await readFile(coreManifest, "utf8"))
  const entrypoint = await readFile(coreEntrypoint)
  const bunEntrypointPath = join(coreDirectory, manifest.bunEntrypoint)
  await assertFile(bunEntrypointPath)
  const bunEntrypoint = await readFile(bunEntrypointPath)
  const version = await desktopPackageVersion()
  expect(manifest.buildId).toBe(
    `core-${version}-e2e-${process.platform}-${process.arch}-${manifest.entrypointSha256.slice(0, 40)}`,
  )
  expect(manifest.entrypoint).toBe("core.mjs")
  expect(manifest.entrypointSha256).toBe(createHash("sha256").update(entrypoint).digest("hex"))
  expect(manifest.bunEntrypointSha256).toBe(
    createHash("sha256").update(bunEntrypoint).digest("hex"),
  )
  expect(resolvePath(coreDirectory).startsWith(`${resolvePath(packaged.resources)}${sep}`)).toBe(
    true,
  )
  expect(resolvePath(coreDirectory)).not.toContain("app.asar")

  const updateConfig = await readFile(join(packaged.resources, "app-update.yml"), "utf8")
  expect(updateConfig).toMatch(/^provider:\s*generic\s*$/m)
  expect(updateConfig).toMatch(/^url:\s*https:\/\/download\.usediffdash\.com\/updates\/stable\s*$/m)
  expect(updateConfig).toMatch(/^updaterCacheDirName:\s*\S+\s*$/m)
}

const desktopPackageVersion = async (): Promise<string> => {
  const value: unknown = JSON.parse(
    await readFile(join(process.cwd(), "../desktop/package.json"), "utf8"),
  )
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    value.version.length === 0
  ) {
    throw new Error("Desktop package version is invalid")
  }
  return value.version
}

const parseCoreArtifactManifest = (text: string) => {
  const value: unknown = JSON.parse(text)
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("buildId" in value) ||
    typeof value.buildId !== "string" ||
    !("entrypoint" in value) ||
    value.entrypoint !== "core.mjs" ||
    !("entrypointSha256" in value) ||
    typeof value.entrypointSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.entrypointSha256) ||
    !("runtime" in value) ||
    typeof value.runtime !== "object" ||
    value.runtime === null ||
    !("utility" in value.runtime) ||
    value.runtime.utility !== true ||
    !("bun" in value.runtime) ||
    typeof value.runtime.bun !== "object" ||
    value.runtime.bun === null ||
    !("minimumVersion" in value.runtime.bun) ||
    typeof value.runtime.bun.minimumVersion !== "string" ||
    !("architecture" in value.runtime.bun) ||
    typeof value.runtime.bun.architecture !== "string" ||
    !("entrypoint" in value.runtime.bun) ||
    value.runtime.bun.entrypoint !== "core-bun.mjs" ||
    !("entrypointSha256" in value.runtime.bun) ||
    typeof value.runtime.bun.entrypointSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.runtime.bun.entrypointSha256)
  ) {
    throw new Error("Packaged Core manifest is invalid.")
  }
  return {
    buildId: value.buildId,
    entrypoint: value.entrypoint,
    entrypointSha256: value.entrypointSha256,
    bunEntrypoint: value.runtime.bun.entrypoint,
    bunEntrypointSha256: value.runtime.bun.entrypointSha256,
  }
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

const realGitPath = resolveExecutable("git")

function resolveExecutable(command: string) {
  const extensions =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")]
      : [""]
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const candidate = resolvePath(directory, `${command}${extension}`)
      try {
        execFileSync(candidate, ["--version"], { stdio: "ignore" })
        return candidate
      } catch {
        // Try the next executable search candidate.
      }
    }
  }
  throw new Error(`Could not resolve ${command} from PATH.`)
}

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
  execGit(source, "remote", "add", "origin", "https://git.fixture.test/platform/backend/service")
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
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  )

const installPackagedFakeCli = async (directory: string, openCodeDirectory: string) => {
  await Promise.all([
    installExecutableFixture(directory, "git", fakeGitScript),
    installExecutableFixture(directory, "gh", fakeGhScript),
    installExecutableFixture(directory, "codex", fakeVersionScript("codex")),
    installExecutableFixture(directory, "claude", fakeVersionScript("claude")),
    installExecutableFixture(openCodeDirectory, "opencode", fakeVersionScript("opencode")),
  ])
}

const fakeVersionScript = (name: string) => `const args = process.argv.slice(2)
if (args[0] === "--version") {
  console.log("${name} 1.0.0")
  process.exit(0)
}
console.error("Unhandled fake ${name} call")
process.exit(1)
`

const fakeGitScript = `import { appendFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
const args = process.argv.slice(2)
const logPath = process.env.FAKE_GIT_LOG ?? (process.env.HOME ? join(process.env.HOME, ".diffdash-e2e-git.log") : null)
if (logPath) appendFileSync(logPath, args.join(" ") + "\\n")
const result = spawnSync(process.env.REAL_GIT_PATH ?? ${JSON.stringify(realGitPath)}, args, {
  env: process.env,
  stdio: "inherit"
})
process.exit(result.status ?? 1)
`

const fakeGhScript = `const args = process.argv.slice(2)
if (args[0] === "--version") console.log("gh version 2.76.1")
else if (args[0] === "auth" && args[1] === "status") console.log("Logged in to github.com")
else if (args[0] === "search" && args[1] === "repos" && args[2] === "--help") console.log("Search for repositories on GitHub.")
else if (args[0] === "api" && args[1] === "graphql") console.log(JSON.stringify({ data: { search: { nodes: [] } } }))
else if (args[0] === "search" || args[0] === "pr") console.log("[]")
else {
  console.error("Unhandled fake gh call")
  process.exit(1)
}
`
