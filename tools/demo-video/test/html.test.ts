import { describe, expect, it } from "vitest"

import { escapeHtml } from "../src/html"

describe("demo HTML escaping", () => {
  it("escapes every character significant in text and quoted attributes", () => {
    expect(escapeHtml(`<button title="Sam's & Co">`)).toBe(
      "&lt;button title=&quot;Sam&#39;s &amp; Co&quot;&gt;",
    )
  })
})
