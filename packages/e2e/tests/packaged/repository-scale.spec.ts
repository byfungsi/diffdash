import { execFileSync } from "node:child_process"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test"
import {
  REPOSITORY_SCALE_MEASUREMENT_POLICY,
  captureProcessTree,
  measureManagedStorage,
  measureProcessTree,
  type ProcessTreeMeasurement,
} from "../../../../tools/repository-scale/src/process-metrics.mjs"
import { installDiffDashE2eApi } from "../helpers/diffdash-bridge"
import {
  coreHostProcessIds,
  packagedE2eExecutable,
  processIsAlive,
  type RepositoryScaleCoreHost,
} from "../helpers/packaged-repository-scale"

type FixtureManifest = {
  readonly id: string
  readonly baseSha: string
  readonly headSha: string
  readonly profile: { readonly fileCount: number }
  readonly scale: { readonly changedFiles: number; readonly addedRows: number }
  readonly scenarios: { readonly broadSearch: string }
}

test("FUN-214/FUN-240 deterministic packaged repository-scale orchestration", async () => {
  const configuration = await readConfiguration()
  test.setTimeout(configuration.profile === "full" ? 20 * 60_000 : 3 * 60_000)
  const userData = join(dirname(configuration.rawReport), "user-data")
  const xdgConfigHome = join(dirname(configuration.rawReport), "xdg-config")
  const managedRoot = join(userData, "managed")
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(managedRoot, { recursive: true }),
    mkdir(join(xdgConfigHome, "diffdash"), { recursive: true }),
  ])
  await writeFile(
    join(xdgConfigHome, "diffdash", "state.json"),
    `${JSON.stringify({ onboardingCompleted: true })}\n`,
  )

  const executable = packagedE2eExecutable()
  const environment = {
    ...process.env,
    DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
    DIFFDASH_E2E_CORE_HOST: configuration.host,
    DIFFDASH_E2E_DISABLE_UPDATES: "1",
    DIFFDASH_E2E_FAKE_AGENT_PROVIDER: "1",
    DIFFDASH_E2E_HIDDEN: "1",
    XDG_CONFIG_HOME: xdgConfigHome,
  }
  const launchArguments = [`--user-data-dir=${userData}`]
  const report = {
    version: 1,
    profile: configuration.profile,
    host: configuration.host,
    session: configuration.session,
    fixture: {
      id: configuration.fixture.id,
      baseSha: configuration.fixture.baseSha,
      headSha: configuration.fixture.headSha,
      changedFiles: configuration.fixture.scale.changedFiles,
      addedRows: configuration.fixture.scale.addedRows,
    },
    gates: {
      packaged: false,
      hostSelected: false,
      exactComparison: false,
      firstRange: false,
      farTarget: false,
      broadSearch: false,
      mountedRowsBounded: false,
      rapidSwitches: false,
      coreRestart: false,
      processTeardown: false,
    },
    observations: { maximumMountedRows: 0, switchCount: 0 },
    blocked: [
      {
        scenario: "foreground disposal completion",
        reason: "No preload API exposes repository-comparison session disposal completion.",
      },
      {
        scenario: "rescan cancellation counters",
        reason:
          "No preload API exposes progressive queue cancellation or rescan lifecycle counters.",
      },
    ],
    switchReports: [] as Array<
      ProcessTreeMeasurement & {
        readonly scenario: "pathological" | "small"
        readonly storage: {
          readonly before: Awaited<ReturnType<typeof measureManagedStorage>>
          readonly after: Awaited<ReturnType<typeof measureManagedStorage>>
          readonly databaseDeltaBytes: number
          readonly managedDeltaBytes: number
          readonly freeSpaceDeltaBytes: number
        }
      }
    >,
  }
  let app: ElectronApplication | null = null
  let observedCoreProcessIds: readonly number[] = []

  try {
    app = await electron.launch({
      executablePath: executable,
      args: [
        ...launchArguments,
        `--diffdash-cli-v1=${configuration.fixtureRepository}`,
        "--",
        "compare",
        configuration.fixture.baseSha,
        configuration.fixture.headSha,
      ],
      env: environment,
    })
    report.gates.packaged = await app.evaluate(({ app: runtimeApp }) => runtimeApp.isPackaged)
    const rootPid = app.process().pid
    if (rootPid === undefined) throw new Error("Packaged Electron process has no PID")
    await expect
      .poll(() => coreHostProcessIds(rootPid, configuration.host).length, { timeout: 15_000 })
      .toBeGreaterThan(0)
    observedCoreProcessIds = coreHostProcessIds(rootPid, configuration.host)
    report.gates.hostSelected = observedCoreProcessIds.length > 0

    const window = await app.firstWindow()
    await window.evaluate(installDiffDashE2eApi)
    await waitForComparison(window, configuration.fixture)
    report.gates.exactComparison = true
    const canvas = window.locator("[data-review-global-canvas]")
    await expect(canvas).toBeVisible({ timeout: 90_000 })
    await expect(window.locator('[data-progressive-range-start="0"]').first()).toBeVisible()
    report.gates.firstRange = true
    report.observations.maximumMountedRows = Math.max(
      report.observations.maximumMountedRows,
      Number((await canvas.getAttribute("data-review-mounted-rows")) ?? 0),
    )
    expect(report.observations.maximumMountedRows).toBeLessThanOrEqual(1_000)
    report.gates.mountedRowsBounded = true

    const farPath = fixturePath(configuration.fixture.profile.fileCount - 1)
    await window.keyboard.press("ControlOrMeta+k")
    await window.getByPlaceholder("Search files").fill(farPath)
    await window.getByRole("button", { name: new RegExp(escapeRegex(farPath), "u") }).click()
    const farCard = window.locator(`[data-diff-card-path="${farPath}"]`)
    await expect(farCard).toBeVisible({ timeout: 60_000 })
    await expect(window.locator("[data-review-diff-scroll-container]")).toHaveAttribute(
      "data-review-navigation-phase",
      "idle",
    )
    report.gates.farTarget = true

    await window.keyboard.press("ControlOrMeta+f")
    await window.getByRole("searchbox", { name: "Search review diff" }).fill("broad-search-match")
    await expect(window.locator("[data-review-search-toolbar]")).not.toContainText("0 / 0", {
      timeout: 60_000,
    })
    report.gates.broadSearch = true
    await window.keyboard.press("Escape")

    await window.keyboard.press("ControlOrMeta+r")
    await expect(window.locator("[data-review-editor-header]")).toContainText(
      `${configuration.fixture.baseSha}...${configuration.fixture.headSha}`,
      { timeout: 90_000 },
    )
    await expect(window.locator("[data-review-global-canvas]")).toBeVisible()

    const switches = configuration.profile === "full" ? 10 : 4
    const exerciseSwitch = async (index: number): Promise<void> => {
      if (index >= switches) return
      const selected =
        index % 2 === 0
          ? { manifest: configuration.fixture, repository: configuration.fixtureRepository }
          : {
              manifest: configuration.smallFixture,
              repository: configuration.smallFixtureRepository,
            }
      if (index > 0) {
        forwardComparison(executable, launchArguments, environment, selected)
        await waitForComparison(window, selected.manifest)
        await expect(window.locator("[data-review-global-canvas]")).toBeVisible({ timeout: 90_000 })
      }
      report.observations.switchCount = index + 1
      if (configuration.profile === "full") {
        const storageBefore = await measureManagedStorage({
          databasePath: join(userData, "diffdash.sqlite"),
          managedRoot,
        })
        const measurement = await measureProcessTree({
          rootPid,
          ...REPOSITORY_SCALE_MEASUREMENT_POLICY,
        })
        const storageAfter = await measureManagedStorage({
          databasePath: join(userData, "diffdash.sqlite"),
          managedRoot,
        })
        report.switchReports.push({
          ...measurement,
          scenario: index % 2 === 0 ? "pathological" : "small",
          storage: {
            before: storageBefore,
            after: storageAfter,
            databaseDeltaBytes: storageAfter.databaseBytes - storageBefore.databaseBytes,
            managedDeltaBytes: storageAfter.managedBytes - storageBefore.managedBytes,
            freeSpaceDeltaBytes:
              storageAfter.filesystemFreeBytes - storageBefore.filesystemFreeBytes,
          },
        })
      } else if (index === switches - 1) {
        await captureProcessTree(rootPid)
      }
      await exerciseSwitch(index + 1)
    }
    await exerciseSwitch(0)
    report.gates.rapidSwitches = report.observations.switchCount === switches

    const previousCorePid = coreHostProcessIds(rootPid, configuration.host)[0]
    if (previousCorePid === undefined) throw new Error("Selected Core host process disappeared")
    process.kill(previousCorePid, "SIGKILL")
    await expect
      .poll(
        () =>
          coreHostProcessIds(rootPid, configuration.host).some((pid) => pid !== previousCorePid),
        { timeout: 20_000 },
      )
      .toBe(true)
    await expect
      .poll(() =>
        window.evaluate(
          async () => (await globalThis.window.diffDashForE2e.appState.get()).onboardingCompleted,
        ),
      )
      .toBe(true)
    report.gates.coreRestart = true
    observedCoreProcessIds = [
      ...observedCoreProcessIds,
      ...coreHostProcessIds(rootPid, configuration.host),
    ]
  } finally {
    await app?.close().catch(() => undefined)
    report.gates.processTeardown = await waitForProcessesToExit(observedCoreProcessIds)
    await mkdir(dirname(configuration.rawReport), { recursive: true })
    await writeFile(configuration.rawReport, `${JSON.stringify(report, null, 2)}\n`)
  }

  expect(report.gates).toEqual({
    packaged: true,
    hostSelected: true,
    exactComparison: true,
    firstRange: true,
    farTarget: true,
    broadSearch: true,
    mountedRowsBounded: true,
    rapidSwitches: true,
    coreRestart: true,
    processTeardown: true,
  })
})

type RepositoryScaleConfiguration = {
  readonly host: RepositoryScaleCoreHost
  readonly profile: "smoke" | "full"
  readonly session: string
  readonly rawReport: string
  readonly fixture: FixtureManifest
  readonly fixtureRepository: string
  readonly smallFixture: FixtureManifest
  readonly smallFixtureRepository: string
}

const readConfiguration = async (): Promise<RepositoryScaleConfiguration> => {
  const host = requiredEnvironment("DIFFDASH_REPOSITORY_SCALE_HOST")
  if (host !== "bun" && host !== "utility") throw new Error("Repository-scale host is invalid")
  const profile = requiredEnvironment("DIFFDASH_REPOSITORY_SCALE_PROFILE")
  if (profile !== "smoke" && profile !== "full")
    throw new Error("Repository-scale profile is invalid")
  const manifestPath = requiredEnvironment("DIFFDASH_REPOSITORY_SCALE_MANIFEST")
  const smallManifestPath = requiredEnvironment("DIFFDASH_REPOSITORY_SCALE_SMALL_MANIFEST")
  return {
    host,
    profile,
    session: requiredEnvironment("DIFFDASH_REPOSITORY_SCALE_SESSION"),
    rawReport: requiredEnvironment("DIFFDASH_REPOSITORY_SCALE_RAW_REPORT"),
    fixture: JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest,
    fixtureRepository: join(dirname(manifestPath), "repository"),
    smallFixture: JSON.parse(await readFile(smallManifestPath, "utf8")) as FixtureManifest,
    smallFixtureRepository: join(dirname(smallManifestPath), "repository"),
  }
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`)
  return value
}

const waitForComparison = async (window: Page, fixture: FixtureManifest): Promise<void> => {
  await expect(window.locator("[data-review-editor-header]")).toContainText(
    `${fixture.baseSha}...${fixture.headSha}`,
    { timeout: 90_000 },
  )
  await expect(window.locator("[data-review-diff-scroll-container]")).toHaveAttribute(
    "data-review-navigation-phase",
    "idle",
  )
}

const forwardComparison = (
  executable: string,
  launchArguments: readonly string[],
  environment: NodeJS.ProcessEnv,
  fixture: { readonly manifest: FixtureManifest; readonly repository: string },
): void => {
  execFileSync(
    executable,
    [
      ...launchArguments,
      `--diffdash-cli-v1=${fixture.repository}`,
      "--",
      "compare",
      fixture.manifest.baseSha,
      fixture.manifest.headSha,
    ],
    { env: environment, stdio: "ignore", timeout: 15_000 },
  )
}

const waitForProcessesToExit = async (processIds: readonly number[]): Promise<boolean> => {
  const deadline = Date.now() + 10_000
  const check = async (): Promise<boolean> => {
    if (!processIds.some(processIsAlive)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    return check()
  }
  return check()
}

const fixturePath = (index: number): string =>
  `fixture/${String(Math.floor(index / 1_000)).padStart(3, "0")}/${String(index).padStart(5, "0")}.txt`

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
