import { describe, expect, it } from "@effect/vitest"

import {
  isVeryLargeDiff,
  isVeryLargeDiffFile,
  VERY_LARGE_DIFF_CHANGED_LINE_THRESHOLD,
  VERY_LARGE_DIFF_CHARACTER_THRESHOLD,
} from "./large-diff-policy"

describe("large diff policy", () => {
  it("keeps the threshold boundary eligible for normal rendering", () => {
    expect(
      isVeryLargeDiffFile({
        additions: VERY_LARGE_DIFF_CHANGED_LINE_THRESHOLD / 2,
        deletions: VERY_LARGE_DIFF_CHANGED_LINE_THRESHOLD / 2,
        patch: "small patch",
      }),
    ).toBe(false)
    expect(
      isVeryLargeDiffFile({
        additions: 1,
        deletions: 1,
        patch: "x".repeat(VERY_LARGE_DIFF_CHARACTER_THRESHOLD),
      }),
    ).toBe(false)
  })

  it("classifies files over either the line or character threshold as very large", () => {
    expect(
      isVeryLargeDiffFile({
        additions: VERY_LARGE_DIFF_CHANGED_LINE_THRESHOLD,
        deletions: 1,
        patch: "line-heavy",
      }),
    ).toBe(true)
    expect(
      isVeryLargeDiffFile({
        additions: 1,
        deletions: 1,
        patch: "x".repeat(VERY_LARGE_DIFF_CHARACTER_THRESHOLD + 1),
      }),
    ).toBe(true)
  })

  it("applies the same thresholds across an aggregate review", () => {
    expect(
      isVeryLargeDiff([
        { additions: 6_000, deletions: 5_000, patch: "first" },
        { additions: 5_000, deletions: 5_000, patch: "second" },
      ]),
    ).toBe(true)
    expect(
      isVeryLargeDiff([
        {
          additions: 1,
          deletions: 1,
          patch: "x".repeat(VERY_LARGE_DIFF_CHARACTER_THRESHOLD + 1),
        },
      ]),
    ).toBe(true)
  })
})
