import { describe, expect, it } from "@effect/vitest"

import { buildReviewFileTreeInput } from "./file-tree-adapter"
import { ParsedDiffFile } from "./domain"

const file = (path: string, status: ParsedDiffFile["status"] = "modified") =>
  ParsedDiffFile.make({
    additions: 1,
    deletions: 0,
    hunks: [],
    oldPath: null,
    patch: `diff --git a/${path} b/${path}`,
    path,
    reviewKey: path,
    status,
  })

describe("buildReviewFileTreeInput", () => {
  it("preserves diff order for visible paths and git statuses", () => {
    const input = buildReviewFileTreeInput(
      [file("src/b.ts", "modified"), file("src/a.ts", "added"), file("src/old.ts", "deleted")],
      false,
    )

    expect(input.paths).toEqual(["src/b.ts", "src/a.ts", "src/old.ts"])
    expect(input.gitStatus).toEqual([
      { path: "src/b.ts", status: "modified" },
      { path: "src/a.ts", status: "added" },
      { path: "src/old.ts", status: "deleted" },
    ])
  })

  it("excludes hidden files unless requested", () => {
    const files = [file("src/app.tsx"), file("pnpm-lock.yaml"), file("assets/logo.png", "binary")]

    expect(buildReviewFileTreeInput(files, false)).toMatchObject({
      hiddenCount: 2,
      paths: ["src/app.tsx"],
    })
    expect(buildReviewFileTreeInput(files, true)).toMatchObject({
      hiddenCount: 0,
      paths: ["src/app.tsx", "pnpm-lock.yaml", "assets/logo.png"],
    })
  })
})
