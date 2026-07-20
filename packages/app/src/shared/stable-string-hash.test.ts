import { describe, expect, it } from "@effect/vitest"
import { stableStringHash32 } from "./stable-string-hash"

describe("stableStringHash32", () => {
  it("keeps stable unsigned 32-bit values for UI identifiers", () => {
    expect(stableStringHash32("")).toBe(0)
    expect(stableStringHash32("abc")).toBe(96_354)
    expect(stableStringHash32("DiffDash review #51")).toBe(683_033_504)
    expect(stableStringHash32("src/😀.ts")).toBe(3_999_012_607)
  })

  it("distinguishes order-sensitive UI keys", () => {
    expect(stableStringHash32("src/app.ts")).not.toBe(stableStringHash32("src/ts.app"))
  })
})
