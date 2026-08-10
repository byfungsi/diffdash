import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { type ReactNode, useRef } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ReviewPagePlaceholder } from "./review-page-placeholder"
import type { ReviewSnapshotRefreshStatus } from "./review-snapshot-page-session"

const originalIntersectionObserver = Object.getOwnPropertyDescriptor(window, "IntersectionObserver")
const noop = (): void => undefined
const IDLE_SNAPSHOT_REFRESH: ReviewSnapshotRefreshStatus = { _tag: "idle" }

let root: Root | null = null
let observedRoot: Element | Document | null | undefined
let observedTarget: Element | null = null
let emitObservedIntersections: ((entries: IntersectionObserverEntry[]) => void) | null = null

afterEach(() => {
  root?.unmount()
  root = null
  observedRoot = undefined
  observedTarget = null
  emitObservedIntersections = null
  document.body.replaceChildren()
  if (originalIntersectionObserver === undefined) {
    Reflect.deleteProperty(window, "IntersectionObserver")
  } else {
    Object.defineProperty(window, "IntersectionObserver", originalIntersectionObserver)
  }
})

describe("ReviewPagePlaceholder", () => {
  it("observes an idle placeholder within the nested diff scroll container", async () => {
    installIntersectionObserver()
    const onVisible = vi.fn<() => void>()
    render(<PlaceholderHarness error={null} loading={false} onVisible={onVisible} />)

    await vi.waitFor(() => expect(observedRoot).toBe(document.querySelector("[data-test-scroll]")))
    emitIntersection()
    expect(onVisible).toHaveBeenCalledOnce()
  })

  it("shows an accessible retryable error without observing the failed placeholder", async () => {
    installIntersectionObserver()
    const onRetry = vi.fn<() => void>()
    render(
      <PlaceholderHarness
        error="Snapshot transport unavailable"
        loading={false}
        onRetry={onRetry}
      />,
    )

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Snapshot transport unavailable",
    )
    const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    )
    expect(retry).toBeDefined()
    retry?.click()
    expect(onRetry).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(observedRoot).toBeUndefined()
  })

  it("shows snapshot refresh as loading rather than a destructive file error", async () => {
    installIntersectionObserver()
    render(
      <PlaceholderHarness error={null} loading={false} snapshotRefresh={{ _tag: "refreshing" }} />,
    )

    expect(document.querySelector("output")?.textContent).toContain("Refreshing diff")
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).not.toContain("Load failed")
    expect(document.body.textContent).not.toContain("Retry")
    await Promise.resolve()
    expect(observedRoot).toBeUndefined()
  })

  it("shows a refresh failure as destructive and retries the snapshot refresh", () => {
    const onRefresh = vi.fn<() => void>()
    render(
      <PlaceholderHarness
        error={null}
        loading={false}
        snapshotRefresh={{ _tag: "failed", message: "Could not refresh the review" }}
        onRefresh={onRefresh}
      />,
    )

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not refresh the review",
    )
    const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    )
    retry?.click()
    expect(onRefresh).toHaveBeenCalledOnce()
  })
})

const fixtureFile = (() => {
  const file = parseUnifiedDiff(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-old
+new`).files[0]
  if (file === undefined) throw new Error("Missing fixture file")
  return ReviewSnapshotFileInventory.make({
    fileId: file.fileId,
    patchHash: file.patchHash,
    reviewKey: file.reviewKey,
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    visibility: file.visibility,
    additions: file.additions,
    deletions: file.deletions,
    hunkCount: file.hunks.length,
  })
})()

const PlaceholderHarness = ({
  error,
  loading,
  snapshotRefresh = IDLE_SNAPSHOT_REFRESH,
  onRetry = noop,
  onRefresh = noop,
  onVisible = noop,
}: {
  readonly error: string | null
  readonly loading: boolean
  readonly snapshotRefresh?: ReviewSnapshotRefreshStatus
  readonly onRetry?: () => void
  readonly onRefresh?: () => void
  readonly onVisible?: () => void
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={scrollContainerRef} data-test-scroll>
      <ReviewPagePlaceholder
        error={error}
        file={fixtureFile}
        loading={loading}
        scrollContainerRef={scrollContainerRef}
        snapshotRefresh={snapshotRefresh}
        tooLarge={false}
        onFileAnchorChange={() => noop}
        onRetry={onRetry}
        onRefresh={onRefresh}
        onVisible={onVisible}
      />
    </div>
  )
}

class TestIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null
  readonly rootMargin: string
  readonly scrollMargin: string
  readonly thresholds: readonly number[]

  constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.root = options.root ?? null
    this.rootMargin = options.rootMargin ?? "0px"
    this.scrollMargin = "0px"
    this.thresholds = Array.isArray(options.threshold)
      ? options.threshold
      : [options.threshold ?? 0]
    observedRoot = this.root
    emitObservedIntersections = (entries) => callback(entries, this)
  }

  disconnect(): void {}

  observe(target: Element): void {
    observedTarget = target
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  unobserve(_target: Element): void {}
}

const installIntersectionObserver = () => {
  Object.defineProperty(window, "IntersectionObserver", {
    configurable: true,
    value: TestIntersectionObserver,
  })
}

const emitIntersection = () => {
  if (emitObservedIntersections === null || observedTarget === null) {
    throw new Error("Intersection observer was not installed")
  }
  const rect = new DOMRectReadOnly(0, 0, 100, 100)
  emitObservedIntersections([
    {
      boundingClientRect: rect,
      intersectionRatio: 1,
      intersectionRect: rect,
      isIntersecting: true,
      rootBounds: rect,
      target: observedTarget,
      time: 0,
    },
  ])
}

const render = (node: ReactNode) => {
  const element = document.createElement("div")
  document.body.append(element)
  root = createRoot(element)
  flushSync(() => root?.render(node))
}
