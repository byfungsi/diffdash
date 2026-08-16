import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test"
import type {
  ReviewSessionIdentity,
  ReviewSessionSearchPublication,
} from "@diffdash/protocol/review-session"
import {
  REPOSITORY_SCALE_MEASUREMENT_POLICY,
  captureMachineProfile,
  captureProcessTree,
  measureManagedStorage,
  measureProcessTree,
  type ProcessTreeMeasurement,
} from "../../../../tools/repository-scale/src/process-metrics.mjs"
import { installDiffDashE2eApi } from "../helpers/diffdash-bridge"
import {
  coreHostProcessIds,
  packagedE2eArtifact,
  packagedE2eExecutable,
  processIsAlive,
  type RepositoryScaleCoreHost,
} from "../helpers/packaged-repository-scale"

type FixtureManifest = {
  readonly id: string
  readonly baseSha: string
  readonly headSha: string
  readonly revisionSha: string
  readonly version: number
  readonly kind: string
  readonly profile: { readonly fileCount: number }
  readonly scale: { readonly changedFiles: number; readonly addedRows: number }
  readonly scenarios: { readonly broadSearch: string }
}

type RendererMeasurement = {
  readonly domNodes: number
  readonly frameDurationMilliseconds: {
    readonly count: number
    readonly p50: number
    readonly p95: number
    readonly p99: number
    readonly maximum: number
  }
  readonly heap: { readonly usedBytes: number | null; readonly limitBytes: number | null }
  readonly livePierreHosts: number
  readonly longTasks: {
    readonly count: number
    readonly maximumDurationMilliseconds: number
    readonly totalDurationMilliseconds: number
  }
}

test("FUN-214/FUN-240 deterministic packaged repository-scale orchestration", async () => {
  const configuration = await readConfiguration()
  test.setTimeout(configuration.profile === "full" ? 20 * 60_000 : 3 * 60_000)
  const userData = join(dirname(configuration.rawReport), "user-data")
  const homeDirectory = join(dirname(configuration.rawReport), "home")
  const xdgConfigHome = join(dirname(configuration.rawReport), "xdg-config")
  const databasePath = join(userData, "diffdash.sqlite")
  const snapshotBlocksRoot = `${databasePath}.snapshot-blocks`
  const snapshotSpoolsRoot = join(snapshotBlocksRoot, "spools")
  const worktreePoolRoot = join(homeDirectory, ".diffdash", "worktree-pool")
  const remoteWorktreePoolRoot = join(homeDirectory, ".diffdash", "remote-worktree-pool")
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(homeDirectory, { recursive: true }),
    mkdir(join(xdgConfigHome, "diffdash"), { recursive: true }),
  ])
  await writeFile(
    join(xdgConfigHome, "diffdash", "state.json"),
    `${JSON.stringify({ onboardingCompleted: true })}\n`,
  )

  const executable = packagedE2eExecutable()
  const environment = {
    ...process.env,
    DIFFDASH_E2E_CORE_HOST: configuration.host,
    DIFFDASH_E2E_DISABLE_UPDATES: "1",
    DIFFDASH_E2E_FAKE_AGENT_PROVIDER: "1",
    DIFFDASH_E2E_HIDDEN: "1",
    HOME: homeDirectory,
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
    provenance: {
      diffdashCommit: configuration.diffdashCommit,
      appVersion: "",
      machineProfile: captureMachineProfile(),
      fixtureManifest: configuration.fixture,
      packaged: false,
      packagedArtifactDigest: createHash("sha256")
        .update(await readFile(packagedE2eArtifact()))
        .digest("hex"),
      core: {
        host: configuration.host,
        session: configuration.session,
        bunVersion:
          configuration.host === "bun"
            ? execFileSync("bun", ["--version"], { encoding: "utf8" }).trim()
            : null,
      },
    },
    gates: {
      packaged: false,
      hostSelected: false,
      exactComparison: false,
      firstRange: false,
      farTarget: false,
      broadSearch: false,
      mountedRowsBounded: false,
      rendererMetricsObserved: false,
      rapidSwitches: false,
      coreRestart: false,
      processTeardown: false,
      disposalComplete: false,
      rescanCancellation: false,
    },
    observations: {
      maximumMountedRows: 0,
      switchCount: 0,
      disposedSessionId: null as string | null,
      replacementSessionId: null as string | null,
      supersededOperationId: null as string | null,
      drainedOperationId: null as string | null,
      acquisitionCounters: null as null | {
        readonly started: number
        readonly superseded: number
        readonly drained: number
      },
      renderer: null as RendererMeasurement | null,
    },
    blocked: [
      {
        scenario: "foreground disposal completion",
        reason: "Packaged Core session-disposal identity has not been observed.",
      },
      {
        scenario: "rescan cancellation counters",
        reason: "Packaged Core supersession and drain identities have not been observed.",
      },
    ],
    switchReports: [] as Array<
      ProcessTreeMeasurement & {
        readonly scenario: "pathological" | "small"
        readonly appVersion: string
        readonly bunVersion: string | null
        readonly coreHost: RepositoryScaleCoreHost
        readonly coreIdentity: {
          readonly host: RepositoryScaleCoreHost
          readonly session: string
          readonly switchIndex: number
          readonly reviewSessionId: string
        }
        readonly diffdashCommit: string
        readonly disposalComplete: true
        readonly fixtureId: string
        readonly fixtureManifest: FixtureManifest
        readonly machineProfile: ReturnType<typeof captureMachineProfile>
        readonly packaged: true
        readonly packagedArtifactDigest: string
        readonly session: string
        readonly switchIndex: number
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
    const window = await app.firstWindow({ timeout: 90_000 })
    report.gates.packaged = await app.evaluate(({ app: runtimeApp }) => runtimeApp.isPackaged)
    report.provenance.packaged = report.gates.packaged
    report.provenance.appVersion = await app.evaluate(({ app: runtimeApp }) =>
      runtimeApp.getVersion(),
    )
    const rootPid = app.process().pid
    if (rootPid === undefined) throw new Error("Packaged Electron process has no PID")
    await expect
      .poll(() => coreHostProcessIds(rootPid, configuration.host).length, { timeout: 15_000 })
      .toBeGreaterThan(0)
    observedCoreProcessIds = coreHostProcessIds(rootPid, configuration.host)
    report.gates.hostSelected = observedCoreProcessIds.length > 0

    await window.evaluate(installDiffDashE2eApi)
    await startRendererMeasurement(window)
    await waitForComparison(window, configuration.fixture)
    report.gates.exactComparison = true
    const canvas = window.locator("[data-review-global-canvas]")
    await expect(canvas).toBeVisible({ timeout: 90_000 })
    const firstRange = window.locator('[data-progressive-range-start="0"]').first()
    await expect(firstRange).toBeVisible()
    const firstPierreHost = window.locator("diffs-container").first()
    await expect(firstPierreHost).toBeAttached({ timeout: 30_000 })
    report.gates.firstRange = true
    report.observations.maximumMountedRows = Math.max(
      report.observations.maximumMountedRows,
      Number((await canvas.getAttribute("data-review-mounted-rows")) ?? 0),
    )
    expect(report.observations.maximumMountedRows).toBeLessThanOrEqual(1_000)
    report.gates.mountedRowsBounded = true

    await expect
      .poll(
        async () => {
          try {
            const publications = await searchReview(window, canvas, "broad-search-match")
            return publications.some(
              (publication) => publication._tag === "Final" && publication.totalMatches > 0,
            )
              ? "match"
              : JSON.stringify(publications)
          } catch (error) {
            return String(error)
          }
        },
        { timeout: 60_000 },
      )
      .toBe("match")
    report.gates.broadSearch = true

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
    report.observations.renderer = await finishRendererMeasurement(window)
    report.gates.rendererMetricsObserved =
      report.observations.renderer.frameDurationMilliseconds.count > 0 &&
      report.observations.renderer.domNodes > 0 &&
      report.observations.renderer.livePierreHosts > 0

    await pressRendererReload(window)
    await expect(window.locator("[data-review-editor-header]")).toContainText(
      `${configuration.fixture.baseSha}...${configuration.fixture.headSha}`,
      { timeout: 90_000 },
    )
    await expect(window.locator("[data-review-global-canvas]")).toBeVisible()

    const lifecycleBefore = await reviewLifecycle(window)
    const priorSessionId = lifecycleBefore.sessions.activeSessionId
    expect(priorSessionId).not.toBeNull()
    const hold = await window.evaluate(async () =>
      globalThis.window.diffDashDiagnosticsForE2e.holdNextReviewAcquisition(),
    )
    expect(hold.armed).toBe(true)
    await pressRendererReload(window)
    await expect
      .poll(async () => (await reviewLifecycle(window)).acquisitions.activeOperationIds.length)
      .toBeGreaterThan(0)
    forwardComparison(executable, launchArguments, environment, {
      manifest: configuration.smallFixture,
      repository: configuration.smallFixtureRepository,
    })
    await waitForComparison(window, configuration.smallFixture)
    await expect
      .poll(async () => {
        const lifecycle = await reviewLifecycle(window)
        return {
          superseded: lifecycle.acquisitions.superseded,
          drained: lifecycle.acquisitions.drained,
          active: lifecycle.acquisitions.activeOperationIds.length,
        }
      })
      .toEqual({
        superseded: lifecycleBefore.acquisitions.superseded + 1,
        drained: lifecycleBefore.acquisitions.drained + 1,
        active: 0,
      })
    const lifecycleAfterSupersession = await reviewLifecycle(window)
    report.observations.supersededOperationId =
      lifecycleAfterSupersession.acquisitions.lastSupersededOperationId
    report.observations.drainedOperationId =
      lifecycleAfterSupersession.acquisitions.lastDrainedOperationId
    report.observations.acquisitionCounters = {
      started: lifecycleAfterSupersession.acquisitions.started,
      superseded: lifecycleAfterSupersession.acquisitions.superseded,
      drained: lifecycleAfterSupersession.acquisitions.drained,
    }
    report.gates.rescanCancellation =
      lifecycleAfterSupersession.acquisitions.lastSupersededOperationId !== null &&
      lifecycleAfterSupersession.acquisitions.lastDrainedOperationId ===
        lifecycleAfterSupersession.acquisitions.lastSupersededOperationId
    if (report.gates.rescanCancellation) {
      report.blocked = report.blocked.filter(
        ({ scenario }) => scenario !== "rescan cancellation counters",
      )
    }

    await expect
      .poll(async () => {
        const sessions = (await reviewLifecycle(window)).sessions
        return {
          activeChanged:
            sessions.activeSessionId !== null && sessions.activeSessionId !== priorSessionId,
          disposedSessionId: sessions.lastDisposedSessionId,
        }
      })
      .toEqual({ activeChanged: true, disposedSessionId: priorSessionId })
    report.observations.disposedSessionId = priorSessionId
    report.observations.replacementSessionId = (
      await reviewLifecycle(window)
    ).sessions.activeSessionId
    report.gates.disposalComplete = true
    report.blocked = report.blocked.filter(
      ({ scenario }) => scenario !== "foreground disposal completion",
    )

    const smallSessionId = (await reviewLifecycle(window)).sessions.activeSessionId
    if (smallSessionId === null) throw new Error("Replacement comparison has no active session")
    forwardComparison(executable, launchArguments, environment, {
      manifest: configuration.fixture,
      repository: configuration.fixtureRepository,
    })
    await waitForComparison(window, configuration.fixture)
    await expect
      .poll(async () => {
        const sessions = (await reviewLifecycle(window)).sessions
        return {
          activeChanged:
            sessions.activeSessionId !== null && sessions.activeSessionId !== smallSessionId,
          disposedSessionId: sessions.lastDisposedSessionId,
        }
      })
      .toEqual({ activeChanged: true, disposedSessionId: smallSessionId })

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
      let activeReviewSessionId = (await reviewLifecycle(window)).sessions.activeSessionId
      if (activeReviewSessionId === null) {
        throw new Error("Measured switch has no active Core review session")
      }
      const disposalCompleteForSwitch = true
      if (index > 0) {
        const previousSessionId = activeReviewSessionId
        forwardComparison(executable, launchArguments, environment, selected)
        await waitForComparison(window, selected.manifest)
        await expect(window.locator("[data-review-global-canvas]")).toBeVisible({ timeout: 90_000 })
        await expect
          .poll(async () => {
            const sessions = (await reviewLifecycle(window)).sessions
            return {
              activeChanged:
                sessions.activeSessionId !== null && sessions.activeSessionId !== previousSessionId,
              disposedSessionId: sessions.lastDisposedSessionId,
            }
          })
          .toEqual({ activeChanged: true, disposedSessionId: previousSessionId })
        const sessions = (await reviewLifecycle(window)).sessions
        activeReviewSessionId = sessions.activeSessionId
        if (
          activeReviewSessionId === null ||
          sessions.lastDisposedSessionId !== previousSessionId
        ) {
          throw new Error("Core did not dispose the prior measured review session")
        }
      }
      report.observations.switchCount = index + 1
      if (configuration.profile === "full") {
        const storageBefore = await measureManagedStorage({
          databasePath,
          snapshotBlocksRoot,
          snapshotSpoolsRoot,
          worktreePoolRoot,
          remoteWorktreePoolRoot,
        })
        const measurement = await measureProcessTree({
          rootPid,
          ...REPOSITORY_SCALE_MEASUREMENT_POLICY,
        })
        const storageAfter = await measureManagedStorage({
          databasePath,
          snapshotBlocksRoot,
          snapshotSpoolsRoot,
          worktreePoolRoot,
          remoteWorktreePoolRoot,
        })
        if (activeReviewSessionId === null) {
          throw new Error("Measured switch has no active Core review session")
        }
        report.switchReports.push({
          ...measurement,
          appVersion: report.provenance.appVersion,
          bunVersion: report.provenance.core.bunVersion,
          coreHost: configuration.host,
          coreIdentity: {
            host: configuration.host,
            session: configuration.session,
            switchIndex: index + 1,
            reviewSessionId: activeReviewSessionId,
          },
          diffdashCommit: configuration.diffdashCommit,
          disposalComplete: disposalCompleteForSwitch,
          fixtureId: configuration.fixture.id,
          fixtureManifest: configuration.fixture,
          machineProfile: report.provenance.machineProfile,
          packaged: true,
          packagedArtifactDigest: report.provenance.packagedArtifactDigest,
          scenario: index % 2 === 0 ? "pathological" : "small",
          session: configuration.session,
          storage: {
            before: storageBefore,
            after: storageAfter,
            databaseDeltaBytes: storageAfter.databaseBytes - storageBefore.databaseBytes,
            managedDeltaBytes: storageAfter.managedBytes - storageBefore.managedBytes,
            freeSpaceDeltaBytes:
              storageAfter.filesystemFreeBytes - storageBefore.filesystemFreeBytes,
          },
          switchIndex: index + 1,
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
      .poll(
        async () => {
          try {
            return await window.evaluate(
              async () =>
                (await globalThis.window.diffDashForE2e.appState.get()).onboardingCompleted,
            )
          } catch {
            return false
          }
        },
        { timeout: 30_000 },
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
    rendererMetricsObserved: true,
    rapidSwitches: true,
    coreRestart: true,
    processTeardown: true,
    disposalComplete: true,
    rescanCancellation: true,
  })
})

type RepositoryScaleConfiguration = {
  readonly host: RepositoryScaleCoreHost
  readonly profile: "smoke" | "full"
  readonly session: string
  readonly rawReport: string
  readonly diffdashCommit: string
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
    diffdashCommit: requiredEnvironment("DIFFDASH_REPOSITORY_SCALE_COMMIT"),
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

const reviewLifecycle = async (window: Page) => {
  const deadline = Date.now() + 10_000
  let lastError: unknown = new Error("Review lifecycle diagnostics were unavailable")
  while (Date.now() < deadline) {
    try {
      return await window.evaluate(async () =>
        globalThis.window.diffDashDiagnosticsForE2e.reviewLifecycle(),
      )
    } catch (error) {
      lastError = error
      await window.waitForTimeout(50)
    }
  }
  throw lastError
}

const searchReview = async (
  window: Page,
  canvas: Locator,
  query: string,
): Promise<readonly ReviewSessionSearchPublication[]> => {
  const attribute = async (name: string): Promise<string> => {
    const value = await canvas.getAttribute(name)
    if (value === null) throw new Error(`Review canvas omitted ${name}`)
    return value
  }
  const [processId, projectId, reviewKey, sessionId, snapshotId, stateVersion] = await Promise.all([
    attribute("data-review-process-id"),
    attribute("data-review-project-id"),
    attribute("data-review-review-key"),
    attribute("data-review-session-id"),
    attribute("data-review-snapshot-id"),
    attribute("data-review-state-version"),
  ])
  // SAFETY: The renderer authored these attributes directly from one parsed ReviewSessionIdentity.
  const identity = {
    processId,
    projectId,
    reviewKey,
    sessionId,
    snapshotId,
    stateVersion: Number(stateVersion),
  } as ReviewSessionIdentity
  return window.evaluate(
    async ({ identity: currentIdentity, query: currentQuery }) => {
      const publications: ReviewSessionSearchPublication[] = []
      const state = await globalThis.window.diffDashForE2e.progressiveReviews.currentSession({
        identity: currentIdentity,
      })
      if (state._tag !== "ready") throw new Error(JSON.stringify(state))
      await globalThis.window.diffDashForE2e.progressiveReviews.search(
        {
          identity: state.identity,
          query: currentQuery,
          anchorFileId: null,
          direction: "next",
          cursor: null,
          limit: 200,
        },
        (publication) => publications.push(publication),
      )
      return publications
    },
    { identity, query },
  )
}

const pressRendererReload = (window: Page) =>
  window.evaluate((shortcutKey) => {
    const isMac = navigator.userAgent.includes("Macintosh")
    const event = new KeyboardEvent("keydown", {
      key: shortcutKey,
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    })
    if (globalThis.window.dispatchEvent(event))
      throw new Error("Renderer did not handle the reload shortcut")
  }, "r")

const startRendererMeasurement = (window: Page) =>
  window.evaluate(() => {
    type MeasurementState = {
      frameBuckets: number[]
      frameCount: number
      maximumFrameDuration: number
      maximumLivePierreHosts: number
      lastFrameAt: number | null
      longTaskDurations: number[]
      observer: PerformanceObserver | null
      running: boolean
    }
    const target = globalThis as typeof globalThis & {
      diffdashRepositoryScaleMeasurement?: MeasurementState
    }
    const state: MeasurementState = {
      frameBuckets: [],
      frameCount: 0,
      maximumFrameDuration: 0,
      maximumLivePierreHosts: 0,
      lastFrameAt: null,
      longTaskDurations: [],
      observer: null,
      running: true,
    }
    const frame = (timestamp: number) => {
      if (!state.running) return
      state.maximumLivePierreHosts = Math.max(
        state.maximumLivePierreHosts,
        document.querySelectorAll("diffs-container").length,
      )
      if (state.lastFrameAt !== null && state.frameCount < 20_000) {
        const duration = timestamp - state.lastFrameAt
        const bucket = Math.min(2_000, Math.ceil(duration))
        state.frameBuckets[bucket] = (state.frameBuckets[bucket] ?? 0) + 1
        state.frameCount += 1
        state.maximumFrameDuration = Math.max(state.maximumFrameDuration, duration)
      }
      state.lastFrameAt = timestamp
      requestAnimationFrame(frame)
    }
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      state.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTaskDurations.push(entry.duration)
      })
      state.observer.observe({ entryTypes: ["longtask"] })
    }
    target.diffdashRepositoryScaleMeasurement = state
    requestAnimationFrame(frame)
  })

const finishRendererMeasurement = (window: Page): Promise<RendererMeasurement> =>
  window.evaluate(() => {
    type ChromiumPerformance = Performance & {
      readonly memory?: { readonly usedJSHeapSize: number; readonly jsHeapSizeLimit: number }
    }
    type MeasurementState = {
      frameBuckets: number[]
      frameCount: number
      maximumFrameDuration: number
      maximumLivePierreHosts: number
      lastFrameAt: number | null
      longTaskDurations: number[]
      observer: PerformanceObserver | null
      running: boolean
    }
    const target = globalThis as typeof globalThis & {
      diffdashRepositoryScaleMeasurement?: MeasurementState
    }
    const state = target.diffdashRepositoryScaleMeasurement
    if (state === undefined) throw new Error("Renderer measurement was not started")
    state.running = false
    state.observer?.disconnect()
    const framePercentile = (fraction: number) => {
      const targetCount = Math.max(1, Math.ceil(state.frameCount * fraction))
      let observed = 0
      for (let duration = 0; duration < state.frameBuckets.length; duration += 1) {
        observed += state.frameBuckets[duration] ?? 0
        if (observed >= targetCount) return duration
      }
      return 0
    }
    const memory = (performance as ChromiumPerformance).memory
    return {
      domNodes: document.querySelectorAll("*").length,
      frameDurationMilliseconds: {
        count: state.frameCount,
        p50: framePercentile(0.5),
        p95: framePercentile(0.95),
        p99: framePercentile(0.99),
        maximum: state.maximumFrameDuration,
      },
      heap: {
        usedBytes: memory?.usedJSHeapSize ?? null,
        limitBytes: memory?.jsHeapSizeLimit ?? null,
      },
      livePierreHosts: state.maximumLivePierreHosts,
      longTasks: {
        count: state.longTaskDurations.length,
        maximumDurationMilliseconds: Math.max(0, ...state.longTaskDurations),
        totalDurationMilliseconds: state.longTaskDurations.reduce(
          (total, duration) => total + duration,
          0,
        ),
      },
    }
  })

const forwardComparison = (
  executable: string,
  launchArguments: readonly string[],
  environment: NodeJS.ProcessEnv,
  fixture: { readonly manifest: FixtureManifest; readonly repository: string },
): void => {
  const originalEnvelopeIndex = launchArguments.findIndex((argument) =>
    argument.startsWith("--diffdash-cli-v1="),
  )
  const electronArguments =
    originalEnvelopeIndex < 0 ? launchArguments : launchArguments.slice(0, originalEnvelopeIndex)
  execFileSync(
    executable,
    [
      ...electronArguments,
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
