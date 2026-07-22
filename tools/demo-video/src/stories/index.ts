import type { DemoStory } from "../framework"
import { diffDash043Story } from "./diffdash-0.4.3"

/** Registered deterministic release reels. */
export const stories: Readonly<Record<string, DemoStory>> = {
  [diffDash043Story.id]: diffDash043Story,
}
