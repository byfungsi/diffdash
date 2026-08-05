import { StoredWalkthrough, Walkthrough, type WalkthroughRisk } from "@diffdash/domain/walkthrough"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import "../styles.css"
import {
  WalkthroughMainHeader,
  type WalkthroughReviewStep,
  type WalkthroughState,
} from "./walkthrough-panel"

const stored = StoredWalkthrough.make({
  repoId: "repo-1",
  prNumber: 42,
  reviewKey: "github:fungsi/diffdash#42",
  baseSha: "base",
  headSha: "head",
  promptVersion: "test",
  walkthrough: Walkthrough.make({
    title: "Review focus",
    summary: "Review summary",
    chapters: [],
    support: [],
  }),
  createdAt: "2026-08-02T00:00:00Z",
})

const state: WalkthroughState = { status: "ready", stored }

const RISK_CLASSES = {
  critical: "border-risk-critical/25 border-l-risk-critical",
  review: "border-risk-review/25 border-l-risk-review",
  support: "border-risk-support/25 border-l-risk-support",
} satisfies Record<WalkthroughRisk, string>

const WALKTHROUGH_RISKS = [
  "critical",
  "review",
  "support",
] as const satisfies readonly WalkthroughRisk[]

let root: Root | null = null

afterEach(() => {
  vi.restoreAllMocks()
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

describe("WalkthroughMainHeader", () => {
  it("copies structured error details and confirms success", async () => {
    const writeText = vi.spyOn(window.navigator.clipboard, "writeText").mockResolvedValue()
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    flushSync(() => {
      root?.render(
        <WalkthroughMainHeader
          activeStepComplete={false}
          step={null}
          state={{
            status: "error",
            message: "Check that Codex is signed in and online, then retry.",
            report: "DiffDash walkthrough error\nError code: AgentProviderOperationError",
          }}
          onMarkComplete={() => undefined}
          onNextStep={() => undefined}
          onRetry={() => undefined}
        />,
      )
    })

    const copyButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Copy error details"),
    )
    expect(copyButton).not.toBeUndefined()
    copyButton?.click()

    await expect
      .poll(() => writeText.mock.calls[0]?.[0])
      .toBe("DiffDash walkthrough error\nError code: AgentProviderOperationError")
    await expect.poll(() => copyButton?.textContent).toContain("Copied")
    expect(document.body.textContent).toContain("Check that Codex is signed in")
    expect(document.querySelector(".truncate")).toBeNull()
  })

  it("shows when copying error details fails", async () => {
    vi.spyOn(window.navigator.clipboard, "writeText").mockRejectedValue(
      new Error("Clipboard unavailable"),
    )
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    flushSync(() => {
      root?.render(
        <WalkthroughMainHeader
          activeStepComplete={false}
          step={null}
          state={{ status: "error", message: "Walkthrough failed.", report: "Safe report" }}
          onMarkComplete={() => undefined}
          onNextStep={() => undefined}
          onRetry={() => undefined}
        />,
      )
    })

    const copyButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Copy error details"),
    )
    copyButton?.click()

    await expect.poll(() => copyButton?.textContent).toContain("Copy failed")
  })

  it.each([
    { status: "empty", title: "No walkthrough available" },
    { status: "unavailable", title: "Walkthrough unavailable" },
  ] as const)("renders the $status state intentionally", ({ status, title }) => {
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    flushSync(() => {
      root?.render(
        <WalkthroughMainHeader
          activeStepComplete={false}
          step={null}
          state={{ status, message: "State-specific explanation" }}
          onMarkComplete={() => undefined}
          onNextStep={() => undefined}
          onRetry={() => undefined}
        />,
      )
    })

    expect(document.body.textContent).toContain(title)
    expect(document.body.textContent).toContain("State-specific explanation")
  })

  it("colors the full card border and stronger left edge by walkthrough risk", () => {
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    for (const risk of WALKTHROUGH_RISKS) {
      const step: WalkthroughReviewStep = {
        id: risk,
        title: `${risk} step`,
        summary: `${risk} summary`,
        risk,
        hunkIds: [],
        chapterTitle: null,
      }
      flushSync(() => {
        root?.render(
          <WalkthroughMainHeader
            activeStepComplete={false}
            step={step}
            state={state}
            onMarkComplete={() => undefined}
            onNextStep={() => undefined}
            onRetry={() => undefined}
          />,
        )
      })

      const header = document.querySelector<HTMLElement>(`[data-walkthrough-main-risk="${risk}"]`)
      const expected = document.createElement("div")
      expected.className = RISK_CLASSES[risk]
      document.body.append(expected)
      expect(header).not.toBeNull()
      expect(getComputedStyle(header!).borderTopColor).toBe(
        getComputedStyle(expected).borderTopColor,
      )
      expect(getComputedStyle(header!).borderLeftColor).toBe(
        getComputedStyle(expected).borderLeftColor,
      )
      expected.remove()
    }
  })
})
