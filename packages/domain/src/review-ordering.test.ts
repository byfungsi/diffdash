import { describe, expect, it } from "@effect/vitest"
import { orderedReviewHunks } from "./review-ordering"

describe("review ordering", () => {
  it("orders hunks by old line, new line, then code-unit ID without mutating input", () => {
    const hunks = [
      { id: "z", oldStart: 1, newStart: 3 },
      { id: "a", oldStart: 1, newStart: 2 },
      { id: "Z", oldStart: 1, newStart: 2 },
      { id: "first", oldStart: 0, newStart: 99 },
    ]

    expect(orderedReviewHunks(hunks).map(({ id }) => id)).toEqual(["first", "Z", "a", "z"])
    expect(hunks.map(({ id }) => id)).toEqual(["z", "a", "Z", "first"])
  })
})
