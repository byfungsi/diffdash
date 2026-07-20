import { describe, expect, it } from "@effect/vitest"
import { formatTimestamp } from "./timestamp"

describe("formatTimestamp", () => {
  it("returns the supplied fallback for an invalid timestamp", () => {
    expect(formatTimestamp("not-a-timestamp", "Unknown date")).toBe("Unknown date")
  })

  it("formats a valid timestamp instead of using the fallback", () => {
    expect(formatTimestamp("2026-07-18T12:30:00.000Z", "Unknown date")).not.toBe("Unknown date")
  })
})
