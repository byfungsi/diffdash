import { describe, expect, it } from "vitest"

import { diffDash043Story } from "../src/stories/diffdash-0.4.3"

describe("DiffDash 0.4.3 demo story", () => {
  it("defines seven unique independent clips and complete release cards", () => {
    expect(diffDash043Story.clips).toHaveLength(7)
    expect(new Set(diffDash043Story.clips.map(({ name }) => name)).size).toBe(7)
    expect(diffDash043Story.intro.title).toBe("Release 0.4.3")
    expect(diffDash043Story.outro.title).toBe("That’s a wrap")
    for (const clip of diffDash043Story.clips) {
      expect(clip.card.title.length).toBeGreaterThan(0)
      expect(clip.card.caption.length).toBeGreaterThan(0)
      expect(clip.steps.some((step) => step.kind === "annotate")).toBe(true)
    }
  })
})
