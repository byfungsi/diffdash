import type { ParsedDiffFile } from "@diffdash/domain/diff"
import { useLayoutEffect, useRef, type RefObject } from "react"
import { type PostRenderPhase, useStableCallback } from "@/review/pierre"
import { stableStringHash32 } from "@/shared/stable-string-hash"

/** One requested viewed-state transition. */
export type ViewedFileUpdate = {
  readonly reviewKey: string
  readonly viewed: boolean
}

/** Captured viewport geometry for one diff card. */
type ViewedFileCardGeometry = {
  readonly reviewKey: string
  readonly bottom: number
  readonly height: number
  readonly top: number
}

/** Captured anchor used to preserve the visible diff position. */
type ViewedFileViewportAnchor = {
  readonly reviewKey: string
  readonly top: number
}

type PendingViewedViewport = {
  readonly anchor: ViewedFileViewportAnchor | null
  readonly cards: Map<string, Omit<ViewedFileCardGeometry, "reviewKey">>
  readonly overflowAnchor: string
  readonly pendingRenderKeys: Set<string>
  readonly scrollTop: number
  readonly visibleTop: number
  readonly windowScrollX: number
  readonly windowScrollY: number
}

/** Keeps only the last requested transition for each review key. */
export const uniqueViewedFileUpdates = (
  updates: readonly ViewedFileUpdate[],
): readonly ViewedFileUpdate[] => [
  ...new Map(updates.map((update) => [update.reviewKey, update])).values(),
]

/** Selects the first visible card and its stable top edge for viewport preservation. */
export const viewedFileViewportAnchor = (
  cards: readonly ViewedFileCardGeometry[],
  updates: readonly ViewedFileUpdate[],
  visibleTop: number,
  visibleBottom: number,
): ViewedFileViewportAnchor | null => {
  const anchorCard = cards.find((card) => card.bottom > visibleTop && card.top < visibleBottom)
  if (anchorCard === undefined) return null

  const anchorUpdate = updates.find((update) => update.reviewKey === anchorCard.reviewKey)
  return {
    reviewKey: anchorCard.reviewKey,
    top: anchorUpdate?.viewed === true ? Math.max(anchorCard.top, visibleTop) : anchorCard.top,
  }
}

/** Calculates scroll compensation after viewed-state changes alter card heights. */
export const viewedFileScrollAdjustment = (
  cards: readonly {
    readonly nextHeight: number
    readonly previous: Omit<ViewedFileCardGeometry, "reviewKey">
  }[],
  visibleTop: number,
) =>
  cards.reduce((adjustment, { nextHeight, previous }) => {
    const heightDelta = nextHeight - previous.height
    if (previous.bottom <= visibleTop) return adjustment + heightDelta
    if (heightDelta < 0 && previous.top < visibleTop) {
      return adjustment - Math.min(-heightDelta, visibleTop - previous.top)
    }
    return adjustment
  }, 0)

/** Clamps a requested scroll position to the current scrollable range. */
export const clampViewedFileScrollTop = (
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
) => Math.min(Math.max(0, scrollTop), Math.max(0, scrollHeight - clientHeight))

/** Stable DOM ID shared by diff rendering and viewport navigation. */
export const diffCardDomId = (reviewKey: string) =>
  `diff-card-${stableStringHash32(reviewKey).toString(36)}`

/** Inputs required by the viewed-file viewport preservation controller. */
interface ViewedFileViewportOptions {
  readonly containerRef: RefObject<HTMLElement | null>
  readonly expandedFileKeys: ReadonlySet<string>
  readonly onSetViewed: (reviewKey: string, viewed: boolean) => void
  readonly scopeKey: string
  readonly stickyChromeRef: RefObject<HTMLElement | null>
  readonly viewedFileKeys: ReadonlySet<string>
  readonly visibleFiles: readonly Pick<ParsedDiffFile, "reviewKey">[]
}

/** Operations exposed by the viewed-file viewport preservation controller. */
interface ViewedFileViewportController {
  readonly handleDiffRendered: (reviewKey: string, phase: PostRenderPhase) => void
  readonly setFileViewed: (reviewKey: string, viewed: boolean) => void
  readonly setFilesViewed: (updates: readonly ViewedFileUpdate[]) => void
}

/**
 * Preserves the current diff viewport while viewed-state transitions collapse or rerender files.
 */
export const useViewedFileViewport = ({
  containerRef,
  expandedFileKeys,
  onSetViewed,
  scopeKey,
  stickyChromeRef,
  viewedFileKeys,
  visibleFiles,
}: ViewedFileViewportOptions): ViewedFileViewportController => {
  const pendingFrameRef = useRef<number | null>(null)
  const pendingTimeoutRef = useRef<number | null>(null)
  const pendingViewportRef = useRef<PendingViewedViewport | null>(null)

  const finish = useStableCallback((pending: PendingViewedViewport) => {
    if (pendingViewportRef.current !== pending) return

    const container = containerRef.current
    if (container !== null) container.style.overflowAnchor = pending.overflowAnchor
    if (pendingFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingFrameRef.current)
      pendingFrameRef.current = null
    }
    if (pendingTimeoutRef.current !== null) {
      window.clearTimeout(pendingTimeoutRef.current)
      pendingTimeoutRef.current = null
    }
    pendingViewportRef.current = null
  })

  const stabilize = useStableCallback((pending: PendingViewedViewport) => {
    if (pendingViewportRef.current !== pending) return

    const container = containerRef.current
    const anchorCard =
      pending.anchor === null
        ? null
        : document.getElementById(diffCardDomId(pending.anchor.reviewKey))
    if (container !== null && anchorCard !== null && pending.anchor !== null) {
      const anchorDelta = anchorCard.getBoundingClientRect().top - pending.anchor.top
      container.scrollTop = clampViewedFileScrollTop(
        container.scrollTop + anchorDelta,
        container.scrollHeight,
        container.clientHeight,
      )
      container.dispatchEvent(new Event("scroll"))
    }
    window.scrollTo(pending.windowScrollX, pending.windowScrollY)
  })

  const scheduleStabilization = useStableCallback(
    (pending: PendingViewedViewport, force = false) => {
      if (pendingViewportRef.current !== pending) return
      if (pendingFrameRef.current !== null) window.cancelAnimationFrame(pendingFrameRef.current)

      const stabilizeAfterFrame = (remainingFrames: number) => {
        pendingFrameRef.current = window.requestAnimationFrame(() => {
          pendingFrameRef.current = null
          if (pendingViewportRef.current !== pending) return
          stabilize(pending)
          if (!force && pending.pendingRenderKeys.size > 0) return
          if (remainingFrames > 1) {
            stabilizeAfterFrame(remainingFrames - 1)
          } else {
            finish(pending)
          }
        })
      }
      stabilizeAfterFrame(2)
    },
  )

  const setFilesViewed = useStableCallback((requestedUpdates: readonly ViewedFileUpdate[]) => {
    const updates = uniqueViewedFileUpdates(requestedUpdates)
    if (updates.length === 0) return

    const container = containerRef.current
    const previousPending = pendingViewportRef.current
    if (previousPending !== null) finish(previousPending)

    if (container !== null) {
      const containerRect = container.getBoundingClientRect()
      const visibleTop = containerRect.top + (stickyChromeRef.current?.offsetHeight ?? 0)
      const visibleCards = visibleFiles.flatMap((file) => {
        const rect = document.getElementById(diffCardDomId(file.reviewKey))?.getBoundingClientRect()
        return rect === undefined
          ? []
          : [
              {
                reviewKey: file.reviewKey,
                bottom: rect.bottom,
                height: rect.height,
                top: rect.top,
              },
            ]
      })
      const cards = new Map<string, Omit<ViewedFileCardGeometry, "reviewKey">>()
      updates.forEach(({ reviewKey }) => {
        const rect = document.getElementById(diffCardDomId(reviewKey))?.getBoundingClientRect()
        if (rect !== undefined) {
          cards.set(reviewKey, { bottom: rect.bottom, height: rect.height, top: rect.top })
        }
      })
      const pending: PendingViewedViewport = {
        anchor: viewedFileViewportAnchor(visibleCards, updates, visibleTop, containerRect.bottom),
        cards,
        overflowAnchor: container.style.overflowAnchor,
        pendingRenderKeys: new Set(
          updates.filter(({ viewed }) => !viewed).map(({ reviewKey }) => reviewKey),
        ),
        scrollTop: container.scrollTop,
        visibleTop,
        windowScrollX: window.scrollX,
        windowScrollY: window.scrollY,
      }
      pendingViewportRef.current = pending
      container.style.overflowAnchor = "none"
      pendingTimeoutRef.current = window.setTimeout(() => {
        pending.pendingRenderKeys.clear()
        scheduleStabilization(pending, true)
      }, 2_000)
    }

    updates.forEach(({ reviewKey, viewed }) => onSetViewed(reviewKey, viewed))
  })

  const setFileViewed = useStableCallback((reviewKey: string, viewed: boolean) => {
    setFilesViewed([{ reviewKey, viewed }])
  })

  const handleDiffRendered = useStableCallback((reviewKey: string, phase: PostRenderPhase) => {
    if (phase === "unmount") return

    const pending = pendingViewportRef.current
    if (pending !== null && pending.pendingRenderKeys.delete(reviewKey)) {
      stabilize(pending)
      if (pending.pendingRenderKeys.size === 0) scheduleStabilization(pending)
    }
  })

  useLayoutEffect(() => {
    const pending = pendingViewportRef.current
    const container = containerRef.current
    if (pending === null || container === null) return

    const changedCards = [...pending.cards].flatMap(([reviewKey, previous]) => {
      const card = document.getElementById(diffCardDomId(reviewKey))
      return card === null ? [] : [{ previous, nextHeight: card.getBoundingClientRect().height }]
    })
    const scrollAdjustment = viewedFileScrollAdjustment(changedCards, pending.visibleTop)
    container.scrollTop = clampViewedFileScrollTop(
      pending.scrollTop + scrollAdjustment,
      container.scrollHeight,
      container.clientHeight,
    )
    container.dispatchEvent(new Event("scroll"))
    window.scrollTo(pending.windowScrollX, pending.windowScrollY)
    stabilize(pending)
    scheduleStabilization(pending)
  }, [containerRef, expandedFileKeys, scheduleStabilization, stabilize, viewedFileKeys])

  useLayoutEffect(
    () => () => {
      const pending = pendingViewportRef.current
      if (pending !== null) finish(pending)
    },
    [finish, scopeKey],
  )

  return { handleDiffRendered, setFileViewed, setFilesViewed }
}
