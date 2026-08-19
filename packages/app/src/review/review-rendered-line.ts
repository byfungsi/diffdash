import type { SelectionSide, VirtualizedFileDiff } from "./pierre"
import type { ReviewThreadAnnotation } from "./thread-annotations"

/** Finds a rendered Pierre content row without assuming unified or split DOM structure. */
export const findRenderedDiffLine = (
  host: HTMLElement,
  instance: VirtualizedFileDiff<ReviewThreadAnnotation>,
  lineNumber: number,
  side: SelectionSide,
): HTMLElement | null => {
  const root = host.shadowRoot
  if (root === null) return null
  const indexes = instance.getLineIndex(lineNumber, side)
  if (indexes === undefined) return null

  const wrapper =
    root.querySelector("[data-unified]") === null ? `[data-${side}]` : "[data-unified]"
  return root.querySelector<HTMLElement>(
    `${wrapper} [data-content] > [data-line][data-line-index="${indexes[0]},${indexes[1]}"]`,
  )
}
