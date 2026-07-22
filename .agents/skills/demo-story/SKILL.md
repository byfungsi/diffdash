---
name: demo-story
description: Author or edit DiffDash Playwright demo stories and clips. Use when changing release cover copy, clip ordering, human interactions, accessible targets, timeline state, cursor behavior, or annotations under tools/demo-video.
---

# Author A DiffDash Demo Story

Stories live in `tools/demo-video/src/stories/` and are registered in `stories/index.ts`. They drive
the real renderer against deterministic scenario data. They are direct Playwright stories, not
application tests and not Remotion compositions.

## Story Shape

Use `defineStory` with:

- `id` and `title`.
- `intro` and `outro` cover copy.
- Ordered `clip(...)` definitions.
- One `CardCopy` per clip.
- Direct steps from `builder.ts`.

Available steps:

- `click(target)`
- `type(target, text)`
- `press(target, key)`
- `waitFor(target)`
- `pause()`
- `annotate(target, body, options)`
- `release(checkpoint)` for deterministic DiffDash timeline state
- `raw(label, fn)` only for interactions the vocabulary cannot express

## Targets

Prefer visible accessible contracts:

- `{ button: "Save", exact: true }`
- `{ textbox: "Thread message", exact: true }`
- `{ placeholder: "Search files", exact: true }`
- `{ text: "Review focus", exact: true }`
- `{ role: "menu", name: "Agent settings" }`

Use test IDs or CSS only when no meaningful accessible target exists. A clip should fail on an
ambiguous or missing target rather than silently continue.

## Clip Rules

- Every clip must be independently replayable from a fresh browser context.
- Use the deterministic timeline to create local navigation, agent completion, revision, or updater
  state instead of sharing state between clips.
- Include at least one annotation explaining the feature.
- Keep cursor movement and typing through `human.ts`; do not call `locator.click()` or `fill()` from
  ordinary story steps.
- Use short human pauses so the viewer can understand each state.
- Keep chapter titles and captions concise enough for a 1440x900 cover.

## Verification

Run:

```text
pnpm --filter @diffdash/demo-video test
pnpm --filter @diffdash/demo-video typecheck
pnpm demo:video -- <story-id>
pnpm demo:verify -- <story-id>
```

Inspect the raw clip as well as the stitched reel. Do not accept a story that only looks correct in
the final transition frame.
