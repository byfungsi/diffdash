import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react"
import { useId, useLayoutEffect, useRef, useState } from "react"
import { type LayoutChangedMeta, useGroupRef, usePanelRef } from "react-resizable-panels"
import { Pane, PaneGroup, PaneResizeHandle } from "@/shared/ui/pane-layout"
import {
  clampReviewContextPanelWidth,
  clampReviewThreadDetailWidth,
  type ReviewActivePane,
  REVIEW_ACTIVITY_RAIL_WIDTH,
  REVIEW_CONTEXT_PANEL_DEFAULT_WIDTH,
  REVIEW_CONTEXT_PANEL_MAX_WIDTH,
  REVIEW_CONTEXT_PANEL_MIN_WIDTH,
  REVIEW_DIFF_MIN_WIDTH,
  type ReviewPaneMode,
  resolveReviewPanePlan,
  REVIEW_THREAD_DETAIL_DEFAULT_WIDTH,
  REVIEW_THREAD_DETAIL_MAX_WIDTH,
  REVIEW_THREAD_DETAIL_MIN_WIDTH,
} from "./review-sidebar-layout"

/** Preferred review-pane sizes persisted independently from responsive placement. */
export type ReviewPanePreferences = {
  readonly contextWidth: number
  readonly threadDetailWidth: number
}

/** Stable nested split tree for review context, thread detail, and diff content. */
export function ReviewWorkbenchLayout({
  activePane,
  context,
  detail,
  detailOpen,
  diff,
  preferences,
  sidebarRequestedOpen,
  renderActivityNavigation,
  onContextCollapsedByUser,
  onContextWidthCommit,
  onDetailCollapsedByUser,
  onDetailWidthCommit,
}: {
  readonly activePane: ReviewActivePane
  readonly context: ReactNode
  readonly detail: ReactNode
  readonly detailOpen: boolean
  readonly diff: ReactNode
  readonly preferences: ReviewPanePreferences
  readonly sidebarRequestedOpen: boolean
  readonly renderActivityNavigation: (placement: "rail" | "bottom") => ReactNode
  readonly onContextCollapsedByUser: () => void
  readonly onContextWidthCommit: (width: number) => void
  readonly onDetailCollapsedByUser: () => void
  readonly onDetailWidthCommit: (width: number) => void
}) {
  const paneId = useId()
  const rootGroupId = `${paneId}-root-group`
  const contextPaneId = `${paneId}-context`
  const contextResizeHandleId = `${paneId}-context-resizer`
  const contentPaneId = `${paneId}-content`
  const contentGroupId = `${paneId}-content-group`
  const detailPaneId = `${paneId}-thread-detail`
  const detailResizeHandleId = `${paneId}-thread-detail-resizer`
  const diffPaneId = `${paneId}-diff`
  const rootRef = useRef<HTMLElement>(null)
  const rootGroupElementRef = useRef<HTMLDivElement>(null)
  const contentGroupElementRef = useRef<HTMLDivElement>(null)
  const rootGroupRef = useGroupRef()
  const contentGroupRef = useGroupRef()
  const contextPaneRef = usePanelRef()
  const contentPaneRef = usePanelRef()
  const detailPaneRef = usePanelRef()
  const diffPaneRef = usePanelRef()
  const [containerWidth, setContainerWidth] = useState(() => window.innerWidth)
  const [mode, setMode] = useState<ReviewPaneMode>("wide")
  const plan = resolveReviewPanePlan({
    activePane,
    containerWidth,
    detailOpen,
    previousMode: mode,
    sidebarRequestedOpen,
  })
  const contextOnly = plan.contextVisible && !plan.detailVisible && !plan.diffVisible
  const detailOnly = plan.detailVisible && !plan.diffVisible
  const diffOnly = plan.diffVisible && !plan.detailVisible
  const outerHandleVisible = plan.contextVisible && (plan.detailVisible || plan.diffVisible)
  const innerHandleVisible = plan.detailVisible && plan.diffVisible
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null) return undefined
    const updateWidth = (width: number) => setContainerWidth(Math.round(width))
    updateWidth(root.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry !== undefined) updateWidth(entry.contentRect.width)
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (plan.mode !== mode) setMode(plan.mode)
  }, [mode, plan.mode])

  useLayoutEffect(() => {
    const groupWidth = Math.max(
      1,
      containerWidth - (plan.activityNavigation === "rail" ? REVIEW_ACTIVITY_RAIL_WIDTH : 0),
    )
    const contentVisible = plan.detailVisible || plan.diffVisible
    const contextPercentage = !plan.contextVisible
      ? 0
      : contentVisible
        ? Math.min(100, (preferences.contextWidth / groupWidth) * 100)
        : 100
    rootGroupRef.current?.setLayout({
      [contextPaneId]: contextPercentage,
      [contentPaneId]: 100 - contextPercentage,
    })

    const contentWidth = Math.max(1, groupWidth * ((100 - contextPercentage) / 100))
    const detailPercentage = !plan.detailVisible
      ? 0
      : plan.diffVisible
        ? Math.min(100, (preferences.threadDetailWidth / contentWidth) * 100)
        : 100
    const frame = window.requestAnimationFrame(() => {
      contentGroupRef.current?.setLayout({
        [detailPaneId]: detailPercentage,
        [diffPaneId]: 100 - detailPercentage,
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [
    containerWidth,
    contextPaneId,
    contentPaneId,
    contentGroupRef,
    detailPaneId,
    diffPaneId,
    plan.contextVisible,
    plan.detailVisible,
    plan.diffVisible,
    plan.activityNavigation,
    preferences.contextWidth,
    preferences.threadDetailWidth,
    rootGroupRef,
  ])

  const commitContextLayout = (layout: Record<string, number>, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return
    const size =
      (rootGroupElementRef.current?.getBoundingClientRect().width ?? 0) *
      ((layout[contextPaneId] ?? 0) / 100)
    if (size === 0) {
      onContextCollapsedByUser()
      return
    }
    onContextWidthCommit(clampReviewContextPanelWidth(size))
  }
  const commitDetailLayout = (layout: Record<string, number>, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return
    const size =
      (contentGroupElementRef.current?.getBoundingClientRect().width ?? 0) *
      ((layout[detailPaneId] ?? 0) / 100)
    if (size === 0) {
      onDetailCollapsedByUser()
      return
    }
    onDetailWidthCommit(clampReviewThreadDetailWidth(size))
  }
  const setContextWidth = (requestedWidth: number) => {
    const width = rootGroupElementRef.current?.getBoundingClientRect().width ?? 0
    if (width <= 0) return
    const contextWidth = clampReviewContextPanelWidth(requestedWidth)
    const percentage = (contextWidth / width) * 100
    rootGroupRef.current?.setLayout({
      [contextPaneId]: percentage,
      [contentPaneId]: 100 - percentage,
    })
    onContextWidthCommit(contextWidth)
  }
  const resetContextWidth = () => setContextWidth(REVIEW_CONTEXT_PANEL_DEFAULT_WIDTH)
  const resizeContextWidthFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentWidth = contextPaneRef.current?.getSize().inPixels ?? preferences.contextWidth
    const step = event.shiftKey ? 32 : 8
    const width =
      event.key === "ArrowLeft"
        ? currentWidth - step
        : event.key === "ArrowRight"
          ? currentWidth + step
          : event.key === "Home"
            ? REVIEW_CONTEXT_PANEL_MIN_WIDTH
            : event.key === "End"
              ? REVIEW_CONTEXT_PANEL_MAX_WIDTH
              : null
    if (width === null) return
    event.preventDefault()
    event.stopPropagation()
    setContextWidth(width)
  }
  const setDetailWidth = (requestedWidth: number) => {
    const width = contentGroupElementRef.current?.getBoundingClientRect().width ?? 0
    if (width <= 0) return
    const detailWidth = clampReviewThreadDetailWidth(requestedWidth)
    const percentage = (detailWidth / width) * 100
    contentGroupRef.current?.setLayout({
      [detailPaneId]: percentage,
      [diffPaneId]: 100 - percentage,
    })
    onDetailWidthCommit(detailWidth)
  }
  const resetDetailWidth = () => setDetailWidth(REVIEW_THREAD_DETAIL_DEFAULT_WIDTH)
  const resizeDetailWidthFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentWidth = detailPaneRef.current?.getSize().inPixels ?? preferences.threadDetailWidth
    const step = event.shiftKey ? 32 : 8
    const width =
      event.key === "ArrowLeft"
        ? currentWidth - step
        : event.key === "ArrowRight"
          ? currentWidth + step
          : event.key === "Home"
            ? REVIEW_THREAD_DETAIL_MIN_WIDTH
            : event.key === "End"
              ? REVIEW_THREAD_DETAIL_MAX_WIDTH
              : null
    if (width === null) return
    event.preventDefault()
    event.stopPropagation()
    setDetailWidth(width)
  }

  return (
    <section
      ref={rootRef}
      data-review-layout
      data-review-pane-mode={plan.mode}
      className={`bg-shell-bevel flex h-full min-h-0 w-full overflow-hidden text-sm ${
        plan.activityNavigation === "bottom" ? "flex-col" : "flex-row"
      }`}
    >
      {renderActivityNavigation(plan.activityNavigation)}
      <div
        data-review-workspace-frame
        className={`workbench-frame bg-background order-1 min-h-0 min-w-0 flex-1 overflow-hidden ${
          plan.activityNavigation === "bottom" ? "h-0 w-full" : "h-full w-0"
        }`}
      >
        <PaneGroup
          id={rootGroupId}
          elementRef={rootGroupElementRef}
          groupRef={rootGroupRef}
          orientation="horizontal"
          onLayoutChanged={commitContextLayout}
        >
          <Pane
            id={contextPaneId}
            panelRef={contextPaneRef}
            collapsible
            collapsedSize={0}
            defaultSize={preferences.contextWidth}
            groupResizeBehavior="preserve-pixel-size"
            minSize={contextOnly ? 0 : REVIEW_CONTEXT_PANEL_MIN_WIDTH}
            maxSize={contextOnly ? "100%" : REVIEW_CONTEXT_PANEL_MAX_WIDTH}
          >
            <div
              aria-hidden={!plan.contextVisible}
              data-review-collapsible-sidebar-pane
              inert={!plan.contextVisible}
              className="h-full min-h-0 min-w-0"
            >
              {context}
            </div>
          </Pane>

          <PaneResizeHandle
            id={contextResizeHandleId}
            aria-label="Resize review sidebar"
            data-review-sidebar-resizer
            disableDoubleClick
            disabled={!outerHandleVisible}
            className={outerHandleVisible ? undefined : "pointer-events-none invisible"}
            onDoubleClick={resetContextWidth}
            onKeyDownCapture={resizeContextWidthFromKeyboard}
          />

          <Pane
            id={contentPaneId}
            panelRef={contentPaneRef}
            collapsible
            collapsedSize={0}
            defaultSize="75%"
            groupResizeBehavior="preserve-relative-size"
            minSize={contextOnly ? 0 : REVIEW_DIFF_MIN_WIDTH}
          >
            <PaneGroup
              id={contentGroupId}
              elementRef={contentGroupElementRef}
              groupRef={contentGroupRef}
              orientation="horizontal"
              onLayoutChanged={commitDetailLayout}
            >
              <Pane
                id={detailPaneId}
                panelRef={detailPaneRef}
                collapsible
                collapsedSize={0}
                defaultSize={preferences.threadDetailWidth}
                groupResizeBehavior="preserve-pixel-size"
                minSize={detailOnly ? 0 : REVIEW_THREAD_DETAIL_MIN_WIDTH}
                maxSize={detailOnly ? "100%" : REVIEW_THREAD_DETAIL_MAX_WIDTH}
              >
                <div
                  aria-hidden={!plan.detailVisible}
                  data-review-collapsible-sidebar-pane
                  inert={!plan.detailVisible}
                  className="h-full min-h-0 min-w-0"
                >
                  {detail}
                </div>
              </Pane>

              <PaneResizeHandle
                id={detailResizeHandleId}
                aria-label="Resize thread details"
                data-review-thread-detail-resizer
                disableDoubleClick
                disabled={!innerHandleVisible}
                className={innerHandleVisible ? undefined : "pointer-events-none invisible"}
                onDoubleClick={resetDetailWidth}
                onKeyDownCapture={resizeDetailWidthFromKeyboard}
              />

              <Pane
                id={diffPaneId}
                panelRef={diffPaneRef}
                collapsible
                collapsedSize={0}
                defaultSize="65%"
                groupResizeBehavior="preserve-relative-size"
                minSize={diffOnly ? 0 : REVIEW_DIFF_MIN_WIDTH}
              >
                <div
                  aria-hidden={!plan.diffVisible}
                  inert={!plan.diffVisible}
                  className="h-full min-h-0 min-w-0"
                >
                  {diff}
                </div>
              </Pane>
            </PaneGroup>
          </Pane>
        </PaneGroup>
      </div>
    </section>
  )
}
