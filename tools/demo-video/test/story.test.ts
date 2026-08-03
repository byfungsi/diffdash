import { describe, expect, it } from "vitest"

import { diffDash043Story } from "../src/stories/diffdash-0.4.3"
import { getStory } from "../src/stories"
import { projectWorkspaceStory } from "../src/stories/project-workspace"

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

describe("project workspace demo story", () => {
  it("defines six unique independent clips and complete release cards", () => {
    expect(projectWorkspaceStory.clips).toHaveLength(6)
    expect(new Set(projectWorkspaceStory.clips.map(({ name }) => name)).size).toBe(6)
    expect(projectWorkspaceStory.intro.title).toBe("One Project. Every Review.")
    expect(projectWorkspaceStory.outro.title).toBe("Stay in the Project")
    for (const clip of projectWorkspaceStory.clips) {
      expect(clip.card.title.length).toBeGreaterThan(0)
      expect(clip.card.caption.length).toBeGreaterThan(0)
      expect(clip.steps.some((step) => step.kind === "annotate")).toBe(true)
    }
  })

  it("is registered without replacing the historical release story", () => {
    expect(getStory("project-workspace")).toBe(projectWorkspaceStory)
    expect(getStory("diffdash-0.4.3")).toBe(diffDash043Story)
  })
})
