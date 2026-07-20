import { jsonSafeUtf8ByteLength } from "@diffdash/protocol/payload-budget"
import {
  REVIEW_SNAPSHOT_SEARCH_MAX_BYTES,
  REVIEW_SNAPSHOT_SEARCH_RESULT_LIMIT,
  ReviewSnapshotSearchAvailable,
  type ReviewSnapshotSearchCursor,
  type ReviewSnapshotSearchMatch,
} from "@diffdash/protocol/review-snapshot"
import { Schema } from "effect"

/** Explicit renderer memory bounds for complete server-side search pages. */
const DEFAULT_REVIEW_SEARCH_PAGE_CACHE_CONFIG = {
  maxBytes: REVIEW_SNAPSHOT_SEARCH_MAX_BYTES * 2,
  maxMatches: REVIEW_SNAPSHOT_SEARCH_RESULT_LIMIT * 2,
  maxPages: 3,
} as const

/** Renderer search-page cache bounds. */
interface ReviewSearchPageCacheConfig {
  readonly maxBytes: number
  readonly maxMatches: number
  readonly maxPages: number
}

/** One complete server-side search page and its global result offset. */
export interface ReviewSearchPage {
  readonly cursor: ReviewSnapshotSearchCursor | null
  readonly response: ReviewSnapshotSearchAvailable
  readonly startIndex: number
}

/** One cached match together with its page and page-local index. */
interface CachedReviewSearchMatch {
  readonly localIndex: number
  readonly match: ReviewSnapshotSearchMatch
  readonly page: ReviewSearchPage
}

interface CachedReviewSearchPage {
  readonly bytes: number
  readonly page: ReviewSearchPage
}

const INITIAL_PAGE_KEY = "initial"

/** Bounded LRU cache for complete server-side review search pages. */
export class ReviewSearchPageCache {
  readonly #config: ReviewSearchPageCacheConfig
  readonly #entries = new Map<string, CachedReviewSearchPage>()
  #bytes = 0
  #matches = 0

  constructor(config: ReviewSearchPageCacheConfig = DEFAULT_REVIEW_SEARCH_PAGE_CACHE_CONFIG) {
    if (
      !isPositiveSafeInteger(config.maxBytes) ||
      !isPositiveSafeInteger(config.maxMatches) ||
      !isPositiveSafeInteger(config.maxPages)
    ) {
      throw new Error("Review search page cache bounds must be positive safe integers")
    }
    this.#config = config
  }

  /** Clears every cached search page. */
  clear(): void {
    this.#entries.clear()
    this.#bytes = 0
    this.#matches = 0
  }

  /** Returns one search page while promoting it to most recently used. */
  get(cursor: ReviewSnapshotSearchCursor | null): ReviewSearchPage | null {
    const key = cursorKey(cursor)
    const entry = this.#entries.get(key)
    if (entry === undefined) return null
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.page
  }

  /** Finds a cached match by its global result index without changing LRU order. */
  find(globalIndex: number): CachedReviewSearchMatch | null {
    if (!Number.isSafeInteger(globalIndex) || globalIndex < 0) return null
    for (const { page } of this.#entries.values()) {
      const localIndex = globalIndex - page.startIndex
      const match = page.response.matches[localIndex]
      if (localIndex >= 0 && match !== undefined) return { localIndex, match, page }
    }
    return null
  }

  /** Adds one complete page and evicts least-recent pages under every configured bound. */
  put(
    page: ReviewSearchPage,
    pinnedCursors: ReadonlySet<ReviewSnapshotSearchCursor | null> = new Set([page.cursor]),
  ): boolean {
    validatePage(page)
    const encoded = Schema.encodeSync(ReviewSnapshotSearchAvailable)(page.response)
    const bytes = jsonSafeUtf8ByteLength({
      cursor: page.cursor,
      response: encoded,
      startIndex: page.startIndex,
    })
    const matchCount = page.response.matches.length
    if (bytes > this.#config.maxBytes || matchCount > this.#config.maxMatches) return false

    const key = cursorKey(page.cursor)
    const previous = this.#entries.get(key)
    if (previous !== undefined) this.#remove(key, previous)
    this.#entries.set(key, { bytes, page })
    this.#bytes += bytes
    this.#matches += matchCount

    const pinnedKeys = new Set([...pinnedCursors].map(cursorKey))
    while (
      this.#entries.size > this.#config.maxPages ||
      this.#matches > this.#config.maxMatches ||
      this.#bytes > this.#config.maxBytes
    ) {
      const evicted = [...this.#entries].find(([candidate]) => !pinnedKeys.has(candidate))
      const fallback = this.#entries.entries().next().value
      const candidate = evicted ?? fallback
      if (candidate === undefined) break
      this.#remove(candidate[0], candidate[1])
    }
    return this.#entries.has(key)
  }

  /** Returns all retained matches in global review order. */
  matches(): readonly ReviewSnapshotSearchMatch[] {
    const pages: ReviewSearchPage[] = []
    for (const { page } of this.#entries.values()) {
      const index = pages.findIndex((candidate) => candidate.startIndex > page.startIndex)
      pages.splice(index === -1 ? pages.length : index, 0, page)
    }
    return pages.flatMap((page) => page.response.matches)
  }

  /** Returns current cache utilization for tests and diagnostics. */
  stats(): { readonly bytes: number; readonly matches: number; readonly pages: number } {
    return { bytes: this.#bytes, matches: this.#matches, pages: this.#entries.size }
  }

  #remove(key: string, entry: CachedReviewSearchPage): void {
    this.#entries.delete(key)
    this.#bytes -= entry.bytes
    this.#matches -= entry.page.response.matches.length
  }
}

const validatePage = (page: ReviewSearchPage) => {
  if (!Number.isSafeInteger(page.startIndex) || page.startIndex < 0) {
    throw new Error("Review search page start index must be a non-negative safe integer")
  }
  if (page.startIndex + page.response.matches.length > page.response.totalMatches) {
    throw new Error("Review search page exceeds its global result count")
  }
  if (page.response.nextCursor !== null && page.response.matches.length === 0) {
    throw new Error("Review search continuation pages must make forward progress")
  }
}

const cursorKey = (cursor: ReviewSnapshotSearchCursor | null): string => cursor ?? INITIAL_PAGE_KEY

const isPositiveSafeInteger = (value: number) => Number.isSafeInteger(value) && value > 0
