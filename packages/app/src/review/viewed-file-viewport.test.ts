import { describe, expect, it } from "@effect/vitest"
import {
  clampViewedFileScrollTop,
  uniqueViewedFileUpdates,
  viewedFileScrollAdjustment,
  viewedFileViewportAnchor,
} from "./viewed-file-viewport"

describe("viewed-file viewport decisions", () => {
  it("keeps only the final viewed transition for each file", () => {
    expect(
      uniqueViewedFileUpdates([
        { reviewKey: "a", viewed: true },
        { reviewKey: "b", viewed: true },
        { reviewKey: "a", viewed: false },
      ]),
    ).toEqual([
      { reviewKey: "a", viewed: false },
      { reviewKey: "b", viewed: true },
    ])
  })

  it("anchors a collapsing visible card at the sticky viewport edge", () => {
    const cards = [
      { reviewKey: "above", top: 20, bottom: 80, height: 60 },
      { reviewKey: "visible", top: 80, bottom: 300, height: 220 },
    ]

    expect(
      viewedFileViewportAnchor(cards, [{ reviewKey: "visible", viewed: true }], 100, 500),
    ).toEqual({ reviewKey: "visible", top: 100 })
    expect(
      viewedFileViewportAnchor(cards, [{ reviewKey: "visible", viewed: false }], 100, 500),
    ).toEqual({ reviewKey: "visible", top: 80 })
  })

  it("compensates cards above the viewport and only the hidden portion of a shrinking anchor", () => {
    expect(
      viewedFileScrollAdjustment(
        [
          {
            previous: { top: 0, bottom: 80, height: 80 },
            nextHeight: 120,
          },
          {
            previous: { top: 80, bottom: 300, height: 220 },
            nextHeight: 120,
          },
          {
            previous: { top: 300, bottom: 500, height: 200 },
            nextHeight: 100,
          },
        ],
        100,
      ),
    ).toBe(20)
  })

  it("clamps to the closest valid viewport after large height changes", () => {
    expect(clampViewedFileScrollTop(-50, 1_000, 400)).toBe(0)
    expect(clampViewedFileScrollTop(350, 1_000, 400)).toBe(350)
    expect(clampViewedFileScrollTop(900, 1_000, 400)).toBe(600)
    expect(clampViewedFileScrollTop(100, 300, 400)).toBe(0)
  })
})
