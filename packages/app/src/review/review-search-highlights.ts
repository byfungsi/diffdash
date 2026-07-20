import { type PostRenderPhase, type SelectionSide, VirtualizedFileDiff } from "./pierre"
import type { ReviewSearchOccurrence } from "./review-search"

/** CSS Custom Highlight registry key for non-active review search matches. */
export const REVIEW_SEARCH_MATCH_HIGHLIGHT = "diffdash-review-search-match"

/** CSS Custom Highlight registry key for the active review search match. */
export const REVIEW_SEARCH_ACTIVE_HIGHLIGHT = "diffdash-review-search-active"

/** A virtualized line target relative to its Pierre host. */
type ReviewSearchScrollTarget = {
  readonly height: number
  readonly host: HTMLElement
  readonly top: number
}

type SearchDiffRegistration = {
  readonly host: HTMLElement
  readonly instance: VirtualizedFileDiff<unknown>
}

/** Bridges parsed review occurrences to Pierre's virtualized shadow-DOM lines. */
export class ReviewSearchHighlightManager {
  private activeElement: HTMLElement | null = null
  private activeRange: StaticRange | null = null
  private activeOccurrenceId: string | null = null
  private readonly registrations = new Map<string, SearchDiffRegistration>()
  private occurrencesByFile = new Map<string, readonly ReviewSearchOccurrence[]>()

  /** Updates the ranges painted in every currently mounted diff. */
  setSearch(occurrences: readonly ReviewSearchOccurrence[], activeOccurrenceId: string | null) {
    const occurrencesByFile = new Map<string, ReviewSearchOccurrence[]>()
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
    this.rebuildHighlights()
  }

  /** Tracks a Pierre host as virtualization mounts, updates, or removes its rows. */
  handlePostRender(reviewKey: string, host: HTMLElement, instance: object, phase: PostRenderPhase) {
    if (phase === "unmount") {
      const registration = this.registrations.get(reviewKey)
      if (registration?.host === host) this.registrations.delete(reviewKey)
      this.rebuildHighlights()
      return
    }

    if (!(instance instanceof VirtualizedFileDiff)) return
    this.registrations.set(reviewKey, { host, instance })
    this.rebuildHighlights()
  }

  /** Returns Pierre's estimated virtual position for an occurrence. */
  getScrollTarget(occurrence: ReviewSearchOccurrence): ReviewSearchScrollTarget | null {
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

  /** Removes all registered hosts and document-level highlight ranges. */
  dispose() {
    this.registrations.clear()
    this.occurrencesByFile.clear()
    this.activeElement = null
    this.activeRange = null
    clearRegisteredHighlights()
  }

  private rebuildHighlights() {
    if (!supportsCustomHighlights()) return

    const matchRanges: StaticRange[] = []
    const activeRanges: StaticRange[] = []
    this.activeElement = null
    this.activeRange = null

    this.registrations.forEach(({ host }, reviewKey) => {
      const shadowRoot = host.shadowRoot
      const occurrences = this.occurrencesByFile.get(reviewKey)
      if (shadowRoot === null || occurrences === undefined) return

      const occurrencesByRow = indexOccurrencesByRenderedRow(occurrences)
      for (const side of ["deletions", "additions"] as const) {
        const rows = shadowRoot.querySelectorAll<HTMLElement>(
          `[data-${side}] [data-content] > [data-line]`,
        )
        rows.forEach((row) => {
          const lineNumber = Number(row.dataset.line)
          if (!Number.isSafeInteger(lineNumber)) return
          const rowOccurrences = occurrencesByRow.get(`${side}:${lineNumber}`)
          if (rowOccurrences === undefined || rowOccurrences.length === 0) return
          if (!renderedTextMatchesSource(row, rowOccurrences[0]?.text ?? "")) return

          rowOccurrences.forEach((occurrence) => {
            const range = createStaticTextRange(row, occurrence.start, occurrence.end)
            if (range === null) return
            if (occurrence.id === this.activeOccurrenceId) {
              activeRanges.push(range)
              if (this.activeRange === null || side === "additions") {
                this.activeElement = row
                this.activeRange = range
              }
            } else {
              matchRanges.push(range)
            }
          })
        })
      }
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
  }
}

const indexOccurrencesByRenderedRow = (occurrences: readonly ReviewSearchOccurrence[]) => {
  const byRow = new Map<string, ReviewSearchOccurrence[]>()
  occurrences.forEach((occurrence) => {
    const rows =
      occurrence.side === "context"
        ? ([
            ["deletions", occurrence.oldLineNumber],
            ["additions", occurrence.newLineNumber],
          ] as const)
        : ([
            [
              occurrence.side,
              occurrence.side === "deletions" ? occurrence.oldLineNumber : occurrence.newLineNumber,
            ],
          ] as const)

    rows.forEach(([side, lineNumber]) => {
      if (lineNumber === null) return
      const key = `${side}:${lineNumber}`
      const rowOccurrences = byRow.get(key)
      if (rowOccurrences === undefined) {
        byRow.set(key, [occurrence])
      } else {
        rowOccurrences.push(occurrence)
      }
    })
  })
  return byRow
}

const renderedTextMatchesSource = (row: HTMLElement, source: string) => {
  const rendered = row.textContent ?? ""
  return rendered === source || (rendered.endsWith("\n") && rendered.slice(0, -1) === source)
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
    if (node instanceof Text) {
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

const supportsCustomHighlights = () =>
  typeof CSS !== "undefined" &&
  "highlights" in CSS &&
  typeof Highlight !== "undefined" &&
  typeof StaticRange !== "undefined"

const clearRegisteredHighlights = () => {
  if (!supportsCustomHighlights()) return
  CSS.highlights.delete(REVIEW_SEARCH_MATCH_HIGHLIGHT)
  CSS.highlights.delete(REVIEW_SEARCH_ACTIVE_HIGHLIGHT)
}
