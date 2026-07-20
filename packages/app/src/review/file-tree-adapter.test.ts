import { ParsedDiffFile } from "@diffdash/domain/diff"
import { makeReviewFileId, makeReviewFilePatchHash } from "@diffdash/domain/review-identity"
import { prepareFileTreeInput } from "@pierre/trees"
import { describe, expect, it } from "@effect/vitest"
import { buildReviewFileTreeInput } from "./file-tree-adapter"

const file = (path: string, status: ParsedDiffFile["status"] = "modified") =>
  ParsedDiffFile.make({
    additions: 1,
    deletions: 0,
    fileId: makeReviewFileId(path, null),
    patchHash: makeReviewFilePatchHash({ hunks: [], oldPath: null, path, status }),
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

  it("sorts non-contiguous directory paths before constructing the file tree", () => {
    const prepared = prepareFileTreeInput([
      "src/main/services/database.ts",
      "web/landing/src/App.tsx",
      "src/main/services/agent-run-store.ts",
    ])

    expect(prepared.paths).toEqual([
      "src/main/services/agent-run-store.ts",
      "src/main/services/database.ts",
      "web/landing/src/App.tsx",
    ])
  })

  it("preserves a deterministic 10,000-file canonical inventory", () => {
    const files = Array.from({ length: 10_000 }, (_, index) =>
      file(`packages/feature-${String(index).padStart(5, "0")}/src/index.ts`),
    )

    const input = buildReviewFileTreeInput(files, false)

    expect(input.paths).toHaveLength(10_000)
    expect(input.gitStatus).toHaveLength(10_000)
    expect(input.hiddenCount).toBe(0)
    expect(input.paths[0]).toBe("packages/feature-00000/src/index.ts")
    expect(input.paths.at(-1)).toBe("packages/feature-09999/src/index.ts")
    expect(new Set(input.paths)).toHaveLength(10_000)
  })
})
