import type { CardCopy, DemoClip, DemoStory, RunContext, Step, Target } from "./framework"

/** Click an accessible target with human cursor movement. */
export const click = (target: Target): Step => ({ kind: "click", target })

/** Type into a field one character at a time. */
export const type = (target: Target, text: string): Step => ({ kind: "type", target, text })

/** Press a keyboard shortcut while a target is focused. */
export const press = (target: Target, key: string): Step => ({ kind: "press", target, key })

/** Spotlight a target and display explanatory release copy. */
export const annotate = (
  target: Target,
  body: string,
  options: {
    readonly title?: string
    readonly placement?: "top" | "bottom" | "left" | "right"
    readonly hold?: number
  } = {},
): Step => ({ kind: "annotate", target, body, ...options })

/** Pause for a fixed duration or a natural randomized beat. */
export const pause = (ms?: number): Step =>
  ms === undefined ? { kind: "pause" } : { kind: "pause", ms }

/** Wait for a target to become visible. */
export const waitFor = (target: Target, timeout?: number): Step =>
  timeout === undefined ? { kind: "wait", target } : { kind: "wait", target, timeout }

/** Release deterministic application state through the demo timeline. */
export const release = (checkpoint: string): Step => ({ kind: "release", checkpoint })

/** Escape hatch for a bespoke Playwright operation. */
export const raw = (label: string, run: (context: RunContext) => Promise<void>): Step => ({
  kind: "raw",
  label,
  run,
})

/** Define one independently replayable clip. */
export const clip = (name: string, card: CardCopy, steps: readonly Step[]): DemoClip => ({
  name,
  card,
  steps,
})

/** Define the ordered release reel and validate unique clip names. */
export const defineStory = (story: DemoStory): DemoStory => {
  const names = story.clips.map(({ name }) => name)
  if (new Set(names).size !== names.length) throw new Error("Demo clip names must be unique")
  return story
}
