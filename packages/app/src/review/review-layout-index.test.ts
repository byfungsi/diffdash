import { describe, expect, it } from "vitest"
import {
  CompactReviewLayoutIndex,
  ReviewFileFlag,
  ReviewVisibilityProjection,
} from "./review-layout-index"

const FILE_COUNT = 61_000
const ROW_COUNT = 30_000_000
const ENORMOUS_FILE_ROWS = 1_000_000

const repositoryScaleRows = (): Uint32Array => {
  const rows = new Uint32Array(FILE_COUNT)
  rows[0] = ENORMOUS_FILE_ROWS
  const remaining = ROW_COUNT - ENORMOUS_FILE_ROWS
  const quotient = Math.floor(remaining / (FILE_COUNT - 1))
  const remainder = remaining % (FILE_COUNT - 1)
  for (let file = 1; file < FILE_COUNT; file += 1) {
    rows[file] = quotient + (file <= remainder ? 1 : 0)
  }
  return rows
}

describe("CompactReviewLayoutIndex", () => {
  it("represents the deterministic 61k-file/30m-row fixture inside the metadata budget", () => {
    const rows = repositoryScaleRows()
    const flags = new Uint8Array(FILE_COUNT)
    const layout = new CompactReviewLayoutIndex(
      rows,
      flags,
      (_file, rowCount) => 28 + rowCount * 20,
    )

    expect(rows.reduce((total, count) => total + count, 0)).toBe(ROW_COUNT)
    expect(layout.fileCount).toBe(FILE_COUNT)
    expect(layout.fileAt(layout.topOf(FILE_COUNT - 1))).toBe(FILE_COUNT - 1)
    expect(layout.byteLength).toBeLessThan(2 * 1_024 * 1_024)
    expect(layout.byteLength).toBeLessThan(64 * 1_024 * 1_024)
  })

  it("updates and locates global offsets without rebuilding file objects", () => {
    const layout = new CompactReviewLayoutIndex(
      Uint32Array.of(10, 20, 30),
      new Uint8Array(3),
      (_file, rows) => rows * 10,
    )
    expect(layout.fileAt(99)).toBe(0)
    expect(layout.fileAt(100)).toBe(1)
    layout.setHeight(0, 150)
    expect(layout.topOf(1)).toBe(150)
    expect(layout.fileAt(149)).toBe(0)
  })

  it("preserves a semantic row through width and mode reflow", () => {
    const layout = new CompactReviewLayoutIndex(
      Uint32Array.of(100, 200),
      new Uint8Array(2),
      (_file, rows) => rows * 10,
    )
    const anchor = layout.captureAnchor(1_500)
    const corrected = layout.reflow(
      anchor,
      400,
      "split",
      (_file, rows, width, mode) => rows * (mode === "split" ? 20 : 10) * (800 / width),
    )

    expect(anchor).toEqual({ fileIndex: 1, row: 50, rowFraction: 0 })
    expect(corrected).toBe(6_000)
  })
})

describe("ReviewVisibilityProjection", () => {
  it("combines hidden, viewed, path, walkthrough, and reveal policy once for tree and canvas", () => {
    const flags = Uint8Array.of(
      0,
      ReviewFileFlag.Hidden,
      ReviewFileFlag.Viewed,
      ReviewFileFlag.Hidden | ReviewFileFlag.Viewed,
      0,
    )
    const projection = new ReviewVisibilityProjection(flags, {
      showHidden: false,
      showViewed: false,
      pathMatches: Uint8Array.of(1, 1, 1, 0, 0),
      walkthrough: Uint8Array.of(1, 1, 1, 1, 0),
      revealed: Uint8Array.of(0, 0, 1, 1, 0),
    })

    expect([...projection.visibleFiles]).toEqual([0, 2, 3])
    expect([...projection.visibleIndexByFile]).toEqual([0, -1, 1, 2, -1])
    expect(projection.byteLength).toBe(5 * 4 + 3 * 4)
  })
})
