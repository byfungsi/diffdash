import { spawnSync } from "node:child_process"
import { mkdir, access } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { _electron as electron, expect, test } from "@playwright/test"

import { installDiffDashE2eApi } from "../helpers/diffdash-bridge"
import { installExecutableFixture } from "../helpers/executable-fixture"
import {
  coreHostProcessIds,
  packagedE2eExecutable,
  processIsAlive,
} from "../helpers/packaged-repository-scale"

test("recovers a large profile and releases Core ownership after Electron dies", async ({
  browserName: _browserName,
}, testInfo) => {
  // Four real launches must each fit their production recovery budget, including slower runners.
  test.setTimeout(300_000)
  const host = process.env.DIFFDASH_E2E_CORE_HOST
  if (host !== "bun" && host !== "utility")
    throw new Error("Startup lifecycle requires an explicit Core host")
  const home = testInfo.outputPath("home")
  const bin = testInfo.outputPath("bin")
  const userData = testInfo.outputPath("user-data")
  const databasePath = join(userData, "diffdash.sqlite")
  await mkdir(home, { recursive: true })
  await Promise.all(
    ["git", "gh", "codex", "claude", "opencode"].map((name) =>
      installExecutableFixture(bin, name, "process.exit(1)\n"),
    ),
  )
  const launchOptions = {
    executablePath: packagedE2eExecutable(),
    args: [`--user-data-dir=${userData}`],
    env: {
      ...process.env,
      DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
      DIFFDASH_E2E_DISABLE_UPDATES: "1",
      DIFFDASH_E2E_HIDDEN: "1",
      DIFFDASH_E2E_FAKE_AGENT_PROVIDER: "1",
      DIFFDASH_E2E_FAKE_GIT_PROVIDER: "0",
      HOME: home,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: testInfo.outputPath("config"),
      XDG_CACHE_HOME: testInfo.outputPath("cache"),
    },
  }
  const initial = await electron.launch(launchOptions)
  try {
    const window = await initial.firstWindow()
    await window.evaluate(installDiffDashE2eApi)
    await window.evaluate(async () => {
      const state = await globalThis.window.diffDashForE2e.appState.get()
      await globalThis.window.diffDashForE2e.appState.update({
        ...state,
        onboardingCompleted: true,
      })
    })
  } finally {
    await initial.close()
  }

  // Synthetic disposable records only; the real profile and repository paths are never copied.
  await mkdir(`${databasePath}.snapshot-blocks/synthetic/a/b/block`, { recursive: true })
  const database = new DatabaseSync(databasePath)
  try {
    database.exec("BEGIN")
    const insert = database.prepare(`INSERT INTO resources
      (id, kind, policy_class, state, generation, location_kind, root_id,
       location_value, bytes, reserved_bytes, created_at_ms, updated_at_ms, last_used_at_ms)
      VALUES (?, 'snapshot-block', 'cache', 'ready', 1, 'filesystem',
        'core:snapshot-blocks:v1', 'synthetic/a/b/block', 0, 0, 1, 1, 1)`)
    for (let index = 0; index < 41_483; index += 1) insert.run(`synthetic-startup-${index}`)
    database.exec("COMMIT")
  } finally {
    database.close()
  }

  const crashDuringPhase = async (phase: "recovering" | "ready") => {
    const app = await electron.launch(launchOptions)
    const startupOutput: string[] = []
    const captureStartupOutput = (chunk: Buffer) => startupOutput.push(chunk.toString("utf8"))
    app.process().stdout?.on("data", captureStartupOutput)
    app.process().stderr?.on("data", captureStartupOutput)
    try {
      if (phase === "ready") {
        const window = await app.firstWindow({ timeout: 90_000 })
        await window.evaluate(installDiffDashE2eApi)
        expect(
          await window.evaluate(
            async () => (await globalThis.window.diffDashForE2e.appState.get()).onboardingCompleted,
          ),
        ).toBe(true)
      }
      await expect
        .poll(async () =>
          access(`${databasePath}.owner`).then(
            () => true,
            () => false,
          ),
        )
        .toBe(true)
      const electronPid = app.process().pid
      if (electronPid === undefined) throw new Error("Startup lifecycle lost its Electron process")
      const corePids = coreHostProcessIds(electronPid, host)
      expect(corePids).toHaveLength(1)
      expect(app.process().kill("SIGKILL")).toBe(true)
      await expect
        .poll(
          () => {
            const alive = corePids.filter(processIsAlive)
            if (alive.length === 0) return ""
            const sample = spawnSync(
              "ps",
              ["-p", alive.join(","), "-o", "pid=,ppid=,stat=,etime=,time="],
              { encoding: "utf8" },
            )
            if (sample.error !== undefined) throw sample.error
            if (sample.status !== 0 && sample.status !== 1)
              throw new Error("Startup lifecycle could not sample Core process state")
            return sample.stdout.trim()
          },
          { timeout: 10_000 },
        )
        .toBe("")
      // Electron can forcibly terminate utility children before their finalizers run. The next
      // launch must recover their stale lease; external Bun must finalize after socket disconnect.
      if (host === "bun") {
        await expect
          .poll(async () =>
            access(`${databasePath}.owner`).then(
              () => true,
              () => false,
            ),
          )
          .toBe(false)
      }
    } finally {
      await app.close().catch(() => undefined)
      await testInfo.attach(`${host}-${phase}-startup`, {
        body: startupOutput
          .join("")
          .split("\n")
          .filter((line) => line.startsWith("[startup") || line.includes("[core:recovery]"))
          .join("\n"),
        contentType: "text/plain",
      })
    }
  }
  await crashDuringPhase("recovering")
  await crashDuringPhase("ready")

  const reopened = await electron.launch(launchOptions)
  try {
    const window = await reopened.firstWindow({ timeout: 90_000 })
    await window.evaluate(installDiffDashE2eApi)
    expect(
      await window.evaluate(
        async () => (await globalThis.window.diffDashForE2e.appState.get()).onboardingCompleted,
      ),
    ).toBe(true)
  } finally {
    await reopened.close()
  }
  await expect(access(`${databasePath}.owner`)).rejects.toMatchObject({ code: "ENOENT" })
})
