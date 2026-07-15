import { mkdir } from "node:fs/promises"
import { setTimeout as pause } from "node:timers/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { chromium } from "playwright"
import { createServer } from "vite"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(scriptDirectory, "../..")
const cacheDirectory = resolve(workspaceRoot, "media/.cache/app-demo")
const outputDirectory = resolve(workspaceRoot, "media/output")
const rawVideoPath = resolve(cacheDirectory, "diffdash-v0.2.1-app-demo.webm")
const outputPath = resolve(outputDirectory, "diffdash-v0.2.1-app-demo-landscape.mp4")
const viewport = { width: 1600, height: 900 }

await mkdir(cacheDirectory, { recursive: true })
await mkdir(outputDirectory, { recursive: true })

const server = await createServer({
  configFile: resolve(workspaceRoot, "demo/capture/vite.config.ts"),
  server: { host: "127.0.0.1", port: 0 },
})
await server.listen()
const serverUrl = server.resolvedUrls?.local[0]
if (serverUrl === undefined) throw new Error("Capture host did not expose a local URL")

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport,
  recordVideo: { dir: cacheDirectory, size: viewport },
  locale: "en-US",
  timezoneId: "UTC",
  colorScheme: "dark",
  reducedMotion: "no-preference",
})
const recordingStartedAt = performance.now()
const page = await context.newPage()
const video = page.video()
let trimOffsetSeconds = 0

try {
  await page.clock.install({ time: new Date("2026-07-10T08:36:19Z") })
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === "127.0.0.1") {
      await route.continue()
      return
    }
    await route.abort("blockedbyclient")
  })
  await page.goto(serverUrl)
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.demoReady === "true" ||
      document.documentElement.dataset.demoError === "true",
  )
  const startupError = await page
    .locator(".capture-error")
    .textContent()
    .catch(() => null)
  if (startupError !== null) throw new Error(startupError)
  await page.evaluate(() => document.fonts.ready)
  await installVisibleCursor(page)
  await page.evaluate(() => {
    document.documentElement.dataset.demoCapture = "video"
  })
  trimOffsetSeconds = Math.max(0, (performance.now() - recordingStartedAt) / 1_000 - 0.5)

  await pause(1_600)
  await moveAndClick(
    page.getByRole("button", {
      name: "Open requested review #417: Make webhook replay claims atomic",
    }),
  )
  await page.getByRole("heading", { name: "Review threads" }).waitFor({ state: "visible" })
  await pause(2_200)

  await moveAndClick(page.getByRole("button", { name: "Walkthrough", exact: true }))
  await page.getByText("Review focus", { exact: true }).waitFor({ state: "visible" })
  await pause(2_000)
  await moveAndClick(
    page.getByRole("button", {
      name: "Select walkthrough step 2: Acquire or recover in one statement",
    }),
  )
  await pause(2_200)

  await moveAndClick(
    page.getByRole("button", { name: "packages/db/src/replay-claims.ts:20 · new", exact: true }),
  )
  const followUp = page.getByRole("textbox", { name: "Thread message" })
  await followUp.waitFor({ state: "visible" })
  await pause(1_400)
  await moveAndClick(followUp)
  await followUp.pressSequentially("Can two regions disagree if their worker clocks drift?", {
    delay: 42,
  })
  await pause(650)
  await moveAndClick(page.getByRole("button", { name: "Send", exact: true }))
  await page.waitForFunction(() =>
    window["__diffDashDemo"].getState().pendingAgentTurnIds.includes("turn-lease-follow-up"),
  )
  await page.getByText("Preparing review context...", { exact: true }).waitFor({ state: "visible" })
  await pause(2_400)

  await page.evaluate(() => window["__diffDashDemo"].release("turn-lease-follow-up"))
  await page.getByText(/Revision 2 closes that gap/).waitFor({ state: "visible" })
  await pause(4_000)

  await page.evaluate(() => window["__diffDashDemo"].release("revision-updated"))
  await moveAndClick(page.getByRole("button", { name: "Actions", exact: true }))
  await moveAndClick(
    page.getByRole("menu", { name: "Review actions" }).getByRole("menuitem", {
      name: /Reload diff/,
    }),
  )
  await page.getByText("f16d263b", { exact: true }).waitFor({ state: "visible" })
  await pause(2_000)
  await moveAndClick(
    page.getByRole("button", { name: "packages/db/src/replay-claims.ts:20 · new", exact: true }),
  )
  const previousRevision = page.getByText("Previous revision", { exact: true })
  await previousRevision.waitFor({ state: "visible" })
  await previousRevision.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest" }),
  )
  await pause(2_600)

  await moveAndClick(page.getByRole("button", { name: "Actions", exact: true }))
  await moveAndClick(
    page.getByRole("menu", { name: "Review actions" }).getByRole("menuitem", { name: /^Approve/ }),
  )
  await page.waitForFunction(() => window["__diffDashDemo"].getState().approved)
  await pause(1_300)
  await moveAndClick(page.getByRole("button", { name: "Actions", exact: true }))
  await page
    .getByRole("menu", { name: "Review actions" })
    .getByRole("menuitem", { name: /^Approve/ })
    .waitFor({ state: "visible" })
  await pause(2_000)
} finally {
  await context.close()
  await video?.saveAs(rawVideoPath)
  await browser.close()
  await server.close()
}

run("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-ss",
  trimOffsetSeconds.toFixed(3),
  "-i",
  rawVideoPath,
  "-vf",
  "scale=1920:1080:flags=lanczos",
  "-r",
  "30",
  "-an",
  "-c:v",
  "libx264",
  "-preset",
  "medium",
  "-crf",
  "22",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  "-metadata",
  "title=DiffDash v0.2.1 App Demo",
  outputPath,
])
process.stdout.write("Recorded media/output/diffdash-v0.2.1-app-demo-landscape.mp4\n")

async function moveAndClick(locator) {
  await locator.scrollIntoViewIfNeeded()
  const bounds = await locator.boundingBox()
  if (bounds === null) throw new Error("Demo interaction target has no bounding box")
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 24 })
  await pause(420)
  await page.mouse.down()
  await pause(110)
  await page.mouse.up()
  await pause(520)
}

async function installVisibleCursor(targetPage) {
  await targetPage.addStyleTag({
    content: `
      * { cursor: none !important; }
      [data-demo-pointer] {
        position: fixed;
        left: 0;
        top: 0;
        z-index: 2147483647;
        width: 25px;
        height: 33px;
        pointer-events: none;
        background: #f8fafc;
        clip-path: polygon(0 0, 82% 70%, 51% 73%, 67% 100%, 53% 100%, 37% 76%, 17% 100%);
        filter: drop-shadow(0 3px 4px rgba(0, 0, 0, .8));
        transform: translate(1200px, 760px);
      }
      [data-demo-click] {
        position: fixed;
        z-index: 2147483646;
        width: 42px;
        height: 42px;
        margin: -21px 0 0 -21px;
        border: 2px solid #22c983;
        border-radius: 999px;
        pointer-events: none;
        animation: demo-click 420ms ease-out forwards !important;
      }
      @keyframes demo-click {
        from { opacity: 1; transform: scale(.45); }
        to { opacity: 0; transform: scale(1.25); }
      }
    `,
  })
  await targetPage.evaluate(() => {
    const cursor = document.createElement("div")
    cursor.dataset.demoPointer = ""
    document.body.append(cursor)
    document.addEventListener("mousemove", (event) => {
      cursor.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`
    })
    document.addEventListener("mousedown", (event) => {
      const click = document.createElement("div")
      click.dataset.demoClick = ""
      click.style.left = `${event.clientX}px`
      click.style.top = `${event.clientY}px`
      click.addEventListener("animationend", () => click.remove(), { once: true })
      document.body.append(click)
    })
  })
}

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { encoding: "utf8" })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
}
