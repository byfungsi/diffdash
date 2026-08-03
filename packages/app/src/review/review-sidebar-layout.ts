import {
  REVIEW_CONTEXT_PANE_DEFAULT_WIDTH,
  REVIEW_CONTEXT_PANE_MAX_WIDTH,
  REVIEW_CONTEXT_PANE_MIN_WIDTH,
  REVIEW_THREAD_DETAIL_PANE_DEFAULT_WIDTH,
  REVIEW_THREAD_DETAIL_PANE_MAX_WIDTH,
  REVIEW_THREAD_DETAIL_PANE_MIN_WIDTH,
  ReviewContextPaneWidth,
  ReviewThreadDetailPaneWidth,
} from "@diffdash/domain/renderer-layout-settings"

/** Default contextual review sidebar width in CSS pixels. */
export const REVIEW_CONTEXT_PANEL_DEFAULT_WIDTH = REVIEW_CONTEXT_PANE_DEFAULT_WIDTH

/** Smallest usable contextual review sidebar width in CSS pixels. */
export const REVIEW_CONTEXT_PANEL_MIN_WIDTH = REVIEW_CONTEXT_PANE_MIN_WIDTH

/** Largest supported contextual review sidebar width in CSS pixels. */
export const REVIEW_CONTEXT_PANEL_MAX_WIDTH = REVIEW_CONTEXT_PANE_MAX_WIDTH

/** Default attached thread-detail width in CSS pixels. */
export const REVIEW_THREAD_DETAIL_DEFAULT_WIDTH = REVIEW_THREAD_DETAIL_PANE_DEFAULT_WIDTH

/** Smallest usable attached thread-detail width in CSS pixels. */
export const REVIEW_THREAD_DETAIL_MIN_WIDTH = REVIEW_THREAD_DETAIL_PANE_MIN_WIDTH

/** Largest supported attached thread-detail width in CSS pixels. */
export const REVIEW_THREAD_DETAIL_MAX_WIDTH = REVIEW_THREAD_DETAIL_PANE_MAX_WIDTH

/** Smallest width that keeps the review diff usable beside auxiliary panes. */
export const REVIEW_DIFF_MIN_WIDTH = 480

/** Fixed width of the desktop review activity rail. */
export const REVIEW_ACTIVITY_RAIL_WIDTH = 52

/** Width reserved by each visible pane separator. */
export const REVIEW_PANE_SEPARATOR_WIDTH = 1

/** Extra capacity required before restoring a responsively collapsed pane. */
export const REVIEW_PANE_RESTORE_HYSTERESIS = 32

/** Review pane that owns navigation in single-pane mode. */
export type ReviewActivePane = "context" | "thread-detail" | "diff"

/** Responsive arrangement selected from the review container's actual width. */
export type ReviewPaneMode = "wide" | "compact" | "single"

/** Effective review-pane visibility without changing user intent or preferred widths. */
export type ReviewPanePlan = {
  readonly mode: ReviewPaneMode
  readonly contextVisible: boolean
  readonly detailVisible: boolean
  readonly diffVisible: boolean
  readonly activityNavigation: "rail" | "bottom"
}

/** Inputs used to resolve effective review-pane placement. */
export type ResolveReviewPanePlanInput = {
  readonly containerWidth: number
  readonly sidebarRequestedOpen: boolean
  readonly detailOpen: boolean
  readonly activePane: ReviewActivePane
  readonly previousMode: ReviewPaneMode
}

/** Keeps a user-resized contextual sidebar inside its supported range. */
export const clampReviewContextPanelWidth = (width: number) =>
  ReviewContextPaneWidth.make(
    Math.round(
      Math.min(REVIEW_CONTEXT_PANEL_MAX_WIDTH, Math.max(REVIEW_CONTEXT_PANEL_MIN_WIDTH, width)),
    ),
  )

/** Keeps a user-resized thread detail inside its supported range. */
export const clampReviewThreadDetailWidth = (width: number) =>
  ReviewThreadDetailPaneWidth.make(
    Math.round(
      Math.min(REVIEW_THREAD_DETAIL_MAX_WIDTH, Math.max(REVIEW_THREAD_DETAIL_MIN_WIDTH, width)),
    ),
  )

/** Resolves wide, compact, and mobile single-pane review layouts from available capacity. */
export const resolveReviewPanePlan = ({
  containerWidth,
  sidebarRequestedOpen,
  detailOpen,
  activePane,
  previousMode,
}: ResolveReviewPanePlanInput): ReviewPanePlan => {
  const contextAndDiffWidth =
    REVIEW_ACTIVITY_RAIL_WIDTH +
    REVIEW_CONTEXT_PANEL_MIN_WIDTH +
    REVIEW_DIFF_MIN_WIDTH +
    REVIEW_PANE_SEPARATOR_WIDTH
  const detailAndDiffWidth =
    REVIEW_ACTIVITY_RAIL_WIDTH +
    REVIEW_THREAD_DETAIL_MIN_WIDTH +
    REVIEW_DIFF_MIN_WIDTH +
    REVIEW_PANE_SEPARATOR_WIDTH
  const allPanesWidth =
    REVIEW_ACTIVITY_RAIL_WIDTH +
    REVIEW_CONTEXT_PANEL_MIN_WIDTH +
    REVIEW_THREAD_DETAIL_MIN_WIDTH +
    REVIEW_DIFF_MIN_WIDTH +
    REVIEW_PANE_SEPARATOR_WIDTH * 2

  const canRestore = (threshold: number) =>
    containerWidth >= threshold + REVIEW_PANE_RESTORE_HYSTERESIS
  const canKeep = (threshold: number, mode: ReviewPaneMode) =>
    previousMode === mode ? containerWidth >= threshold : canRestore(threshold)

  let mode: ReviewPaneMode
  if (detailOpen) {
    if (sidebarRequestedOpen && canKeep(allPanesWidth, "wide")) mode = "wide"
    else if (canKeep(detailAndDiffWidth, "compact")) mode = "compact"
    else mode = "single"
  } else if (sidebarRequestedOpen) {
    mode = canKeep(contextAndDiffWidth, "wide") ? "wide" : "single"
  } else {
    mode = containerWidth >= REVIEW_ACTIVITY_RAIL_WIDTH + REVIEW_DIFF_MIN_WIDTH ? "wide" : "single"
  }

  if (mode === "wide") {
    return {
      mode,
      contextVisible: sidebarRequestedOpen,
      detailVisible: detailOpen,
      diffVisible: true,
      activityNavigation: "rail",
    }
  }
  if (mode === "compact") {
    return {
      mode,
      contextVisible: false,
      detailVisible: detailOpen,
      diffVisible: true,
      activityNavigation: "rail",
    }
  }

  const singlePane =
    activePane === "thread-detail" && !detailOpen
      ? sidebarRequestedOpen
        ? "context"
        : "diff"
      : activePane === "context" && !sidebarRequestedOpen
        ? "diff"
        : activePane
  return {
    mode,
    contextVisible: singlePane === "context",
    detailVisible: singlePane === "thread-detail",
    diffVisible: singlePane === "diff",
    activityNavigation: "bottom",
  }
}
