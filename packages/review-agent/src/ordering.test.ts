import { describe, expect, it } from "@effect/vitest"

import { compareStrings, orderedReviewHunks, sortedCopy } from "./ordering"

describe("review ordering", () => {
  it("sorts copies without mutating input", () => {
    const input = ["b", "a"] as const
    expect(sortedCopy(input, compareStrings)).toEqual(["a", "b"])
    expect(input).toEqual(["b", "a"])
  })

  it("orders hunks by old line, new line, then stable ID", () => {
    const hunks = [
      { id: "b", oldStart: 1, newStart: 2 },
      { id: "a", oldStart: 1, newStart: 2 },
      { id: "c", oldStart: 2, newStart: 1 },
    ]

    expect(orderedReviewHunks(hunks).map(({ id }) => id)).toEqual(["a", "b", "c"])
  })
})
