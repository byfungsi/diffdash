---
name: generate-demo
description: Generate a DiffDash release demo from independent Playwright clips, HTML chapter covers, and FFmpeg stitching. Use when asked to record, regenerate, combine, verify, or deliver a DiffDash demo video.
---

# Generate A DiffDash Demo

Produces a landscape MP4 from the real DiffDash renderer against the deterministic `@diffdash/demo`
runtime. It never uses Remotion, screenshots as video content, real repositories, credentials, or
network services.

## Workflow

1. Confirm the story exists in `tools/demo-video/src/stories/index.ts`. Load the `demo-story` skill
   when authoring or changing its contents.
2. Run focused checks:
   - `pnpm --filter @diffdash/demo test`
   - `pnpm --filter @diffdash/demo-video test`
   - `pnpm --filter @diffdash/demo-video typecheck`
3. Confirm Chromium, `ffmpeg`, and `ffprobe` are available. Use `FFMPEG_PATH` and `FFPROBE_PATH`
   only when they are not on `PATH`.
4. Generate everything with `pnpm demo:video -- <story-id>`.
5. Validate with `pnpm demo:verify -- <story-id>`.
6. Extract representative frames from the front cover, chapter covers, pointer interactions, and
   annotations. Inspect them for blank flashes, clipped text, missing UI, and failed-take PNGs.
7. Return the final MP4, poster, manifest, and raw-clip directory paths.

## Outputs

All outputs live in `tools/demo-video/output/<story-id>/`:

- One `.webm` per Playwright clip.
- `manifest.json` controlling order and cover copy.
- `<story-id>-poster.png`.
- `<story-id>-demo.mp4`.
- `release.json` with delivery metadata.

Run `pnpm demo:dashboard` to inspect the combined reel and every raw clip locally.

## Constraints

- Record each clip in a fresh Playwright context.
- Keep the visible cursor, human-paced typing, and annotations inside Playwright helpers.
- Assemble only with FFmpeg.
- Produce one 1440x900 landscape video unless the user explicitly changes the product requirement.
- Never restore the removed Remotion, vertical, storyboard, screenshot-tour, or audio pipelines.
