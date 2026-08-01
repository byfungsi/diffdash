import type { DemoStory } from "../framework"
import { assertDemoSlug } from "../paths"
import { diffDash043Story } from "./diffdash-0.4.3"

/** Registered deterministic release reels. */
export const stories: Readonly<Record<string, DemoStory>> = {
  [diffDash043Story.id]: diffDash043Story,
}

/** Resolves a registered story without allowing arbitrary output directory selection. */
export const getStory = (storyId: string): DemoStory => {
  assertDemoSlug(storyId, "story ID")
  const story = stories[storyId]
  if (story === undefined) throw new Error(`Unknown demo story: ${storyId}`)
  return story
}
