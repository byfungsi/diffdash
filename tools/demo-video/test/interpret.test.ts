import type { Locator, Page } from "playwright"
import { describe, expect, it } from "vitest"

import { locate } from "../src/interpret"

describe("demo accessible locators", () => {
  it("does not mask ambiguous text targets with first()", () => {
    let firstCalls = 0
    const locator = {
      or: () => locator,
      first: () => {
        firstCalls += 1
        return locator
      },
    }
    // SAFETY: locate only calls the selector methods supplied by this focused test double.
    const page = {
      getByRole: () => locator,
      getByText: () => locator,
    } as unknown as Page

    expect(locate(page, { text: "Review focus", exact: true })).toBe(locator as unknown as Locator)
    expect(locate(page, "Review focus")).toBe(locator as unknown as Locator)
    expect(firstCalls).toBe(0)
  })
})
