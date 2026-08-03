import { describe, expect, it } from "vitest"
import {
  clampReviewContextPanelWidth,
  clampReviewThreadDetailWidth,
  REVIEW_CONTEXT_PANEL_MAX_WIDTH,
  REVIEW_CONTEXT_PANEL_MIN_WIDTH,
  REVIEW_THREAD_DETAIL_MAX_WIDTH,
  REVIEW_THREAD_DETAIL_MIN_WIDTH,
  resolveReviewPanePlan,
} from "./review-sidebar-layout"

describe("review sidebar layout", () => {
  it("rounds and clamps contextual panel widths", () => {
    expect(clampReviewContextPanelWidth(319.6)).toBe(320)
    expect(clampReviewContextPanelWidth(0)).toBe(REVIEW_CONTEXT_PANEL_MIN_WIDTH)
    expect(clampReviewContextPanelWidth(1_000)).toBe(REVIEW_CONTEXT_PANEL_MAX_WIDTH)
  })

  it("rounds and clamps thread-detail widths", () => {
    expect(clampReviewThreadDetailWidth(431.6)).toBe(432)
    expect(clampReviewThreadDetailWidth(0)).toBe(REVIEW_THREAD_DETAIL_MIN_WIDTH)
    expect(clampReviewThreadDetailWidth(2_000)).toBe(REVIEW_THREAD_DETAIL_MAX_WIDTH)
  })

  it("collapses the context pane before thread detail under width pressure", () => {
    expect(
      resolveReviewPanePlan({
        containerWidth: 1_320,
        sidebarRequestedOpen: true,
        detailOpen: true,
        activePane: "thread-detail",
        previousMode: "wide",
      }),
    ).toMatchObject({ mode: "wide", contextVisible: true, detailVisible: true, diffVisible: true })

    expect(
      resolveReviewPanePlan({
        containerWidth: 1_080,
        sidebarRequestedOpen: true,
        detailOpen: true,
        activePane: "thread-detail",
        previousMode: "wide",
      }),
    ).toMatchObject({
      mode: "compact",
      contextVisible: false,
      detailVisible: true,
      diffVisible: true,
    })
  })

  it("uses one active pane and bottom navigation on mobile widths", () => {
    expect(
      resolveReviewPanePlan({
        containerWidth: 720,
        sidebarRequestedOpen: true,
        detailOpen: true,
        activePane: "thread-detail",
        previousMode: "compact",
      }),
    ).toEqual({
      mode: "single",
      contextVisible: false,
      detailVisible: true,
      diffVisible: false,
      activityNavigation: "bottom",
    })
  })

  it("requires hysteresis before restoring responsively collapsed panes", () => {
    const withoutRestoreMargin = resolveReviewPanePlan({
      containerWidth: 1_080,
      sidebarRequestedOpen: true,
      detailOpen: false,
      activePane: "context",
      previousMode: "single",
    })
    expect(withoutRestoreMargin.mode).toBe("wide")

    const compactWithoutRestoreMargin = resolveReviewPanePlan({
      containerWidth: 870,
      sidebarRequestedOpen: true,
      detailOpen: true,
      activePane: "thread-detail",
      previousMode: "single",
    })
    expect(compactWithoutRestoreMargin.mode).toBe("single")
  })
})
