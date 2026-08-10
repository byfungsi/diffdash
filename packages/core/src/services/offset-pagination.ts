/** One deterministic page selected by a zero-based item offset. */
interface OffsetPage<Item> {
  readonly items: readonly Item[]
  readonly offset: number
  readonly limit: number
  readonly total: number
  readonly hasMore: boolean
  readonly nextOffset: number | null
}

/** Selects one offset page and derives the next offset from the number of returned items. */
export const paginateByOffset = <Item>(
  items: readonly Item[],
  offset: number,
  limit: number,
): OffsetPage<Item> => {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("Pagination offset must be a non-negative safe integer")
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("Pagination limit must be a positive safe integer")
  }

  const pageItems = items.slice(offset, Math.min(items.length, offset + limit))
  const candidateNextOffset = offset + pageItems.length
  const hasMore = candidateNextOffset < items.length
  return {
    items: pageItems,
    offset,
    limit,
    total: items.length,
    hasMore,
    nextOffset: hasMore ? candidateNextOffset : null,
  }
}
