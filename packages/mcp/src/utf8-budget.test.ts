import { describe, expect, it } from "@effect/vitest"
import { truncateUtf8, utf8ByteLength, utf8Prefix } from "./utf8-budget"

describe("UTF-8 byte budgets", () => {
  it("counts ASCII and two-, three-, and four-byte code points", () => {
    expect(utf8ByteLength("A")).toBe(1)
    expect(utf8ByteLength("¢")).toBe(2)
    expect(utf8ByteLength("€")).toBe(3)
    expect(utf8ByteLength("🚀")).toBe(4)
    expect(utf8ByteLength("A¢€🚀")).toBe(10)
  })

  it("selects prefixes at code-point and combining-sequence byte boundaries", () => {
    expect(utf8Prefix("A¢€🚀Z", 1)).toBe("A")
    expect(utf8Prefix("A¢€🚀Z", 2)).toBe("A")
    expect(utf8Prefix("A¢€🚀Z", 3)).toBe("A¢")
    expect(utf8Prefix("A¢€🚀Z", 6)).toBe("A¢€")

    const combining = "e\u0301"
    expect(utf8ByteLength(combining)).toBe(3)
    expect(utf8Prefix(combining, 2)).toBe("e")
    expect(utf8Prefix(combining, 3)).toBe(combining)
  })

  it("never splits a four-byte code point at a UTF-16 surrogate boundary", () => {
    expect(utf8Prefix("A🚀B", 4)).toBe("A")
    expect(utf8Prefix("A🚀B", 5)).toBe("A🚀")
    expect(utf8Prefix("A🚀B", 6)).toBe("A🚀B")
  })

  it("keeps exact fits and appends a complete marker within the budget", () => {
    expect(truncateUtf8("A¢€", 6, "[cut]")).toBe("A¢€")
    expect(truncateUtf8("abcdefghij", 7, "[x]")).toBe("abcd[x]")
  })

  it("uses content bytes when the marker is larger than the budget", () => {
    const truncated = truncateUtf8("abcdefghij", 3, "[marker-too-large]")

    expect(truncated).toBe("abc")
    expect(utf8ByteLength(truncated)).toBeLessThanOrEqual(3)
  })

  it("returns an empty prefix for zero, negative, and non-finite budgets", () => {
    expect(utf8Prefix("content", 0)).toBe("")
    expect(utf8Prefix("content", -1)).toBe("")
    expect(truncateUtf8("content", 0, "[cut]")).toBe("")
    expect(truncateUtf8("content", -1, "[cut]")).toBe("")
    expect(truncateUtf8("content", Number.NaN, "[cut]")).toBe("")
  })
})
