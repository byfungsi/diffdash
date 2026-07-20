import { ReviewFileId, ReviewHunkId, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import {
  ReviewSnapshotSearchAvailable,
  ReviewSnapshotSearchCursor,
  ReviewSnapshotSearchMatch,
} from "@diffdash/protocol/review-snapshot"
import { describe, expect, it } from "@effect/vitest"
import { type ReviewSearchPage, ReviewSearchPageCache } from "./review-search-page-cache"

const snapshotId = ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000000")

const makePage = (
  startIndex: number,
  matchCount: number,
  totalMatches: number,
): ReviewSearchPage => {
  const nextIndex = startIndex + matchCount
  return {
    cursor:
      startIndex === 0 ? null : ReviewSnapshotSearchCursor.make(`search:v1:${startIndex}:00000000`),
    startIndex,
    response: ReviewSnapshotSearchAvailable.make({
      snapshotId,
      matches: Array.from({ length: matchCount }, (_, localIndex) => {
        const globalIndex = startIndex + localIndex
        return ReviewSnapshotSearchMatch.make({
          id: `match-${globalIndex}`,
          fileId: ReviewFileId.make(`file-${globalIndex}`),
          filePath: `src/file-${globalIndex}.ts`,
          reviewKey: `review-${globalIndex}`,
          hunkId: ReviewHunkId.make(`hunk-${globalIndex}`),
          hunkLineIndex: globalIndex,
          newLineNumber: globalIndex + 1,
          oldLineNumber: null,
          side: "additions",
          text: `match ${globalIndex}`,
          start: 0,
          end: 5,
        })
      }),
      totalMatches,
      nextCursor:
        nextIndex < totalMatches
          ? ReviewSnapshotSearchCursor.make(`search:v1:${nextIndex}:00000000`)
          : null,
    }),
  }
}

describe("ReviewSearchPageCache", () => {
  it("evicts least-recent pages under the global page and match bounds", () => {
    const cache = new ReviewSearchPageCache({ maxBytes: 1_000_000, maxMatches: 4, maxPages: 2 })
    const first = makePage(0, 2, 6)
    const second = makePage(2, 2, 6)
    const third = makePage(4, 2, 6)

    expect(cache.put(first)).toBe(true)
    expect(cache.put(second)).toBe(true)
    expect(cache.get(first.cursor)).toBe(first)
    expect(cache.put(third)).toBe(true)

    expect(cache.find(0)?.match.id).toBe("match-0")
    expect(cache.find(2)).toBeNull()
    expect(cache.find(4)?.match.id).toBe("match-4")
    expect(cache.matches().map((match) => match.id)).toEqual([
      "match-0",
      "match-1",
      "match-4",
      "match-5",
    ])
    expect(cache.stats()).toMatchObject({ matches: 4, pages: 2 })
  })

  it("retains only the newest fitting page under the aggregate byte bound", () => {
    const first = makePage(0, 1, 2)
    const second = makePage(1, 1, 2)
    const probe = new ReviewSearchPageCache({
      maxBytes: 1_000_000,
      maxMatches: 10,
      maxPages: 10,
    })
    probe.put(first)
    const firstBytes = probe.stats().bytes
    probe.clear()
    probe.put(second)
    const maxBytes = Math.max(firstBytes, probe.stats().bytes)
    const cache = new ReviewSearchPageCache({ maxBytes, maxMatches: 10, maxPages: 10 })

    expect(cache.put(first)).toBe(true)
    expect(cache.put(second)).toBe(true)

    expect(cache.get(first.cursor)).toBeNull()
    expect(cache.get(second.cursor)).toBe(second)
    expect(cache.stats().bytes).toBeLessThanOrEqual(maxBytes)
  })

  it("rejects one page that cannot fit without exceeding its configured bounds", () => {
    const cache = new ReviewSearchPageCache({ maxBytes: 1_000_000, maxMatches: 1, maxPages: 1 })

    expect(cache.put(makePage(0, 2, 2))).toBe(false)
    expect(cache.stats()).toEqual({ bytes: 0, matches: 0, pages: 0 })
  })
})
