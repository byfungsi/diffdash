import { ParsedDiffFile } from "@diffdash/domain/diff"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  makeReviewFileId,
  makeReviewFilePatchHash,
  ReviewKey,
} from "@diffdash/domain/review-identity"
import { prepareFileTreeInput } from "@pierre/trees"
import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { buildReviewFileTreeInput } from "./file-tree-adapter"

const file = (path: string, status: ParsedDiffFile["status"] = "modified") => {
  const repositoryPath = RepositoryRelativePath.make(path)
  return Schema.decodeSync(ParsedDiffFile)({
    additions: 1,
    deletions: 0,
    fileId: makeReviewFileId(repositoryPath, null),
    patchHash: makeReviewFilePatchHash({
      hunks: [],
      oldPath: null,
      path: repositoryPath,
      status,
    }),
    hunks: [],
    oldPath: null,
    patch: `diff --git a/${path} b/${path}`,
    path: repositoryPath,
    reviewKey: ReviewKey.make(path),
    status,
  })
}

describe("buildReviewFileTreeInput", () => {
  it("preserves diff order for visible paths and git statuses", () => {
    const input = buildReviewFileTreeInput(
      [file("src/b.ts", "modified"), file("src/a.ts", "added"), file("src/old.ts", "deleted")],
      false,
    )

    expect(input.paths).toEqual(["src/b.ts", "src/a.ts", "src/old.ts"])
    expect(input.gitStatus).toEqual([
      { path: "src/", status: "modified" },
      { path: "src/b.ts", status: "modified" },
      { path: "src/a.ts", status: "added" },
      { path: "src/old.ts", status: "deleted" },
    ])
  })

  it("aggregates descendant statuses onto folders", () => {
    const input = buildReviewFileTreeInput(
      [
        file("src/added.ts", "added"),
        file("src/nested/also-added.ts", "added"),
        file("src/old.ts", "deleted"),
        file("docs/old.md", "deleted"),
        file("renamed/next.ts", "renamed"),
      ],
      false,
    )

    expect(input.gitStatus).toEqual(
      expect.arrayContaining([
        { path: "docs/", status: "deleted" },
        { path: "renamed/", status: "modified" },
        { path: "src/", status: "modified" },
        { path: "src/nested/", status: "added" },
      ]),
    )
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
    expect(input.gitStatus).toHaveLength(30_001)
    expect(input.hiddenCount).toBe(0)
    expect(input.paths[0]).toBe("packages/feature-00000/src/index.ts")
    expect(input.paths.at(-1)).toBe("packages/feature-09999/src/index.ts")
    expect(new Set(input.paths)).toHaveLength(10_000)
  })
})
