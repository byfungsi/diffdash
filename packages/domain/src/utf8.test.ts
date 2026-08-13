import { describe, expect, it } from "@effect/vitest"

import { truncateUtf8, utf8ByteLength, utf8Prefix } from "./utf8"

describe("UTF-8 byte budgets", () => {
  it("counts one- through four-byte code points", () => {
    expect(utf8ByteLength("A¢€🚀")).toBe(10)
  })

  it("selects prefixes only at complete code-point boundaries", () => {
    expect(utf8Prefix("A¢€🚀Z", 1)).toBe("A")
    expect(utf8Prefix("A¢€🚀Z", 2)).toBe("A")
    expect(utf8Prefix("A¢€🚀Z", 3)).toBe("A¢")
    expect(utf8Prefix("A¢€🚀Z", 6)).toBe("A¢€")
    expect(utf8Prefix("A🚀B", 4)).toBe("A")
    expect(utf8Prefix("A🚀B", 5)).toBe("A🚀")
  })

  it("keeps exact fits and appends a complete marker within the budget", () => {
    expect(truncateUtf8("A¢€", 6, "[cut]")).toBe("A¢€")
    expect(truncateUtf8("abcdefghij", 7, "[x]")).toBe("abcd[x]")
  })

  it("uses content bytes when the marker cannot fit", () => {
    expect(truncateUtf8("abcdefghij", 3, "[marker-too-large]")).toBe("abc")
  })

  it("normalizes zero, negative, and non-finite budgets", () => {
    expect(utf8Prefix("content", 0)).toBe("")
    expect(utf8Prefix("content", -1)).toBe("")
    expect(truncateUtf8("content", Number.NaN, "[cut]")).toBe("")
  })
})
