import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { parseUnifiedDiff } from "./diff-parser"
import {
  buildWalkthroughHunkDigest,
  flattenWalkthroughStops,
  focusFilesForWalkthroughHunks,
  validateWalkthrough,
  walkthroughPullRequestScope,
} from "./walkthrough"

const parsedDiff = parseUnifiedDiff(`diff --git a/src/app.tsx b/src/app.tsx
index 1111111..2222222 100644
--- a/src/app.tsx
+++ b/src/app.tsx
@@ -1,1 +1,1 @@
-old entry
+new entry
@@ -10,1 +10,1 @@
-old footer
+new footer
diff --git a/docs/readme.md b/docs/readme.md
index 3333333..4444444 100644
--- a/docs/readme.md
+++ b/docs/readme.md
@@ -1,1 +1,1 @@
-docs
+docs update`)

const scope = walkthroughPullRequestScope(51)
const hunkDigest = buildWalkthroughHunkDigest(parsedDiff.files, scope)
const [appEntryHunk, appFooterHunk, docsHunk] = hunkDigest

const validWalkthrough = {
  title: "Review path",
  summary: "Review the app entry point before supporting docs.",
  chapters: [
    {
      id: "c1",
      title: "Runtime",
      summary: "App behavior changes.",
      stops: [
        {
          id: "s1",
          title: "Entry point",
          summary: "Start with the entry behavior.",
          risk: "critical",
          hunkIds: [appEntryHunk?.id],
        },
        {
          id: "s2",
          title: "Footer behavior",
          summary: "Review the later app hunk separately.",
          risk: "review",
          hunkIds: [appFooterHunk?.id],
        },
      ],
    },
  ],
  support: [
    {
      id: "support-docs",
      title: "Docs",
      reason: "Documentation support.",
      hunkIds: [docsHunk?.id],
    },
  ],
}

describe("validateWalkthrough", () => {
  it.effect("accepts Codiff-style hunk stops and allows the same file in multiple stops", () =>
    Effect.gen(function* () {
      const walkthrough = yield* validateWalkthrough(validWalkthrough, hunkDigest)
      const stops = flattenWalkthroughStops(walkthrough)

      expect(stops.map(({ stop }) => stop.title)).toEqual(["Entry point", "Footer behavior"])
      expect(stops[0]?.stop.hunkIds).toEqual([appEntryHunk?.id])
      expect(stops[1]?.stop.hunkIds).toEqual([appFooterHunk?.id])
    }),
  )

  it.effect("adds omitted hunks to Support when generated output omits support", () =>
    Effect.gen(function* () {
      const walkthrough = yield* validateWalkthrough(
        {
          ...validWalkthrough,
          support: undefined,
        },
        hunkDigest,
      )

      expect(walkthrough.support).toHaveLength(1)
      expect(walkthrough.support[0]?.title).toBe("Other changes")
      expect(walkthrough.support[0]?.hunkIds).toEqual([docsHunk?.id])
    }),
  )

  it.effect("rejects duplicate hunk IDs across stops and support", () =>
    Effect.gen(function* () {
      const error = yield* validateWalkthrough(
        {
          ...validWalkthrough,
          support: [
            {
              id: "duplicate",
              title: "Duplicate",
              reason: "Duplicate coverage.",
              hunkIds: [appEntryHunk?.id],
            },
          ],
        },
        hunkDigest,
      ).pipe(Effect.flip)

      expect(error.reason).toBe("invalid_hunk_coverage")
      expect(error.details).toContain(
        `Support item 1 (Duplicate) duplicates hunk ID: ${appEntryHunk?.id}`,
      )
    }),
  )

  it.effect("rejects unknown hunk IDs", () =>
    Effect.gen(function* () {
      const error = yield* validateWalkthrough(
        {
          ...validWalkthrough,
          chapters: [
            {
              ...validWalkthrough.chapters[0],
              stops: [
                {
                  ...validWalkthrough.chapters[0]?.stops[0],
                  hunkIds: ["src/unknown.ts:pull-request:51:h1"],
                },
              ],
            },
          ],
        },
        hunkDigest,
      ).pipe(Effect.flip)

      expect(error.reason).toBe("invalid_hunk_coverage")
      expect(error.details).toContain(
        "Chapter 1, stop 1 (Entry point) references an unknown hunk ID: src/unknown.ts:pull-request:51:h1",
      )
    }),
  )

  it.effect("rejects invalid risk values", () =>
    Effect.gen(function* () {
      const error = yield* validateWalkthrough(
        {
          ...validWalkthrough,
          chapters: [
            {
              ...validWalkthrough.chapters[0],
              stops: [
                {
                  ...validWalkthrough.chapters[0]?.stops[0],
                  risk: "urgent",
                },
              ],
            },
          ],
        },
        hunkDigest,
      ).pipe(Effect.flip)

      expect(error.reason).toBe("invalid_shape")
      expect(error.details).toContain(
        "Walkthrough output does not match the required JSON contract.",
      )
    }),
  )

  it.effect("rejects empty stops", () =>
    Effect.gen(function* () {
      const error = yield* validateWalkthrough(
        {
          ...validWalkthrough,
          chapters: [
            {
              ...validWalkthrough.chapters[0],
              stops: [
                {
                  ...validWalkthrough.chapters[0]?.stops[0],
                  hunkIds: [],
                },
              ],
            },
          ],
        },
        hunkDigest,
      ).pipe(Effect.flip)

      expect(error.reason).toBe("invalid_hunk_coverage")
      expect(error.details).toContain(
        "Chapter 1, stop 1 (Entry point) does not contain any hunk IDs.",
      )
    }),
  )
})

describe("focusFilesForWalkthroughHunks", () => {
  it("renders different focused patches for different stops in the same file", () => {
    const first = focusFilesForWalkthroughHunks(parsedDiff.files, [appEntryHunk?.id ?? ""], scope)
    const second = focusFilesForWalkthroughHunks(parsedDiff.files, [appFooterHunk?.id ?? ""], scope)

    expect(first[0]?.path).toBe("src/app.tsx")
    expect(first[0]?.patch).toContain("new entry")
    expect(first[0]?.patch).not.toContain("new footer")
    expect(second[0]?.path).toBe("src/app.tsx")
    expect(second[0]?.patch).toContain("new footer")
    expect(second[0]?.patch).not.toContain("new entry")
  })
})
