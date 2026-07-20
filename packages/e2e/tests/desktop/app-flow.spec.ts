import { execFileSync } from "node:child_process"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { _electron as electron, expect, type Locator, type Page, test } from "@playwright/test"

const desktopRoot = join(process.cwd(), "../desktop")

test("FUN-130 AC: routes a hosted review through the non-GitHub fixture provider", async ({
  browserName: _browserName,
}, testInfo) => {
  const fakeBin = testInfo.outputPath("fake-bin")
  const xdgConfigHome = testInfo.outputPath("xdg-config")
  const userData = testInfo.outputPath("user-data")
  await Promise.all([
    mkdir(fakeBin, { recursive: true }),
    mkdir(xdgConfigHome, { recursive: true }),
    mkdir(userData, { recursive: true }),
  ])
  await Promise.all([installFakeCli(fakeBin), installCodexSettings(xdgConfigHome)])

  const app = await electron.launch({
    args: [join(desktopRoot, "out/main/index.js"), `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
      DIFFDASH_E2E_FAKE_AGENT_PROVIDER: "1",
      DIFFDASH_E2E_FAKE_GIT_PROVIDER: "1",
      DIFFDASH_E2E_FAKE_GIT_REMOTE: "https://git.fixture.test/platform/backend/service.git",
      DIFFDASH_E2E_HIDDEN: "1",
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: xdgConfigHome,
    },
  })

  try {
    const window = await app.firstWindow()
    await dismissOnboardingIfPresent(window)
    expect(
      await window.evaluate(async () => {
        const catalog = await globalThis.window.diffDash.agentProviders.getCatalog()
        return {
          fixture: catalog.providers.find(({ id }) => id === "fixture-agent"),
          autoWalkthrough: catalog.autoCandidates.walkthrough,
        }
      }),
    ).toEqual({
      fixture: expect.objectContaining({
        displayName: "Fixture Agent",
        defaults: { reviewThreadModel: "fixture-model", walkthroughModel: "fixture-model" },
        models: [expect.objectContaining({ id: "fixture-model" })],
        setup: [expect.objectContaining({ name: "fixture-runtime" })],
      }),
      autoWalkthrough: ["claude", "codex", "opencode"],
    })
    await expect(window.getByRole("option", { name: "Fixture Forge" })).toHaveCount(1)

    const fixtureReview = window.getByRole("button", {
      name: /Open requested review #73: Fixture merge request flow/,
    })
    await expect(fixtureReview).toBeVisible()
    await fixtureReview.click()

    await expect(window.getByRole("heading", { name: "Fixture merge request flow" })).toBeVisible()
    await expect(window.getByText("Opened MR #73: Fixture merge request flow")).toBeVisible()
    await expect(window.getByText("src/fixture.ts").first()).toBeVisible()
    await window.getByRole("button", { name: "Actions" }).click()
    await expect(window.getByRole("menuitem", { name: /Approve/ })).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test("covers finished Home to Review flow with fake CLI fixtures", async ({
  browserName: _browserName,
}, testInfo) => {
  testInfo.setTimeout(60_000)
  const fakeBin = testInfo.outputPath("fake-bin")
  const codexRunLog = testInfo.outputPath("codex-runs.log")
  const linkedRepo = testInfo.outputPath("linked-repo")
  const poolPath = testInfo.outputPath("worktree-pool")
  const xdgConfigHome = testInfo.outputPath("xdg-config")
  const userData = testInfo.outputPath("user-data")
  await mkdir(fakeBin, { recursive: true })
  await mkdir(xdgConfigHome, { recursive: true })
  await mkdir(userData, { recursive: true })
  await installFakeCli(fakeBin)
  await installCodexSettings(xdgConfigHome)
  const pullRequest = await installPullRequestRepository(
    linkedRepo,
    testInfo.outputPath("origin.git"),
  )
  const sourceBranch = realGit(linkedRepo, "branch", "--show-current")
  const sourceStatus = realGit(linkedRepo, "status", "--porcelain", "--untracked-files=all")

  const appEnvironment = {
    ...process.env,
    DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
    DIFFDASH_E2E_HIDDEN: "1",
    DIFFDASH_WORKTREE_POOL_PATH: poolPath,
    FAKE_CODEX_RUN_LOG: codexRunLog,
    FAKE_PR_BASE_SHA: pullRequest.baseSha,
    FAKE_PR_HEAD_SHA: pullRequest.headSha,
    FAKE_USE_REAL_GIT: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${pullRequest.remote}.insteadOf`,
    GIT_CONFIG_VALUE_0: "git@github.com:fungsi/diffdash.git",
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    REAL_GIT_PATH: "/usr/bin/git",
    XDG_CONFIG_HOME: xdgConfigHome,
  }
  const appEntry = join(desktopRoot, "out/main/index.js")
  let app = await electron.launch({
    args: [appEntry, `--user-data-dir=${userData}`, `--diffdash-link-path=${linkedRepo}`],
    env: appEnvironment,
  })

  try {
    const window = await app.firstWindow()
    await dismissOnboardingIfPresent(window, { telemetryEnabled: false })
    expect(
      await window.evaluate(async () => {
        const settings = await globalThis.window.diffDash.settings.get()
        return {
          onboardingCompleted: (await globalThis.window.diffDash.appState.get())
            .onboardingCompleted,
          telemetryEnabled: settings.telemetryEnabled,
          diffDashType: typeof globalThis.window.diffDash,
          nodeProcessType: typeof Reflect.get(globalThis.window, "process"),
          nodeRequireType: typeof Reflect.get(globalThis.window, "require"),
        }
      }),
    ).toEqual({
      onboardingCompleted: true,
      telemetryEnabled: false,
      diffDashType: "object",
      nodeProcessType: "undefined",
      nodeRequireType: "undefined",
    })
    const malformedIpcErrors = await window.evaluate(async () => {
      const requests = [
        Reflect.apply(globalThis.window.diffDash.analytics.capture, undefined, [null]),
        Reflect.apply(globalThis.window.diffDash.reviewThreads.list, undefined, [null]),
        Reflect.apply(globalThis.window.diffDash.reviewThreads.create, undefined, [null]),
        Reflect.apply(globalThis.window.diffDash.reviewThreads.addUserMessage, undefined, [null]),
        Reflect.apply(globalThis.window.diffDash.reviewThreads.get, undefined, [null]),
        Reflect.apply(globalThis.window.diffDash.reviewThreads.runAgent, undefined, [null]),
        Reflect.apply(globalThis.window.diffDash.settings.update, undefined, [null]),
        Reflect.apply(globalThis.window.diffDash.appState.update, undefined, [null]),
        Reflect.apply(globalThis.window.diffDash.repositories.link, undefined, [null]),
        Reflect.apply(globalThis.window.diffDash.hostedRepositories.searchRepositories, undefined, [
          null,
        ]),
        Reflect.apply(globalThis.window.diffDash.reviewSnapshots.acquireHosted, undefined, [null]),
        Reflect.apply(globalThis.window.diffDash.reviewSnapshots.acquireLocal, undefined, [null]),
        Reflect.apply(globalThis.window.diffDash.reviewSnapshots.getPage, undefined, [null]),
        Reflect.apply(globalThis.window.diffDash.reviewSnapshots.search, undefined, [null]),
        Reflect.apply(globalThis.window.diffDash.localWalkthroughs.get, undefined, [null]),
        Reflect.apply(globalThis.window.diffDash.localWalkthroughs.generate, undefined, [null]),
      ]
      return Promise.all(
        requests.map(async (request) => {
          try {
            await request
            return "resolved unexpectedly"
          } catch (error) {
            return error instanceof Error ? error.message : String(error)
          }
        }),
      )
    })
    const decodedChannels = [
      "analytics:capture",
      "reviewThreads:list",
      "reviewThreads:create",
      "reviewThreads:addUserMessage",
      "reviewThreads:get",
      "reviewThreads:runAgent",
      "settings:update",
      "appState:update",
      "repositories:link",
      "hostedRepositories:search",
      "reviewSnapshots:acquireHosted",
      "reviewSnapshots:acquireLocal",
      "reviewSnapshots:getPage",
      "reviewSnapshots:search",
      "localWalkthroughs:get",
      "localWalkthroughs:generate",
    ]
    expect(malformedIpcErrors).toHaveLength(decodedChannels.length)
    for (const [index, channel] of decodedChannels.entries()) {
      expect(malformedIpcErrors[index]).toContain(`${channel} failed`)
    }
    await expect(window.locator("html")).toHaveClass(/dark/)
    await expect(
      window.getByRole("button", { name: /Use (?:light|dark|system) theme/ }),
    ).toHaveCount(0)
    await expect(window.getByRole("button", { name: "Home" })).toBeVisible()
    const openPullRequest = window.getByRole("button", { name: /Open review #51/ })
    await expect(openPullRequest).toBeVisible()
    await openPullRequest.click()

    await expect(window.getByRole("heading", { name: "Request review flow" })).toBeVisible()
    await expect(window.getByText("Link a checkout for isolated agent review")).toHaveCount(0)
    await expect(window.getByText("src/app.tsx").first()).toBeVisible()
    await expect(window.getByText("Viewed").first()).toBeVisible()
    await expect(window.getByText("+1").first()).toBeVisible()
    await expect(window.getByText("-1").first()).toBeVisible()
    await expect(window.getByRole("button", { name: "Request changes" })).toBeHidden()

    const addedLine = window
      .locator("diffs-container [data-line]")
      .filter({ hasText: "new" })
      .first()
    await expect(addedLine).toBeVisible()
    const gutterNumber = window
      .locator("diffs-container [data-column-number]:visible")
      .filter({ hasText: "1" })
      .first()
    const initialComposer = await openGutterThreadComposer(window, gutterNumber)
    await initialComposer.fill("Why was this line changed?")
    await window.getByRole("button", { name: "Comment" }).click()

    await expect(window.getByText("Why was this line changed?")).toBeVisible()
    await expect(window.getByText("Agent is reviewing...")).toBeVisible()
    await expect(
      window.getByText("The agent response did not start. Retry to try again."),
    ).toHaveCount(0)
    await expect(window.getByText("The line check is complete.")).toBeVisible()
    const reviewDisclosure = window.getByRole("button", { name: "Review on L1" })
    const reviewContainer = window.locator("[data-review-thread-annotation]")
    await expect(reviewDisclosure).toHaveAttribute("aria-expanded", "true")
    await expect(reviewContainer).not.toContainText("src/app.tsx:1")
    await expect(reviewContainer).not.toContainText("Current revision")
    await reviewDisclosure.click()
    await expect(reviewDisclosure).toHaveAttribute("aria-expanded", "false")
    await expect(window.getByText("Why was this line changed?")).toBeHidden()
    await expect(reviewDisclosure).toBeVisible()
    await reviewDisclosure.click()
    await expect(reviewDisclosure).toHaveAttribute("aria-expanded", "true")
    const followUpComposer = window.getByRole("textbox", { name: "Thread message" })
    await expect(followUpComposer).toBeVisible()
    await followUpComposer.fill("What behavior does it preserve?")
    await window.getByRole("button", { name: "Send" }).click()

    await expect(window.getByText("What behavior does it preserve?")).toBeVisible()
    await expect(window.getByText("Agent is reviewing...")).toBeVisible()
    await expect(window.getByText("The line check is complete.")).toHaveCount(2)
    expect(await countLogLines(codexRunLog)).toBe(2)
    await expect(window.getByRole("button", { name: "Close" })).toBeHidden()
    await expect(window.getByRole("heading", { name: "Request review flow" })).toBeVisible()

    const diffCard = window.locator('[data-diff-card-path="src/app.tsx"]')
    const viewedCheckbox = diffCard.getByRole("checkbox")
    await viewedCheckbox.check({ force: true })
    await expect(viewedCheckbox).toBeChecked()
    expect(await window.evaluate(() => globalThis.scrollY)).toBe(0)

    await window.getByRole("button", { name: "Actions" }).click()
    await window.getByRole("menuitem", { name: /Approve/ }).click()
    await window.getByRole("button", { name: "Actions" }).click()
    await expect(window.getByRole("menuitem", { name: /Approved/ })).toBeVisible()
    await window.keyboard.press("Escape")
    await expect(window.getByRole("menuitem", { name: /Approved/ })).toBeHidden()

    await window.getByRole("button", { name: "Walkthrough" }).click()

    await expect(window.getByText("Review focus")).toBeVisible()
    await expect(window.getByRole("heading", { name: "Entry point" })).toBeVisible()
    await expect(window.getByText("CRITICAL")).toBeVisible()

    await app.close()
    const beforeRestart = readReviewPersistenceSnapshot(join(userData, "diffdash.sqlite"))
    expect(beforeRestart.runs).toHaveLength(2)
    expect(beforeRestart.runs.map(({ status }) => status)).toEqual(["completed", "completed"])
    expect(beforeRestart.runs.map(({ provider }) => provider)).toEqual(["codex", "codex"])
    for (const run of beforeRestart.runs) {
      expect(run.reviewKey).toBe(run.threadReviewKey)
      expect(run.baseRevision).toBe(run.threadBaseRevision)
      expect(run.headRevision).toBe(run.threadHeadRevision)
    }
    expect(beforeRestart.runs.map(({ usage }) => usage)).toEqual([
      expect.objectContaining({ inputTokens: 10, outputTokens: 10 }),
      expect.objectContaining({ inputTokens: 10, outputTokens: 10 }),
    ])
    expect(beforeRestart.artifacts).toHaveLength(2)
    expect(beforeRestart.artifacts.map(({ type }) => type)).toEqual([
      "provider_message",
      "provider_message",
    ])
    expect(beforeRestart.artifacts.map(({ metadata }) => metadata)).toEqual([
      expect.objectContaining({ sourceProvider: "codex", itemId: "message-1" }),
      expect.objectContaining({ sourceProvider: "codex", itemId: "message-1" }),
    ])
    expect(beforeRestart.memory).toEqual([
      expect.objectContaining({
        summarizedThroughSequence: 4,
        summaryAlgorithm: "deterministic-transcript",
        summaryVersion: 1,
        summary:
          "[#1] user: Why was this line changed?\n[#2] assistant: The line check is complete.\n[#3] user: What behavior does it preserve?\n[#4] assistant: The line check is complete.",
      }),
    ])
    expect(new Set(beforeRestart.memory[0]?.importantArtifactIds)).toEqual(
      new Set(beforeRestart.artifacts.map(({ id }) => id)),
    )
    expect(new Set(beforeRestart.agentMessageRunIds)).toEqual(
      new Set(beforeRestart.runs.map(({ id }) => id)),
    )

    app = await electron.launch({
      args: [appEntry, `--user-data-dir=${userData}`],
      env: appEnvironment,
    })

    const restartedWindow = await app.firstWindow()
    await expect(restartedWindow.getByRole("button", { name: "Continue to DiffDash" })).toHaveCount(
      0,
    )
    expect(
      await restartedWindow.evaluate(async () => {
        const settings = await globalThis.window.diffDash.settings.get()
        return {
          appearance: settings.appearance,
          provider: settings.routes.walkthrough,
          telemetryEnabled: settings.telemetryEnabled,
        }
      }),
    ).toEqual({ appearance: "dark", provider: "codex", telemetryEnabled: false })
    const reopenedPullRequest = restartedWindow.getByRole("button", {
      name: /Open (?:requested review|PR) #51/,
    })
    await expect(reopenedPullRequest).toBeVisible()
    await reopenedPullRequest.click()
    await expect(
      restartedWindow.getByRole("heading", { name: "Request review flow" }),
    ).toBeVisible()

    const restartedDiffCard = restartedWindow.locator('[data-diff-card-path="src/app.tsx"]')
    const restartedViewedCheckbox = restartedDiffCard.getByRole("checkbox")
    await expect(restartedViewedCheckbox).toBeChecked()
    expect(await countLogLines(codexRunLog)).toBe(2)

    await restartedViewedCheckbox.uncheck({ force: true })
    const restartedReviewDisclosure = restartedWindow.getByRole("button", {
      name: "Review on L1",
    })
    await expect(restartedReviewDisclosure).toBeVisible()
    await restartedReviewDisclosure.click()
    await expect(restartedWindow.getByText("Why was this line changed?")).toBeVisible()
    await expect(restartedWindow.getByText("What behavior does it preserve?")).toBeVisible()
    await expect(restartedWindow.getByText("The line check is complete.")).toHaveCount(2)

    await restartedWindow.getByRole("button", { name: "Walkthrough" }).click()
    await expect(restartedWindow.getByRole("heading", { name: "Entry point" })).toBeVisible()
    expect(await countLogLines(codexRunLog)).toBe(2)
    await app.close()
    expect(readReviewPersistenceSnapshot(join(userData, "diffdash.sqlite"))).toEqual(beforeRestart)
  } finally {
    await app.close().catch(() => undefined)
  }
  expect(realGit(linkedRepo, "branch", "--show-current")).toBe(sourceBranch)
  expect(realGit(linkedRepo, "status", "--porcelain", "--untracked-files=all")).toBe(sourceStatus)
})

test("opens local working tree review from CLI argument", async ({
  browserName: _browserName,
}, testInfo) => {
  const fakeBin = testInfo.outputPath("fake-bin")
  const localRepo = testInfo.outputPath("local-repo")
  const xdgConfigHome = testInfo.outputPath("xdg-config")
  const userData = testInfo.outputPath("user-data")
  await mkdir(fakeBin, { recursive: true })
  await mkdir(localRepo, { recursive: true })
  await mkdir(xdgConfigHome, { recursive: true })
  await mkdir(userData, { recursive: true })
  await installFakeCli(fakeBin)
  await installCodexSettings(xdgConfigHome)

  const app = await electron.launch({
    args: [
      join(desktopRoot, "out/main/index.js"),
      `--user-data-dir=${userData}`,
      `--diffdash-local-path=${localRepo}`,
    ],
    env: {
      ...process.env,
      DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
      DIFFDASH_E2E_HIDDEN: "1",
      FAKE_REPO_ROOT: localRepo,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: xdgConfigHome,
    },
  })

  try {
    const window = await app.firstWindow()
    await dismissOnboardingIfPresent(window)
    await expect(window.getByRole("heading", { name: "Local changes" })).toBeVisible()
    await expect(window.getByText("src/local.ts").first()).toBeVisible()
    await expect(window.getByText("notes.txt").first()).toBeVisible()
    await expect(window.getByRole("button", { name: "Approve" })).toBeHidden()

    await window.getByRole("button", { name: "Walkthrough" }).click()
    await expect(window.getByText("Review focus")).toBeVisible()
    await expect(window.getByRole("heading", { name: "Entry point" })).toBeVisible()
  } finally {
    await app.close()
  }
})

for (const fixture of [
  { provider: "codex", response: "The line check is complete." },
  { provider: "claude", response: "Claude completed the line review." },
  { provider: "opencode", response: "OpenCode completed the line review." },
] as const) {
  test(`FUN-133 AC: runs a fixture review turn through ${fixture.provider}`, async ({
    browserName: _browserName,
  }, testInfo) => {
    testInfo.setTimeout(45_000)
    const fakeBin = testInfo.outputPath("fake-bin")
    const localRepo = testInfo.outputPath("local-repo")
    const xdgConfigHome = testInfo.outputPath("xdg-config")
    const userData = testInfo.outputPath("user-data")
    await Promise.all([
      mkdir(fakeBin, { recursive: true }),
      mkdir(localRepo, { recursive: true }),
      mkdir(xdgConfigHome, { recursive: true }),
      mkdir(userData, { recursive: true }),
    ])
    await Promise.all([
      installFakeCli(fakeBin),
      installAgentSettings(xdgConfigHome, fixture.provider),
    ])

    const app = await electron.launch({
      args: [
        join(desktopRoot, "out/main/index.js"),
        `--user-data-dir=${userData}`,
        `--diffdash-local-path=${localRepo}`,
      ],
      env: {
        ...process.env,
        DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
        DIFFDASH_E2E_HIDDEN: "1",
        FAKE_REPO_ROOT: localRepo,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        XDG_CONFIG_HOME: xdgConfigHome,
      },
    })

    try {
      const window = await app.firstWindow()
      await dismissOnboardingIfPresent(window)
      await expect(window.getByRole("heading", { name: "Local changes" })).toBeVisible()
      const gutterNumber = window
        .locator("diffs-container [data-column-number]:visible")
        .filter({ hasText: "1" })
        .first()
      const composer = await openGutterThreadComposer(window, gutterNumber)
      await composer.fill("Review this line")
      await window.getByRole("button", { name: "Comment" }).click()
      await expect(window.getByText(fixture.response)).toBeVisible({ timeout: 20_000 })
    } finally {
      await app.close()
    }

    const snapshot = readReviewPersistenceSnapshot(join(userData, "diffdash.sqlite"))
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.runs[0]).toEqual(
      expect.objectContaining({ provider: fixture.provider, status: "completed" }),
    )
  })
}

test("opens a merge-base branch comparison from the versioned CLI command", async ({
  browserName: _browserName,
}, testInfo) => {
  const fakeBin = testInfo.outputPath("fake-bin")
  const localRepo = testInfo.outputPath("local-repo")
  const xdgConfigHome = testInfo.outputPath("xdg-config")
  const userData = testInfo.outputPath("user-data")
  await mkdir(fakeBin, { recursive: true })
  await mkdir(localRepo, { recursive: true })
  await mkdir(xdgConfigHome, { recursive: true })
  await mkdir(userData, { recursive: true })
  await installFakeCli(fakeBin)
  await installCodexSettings(xdgConfigHome)

  const app = await electron.launch({
    args: [
      join(desktopRoot, "out/main/index.js"),
      `--user-data-dir=${userData}`,
      "--diffdash-cli-v1",
      localRepo,
      "--",
      "diff",
      "dev",
    ],
    env: {
      ...process.env,
      DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
      DIFFDASH_E2E_HIDDEN: "1",
      FAKE_REPO_ROOT: localRepo,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: xdgConfigHome,
    },
  })

  try {
    const window = await app.firstWindow()
    await dismissOnboardingIfPresent(window)
    await expect(window.getByRole("heading", { name: "Changes vs dev" })).toBeVisible()
    await expect(window.getByText("vs dev", { exact: true })).toBeVisible()
    await expect(window.getByText("src/local.ts").first()).toBeVisible()
  } finally {
    await app.close()
  }
})

test("forwards a CLI command to the running DiffDash instance", async ({
  browserName: _browserName,
}, testInfo) => {
  const fakeBin = testInfo.outputPath("fake-bin")
  const localRepo = testInfo.outputPath("local-repo")
  const xdgConfigHome = testInfo.outputPath("xdg-config")
  const userData = testInfo.outputPath("user-data")
  await mkdir(fakeBin, { recursive: true })
  await mkdir(localRepo, { recursive: true })
  await mkdir(xdgConfigHome, { recursive: true })
  await mkdir(userData, { recursive: true })
  await installFakeCli(fakeBin)
  await installCodexSettings(xdgConfigHome)

  const appEnvironment = {
    ...process.env,
    DIFFDASH_E2E_HIDDEN: "1",
    FAKE_REPO_ROOT: localRepo,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: xdgConfigHome,
  }
  const app = await electron.launch({
    args: [join(desktopRoot, "out/main/index.js"), `--user-data-dir=${userData}`],
    env: appEnvironment,
  })

  try {
    const window = await app.firstWindow()
    await dismissOnboardingIfPresent(window)
    await expect(window.getByRole("heading", { name: "DiffDash" })).toBeVisible()
    expect(await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"))).toBe(
      userData,
    )

    const electronExecutable = execFileSync(process.execPath, ["-p", "require('electron')"], {
      cwd: desktopRoot,
      encoding: "utf8",
    }).trim()
    execFileSync(
      electronExecutable,
      [
        join(desktopRoot, "out/main/index.js"),
        `--user-data-dir=${userData}`,
        `--diffdash-cli-v1=${localRepo}`,
        "--",
        "diff",
        "dev",
      ],
      { env: appEnvironment, stdio: "ignore", timeout: 10_000 },
    )

    await expect(window.getByRole("heading", { name: "Changes vs dev" })).toBeVisible()
    await expect(window.getByText("src/local.ts").first()).toBeVisible()
  } finally {
    await app.close()
  }
})

test("shows a reloadable Electron fallback when the renderer cannot load", async ({
  browserName: _browserName,
}, testInfo) => {
  const userData = testInfo.outputPath("user-data")
  await mkdir(userData, { recursive: true })
  const unavailableRendererUrl = "http://127.0.0.1:1"
  const app = await electron.launch({
    args: [join(desktopRoot, "out/main/index.js"), `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
      DIFFDASH_E2E_HIDDEN: "1",
      ELECTRON_RENDERER_URL: unavailableRendererUrl,
    },
  })

  try {
    const window = await app.firstWindow()
    await expect(
      window.getByRole("heading", { name: "DiffDash encountered an error" }),
    ).toBeVisible()
    await expect(window.getByRole("alert")).toContainText("Renderer failed to load")
    await expect(window.getByRole("link", { name: "Reload DiffDash" })).toHaveAttribute(
      "href",
      `${unavailableRendererUrl}/`,
    )
  } finally {
    await app.close()
  }
})

test("recreates the app window when macOS activates with no open windows", async ({
  browserName: _browserName,
}, testInfo) => {
  test.skip(process.platform !== "darwin", "Electron activation recreation is macOS behavior")
  const userData = testInfo.outputPath("user-data")
  const fakeBin = testInfo.outputPath("fake-bin")
  const xdgConfigHome = testInfo.outputPath("xdg-config")
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(fakeBin, { recursive: true })])
  await Promise.all([installFakeCli(fakeBin), installCodexSettings(xdgConfigHome)])
  const app = await electron.launch({
    args: [join(desktopRoot, "out/main/index.js"), `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
      DIFFDASH_E2E_HIDDEN: "1",
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: xdgConfigHome,
    },
  })

  try {
    const initialWindow = await app.firstWindow()
    await initialWindow.close()
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(0)

    const recreatedWindowPromise = app.waitForEvent("window")
    await app.evaluate(({ app: electronApp }) => electronApp.emit("activate"))
    const recreatedWindow = await recreatedWindowPromise

    await expect(recreatedWindow.getByRole("heading", { name: "DiffDash" })).toBeVisible()
  } finally {
    await app.close()
  }
})

const installFakeCli = async (directory: string) => {
  await Promise.all([
    writeExecutable(join(directory, "diffdash"), fakeDiffDashScript),
    writeExecutable(join(directory, "gh"), fakeGhScript),
    writeExecutable(join(directory, "git"), fakeGitScript),
    writeExecutable(join(directory, "codex"), fakeCodexScript),
    writeExecutable(join(directory, "claude"), fakeClaudeScript),
    writeExecutable(join(directory, "opencode"), fakeOpenCodeScript),
  ])
}

const installCodexSettings = async (xdgConfigHome: string) => {
  await installAgentSettings(xdgConfigHome, "codex")
}

const installAgentSettings = async (xdgConfigHome: string, provider: string) => {
  const settingsDirectory = join(xdgConfigHome, "diffdash-development")
  await mkdir(settingsDirectory, { recursive: true })
  await writeFile(
    join(settingsDirectory, "settings.json"),
    JSON.stringify({
      appearance: "dark",
      provider,
      models: {
        auto: "balance",
        claude: "claude-sonnet-5",
        codex: "gpt-5.3-codex-spark",
        opencode: "openai/gpt-5.3-codex-spark",
      },
    }),
    "utf8",
  )
}

const dismissOnboardingIfPresent = async (
  window: Page,
  options: { readonly telemetryEnabled?: boolean } = {},
) => {
  const continueButton = window.getByRole("button", { name: "Continue to DiffDash" })
  try {
    await continueButton.waitFor({ state: "visible", timeout: 2_000 })
    if (options.telemetryEnabled === false) {
      await window.getByRole("checkbox", { name: "Share anonymous usage data" }).uncheck()
    }
    await continueButton.click()
  } catch {
    // Onboarding is only shown for fresh app state.
  }
}

const openGutterThreadComposer = async (window: Page, gutterNumber: Locator) => {
  const utility = window.locator("diffs-container [data-utility-button]").first()
  const composer = window.getByRole("textbox", { name: "Thread message" })
  await expect
    .poll(
      async () => {
        if (await composer.isVisible()) return true
        try {
          await gutterNumber.hover({ force: true, timeout: 1_000 })
          if (!(await utility.isVisible())) return false
          await utility.evaluate((button) => {
            const init = {
              bubbles: true,
              button: 0,
              composed: true,
              pointerId: 1,
              pointerType: "mouse",
            }
            button.dispatchEvent(new PointerEvent("pointerdown", init))
            button.dispatchEvent(new PointerEvent("pointerup", init))
          })
          return composer.isVisible()
        } catch {
          return false
        }
      },
      { timeout: 15_000 },
    )
    .toBe(true)
  return composer
}

const writeExecutable = async (path: string, content: string) => {
  await writeFile(path, content, "utf8")
  await chmod(path, 0o755)
}

const countLogLines = async (path: string) => {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).length
  } catch {
    return 0
  }
}

const readReviewPersistenceSnapshot = (databasePath: string) => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const runs = records(
      database
        .prepare(
          `SELECT run.id, run.thread_id, run.review_key, run.base_sha, run.head_sha,
             run.provider, run.model, run.prompt_version, run.status, run.provider_run_id,
             run.usage_json, run.error, run.started_at, run.completed_at,
             thread.review_key AS thread_review_key,
             thread.current_base_sha AS thread_base_sha,
             thread.current_head_sha AS thread_head_sha
           FROM agent_runs AS run
           INNER JOIN review_threads AS thread ON thread.id = run.thread_id
           ORDER BY run.started_at, run.id`,
        )
        .all(),
    ).map((row) => ({
      id: stringField(row, "id"),
      threadId: stringField(row, "thread_id"),
      reviewKey: stringField(row, "review_key"),
      baseRevision: stringField(row, "base_sha"),
      headRevision: stringField(row, "head_sha"),
      threadReviewKey: stringField(row, "thread_review_key"),
      threadBaseRevision: stringField(row, "thread_base_sha"),
      threadHeadRevision: stringField(row, "thread_head_sha"),
      provider: stringField(row, "provider"),
      model: stringField(row, "model"),
      promptVersion: stringField(row, "prompt_version"),
      status: stringField(row, "status"),
      providerRunId: nullableStringField(row, "provider_run_id"),
      usage: jsonField(row, "usage_json"),
      error: nullableStringField(row, "error"),
      startedAt: stringField(row, "started_at"),
      completedAt: nullableStringField(row, "completed_at"),
    }))
    const artifacts = records(
      database
        .prepare(
          `SELECT id, run_id, thread_id, type, title, content, content_digest, metadata_json,
             truncated, original_size, created_at
           FROM agent_run_artifacts ORDER BY created_at, id`,
        )
        .all(),
    ).map((row) => ({
      id: stringField(row, "id"),
      runId: stringField(row, "run_id"),
      threadId: stringField(row, "thread_id"),
      type: stringField(row, "type"),
      title: stringField(row, "title"),
      content: stringField(row, "content"),
      contentDigest: stringField(row, "content_digest"),
      metadata: jsonField(row, "metadata_json"),
      truncated: numberField(row, "truncated"),
      originalSize: numberField(row, "original_size"),
      createdAt: stringField(row, "created_at"),
    }))
    const memory = records(
      database
        .prepare(
          `SELECT thread_id, summary, important_artifact_ids_json, updated_at,
             summarized_through_sequence, summary_algorithm, summary_version
           FROM thread_memory ORDER BY thread_id`,
        )
        .all(),
    ).map((row) => ({
      threadId: stringField(row, "thread_id"),
      summary: stringField(row, "summary"),
      importantArtifactIds: stringArrayJsonField(row, "important_artifact_ids_json"),
      updatedAt: stringField(row, "updated_at"),
      summarizedThroughSequence: numberField(row, "summarized_through_sequence"),
      summaryAlgorithm: stringField(row, "summary_algorithm"),
      summaryVersion: numberField(row, "summary_version"),
    }))
    const agentMessageRunIds = records(
      database
        .prepare(
          `SELECT agent_run_id FROM review_thread_messages
           WHERE agent_run_id IS NOT NULL ORDER BY sequence`,
        )
        .all(),
    ).map((row) => stringField(row, "agent_run_id"))

    return { runs, artifacts, memory, agentMessageRunIds }
  } finally {
    database.close()
  }
}

const records = (rows: readonly unknown[]): readonly Readonly<Record<string, unknown>>[] =>
  rows.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("SQLite returned a non-record row")
    }
    const record: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) record[key] = value
    return record
  })

const stringField = (row: Readonly<Record<string, unknown>>, key: string) => {
  const value = row[key]
  if (typeof value !== "string") throw new Error(`SQLite field ${key} is not a string`)
  return value
}

const nullableStringField = (row: Readonly<Record<string, unknown>>, key: string) => {
  const value = row[key]
  if (value !== null && typeof value !== "string") {
    throw new Error(`SQLite field ${key} is not a nullable string`)
  }
  return value
}

const numberField = (row: Readonly<Record<string, unknown>>, key: string) => {
  const value = row[key]
  if (typeof value !== "number") throw new Error(`SQLite field ${key} is not a number`)
  return value
}

const jsonField = (row: Readonly<Record<string, unknown>>, key: string): unknown =>
  JSON.parse(stringField(row, key)) as unknown

const stringArrayJsonField = (row: Readonly<Record<string, unknown>>, key: string) => {
  const value: unknown = jsonField(row, key)
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`SQLite field ${key} is not a string array`)
  }
  return value
}

const installPullRequestRepository = async (source: string, remote: string) => {
  await mkdir(source, { recursive: true })
  realGit(source, "init")
  await writeFile(join(source, "src-app.tsx"), "old\n")
  realGit(source, "add", ".")
  commit(source, "base")
  const baseSha = realGit(source, "rev-parse", "HEAD")
  realGit(process.cwd(), "clone", "--bare", source, remote)
  realGit(source, "remote", "add", "origin", "git@github.com:fungsi/diffdash.git")
  await writeFile(join(source, "src-app.tsx"), "new\n")
  realGit(source, "add", ".")
  commit(source, "feature")
  const headSha = realGit(source, "rev-parse", "HEAD")
  realGit(source, "push", remote, "HEAD:refs/pull/51/head")
  realGit(source, "reset", "--hard", baseSha)
  await writeFile(join(source, "user-local.txt"), "preserve\n")
  return { baseSha, headSha, remote }
}

const commit = (cwd: string, message: string) =>
  realGit(
    cwd,
    "-c",
    "user.name=DiffDash Test",
    "-c",
    "user.email=test@diffdash.dev",
    "commit",
    "-m",
    message,
  )

const realGit = (cwd: string, ...args: readonly string[]) =>
  execFileSync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

const fakeDiffDashScript = `#!/usr/bin/env node
process.exit(0)
`

const fakeGitScript = `#!/usr/bin/env node
import { spawnSync } from "node:child_process"
const args = process.argv.slice(2)
const joined = args.join(" ")
const repoRoot = process.env.FAKE_REPO_ROOT ?? "/tmp/diffdash-local-repo"

if (process.env.FAKE_USE_REAL_GIT === "1") {
  if (joined.includes("remote get-url origin")) {
    console.log("git@github.com:fungsi/diffdash.git")
    process.exit(0)
  }
  const result = spawnSync(process.env.REAL_GIT_PATH ?? "/usr/bin/git", args, {
    env: process.env,
    stdio: "inherit"
  })
  process.exit(result.status ?? 1)
}

if (args[0] === "--version") {
  console.log("git version 2.50.0")
  process.exit(0)
}

if (joined.includes("rev-parse --show-toplevel")) {
  console.log(repoRoot)
  process.exit(0)
}

if (joined.includes("branch --show-current")) {
  console.log("feature/local-review")
  process.exit(0)
}

if (joined.includes("check-ref-format --branch dev")) {
  console.log("dev")
  process.exit(0)
}

if (joined.includes("fetch --no-tags origin +refs/heads/dev:refs/remotes/origin/dev")) {
  process.exit(0)
}

if (joined.includes("rev-parse --verify --end-of-options refs/remotes/origin/dev^{commit}")) {
  console.log("dddddddddddddddddddddddddddddddddddddddd")
  process.exit(0)
}

if (joined.includes("merge-base dddddddddddddddddddddddddddddddddddddddd HEAD")) {
  console.log("cccccccccccccccccccccccccccccccccccccccc")
  process.exit(0)
}

if (joined.includes("rev-parse --verify HEAD")) {
  console.log("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
  process.exit(0)
}

if (joined.includes("diff --no-ext-diff bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --")) {
  console.log([
    "diff --git a/src/local.ts b/src/local.ts",
    "index 1111111..2222222 100644",
    "--- a/src/local.ts",
    "+++ b/src/local.ts",
    "@@ -1,1 +1,1 @@",
    "-old local",
    "+new local"
  ].join("\\n"))
  process.exit(0)
}

if (joined.includes("diff --no-ext-diff cccccccccccccccccccccccccccccccccccccccc --")) {
  console.log([
    "diff --git a/src/local.ts b/src/local.ts",
    "index 1111111..2222222 100644",
    "--- a/src/local.ts",
    "+++ b/src/local.ts",
    "@@ -1,1 +1,1 @@",
    "-dev version",
    "+feature worktree"
  ].join("\\n"))
  process.exit(0)
}

if (joined.includes("ls-files --others --exclude-standard -z")) {
  process.stdout.write("notes.txt\\0")
  process.exit(0)
}

if (args[0] === "diff" && args.includes("--no-index")) {
  console.log([
    "diff --git a/notes.txt b/notes.txt",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/notes.txt",
    "@@ -0,0 +1 @@",
    "+local note"
  ].join("\\n"))
  process.exit(1)
}

console.error("Unhandled fake git call: " + joined)
process.exit(1)
`

const fakeCodexScript = `#!/usr/bin/env node
import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)

if (args[0] === "--version") {
  console.log("codex 0.1.0")
  process.exit(0)
}

if (!args.includes("exec")) {
  console.error("Unhandled fake codex call: " + args.join(" "))
  process.exit(1)
} else if (args.includes("--output-schema")) {
    if (process.env.FAKE_CODEX_RUN_LOG) {
      appendFileSync(process.env.FAKE_CODEX_RUN_LOG, "run\\n")
    }
    setTimeout(() => {
      console.log([
        JSON.stringify({ type: "thread.started", thread_id: "codex-e2e-thread" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "message-1",
            type: "agent_message",
            text: JSON.stringify({
              bodyMarkdown: "The line check is complete.",
              threadSummaryUpdate: null,
              referencedAnchors: null
            })
          }
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 }
        })
      ].join("\\n"))
      process.exit(0)
    }, 500)
} else {
  console.log(JSON.stringify({
    title: "Review path",
    summary: "Review the app entry point first.",
    chapters: [{
      id: "c1",
      title: "Runtime",
      summary: "Runtime behavior changes.",
      stops: [{
        id: "s1",
        title: "Entry point",
        summary: "The changed app file owns the visible review behavior.",
        risk: "critical",
        hunkIds: ["h1"]
      }]
    }]
  }))
  process.exit(0)
}
`

const fakeClaudeScript = `#!/usr/bin/env node
const args = process.argv.slice(2)

if (args[0] === "--version") {
  console.log("claude 0.1.0")
  process.exit(0)
}

if (args.includes("stream-json")) {
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "claude-e2e-session",
    result: JSON.stringify({
      bodyMarkdown: "Claude completed the line review.",
      threadSummaryUpdate: null,
      referencedAnchors: null
    }),
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 10 }
  }))
  process.exit(0)
}

if (args[0] === "--print") {
  console.log(JSON.stringify({
    title: "Review path",
    summary: "Review the app entry point first.",
    chapters: [{
      id: "c1",
      title: "Runtime",
      summary: "Runtime behavior changes.",
      stops: [{
        id: "s1",
        title: "Entry point",
        summary: "The changed app file owns the visible review behavior.",
        risk: "critical",
        hunkIds: ["h1"]
      }]
    }]
  }))
  process.exit(0)
}

console.error("Unhandled fake claude call: " + args.join(" "))
process.exit(1)
`

const fakeOpenCodeScript = `#!/usr/bin/env node
import { createServer } from "node:http"
const args = process.argv.slice(2)
if (args.includes("--version")) {
  console.log("opencode 0.1.0")
  process.exit(0)
}
if (args[0] === "serve") {
  const port = Number((args.find((arg) => arg.startsWith("--port=")) ?? "").slice(7))
  const server = createServer((request, response) => {
    request.resume()
    request.on("end", () => {
      response.setHeader("content-type", "application/json")
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname
      if (request.method === "POST" && pathname.startsWith("/session/") && pathname.endsWith("/message")) {
        response.end(JSON.stringify({
          info: {
            id: "opencode-e2e-message",
            modelID: "gpt-5.3-codex-spark",
            providerID: "openai",
            structured: {
              bodyMarkdown: "OpenCode completed the line review.",
              threadSummaryUpdate: null,
              referencedAnchors: null
            },
            tokens: { input: 10, output: 10, cache: { read: 0, write: 0 } },
            cost: 0
          },
          parts: []
        }))
        return
      }
      if (request.method === "POST" && pathname.startsWith("/session/") && pathname.endsWith("/abort")) {
        response.end("true")
        return
      }
      if (request.method === "POST" && pathname === "/session") {
        response.end(JSON.stringify({ id: "opencode-e2e-session" }))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: "Unhandled fake OpenCode route " + request.method + " " + request.url }))
    })
  })
  server.listen(port, "127.0.0.1", () => {
    console.log("opencode server listening on http://127.0.0.1:" + port)
  })
  process.on("SIGTERM", () => server.close(() => process.exit(0)))
} else {
  console.error("Unhandled fake opencode call: " + args.join(" "))
  process.exit(2)
}
`

const fakeGhScript = `#!/usr/bin/env node
const args = process.argv.slice(2)
const joined = args.join(" ")

const pullRequest = {
  author: { login: "octocat" },
  baseRefName: "main",
  baseRefOid: process.env.FAKE_PR_BASE_SHA ?? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  body: "Please review this workspace change.",
  createdAt: "2026-07-07T00:00:00Z",
  headRefName: "feature/requested-review",
  headRefOid: process.env.FAKE_PR_HEAD_SHA ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  isDraft: false,
  number: 51,
  state: "OPEN",
  title: "Request review flow",
  updatedAt: "2026-07-07T02:00:00Z",
  url: "https://github.com/fungsi/diffdash/pull/51"
}

if (args[0] === "--version") {
  console.log("gh version 2.76.1")
  process.exit(0)
}

if (args[0] === "search" && args[1] === "repos" && args[2] === "--help") {
  console.log("Search for repositories on GitHub.")
  process.exit(0)
}

if (args[0] === "search" && args[1] === "repos") {
  console.log("[]")
  process.exit(0)
}

if (args[0] === "auth" && args[1] === "status") {
  console.log("Logged in to github.com")
  process.exit(0)
}

if (args[0] === "api" && args[1] === "graphql") {
  if (joined.includes("review-requested:@me")) {
    console.log(JSON.stringify({
      data: {
        search: {
          nodes: [{
            ...pullRequest,
            repository: { name: "diffdash", owner: { login: "fungsi" } }
          }]
        }
      }
    }))
    process.exit(0)
  }

  if (joined.includes("latestReviews")) {
    console.log(JSON.stringify({
      data: {
        viewer: { login: "hanipcode" },
        repository: {
          pullRequest: {
            latestReviews: { nodes: [] }
          }
        }
      }
    }))
    process.exit(0)
  }

  console.log(JSON.stringify({ data: { viewer: { repositories: { nodes: [] } } } }))
  process.exit(0)
}

if (args[0] === "pr" && args[1] === "review" && args.includes("--approve")) {
  process.exit(0)
}

if (args[0] === "pr" && args[1] === "list") {
  console.log(JSON.stringify([pullRequest]))
  process.exit(0)
}

if (args[0] === "pr" && args[1] === "view") {
  const jsonFields = args[args.indexOf("--json") + 1] ?? ""
  if (jsonFields === "headRefOid") {
    console.log(JSON.stringify({ headRefOid: pullRequest.headRefOid }))
    process.exit(0)
  }

  console.log(JSON.stringify({
    ...pullRequest,
    commits: [],
    files: [{
      additions: 1,
      changeType: "modified",
      deletions: 1,
      path: "src/app.tsx"
    }]
  }))
  process.exit(0)
}

if (args[0] === "pr" && args[1] === "diff") {
  console.log([
    "diff --git a/src/app.tsx b/src/app.tsx",
    "index 1111111..2222222 100644",
    "--- a/src/app.tsx",
    "+++ b/src/app.tsx",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new"
  ].join("\\n"))
  process.exit(0)
}

console.error("Unhandled fake gh call: " + joined)
process.exit(1)
`
