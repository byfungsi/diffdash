import { describe, expect, it } from "vitest"

import { electronErrorPageDataUrl } from "./error-page"

describe("electronErrorPageDataUrl", () => {
  it("renders escaped error text and a reload target without renderer dependencies", () => {
    const page = decodeURIComponent(
      electronErrorPageDataUrl('<script>alert("broken")</script>', "file:///DiffDash/index.html"),
    )

    expect(page).toContain("DiffDash encountered an error")
    expect(page).toContain("Reload DiffDash")
    expect(page).toContain("&lt;script&gt;alert(&quot;broken&quot;)&lt;/script&gt;")
    expect(page).not.toContain('<script>alert("broken")</script>')
    expect(page).toContain('href="file:///DiffDash/index.html"')
  })
})
