/* eslint-disable no-await-in-loop -- Isolated clips must record sequentially to avoid Chromium video contention. */
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { createServer } from "vite"

import type { DemoManifest } from "./framework"
import { ensureCursor, setHumanSeed } from "./human"
import { runSteps } from "./interpret"
import { stories } from "./stories"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(packageRoot, "../..")
const storyId = process.argv[2] ?? "diffdash-0.4.3"
const story = stories[storyId]
if (story === undefined) throw new Error(`Unknown demo story: ${storyId}`)

const desktopPackage = JSON.parse(
  await readFile(resolve(workspaceRoot, "packages/desktop/package.json"), "utf8"),
) as { readonly version: string }
if (storyId === "diffdash-0.4.3" && desktopPackage.version !== "0.4.3") {
  throw new Error(`Story ${storyId} does not match desktop version ${desktopPackage.version}`)
}

const viewport = { width: 1440, height: 900 } as const
const outputDirectory = resolve(packageRoot, "output", story.id)
await mkdir(outputDirectory, { recursive: true })
for (const file of await readdir(outputDirectory)) {
  if (/^(FAILED-|\.card-|\.seg-)|\.(webm|mp4|png|json)$/u.test(file)) {
    await rm(resolve(outputDirectory, file), { force: true })
  }
}

const server = await createServer({
  configFile: resolve(packageRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
})
await server.listen()
const serverUrl = server.resolvedUrls?.local[0]
if (serverUrl === undefined) throw new Error("Demo host did not expose a local URL")

const browser = await chromium.launch({ headless: true })
const manifestClips: DemoManifest["clips"][number][] = []
try {
  for (const [index, clip] of story.clips.entries()) {
    process.stdout.write(`[demo] recording ${clip.name}\n`)
    setHumanSeed(index + 1)
    const context = await browser.newContext({
      viewport,
      recordVideo: { dir: outputDirectory, size: viewport },
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "dark",
      reducedMotion: "no-preference",
    })
    const page = await context.newPage()
    const video = page.video()
    const recordingStartedAt = performance.now()
    let trimStartSeconds = 0
    try {
      await page.clock.install({ time: new Date("2026-07-10T08:36:19Z") })
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url())
        if (url.hostname === "127.0.0.1") await route.continue()
        else await route.abort("blockedbyclient")
      })
      await page.goto(serverUrl, { waitUntil: "domcontentloaded" })
      await page.waitForFunction(
        () =>
          document.documentElement.dataset.demoReady === "true" ||
          document.documentElement.dataset.demoError === "true",
      )
      const startupError = await page
        .locator(".demo-error")
        .textContent()
        .catch(() => null)
      if (startupError !== null) throw new Error(startupError)
      await page.evaluate(() => document.fonts.ready)
      await ensureCursor(page)
      trimStartSeconds = Math.max(0, (performance.now() - recordingStartedAt) / 1_000 - 0.3)
      await page.waitForTimeout(500)
      await runSteps(page, clip.steps)
      await page.waitForTimeout(500)
    } catch (error) {
      await page
        .screenshot({ path: resolve(outputDirectory, `FAILED-${clip.name}.png`), fullPage: true })
        .catch(() => undefined)
      throw error
    } finally {
      await context.close()
    }
    if (video === null) throw new Error(`Playwright did not create video for ${clip.name}`)
    const source = await video.path()
    const file = `${clip.name}.webm`
    await rename(source, resolve(outputDirectory, file))
    manifestClips.push({ name: clip.name, file, trimStartSeconds, card: clip.card })
  }
} finally {
  await browser.close()
  await server.close()
}

const manifest: DemoManifest = {
  schemaVersion: 1,
  story: story.id,
  title: story.title,
  viewport,
  intro: story.intro,
  outro: story.outro,
  clips: manifestClips,
}
await writeFile(resolve(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`[demo] recorded ${manifestClips.length} clips in ${outputDirectory}\n`)
