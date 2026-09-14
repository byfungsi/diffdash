import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"

import { installDiffDashE2eApi } from "../helpers/diffdash-bridge"
import { installExecutableFixture } from "../helpers/executable-fixture"
import { packagedE2eExecutable } from "../helpers/packaged-repository-scale"

for (const packaging of ["unpacked", "AppImage"] as const) {
  test(`starts a fresh ${packaging} profile and reopens with a legacy fallback flag`, async ({
    browserName: _browserName,
  }, testInfo) => {
    test.skip(packaging === "AppImage" && process.platform !== "linux", "AppImages run on Linux")
    test.setTimeout(120_000)
    const home = testInfo.outputPath("home")
    const bin = testInfo.outputPath("bin")
    const xdgConfigHome = testInfo.outputPath("config")
    const configDirectory = join(xdgConfigHome, "diffdash")
    const legacyFlagPath = join(configDirectory, "core-no-fallback.json")
    const legacyFlag = '{"schemaVersion":1,"fallbackAllowed":false}'
    await mkdir(home, { recursive: true })
    for (const name of ["git", "gh", "codex", "claude", "opencode", "bun"]) {
      await installExecutableFixture(bin, name, "process.exit(1)\n")
    }
    await expect(access(configDirectory)).rejects.toMatchObject({ code: "ENOENT" })

    let executablePath = packagedE2eExecutable()
    if (packaging === "AppImage") {
      // PATH and HOME exclude the CI-installed Bun. Conventional system candidates must be absent too.
      for (const bunPath of ["/usr/local/bin/bun", "/usr/bin/bun"]) {
        await expect(access(bunPath)).rejects.toMatchObject({ code: "ENOENT" })
      }
      const dist = join(process.cwd(), "../desktop/dist")
      const images = (await readdir(dist)).filter((name) => name.endsWith(".AppImage"))
      const image = images[0]
      if (images.length !== 1 || image === undefined) {
        throw new Error("Startup recovery requires exactly one packaged AppImage")
      }
      executablePath = join(dist, image)
    }
    const environment = {
      ...process.env,
      APPIMAGE_EXTRACT_AND_RUN: "1",
      DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
      DIFFDASH_E2E_CORE_HOST: packaging === "AppImage" ? "" : "utility",
      DIFFDASH_E2E_DISABLE_UPDATES: "1",
      DIFFDASH_E2E_HIDDEN: "1",
      DIFFDASH_E2E_FAKE_AGENT_PROVIDER: "1",
      DIFFDASH_E2E_FAKE_GIT_PROVIDER: "0",
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_CACHE_HOME: testInfo.outputPath("cache"),
    }
    const launchOptions = {
      executablePath,
      args: [`--user-data-dir=${testInfo.outputPath("user-data")}`],
      env: environment,
    }

    for (const launch of ["first", "legacy-flag", "malformed-flag"] as const) {
      const app = await electron.launch(launchOptions)
      try {
        const window = await app.firstWindow()
        await window.evaluate(installDiffDashE2eApi)
        const completed = await window.evaluate(async () => {
          const state = await globalThis.window.diffDashForE2e.appState.get()
          return state.onboardingCompleted
        })
        expect(completed).toBe(launch !== "first")
        expect(
          await app.evaluate(({ app: runtimeApp }) =>
            runtimeApp
              .getAppMetrics()
              .some((metric) => metric.type === "Utility" && metric.name === "DiffDash Core"),
          ),
        ).toBe(true)
        if (packaging === "AppImage") {
          expect(await app.evaluate(() => process.env.APPIMAGE)).toBe(executablePath)
        }
        if (launch === "first") {
          await window.evaluate(async () => {
            const state = await globalThis.window.diffDashForE2e.appState.get()
            await globalThis.window.diffDashForE2e.appState.update({
              ...state,
              onboardingCompleted: true,
            })
          })
        }
      } finally {
        await app.close()
      }

      if (launch === "first") {
        await expect(access(legacyFlagPath)).rejects.toMatchObject({ code: "ENOENT" })
        await mkdir(configDirectory, { recursive: true })
        await writeFile(legacyFlagPath, legacyFlag, "utf8")
      } else if (launch === "legacy-flag") {
        expect(await readFile(legacyFlagPath, "utf8")).toBe(legacyFlag)
        await writeFile(legacyFlagPath, "not-json", "utf8")
      } else {
        expect(await readFile(legacyFlagPath, "utf8")).toBe("not-json")
      }
    }
  })
}
