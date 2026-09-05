import { App, trustedWebReviewExtensions } from "@diffdash/app"
import type { DiffDashApi } from "@diffdash/protocol/api"
import { AISettings } from "@diffdash/domain/ai-settings"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it } from "vitest"
import { page } from "vitest/browser"
import { StrictMode } from "react"
import { CloudRoot } from "./cloud-root"
import { CloudCommentNotes } from "./cloud-comment-notes"
import { HostedCommentNoteContext } from "@diffdash/domain/comment-note"
import { makeHostedRepositoryKey, makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { ClearCommentNotesRequest } from "@diffdash/protocol/comment-notes"
import { createCloudApi, createCloudBridge } from "./cloud-api"
import { createCloudNavigation, type CloudNavigationStatus } from "./cloud-navigation"
import { CloudStorage } from "./cloud-storage"
import { GithubClient } from "./github-client"
import {
  clearGithubPersonalAccessToken,
  parseGithubPersonalAccessToken,
} from "./github-credentials"
import { cloudFixtureHeadSha, cloudFixtureRequest } from "./cloud-review-fixtures"
import "./cloud.css"

let root: Root | null = null

it.each([
  "dark",
  "light",
  "system",
] as const)("applies the saved %s appearance before PAT sign-in", async (appearance) => {
  const storage = new CloudStorage()
  const previous = storage.loadSettings()
  clearGithubPersonalAccessToken()
  document.documentElement.classList.remove("dark")
  delete document.documentElement.dataset.theme
  storage.saveSettings(
    AISettings.make({ ...previous, appearance, themes: { light: "diffdash", dark: "diffdash" } }),
  )
  try {
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(<CloudRoot request={cloudFixtureRequest} />)
    await expect.element(page.getByRole("heading", { name: "Connect GitHub" })).toBeVisible()
    const scheme =
      appearance === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : appearance
    await expect.poll(() => document.documentElement.dataset.theme).toBe(`diffdash-${scheme}`)
    expect(document.documentElement.classList.contains("dark")).toBe(scheme === "dark")
    expect(document.documentElement.style.colorScheme).toBe(scheme)
  } finally {
    storage.saveSettings(previous)
  }
})
const originalUrl = window.location.href
afterEach(async () => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
  clearGithubPersonalAccessToken()
  window.history.replaceState(null, "", originalUrl)
  await page.viewport(1280, 900)
})

it.each([
  320, 390, 640,
])("opens the file tree from the compact titlebar at %s pixels", async (width) => {
  await page.viewport(width, 844)
  const { container } = renderCloudRoute("/cloud-fixture/review-fixture/pull/1/files")
  await expect.poll(() => renderedDiffText(container)).toContain("after route")
  await page.getByRole("button", { name: "Open file tree", exact: true }).click()
  const filter = container.querySelector('input[placeholder="Filter files"]')
  if (!(filter instanceof HTMLInputElement)) throw new Error("File filter is missing")
  await expect.element(filter).toBeVisible()
  await page.getByRole("button", { name: "Close file tree", exact: true }).click()
  await expect
    .element(page.getByRole("button", { name: "Open file tree", exact: true }))
    .toBeVisible()
  const shortcuts = container.querySelector("[data-workbench-keyboard-shortcuts]")
  const sidebar = container.querySelector("[data-workbench-sidebar-toggle]")
  expect(shortcuts?.getBoundingClientRect().width).toBe(0)
  expect(sidebar?.getBoundingClientRect().width).toBe(0)
  const command = container.querySelector("[data-workbench-command-center]")
  expect(command?.getBoundingClientRect().left).toBeLessThan(64)
  expect(command?.getBoundingClientRect().right).toBeLessThanOrEqual(width)
  expect(document.documentElement.scrollWidth).toBe(width)
  const header = container.querySelector("[data-diff-card-header]")
  expect(header?.scrollWidth).toBe(header?.clientWidth)
  expect(header?.getBoundingClientRect().height).toBeLessThanOrEqual(40)
  const card = container.querySelector("[data-diff-card-path]")
  if (card === null) throw new Error("Diff card is missing")
  expect(card.getBoundingClientRect().left).toBe(0)
  expect(card.getBoundingClientRect().width).toBe(width)
  expect(getComputedStyle(card).borderRadius).toBe("0px")
  const content = container.querySelector("[data-review-diff-content]")
  if (content === null) throw new Error("Diff content is missing")
  expect(getComputedStyle(content).padding).toBe("0px")
  expect(getComputedStyle(card).marginBottom).toBe("0px")
})

const renderCloudRoute = (
  path: string,
  request: typeof fetch = cloudFixtureRequest,
  configureApi: (api: DiffDashApi) => DiffDashApi = (api) => api,
) => {
  window.history.replaceState(null, "", path)
  const github = new GithubClient(
    parseGithubPersonalAccessToken("github_pat_test_fixture_only"),
    request,
  )
  const storage = new CloudStorage()
  Object.defineProperty(window, "diffDash", {
    configurable: true,
    value: createCloudBridge(configureApi(createCloudApi(github, storage))),
  })
  let status: CloudNavigationStatus = { kind: "loading" }
  const navigation = createCloudNavigation(
    github,
    storage,
    {
      pathname: () => window.location.pathname,
      push: (pathname) => window.history.pushState(null, "", pathname),
      subscribe: (listener) => {
        window.addEventListener("popstate", listener)
        return () => window.removeEventListener("popstate", listener)
      },
    },
    (next) => {
      status = next
    },
  )
  const container = document.createElement("div")
  container.style.height = "900px"
  document.body.append(container)
  root = createRoot(container)
  root.render(
    <App
      capabilities={{ localProjects: false, reviewViewport: "code-view" }}
      extensions={trustedWebReviewExtensions}
      navigation={navigation}
    />,
  )
  return { status: () => status, container }
}

it("loads a PR overview, navigates to files, and restores browser Back/Forward", async () => {
  const { status, container } = renderCloudRoute("/cloud-fixture/review-fixture/pull/1")
  await expect.poll(status).toEqual({ kind: "ready" })
  await expect.poll(() => container.textContent).toContain("Cloud route fixture PR")
  await expect
    .poll(() =>
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Open diff",
      ),
    )
    .toBeDefined()
  const files = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Open diff",
  )
  files?.click()
  await expect
    .poll(() => window.location.pathname)
    .toBe("/cloud-fixture/review-fixture/pull/1/files")
  window.history.back()
  await expect.poll(() => window.location.pathname).toBe("/cloud-fixture/review-fixture/pull/1")
  await expect.poll(status).toEqual({ kind: "ready" })
  window.history.forward()
  await expect
    .poll(() => window.location.pathname)
    .toBe("/cloud-fixture/review-fixture/pull/1/files")
  await expect.poll(() => container.textContent).toContain("route.txt")
})

it.each([
  "/cloud-fixture/review-fixture/pull/1/files",
  `/cloud-fixture/review-fixture/commit/${cloudFixtureHeadSha}`,
  "/cloud-fixture/review-fixture/compare/main...feature",
])("opens the diff directly at %s", async (path) => {
  const { status, container } = renderCloudRoute(path)
  await expect.poll(status).toEqual({ kind: "ready" })
  await expect.poll(() => container.textContent).toContain("route.txt")
  await expect.poll(() => renderedDiffText(container)).toContain("after route")
  expect(window.location.pathname).toBe(path)
})

const renderedDiffText = (container: Element | ShadowRoot): string => {
  let text = container.textContent ?? ""
  for (const element of container.querySelectorAll("*")) {
    if (element.shadowRoot !== null) text += renderedDiffText(element.shadowRoot)
  }
  return text
}

it("places the diff scrollbar at the full pane edge on wide screens", async () => {
  await page.viewport(1920, 1080)
  const { container } = renderCloudRoute("/cloud-fixture/review-fixture/pull/1/files")
  await expect.poll(() => renderedDiffText(container)).toContain("after route")
  const scroll = container.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
  const pane = container.querySelector("[data-review-diff-content]")?.parentElement
  if (scroll === null || pane === null || pane === undefined) throw new Error("Missing diff pane")
  const paneBounds = pane.getBoundingClientRect()
  const scrollBounds = scroll.getBoundingClientRect()
  expect(Math.abs(scrollBounds.right - paneBounds.right)).toBeLessThanOrEqual(1)
  expect(Math.abs(scrollBounds.left - paneBounds.left)).toBeLessThanOrEqual(1)
  expect(Math.abs(scrollBounds.bottom - paneBounds.bottom)).toBeLessThanOrEqual(1)
})

it("renders a usable first diff before the HTTP patch stream finishes", async () => {
  const encoder = new TextEncoder()
  let finish: (() => void) | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          "diff --git a/first.ts b/first.ts\nnew file mode 100644\n--- /dev/null\n+++ b/first.ts\n@@ -0,0 +1 @@\n+first streamed line\ndiff --git a/second.ts b/second.ts\n",
        ),
      )
      finish = () => {
        controller.enqueue(
          encoder.encode(
            "new file mode 100644\n--- /dev/null\n+++ b/second.ts\n@@ -0,0 +1 @@\n+last streamed line\n",
          ),
        )
        controller.close()
      }
    },
  })
  const { container } = renderCloudRoute(
    "/cloud-fixture/review-fixture/pull/1/files",
    (input, init) =>
      new Headers(init?.headers).get("Accept") === "application/vnd.github.diff"
        ? Promise.resolve(new Response(body))
        : cloudFixtureRequest(input, init),
  )
  try {
    await expect.poll(() => renderedDiffText(container)).toContain("first streamed line")
    expect(renderedDiffText(container)).not.toContain("last streamed line")
    const firstCard = container.querySelector('[data-diff-card-path="first.ts"]')
    expect(firstCard).not.toBeNull()
  } finally {
    finish?.()
  }
  await expect.poll(() => renderedDiffText(container)).toContain("last streamed line")
})

it("bounds mounted diff files across a 2000-file review and keeps filtering usable", async () => {
  await page.viewport(1280, 900)
  const patch = Array.from(
    { length: 2000 },
    (_, index) =>
      `diff --git a/file-${index}.ts b/file-${index}.ts\nnew file mode 100644\n--- /dev/null\n+++ b/file-${index}.ts\n@@ -0,0 +1,4 @@\n+first\n+second\n+third\n+fourth\n`,
  ).join("")
  const { container } = renderCloudRoute(
    "/cloud-fixture/review-fixture/pull/1/files",
    (input, init) =>
      new Headers(init?.headers).get("Accept") === "application/vnd.github.diff"
        ? Promise.resolve(new Response(patch))
        : cloudFixtureRequest(input, init),
  )
  await expect.poll(() => renderedDiffText(container)).toContain("fourth")
  await expect
    .poll(() => container.textContent?.includes("Loading review files"), { timeout: 30000 })
    .toBe(false)
  expect(container.querySelectorAll("[data-diff-card-path]").length).toBeLessThan(50)
  await page.getByPlaceholder("Filter files").fill("file-1999.ts")
  await expect
    .poll(() => container.querySelector('[data-diff-card-path="file-1999.ts"]'))
    .not.toBeNull()
  expect(container.querySelectorAll("[data-diff-card-path]")).toHaveLength(1)
  const tree = container.querySelector("file-tree-container")?.shadowRoot
  const selectedFile = tree?.querySelector<HTMLElement>('[data-item-path="file-1999.ts"]')
  if (selectedFile === null || selectedFile === undefined)
    throw new Error("Missing filtered tree item")
  selectedFile.click()
  const scroller = container.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
  if (scroller === null) throw new Error("Missing review scroller")
  await expect
    .poll(
      () => ({
        phase: scroller.dataset.reviewNavigationPhase,
        outcome: scroller.dataset.reviewNavigationOutcome,
      }),
      { timeout: 5000 },
    )
    .toEqual({ phase: "idle", outcome: "completed::" })
  await page.getByPlaceholder("Filter files").fill("")
  scroller.scrollTop = 0
  await expect
    .poll(() => container.querySelector('[data-diff-card-path="file-0.ts"]'))
    .not.toBeNull()
  // Clearing a filter no longer auto-scrolls the tree to its selection. Reveal it
  // explicitly, as a user scrolling the independent tree pane would.
  const treeScroll = tree?.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll]")
  if (!treeScroll) throw new Error("Missing tree scroller")
  treeScroll.scrollTop = treeScroll.scrollHeight
  await expect.poll(() => tree?.querySelector('[data-item-path="file-1999.ts"]')).not.toBeNull()
  const retainedSelection = tree?.querySelector<HTMLElement>('[data-item-path="file-1999.ts"]')
  if (retainedSelection === null || retainedSelection === undefined)
    throw new Error("Missing selected tree item")
  retainedSelection.click()
  await expect
    .poll(() => container.querySelector('[data-diff-card-path="file-1999.ts"]'))
    .not.toBeNull()
}, 40000)

it.skipIf(import.meta.env.VITE_LARGE_PR_REPLAY !== "1").each([390, 1280])(
  "replays the actual Bun 30412 patch with bounded viewport DOM at %i pixels",
  async (width) => {
    await page.viewport(width, 900)
    const started = performance.now()
    const response = await fetch("/__bun-30412.diff")
    expect(response.ok).toBe(true)
    const { container } = renderCloudRoute(
      "/cloud-fixture/review-fixture/pull/1/files",
      (input, init) =>
        new Headers(init?.headers).get("Accept") === "application/vnd.github.diff"
          ? Promise.resolve(response)
          : cloudFixtureRequest(input, init),
    )
    await expect
      .poll(() => container.querySelector("[data-diff-card-path]"), { timeout: 30000 })
      .not.toBeNull()
    const firstFileMs = performance.now() - started
    await expect
      .poll(() => container.textContent?.includes("Loading review files"), { timeout: 120000 })
      .toBe(false)
    expect(container.textContent).not.toContain("Review loading stopped")
    expect(container.textContent).not.toContain("Could not load this diff")
    expect(container.querySelectorAll("[data-diff-card-path]").length).toBeLessThan(50)
    if (width < 768) await page.getByRole("button", { name: "Open file tree", exact: true }).click()
    await page.getByPlaceholder("Filter files").fill("test/tsconfig.json")
    if (width < 768)
      await page.getByRole("button", { name: "Close file tree", exact: true }).click()
    await expect
      .poll(() => container.querySelector('[data-diff-card-path="test/tsconfig.json"]'), {
        timeout: 10000,
      })
      .not.toBeNull()
    if (width < 768) await page.getByRole("button", { name: "Open file tree", exact: true }).click()
    await page.getByPlaceholder("Filter files").fill("")
    if (width < 768)
      await page.getByRole("button", { name: "Close file tree", exact: true }).click()
    const scroller = container.querySelector<HTMLElement>("[data-review-diff-scroll-container]")
    if (scroller === null) throw new Error("Missing review scroller")
    const frameGaps: number[] = []
    let previousFrame = performance.now()
    for (let step = 0; step < 20; step += 1) {
      scroller.scrollTop = step * 1000
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const now = performance.now()
      frameGaps.push(now - previousFrame)
      previousFrame = now
    }
    expect(Math.max(...frameGaps)).toBeLessThan(200)
    console.info("Bun replay", {
      width,
      firstFileMs: Math.round(firstFileMs),
      settledMs: Math.round(performance.now() - started),
      maxTwoFrameGapMs: Math.round(Math.max(...frameGaps)),
      mountedFiles: container.querySelectorAll("[data-diff-card-path]").length,
    })
  },
  150000,
)

it("shows the first diff while a later file is still loading", async () => {
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let delayed = false
  const patch =
    "diff --git a/first.ts b/first.ts\nnew file mode 100644\n--- /dev/null\n+++ b/first.ts\n@@ -0,0 +1 @@\n+first progressive line\ndiff --git a/second.ts b/second.ts\nnew file mode 100644\n--- /dev/null\n+++ b/second.ts\n@@ -0,0 +1 @@\n+second progressive line\n"
  const { container } = renderCloudRoute(
    "/cloud-fixture/review-fixture/pull/1/files",
    (input, init) =>
      new Headers(init?.headers).get("Accept") === "application/vnd.github.diff"
        ? Promise.resolve(new Response(patch))
        : cloudFixtureRequest(input, init),
    (api) => ({
      ...api,
      progressiveReviews: {
        ...api.progressiveReviews,
        readRange: async (request) => {
          const range = await api.progressiveReviews.readRange(request)
          if (range.file.path === "second.ts") {
            delayed = true
            await pending
          }
          return range
        },
        waitForRange: async (request) => {
          const range = await api.progressiveReviews.waitForRange(request)
          if (range.file.path === "second.ts") {
            delayed = true
            await pending
          }
          return range
        },
      },
    }),
  )
  try {
    await expect.poll(() => delayed).toBe(true)
    await expect.poll(() => renderedDiffText(container)).toContain("first progressive line")
    expect(renderedDiffText(container)).not.toContain("second progressive line")
  } finally {
    release()
  }
  await expect.poll(() => renderedDiffText(container)).toContain("second progressive line")
})

it("renders a PR through the public patch fallback after GitHub rejects the REST diff", async () => {
  let publicPatchRequests = 0
  const publicPatchAuthorization: boolean[] = []
  const { container } = renderCloudRoute(
    "/cloud-fixture/review-fixture/pull/1/files",
    (input, init) => {
      if (typeof input === "string" && input.startsWith("/api/public-pull-diff/")) {
        publicPatchRequests += 1
        publicPatchAuthorization.push(new Headers(init?.headers).has("Authorization"))
        return cloudFixtureRequest(
          "https://api.github.com/repos/cloud-fixture/review-fixture/pulls/1",
          { headers: { Accept: "application/vnd.github.diff" } },
        )
      }
      if (new Headers(init?.headers).get("Accept") === "application/vnd.github.diff")
        return Promise.resolve(new Response("", { status: 406 }))
      return cloudFixtureRequest(input, init)
    },
  )
  await expect.poll(() => renderedDiffText(container)).toContain("after route")
  expect(publicPatchRequests).toBe(1)
  expect(publicPatchAuthorization).toEqual([false])
})

it("clears the mobile Notes highlight when returning to the diff and restores it on reopen", async () => {
  await page.viewport(390, 844)
  const { container } = renderCloudRoute("/cloud-fixture/review-fixture/pull/1/files")
  await expect.poll(() => renderedDiffText(container)).toContain("after route")
  const notes = page.getByRole("button", { name: "Notes", exact: true })
  await notes.click()
  await expect.element(notes).toHaveAttribute("aria-expanded", "true")
  await expect.element(notes).toHaveAttribute("aria-pressed", "true")
  await notes.click()
  await expect.element(notes).toHaveAttribute("aria-expanded", "false")
  await expect.element(notes).toHaveAttribute("aria-pressed", "false")
  await expect.element(notes).not.toHaveClass("text-primary")
  await notes.click()
  await expect.element(notes).toHaveAttribute("aria-expanded", "true")
  await expect.element(notes).toHaveAttribute("aria-pressed", "true")
  await page.viewport(1280, 844)
  await expect
    .element(page.getByRole("button", { name: "Notes", exact: true }))
    .toHaveAttribute("aria-pressed", "true")
})

it.each([
  390, 1280,
])("collects, persists, copies and clears web notes at %s pixels", async (width) => {
  await page.viewport(width, 844)
  const review = makeHostedReviewLocator("github", "cloud-fixture", "review-fixture", 1)
  const collection = ClearCommentNotesRequest.make({
    projectId: ReviewProjectId.make(makeHostedRepositoryKey(review.repository)),
    context: HostedCommentNoteContext.make({
      review,
      baseRefName: RepositoryComparisonRef.make("main"),
    }),
  })
  await new CloudCommentNotes().clear(collection)
  const path = "/cloud-fixture/review-fixture/pull/1/files"
  const { container } = renderCloudRoute(path)
  await expect.poll(() => renderedDiffText(container)).toContain("after route")
  const diffRoot = Array.from(container.querySelectorAll("*")).find((element) =>
    element.shadowRoot?.querySelector('[data-column-number="1"]'),
  )?.shadowRoot
  if (diffRoot === undefined || diffRoot === null) throw new Error("Diff line numbers are missing")
  const number = diffRoot.querySelector('[data-column-number="1"]')
  if (!(number instanceof HTMLElement)) throw new Error("Diff line number is missing")
  number.dispatchEvent(
    new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "touch" }),
  )
  expect(diffRoot.querySelector("[data-utility-button]")).toBeNull()
  number.click()
  await page
    .getByRole("textbox", { name: "Thread message" })
    .fill("Remember to test the empty route")
  await page.getByRole("button", { name: "Add note", exact: true }).click()
  await expect.poll(() => renderedDiffText(container)).toContain("Remember to test the empty route")
  await expect.poll(async () => (await new CloudCommentNotes().list(collection)).length).toBe(1)
  root?.unmount()
  root = null
  container.remove()
  const restored = renderCloudRoute(path)
  await expect
    .poll(() => renderedDiffText(restored.container))
    .toContain("Remember to test the empty route")
  await page.getByRole("button", { name: "Notes", exact: true }).click()
  await page.getByRole("button", { name: "Copy all notes", exact: true }).click()
  await expect
    .poll(() => navigator.clipboard.readText())
    .toContain("Remember to test the empty route")
  expect(await navigator.clipboard.readText()).toContain("route.txt")
  await page.getByRole("button", { name: "Clear all notes", exact: true }).click()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(await new CloudCommentNotes().list(collection)).toHaveLength(1)
  await page.getByRole("button", { name: "Clear all notes", exact: true }).click()
  await page.getByRole("button", { name: "Clear notes", exact: true }).click()
  await expect.poll(async () => (await new CloudCommentNotes().list(collection)).length).toBe(0)
})

it.each([
  390, 1280,
])("keeps code visible during long-diff scrolling at %s pixels", async (width) => {
  await page.viewport(width, 844)
  const lines = Array.from(
    { length: 2_000 },
    (_, index) => `+scroll fixture line ${index + 1}`,
  ).join("\n")
  const patch = `diff --git a/route.txt b/route.txt\nnew file mode 100644\n--- /dev/null\n+++ b/route.txt\n@@ -0,0 +1,2000 @@\n${lines}\n`
  const { container } = renderCloudRoute(
    "/cloud-fixture/review-fixture/pull/1/files",
    (input, init) => {
      if (new Headers(init?.headers).get("Accept") === "application/vnd.github.diff")
        return Promise.resolve(new Response(patch))
      return cloudFixtureRequest(input, init)
    },
  )
  await expect.poll(() => renderedDiffText(container)).toContain("scroll fixture line 1")
  const scroll = container.querySelector("[data-review-diff-scroll-container]")
  if (!(scroll instanceof HTMLElement)) throw new Error("Diff scroll container is missing")
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const blankOffsets: number[] = []
  for (let offset = 0; offset < 20_000; offset += 800) {
    scroll.scrollTop = offset
    await nextFrame()
    await nextFrame()
    const viewport = scroll.getBoundingClientRect()
    const visibleLines = Array.from(scroll.querySelectorAll("*"))
      .flatMap((element) => Array.from(element.shadowRoot?.querySelectorAll("[data-line]") ?? []))
      .filter((line) => {
        const bounds = line.getBoundingClientRect()
        return (
          bounds.bottom > viewport.top + 100 && bounds.top < viewport.bottom && bounds.height > 0
        )
      })
    if (visibleLines.length === 0) blankOffsets.push(offset)
  }
  expect(blankOffsets).toEqual([])
})

it("scrolls long mobile code lines horizontally and restores desktop wrapping", async () => {
  await page.viewport(390, 844)
  const longLine = `horizontal scroll fixture ${"long_identifier ".repeat(40)}`
  const patch = `diff --git a/route.txt b/route.txt\nnew file mode 100644\n--- /dev/null\n+++ b/route.txt\n@@ -0,0 +1 @@\n+${longLine}\n`
  const { container } = renderCloudRoute(
    "/cloud-fixture/review-fixture/pull/1/files",
    (input, init) => {
      if (new Headers(init?.headers).get("Accept") === "application/vnd.github.diff")
        return Promise.resolve(new Response(patch))
      return cloudFixtureRequest(input, init)
    },
  )
  await expect.poll(() => renderedDiffText(container)).toContain("horizontal scroll fixture")
  const diffRoot = Array.from(container.querySelectorAll("*")).find((element) =>
    element.shadowRoot?.querySelector('[data-overflow="scroll"]'),
  )?.shadowRoot
  if (diffRoot === undefined || diffRoot === null)
    throw new Error("Mobile scroll-mode diff is missing")
  const horizontalScroller = Array.from(diffRoot.querySelectorAll("*")).find((element) => {
    const overflow = getComputedStyle(element).overflowX
    return (
      (overflow === "auto" || overflow === "scroll") && element.scrollWidth > element.clientWidth
    )
  })
  if (horizontalScroller === undefined) throw new Error("Horizontal diff scroller is missing")
  horizontalScroller.scrollLeft = 120
  expect(horizontalScroller.scrollLeft).toBeGreaterThan(0)
  expect(document.documentElement.scrollWidth).toBe(390)
  await page.viewport(1280, 844)
  await expect
    .poll(() =>
      Array.from(container.querySelectorAll("*")).some((element) =>
        element.shadowRoot?.querySelector('[data-overflow="wrap"]'),
      ),
    )
    .toBe(true)
})

it("reports unsupported routes rather than resolving a different review", async () => {
  const { status } = renderCloudRoute("/cloud-fixture/review-fixture/issues/1")
  await expect.poll(() => status().kind).toBe("error")
})

it("retains a files deep link through PAT sign-in and authenticated remount", async () => {
  clearGithubPersonalAccessToken()
  const path = "/cloud-fixture/review-fixture/pull/1/files"
  window.history.replaceState(null, "", path)
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  root.render(
    <StrictMode>
      <CloudRoot request={cloudFixtureRequest} />
    </StrictMode>,
  )
  await page
    .getByLabelText("Personal access token", { exact: true })
    .fill("github_pat_test_fixture_only")
  await page.getByRole("button", { name: "Open DiffDash", exact: true }).click()
  await expect.poll(() => container.textContent).toContain("route.txt")
  expect(window.location.pathname).toBe(path)
  root.unmount()
  root = createRoot(container)
  root.render(
    <StrictMode>
      <CloudRoot request={cloudFixtureRequest} />
    </StrictMode>,
  )
  await expect.poll(() => container.textContent).toContain("route.txt")
  expect(window.location.pathname).toBe(path)
})
