import {
  type FileDiffOptions,
  isVirtualizedFileDiff,
  type PostRenderPhase,
  type SelectionSide,
  VirtualizedFileDiff,
} from "./pierre"
import { findRenderedDiffLine } from "./review-rendered-line"
import type { ReviewThreadAnnotation } from "./thread-annotations"
import { isTextNode } from "@/shared/dom"
import type { ReviewSnapshotSearchMatch } from "@diffdash/protocol/review-snapshot"

/** CSS Custom Highlight registry key for non-active review search matches. */
export const REVIEW_SEARCH_MATCH_HIGHLIGHT = "diffdash-review-search-match"

/** CSS Custom Highlight registry key for the active review search match. */
export const REVIEW_SEARCH_ACTIVE_HIGHLIGHT = "diffdash-review-search-active"

const ACTIVE_REBUILD_RETRY_FRAMES = 8

/** A virtualized line target relative to its Pierre host. */
type ReviewSearchScrollTarget = {
  readonly height: number
  readonly host: HTMLElement
  readonly top: number
}

type SearchDiffRegistration = {
  readonly host: HTMLElement
  readonly instance: VirtualizedFileDiff<ReviewThreadAnnotation>
}

type PierrePostRenderInstance = Parameters<
  NonNullable<FileDiffOptions<ReviewThreadAnnotation>["onPostRender"]>
>[1]

/** Bridges parsed review occurrences to Pierre's virtualized shadow-DOM lines. */
export class ReviewSearchHighlightManager {
  private activeElement: HTMLElement | null = null
  private activeRange: StaticRange | null = null
  private activeOccurrenceId: string | null = null
  private readonly registrations = new Map<string, SearchDiffRegistration>()
  private occurrencesByFile = new Map<string, readonly ReviewSnapshotSearchMatch[]>()
  private rebuildFrame: number | null = null
  private activeRebuildRetries = 0
  private highlightsRegistered = false

  /** Updates the ranges painted in every currently mounted diff. */
  setSearch(occurrences: readonly ReviewSnapshotSearchMatch[], activeOccurrenceId: string | null) {
    const occurrencesByFile = new Map<string, ReviewSnapshotSearchMatch[]>()
    occurrences.forEach((occurrence) => {
      const fileOccurrences = occurrencesByFile.get(occurrence.reviewKey)
      if (fileOccurrences === undefined) {
        occurrencesByFile.set(occurrence.reviewKey, [occurrence])
      } else {
        fileOccurrences.push(occurrence)
      }
    })
    this.occurrencesByFile = occurrencesByFile
    this.activeOccurrenceId = activeOccurrenceId
    this.activeElement = null
    this.activeRange = null
    this.activeRebuildRetries = 0
    if (occurrencesByFile.size === 0) {
      this.cancelScheduledRebuild()
      this.clearHighlights()
      return
    }
    this.scheduleRebuild()
  }

  /** Tracks a Pierre host as virtualization mounts, updates, or removes its rows. */
  handlePostRender(
    reviewKey: string,
    host: HTMLElement,
    instance: PierrePostRenderInstance,
    phase: PostRenderPhase,
  ) {
    if (phase === "unmount") {
      const registration = this.registrations.get(reviewKey)
      if (registration?.host === host) {
        queueMicrotask(() => {
          const current = this.registrations.get(reviewKey)
          if (current?.host === host && !host.isConnected) {
            this.registrations.delete(reviewKey)
          }
          this.scheduleRebuild()
        })
      }
      return
    }

    if (!isVirtualizedFileDiff<ReviewThreadAnnotation>(instance)) return
    this.registrations.forEach((registration, registeredReviewKey) => {
      if (registeredReviewKey !== reviewKey && registration.host === host) {
        this.registrations.delete(registeredReviewKey)
      }
    })
    this.registrations.set(reviewKey, { host, instance })
    this.scheduleRebuild()
  }

  /** Returns Pierre's estimated virtual position for an occurrence. */
  getScrollTarget(occurrence: ReviewSnapshotSearchMatch): ReviewSearchScrollTarget | null {
    const registration = this.registrations.get(occurrence.reviewKey)
    if (registration === undefined) return null

    const side: SelectionSide = occurrence.side === "deletions" ? "deletions" : "additions"
    const lineNumber = side === "deletions" ? occurrence.oldLineNumber : occurrence.newLineNumber
    if (lineNumber === null) return null

    const position = registration.instance.getLinePosition(lineNumber, side)
    return position === undefined ? null : { ...position, host: registration.host }
  }

  /** Measures the active painted substring once its virtual row is mounted. */
  getActiveMatchRect(): DOMRect | null {
    const range = this.activeRange
    if (range === null || !range.startContainer.isConnected || !range.endContainer.isConnected) {
      return null
    }

    const liveRange = document.createRange()
    liveRange.setStart(range.startContainer, range.startOffset)
    liveRange.setEnd(range.endContainer, range.endOffset)
    const rect = liveRange.getBoundingClientRect()
    liveRange.detach()
    return rect.width > 0 && rect.height > 0 ? rect : null
  }

  /** Returns the mounted Pierre row containing the active substring. */
  getActiveMatchElement(): HTMLElement | null {
    return this.activeElement?.isConnected === true ? this.activeElement : null
  }

  /** Rebuilds search ranges after imperative navigation settles a virtualized row. */
  refresh(): void {
    this.activeRebuildRetries = ACTIVE_REBUILD_RETRY_FRAMES
    this.scheduleRebuild()
  }

  /** Removes all registered hosts and document-level highlight ranges. */
  dispose() {
    this.cancelScheduledRebuild()
    this.registrations.clear()
    this.occurrencesByFile.clear()
    this.activeElement = null
    this.activeRange = null
    this.activeRebuildRetries = 0
    this.clearHighlights()
  }

  private scheduleRebuild() {
    if (this.occurrencesByFile.size === 0 || this.rebuildFrame !== null) return
    this.rebuildFrame = window.requestAnimationFrame(() => {
      this.rebuildFrame = null
      this.rebuildHighlights()
      if (
        this.activeOccurrenceId !== null &&
        this.activeRange === null &&
        this.activeRebuildRetries > 0
      ) {
        this.activeRebuildRetries -= 1
        this.scheduleRebuild()
      } else {
        this.activeRebuildRetries = 0
      }
    })
  }

  private cancelScheduledRebuild() {
    if (this.rebuildFrame === null) return
    window.cancelAnimationFrame(this.rebuildFrame)
    this.rebuildFrame = null
  }

  private clearHighlights() {
    if (!this.highlightsRegistered) return
    clearRegisteredHighlights()
    this.highlightsRegistered = false
  }

  private rebuildHighlights() {
    if (!supportsCustomHighlights() || this.occurrencesByFile.size === 0) return

    const matchRanges: StaticRange[] = []
    const activeRanges: StaticRange[] = []
    this.activeElement = null
    this.activeRange = null

    this.registrations.forEach(({ host, instance }, reviewKey) => {
      const shadowRoot = host.shadowRoot
      const occurrences = this.occurrencesByFile.get(reviewKey)
      if (shadowRoot === null || occurrences === undefined) return

      occurrences.forEach((occurrence) => {
        const seenRows = new Set<HTMLElement>()
        for (const [side, lineNumber] of renderedSearchCoordinates(occurrence)) {
          if (lineNumber === null) continue
          const row = findRenderedDiffLine(host, instance, lineNumber, side)
          if (
            row === null ||
            seenRows.has(row) ||
            !renderedTextMatchesSource(row, occurrence.text, occurrence.start, occurrence.end)
          ) {
            continue
          }
          seenRows.add(row)

          const range = createStaticTextRange(row, occurrence.start, occurrence.end)
          if (range === null) continue
          if (occurrence.id === this.activeOccurrenceId) {
            activeRanges.push(range)
            if (this.activeRange === null) {
              this.activeElement = row
              this.activeRange = range
            }
          } else {
            matchRanges.push(range)
          }
        }
      })
    })

    clearRegisteredHighlights()
    if (matchRanges.length > 0) {
      CSS.highlights.set(REVIEW_SEARCH_MATCH_HIGHLIGHT, new Highlight(...matchRanges))
    }
    if (activeRanges.length > 0) {
      const activeHighlight = new Highlight(...activeRanges)
      activeHighlight.priority = 1
      CSS.highlights.set(REVIEW_SEARCH_ACTIVE_HIGHLIGHT, activeHighlight)
    }
    this.highlightsRegistered = matchRanges.length > 0 || activeRanges.length > 0
  }
}

const renderedSearchCoordinates = (
  occurrence: ReviewSnapshotSearchMatch,
): readonly (readonly [SelectionSide, number | null])[] =>
  occurrence.side === "context"
    ? [
        ["additions", occurrence.newLineNumber],
        ["deletions", occurrence.oldLineNumber],
      ]
    : [
        [
          occurrence.side,
          occurrence.side === "deletions" ? occurrence.oldLineNumber : occurrence.newLineNumber,
        ],
      ]

const renderedTextMatchesSource = (
  row: HTMLElement,
  source: string,
  start: number,
  end: number,
) => {
  const rendered = row.textContent ?? ""
  const normalized = rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered
  return normalized === source || normalized.slice(start, end) === source
}

const createStaticTextRange = (
  row: HTMLElement,
  startOffset: number,
  endOffset: number,
): StaticRange | null => {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  let offset = 0
  let start: { readonly node: Text; readonly offset: number } | null = null

  while (node !== null) {
    if (isTextNode(node)) {
      const nextOffset = offset + node.data.length
      if (start === null && startOffset <= nextOffset) {
        start = { node, offset: startOffset - offset }
      }
      if (start !== null && endOffset <= nextOffset) {
        return new StaticRange({
          endContainer: node,
          endOffset: endOffset - offset,
          startContainer: start.node,
          startOffset: start.offset,
        })
      }
      offset = nextOffset
    }
    node = walker.nextNode()
  }

  return null
}

const supportsCustomHighlights = () => {
  const css = globalThis.CSS
  const highlight = globalThis.Highlight
  const staticRange = globalThis.StaticRange
  return (
    css !== undefined && "highlights" in css && highlight !== undefined && staticRange !== undefined
  )
}

const clearRegisteredHighlights = () => {
  if (!supportsCustomHighlights()) return
  CSS.highlights.delete(REVIEW_SEARCH_MATCH_HIGHLIGHT)
  CSS.highlights.delete(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)
}
