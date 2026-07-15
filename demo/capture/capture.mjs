import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { createServer } from "vite"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(scriptDirectory, "../..")
const scenarioId = "atomic-webhook-replay"
const campaignId = "ai-review"
const viewport = { width: 1440, height: 900 }
const outputDirectory = resolve(workspaceRoot, "media/public/captures", campaignId)
const manifestPath = resolve(outputDirectory, "capture-manifest.json")
const fontDirectory = resolve(workspaceRoot, "media/public/fonts")
const fixedTime = "2026-07-10T08:36:19Z"

await mkdir(outputDirectory, { recursive: true })
await mkdir(fontDirectory, { recursive: true })
await copyFile(
  resolve(workspaceRoot, "demo/capture/src/Inter-Latin.woff2"),
  resolve(fontDirectory, "Inter-Latin.woff2"),
)

const server = await createServer({
  configFile: resolve(workspaceRoot, "demo/capture/vite.config.ts"),
  server: { host: "127.0.0.1", port: 0 },
})
await server.listen()
const serverUrl = server.resolvedUrls?.local[0]
if (serverUrl === undefined) throw new Error("Capture host did not expose a local URL")

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({
  viewport,
  deviceScaleFactor: 2,
  locale: "en-US",
  timezoneId: "UTC",
  colorScheme: "dark",
  reducedMotion: "reduce",
})
const checkpoints = []

try {
  await page.clock.install({ time: new Date(fixedTime) })
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

  await capture("home-ready", {
    reviewRequest: page.getByRole("button", {
      name: "Open requested review #417: Make webhook replay claims atomic",
    }),
  })

  await page
    .getByRole("button", {
      name: "Open requested review #417: Make webhook replay claims atomic",
    })
    .click()
  await page.getByRole("heading", { name: "Review threads" }).waitFor({ state: "visible" })
  await capture("review-diff", {
    primaryDiff: page.locator(
      '[data-diff-card-path="packages/db/migrations/202607091430_add_replay_claims.sql"]',
    ),
    reviewHeader: page.getByText("Make webhook replay claims atomic", { exact: true }),
  })

  await page.getByRole("button", { name: "Walkthrough", exact: true }).click()
  await page.getByText("Review focus", { exact: true }).waitFor({ state: "visible" })
  await capture("walkthrough-critical", {
    reviewFocus: page.getByText("Review focus", { exact: true }),
    criticalStep: page.getByRole("button", {
      name: "Select walkthrough step 1: Persist one active claim per delivery",
    }),
  })

  await page
    .getByRole("button", { name: "packages/db/src/replay-claims.ts:20 · new", exact: true })
    .click()
  const followUp = page.getByRole("textbox", { name: "Thread message" })
  await followUp.waitFor({ state: "visible" })
  await followUp.fill("Can two regions disagree if their worker clocks drift?")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await page.waitForFunction(() =>
    window["__diffDashDemo"].getState().pendingAgentTurnIds.includes("turn-lease-follow-up"),
  )
  await page.getByText("Preparing review context...", { exact: true }).waitFor({ state: "visible" })
  await capture("thread-pending", {
    thread: page.locator('[data-review-thread-id="thread-replay-lease"]'),
    progress: page.getByText("Preparing review context...", { exact: true }),
  })

  await page.evaluate(() => window["__diffDashDemo"].release("turn-lease-follow-up"))
  await page.getByText(/Revision 2 closes that gap/).waitFor({ state: "visible" })
  await capture("thread-complete", {
    thread: page.locator('[data-review-thread-id="thread-replay-lease"]'),
    response: page.getByText(/Revision 2 closes that gap/),
  })

  await page.evaluate(() => window["__diffDashDemo"].release("revision-updated"))
  await page.getByRole("button", { name: "Actions", exact: true }).click()
  const reviewActions = page.getByRole("menu", { name: "Review actions" })
  await reviewActions.getByRole("menuitem", { name: /Reload diff/ }).click()
  await page.getByText("f16d263b", { exact: true }).waitFor({ state: "visible" })
  await page
    .getByRole("button", { name: "packages/db/src/replay-claims.ts:20 · new", exact: true })
    .click()
  const previousRevision = page.getByText("Previous revision", { exact: true })
  await previousRevision.waitFor({ state: "visible" })
  await previousRevision.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest" }),
  )
  await page.waitForFunction(() => {
    const badge = [...document.querySelectorAll("span")].find(
      (element) => element.textContent === "Previous revision",
    )
    if (badge === undefined) return false
    const bounds = badge.getBoundingClientRect()
    return bounds.top > 150 && bounds.bottom < window.innerHeight
  })
  await capture("revision-updated", {
    carriedThread: previousRevision,
  })

  await page.getByRole("button", { name: "Actions", exact: true }).click()
  await page
    .getByRole("menu", { name: "Review actions" })
    .getByRole("menuitem", { name: /^Approve/ })
    .click()
  await page.waitForFunction(() => window["__diffDashDemo"].getState().approved)
  await page.getByRole("button", { name: "Actions", exact: true }).click()
  await page
    .getByRole("menu", { name: "Review actions" })
    .getByRole("menuitem", { name: /^Approve/ })
    .waitFor({ state: "visible" })
  await capture("approved", {
    approval: page
      .getByRole("menu", { name: "Review actions" })
      .getByRole("menuitem", { name: /^Approve/ }),
  })

  await page.keyboard.press("Escape")
  await page.evaluate(() => window["__diffDashDemo"].release("update-available"))
  await page.getByRole("button", { name: "Download update" }).click()
  await page.evaluate(() => window["__diffDashDemo"].release("update-downloaded"))
  await page.getByRole("button", { name: "Restart and update" }).waitFor({ state: "visible" })
  await capture("update-downloaded", {
    updateBanner: page.locator("aside").filter({ hasText: "DiffDash v0.2.2 is ready" }),
  })

  const cacheKey = await hashCaptureInputs()
  const packageJson = JSON.parse(
    await readFile(resolve(workspaceRoot, "packages/desktop/package.json"), "utf8"),
  )
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        campaignId,
        scenarioId,
        capturedAt: fixedTime,
        cacheKey,
        viewport,
        deviceScaleFactor: 2,
        locale: "en-US",
        timezone: "UTC",
        theme: "dark",
        appVersion: packageJson.version,
        nodeVersion: process.version,
        checkpoints,
      },
      null,
      2,
    )}\n`,
  )
  process.stdout.write(
    `Captured ${checkpoints.length} product checkpoints in ${relative(workspaceRoot, outputDirectory)}\n`,
  )
} finally {
  await browser.close()
  await server.close()
}

async function capture(name, targets) {
  const targetRectangles = Object.fromEntries(
    await Promise.all(
      Object.entries(targets).map(async ([targetName, locator]) => {
        await locator.waitFor({ state: "visible" })
        const box = await locator.boundingBox()
        if (box === null)
          throw new Error(`Capture target ${name}.${targetName} has no bounding box`)
        return [targetName, box]
      }),
    ),
  )
  const fileName = `${name}.png`
  await page.screenshot({ path: resolve(outputDirectory, fileName) })
  const state = await page.evaluate(() => window["__diffDashDemo"].getState())
  const actionCount = await page.evaluate(() => window["__diffDashDemo"].getActionLog().length)
  checkpoints.push({ name, fileName, state, targetRectangles, actionCount })
}

async function hashCaptureInputs() {
  const hash = createHash("sha256")
  const roots = [
    resolve(workspaceRoot, "demo/scenarios", scenarioId),
    resolve(workspaceRoot, "demo/capture"),
    resolve(workspaceRoot, "src/demo"),
    resolve(workspaceRoot, "pnpm-lock.yaml"),
  ]
  const files = (await Promise.all(roots.map((root) => listFiles(root))))
    .flat()
    .toSorted((left, right) => left.localeCompare(right))
  const contents = await Promise.all(files.map((file) => readFile(file)))
  for (const [index, file] of files.entries()) {
    hash.update(relative(workspaceRoot, file))
    hash.update(contents[index])
  }
  return hash.digest("hex")
}

async function listFiles(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null)
  if (entries === null) return [path]
  const children = await Promise.all(
    entries
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const child = resolve(path, entry.name)
        if (entry.isDirectory()) return listFiles(child)
        return child.includes(`${resolve(workspaceRoot, "demo/.cache")}/`) ? [] : [child]
      }),
  )
  return children.flat()
}
