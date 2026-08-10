/* eslint-disable no-await-in-loop -- Isolated clips must record sequentially to avoid Chromium video contention. */
import { readFile, rename, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { Schema } from "effect"
import { createServer } from "vite"

import { DemoArtifactTransaction } from "./artifact-transaction"
import { demoOutputRoot, demoVideoPackageRoot, demoWorkspaceRoot } from "./environment"
import { DEMO_VIEWPORT, type DemoManifest } from "./framework"
import { ensureCursor, setHumanSeed } from "./human"
import { runSteps } from "./interpret"
import { getStory } from "./stories"

/** Records every clip for one registered story and promotes the complete take transactionally. */
export const recordDemo = async (storyId: string) => {
  const story = getStory(storyId)
  await assertStoryVersion(story.id)
  return DemoArtifactTransaction.run(demoOutputRoot, story.id, "record", async (transaction) => {
    const { outputDirectory, stagingDirectory } = transaction
    const manifestClips: DemoManifest["clips"][number][] = []
    const server = await createServer({
      configFile: resolve(demoVideoPackageRoot, "vite.config.ts"),
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    })
    await server.listen()
    try {
      const serverUrl = server.resolvedUrls?.local[0]
      if (serverUrl === undefined) throw new Error("Demo host did not expose a local URL")
      const browser = await chromium.launch({ headless: true })
      try {
        for (const [index, clip] of story.clips.entries()) {
          process.stdout.write(`[demo] recording ${clip.name}\n`)
          setHumanSeed(index + 1)
          const context = await browser.newContext({
            viewport: DEMO_VIEWPORT,
            recordVideo: { dir: stagingDirectory, size: DEMO_VIEWPORT },
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
            // Playwright starts video with the context and exposes no recording timestamp for
            // demoReady. Keep the bounded wall-clock trim until a non-visible frame marker can
            // be detected without changing the delivered recording.
            trimStartSeconds = Math.max(0, (performance.now() - recordingStartedAt) / 1_000 - 0.3)
            await page.waitForTimeout(500)
            await runSteps(page, clip.steps)
            await page.waitForTimeout(500)
          } catch (cause) {
            await page
              .screenshot({
                path: transaction.stagePath(`FAILED-${clip.name}.png`),
                fullPage: true,
              })
              .catch(() => undefined)
            throw cause
          } finally {
            await context.close()
          }
          if (video === null) throw new Error(`Playwright did not create video for ${clip.name}`)
          const source = await video.path()
          const file = `${clip.name}.webm`
          await rename(source, transaction.stagePath(file))
          manifestClips.push({ name: clip.name, file, trimStartSeconds, card: clip.card })
        }
      } finally {
        await browser.close()
      }
    } finally {
      await server.close()
    }

    const manifest: DemoManifest = {
      schemaVersion: 1,
      story: story.id,
      title: story.title,
      viewport: DEMO_VIEWPORT,
      intro: story.intro,
      outro: story.outro,
      clips: manifestClips,
    }
    const stagedManifest = transaction.stagePath("manifest.json")
    await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`)
    const generatedFiles = [...manifest.clips.map(({ file }) => file), "manifest.json"] as const
    await transaction.commit(generatedFiles, { obsolete: (file) => file.endsWith(".webm") })
    process.stdout.write(`[demo] recorded ${manifestClips.length} clips in ${outputDirectory}\n`)
  })
}

const assertStoryVersion = async (storyId: string) => {
  const expectedVersion = storyId.startsWith("diffdash-") ? storyId.slice("diffdash-".length) : null
  if (expectedVersion === null) return
  const source = await readFile(resolve(demoWorkspaceRoot, "packages/desktop/package.json"), "utf8")
  let packageMetadata: { readonly version: string }
  try {
    packageMetadata = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
    )(source)
  } catch (cause) {
    throw new Error("Desktop package metadata is not valid JSON or has no string version", {
      cause,
    })
  }
  const version = packageMetadata.version
  if (version !== expectedVersion) {
    throw new Error(`Story ${storyId} does not match desktop version ${version}`)
  }
}
