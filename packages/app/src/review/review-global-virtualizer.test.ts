import { describe, expect, it, vi } from "vitest"
import { CompactReviewLayoutIndex } from "./review-layout-index"
import {
  ReviewGlobalVirtualizer,
  ReviewRendererCaches,
  ReviewShellPool,
} from "./review-global-virtualizer"

const cacheBudgets = {
  text: 10,
  "syntax-ast": 20,
  "syntax-output": 20,
  annotation: 20,
  observer: 20,
  measurement: 20,
  reservation: 20,
  worker: 20,
  "dom-container": 20,
  prefetch: 20,
  pin: 4,
} as const

describe("ReviewGlobalVirtualizer", () => {
  it("bounds mounted rows and directly seeks the final file through browser-height pages", () => {
    const rows = Uint32Array.of(400, 400, 400, 400)
    const layout = new CompactReviewLayoutIndex(
      rows,
      new Uint8Array(4),
      (_file, count) => count * 100_000,
    )
    const virtualizer = new ReviewGlobalVirtualizer(layout, 10_000_000, 1_000)

    const mounted = virtualizer.window(0, layout.logicalHeight, 0)
    expect([...mounted.files]).toEqual([0, 1])
    expect(mounted.mountedRows).toBe(800)

    const final = virtualizer.primeTargetShell(3, 50_000_000)
    expect(final.logicalTop).toBe(layout.topOf(3))
    expect(layout.heightOf(3)).toBe(50_000_000)
    expect(final.physicalTop).toBeLessThan(10_000_000)
    expect(final.pageOrigin + final.physicalTop).toBe(final.logicalTop)
    const finalWindow = virtualizer.window(final.logicalTop, 800, 1_200)
    expect([...finalWindow.files]).toContain(3)
    expect(finalWindow.mountedRows).toBeLessThanOrEqual(1_000)
  })

  it("keeps inverse-sticky content stable and preserves semantic anchors on reflow", () => {
    const layout = new CompactReviewLayoutIndex(
      Uint32Array.of(100, 100, 100),
      new Uint8Array(3),
      (_file, rows) => rows * 10,
    )
    const virtualizer = new ReviewGlobalVirtualizer(layout, 1_000, 1_000)
    expect(virtualizer.correctMeasurement(1_500, 1, 0, 1_200).logicalTop).toBe(1_700)
    expect(virtualizer.correctMeasurement(1_700, 1, 2, 1_200).logicalTop).toBe(1_700)

    const reflowed = virtualizer.reflow(
      1_700,
      500,
      "split",
      (_file, rows, width, mode) => rows * (mode === "split" ? 20 : 10) * (1_000 / width),
    )
    expect(layout.captureAnchor(reflowed.logicalTop)).toEqual({
      fileIndex: 1,
      row: 50,
      rowFraction: 0,
    })
  })

  it("removes a measured file's stale trailing height when it collapses", () => {
    const layout = new CompactReviewLayoutIndex(
      Uint32Array.of(100, 100, 100),
      new Uint8Array(3),
      (_file, rows) => rows * 10,
    )
    const virtualizer = new ReviewGlobalVirtualizer(layout, 1_000, 1_000)
    virtualizer.correctMeasurement(1_500, 1, 0, 1_200)
    const expandedLogicalHeight = layout.logicalHeight

    virtualizer.correctMeasurement(1_700, 1, 0, 100)

    expect(layout.logicalHeight).toBe(expandedLogicalHeight - 1_100)
  })
})

describe("ReviewRendererCaches", () => {
  it("enforces independent budgets while evicting every owner for the same range", () => {
    const released: string[] = []
    const caches = new ReviewRendererCaches(cacheBudgets)
    caches.put("first", [
      { kind: "text", bytes: 6, release: () => released.push("first-text") },
      { kind: "syntax-ast", bytes: 10, release: () => released.push("first-ast") },
      { kind: "dom-container", bytes: 10, release: () => released.push("first-dom") },
    ])
    caches.put("second", [
      { kind: "text", bytes: 6, release: () => released.push("second-text") },
      { kind: "syntax-ast", bytes: 10, release: () => released.push("second-ast") },
    ])

    expect(released).toEqual(["first-text", "first-ast", "first-dom"])
    expect(caches.bytes("text")).toBe(6)
    expect(caches.bytes("syntax-ast")).toBe(10)
    expect(caches.bytes("dom-container")).toBe(0)
    caches.clear()
    expect(released).toContain("second-text")
    expect(released).toContain("second-ast")
  })

  it("rejects an invalid range without replacing its existing resources", () => {
    const release = vi.fn<() => void>()
    const caches = new ReviewRendererCaches(cacheBudgets)
    caches.put("range", [{ kind: "text", bytes: 4, release }])

    expect(() =>
      caches.put("range", [
        { kind: "text", bytes: 2, release: vi.fn<() => void>() },
        { kind: "syntax-ast", bytes: -1, release: vi.fn<() => void>() },
      ]),
    ).toThrow("Cache bytes must be a non-negative safe integer")
    expect(caches.bytes("text")).toBe(4)
    expect(release).not.toHaveBeenCalled()
  })

  it("adds deferred resources without releasing the mounted range", () => {
    const released: string[] = []
    const caches = new ReviewRendererCaches(cacheBudgets)
    caches.put("range", [
      { kind: "text", bytes: 4, release: () => released.push("text") },
      { kind: "dom-container", bytes: 4, release: () => released.push("dom") },
    ])

    caches.add("range", [
      { kind: "syntax-ast", bytes: 5, release: () => released.push("ast") },
      { kind: "worker", bytes: 3, release: () => released.push("worker") },
    ])

    expect(released).toEqual([])
    expect(caches.bytes("text")).toBe(4)
    expect(caches.bytes("syntax-ast")).toBe(5)
    caches.delete("range")
    expect(released).toEqual(["text", "ast", "worker", "dom"])
  })
})

describe("ReviewShellPool", () => {
  it("resets every shell before reuse and destroys overflow", () => {
    const reset = vi.fn<(shell: { stale: boolean }) => void>((shell) => {
      shell.stale = false
    })
    const destroy = vi.fn<(shell: { stale: boolean }) => void>()
    const pool = new ReviewShellPool(1, { create: () => ({ stale: false }), reset, destroy })
    const first = pool.acquire()
    const second = pool.acquire()
    first.stale = true
    second.stale = true
    pool.release(first)
    pool.release(second)

    expect(reset).toHaveBeenCalledTimes(2)
    expect(destroy).toHaveBeenCalledWith(second)
    expect(pool.acquire()).toBe(first)
    expect(first.stale).toBe(false)
  })

  it("destroys a shell that cannot be reset", () => {
    const failure = new Error("reset failed")
    const destroy = vi.fn<(shell: object) => void>()
    const pool = new ReviewShellPool(1, {
      create: () => ({}),
      reset: () => {
        throw failure
      },
      destroy,
    })
    const shell = pool.acquire()

    expect(() => pool.release(shell)).toThrow(failure)
    expect(destroy).toHaveBeenCalledWith(shell)
    expect(pool.size).toBe(0)
  })
})
