import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"

import { Button } from "./button"

describe("Button", () => {
  it("covers isolated component rendering for ticket UI criteria", () => {
    const html = renderToStaticMarkup(
      <Button variant="outline" size="sm">
        Add local repo
      </Button>,
    )

    expect(html).toContain('data-slot="button"')
    expect(html).toContain('data-variant="outline"')
    expect(html).toContain('data-size="sm"')
    expect(html).toContain("Add local repo")
  })
})
