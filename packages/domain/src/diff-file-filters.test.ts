import { describe, expect, it } from "@effect/vitest"
import { ParsedDiffFile } from "./diff"
import { filterVisibleDiffFiles, getHiddenDiffFileReason } from "./diff-file-filters"
import { makeReviewFileId, makeReviewFilePatchHash } from "./review-identity"

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

describe("diff file filters", () => {
  it("hides lockfiles", () => {
    expect(getHiddenDiffFileReason(file("pnpm-lock.yaml"))).toBe("lockfile")
  })

  it("hides generated files", () => {
    expect(getHiddenDiffFileReason(file("src/__generated__/api.ts"))).toBe("generated")
    expect(getHiddenDiffFileReason(file("src/client.gen.ts"))).toBe("generated")
  })

  it("hides vendored files", () => {
    expect(getHiddenDiffFileReason(file("vendor/library/source.ts"))).toBe("vendored")
    expect(getHiddenDiffFileReason(file("packages/app/node_modules/lib/index.js"))).toBe("vendored")
  })

  it("hides binary files", () => {
    expect(getHiddenDiffFileReason(file("assets/logo.png"))).toBe("binary")
    expect(getHiddenDiffFileReason(file("assets/blob.bin", "binary"))).toBe("binary")
  })

  it("keeps normal source files visible unless hidden files are requested", () => {
    const files = [file("src/app.tsx"), file("pnpm-lock.yaml"), file("src/api.generated.ts")]
    const sourceFile = files[0]

    if (sourceFile === undefined) throw new Error("Expected source file fixture")
    expect(getHiddenDiffFileReason(sourceFile)).toBe(null)
    expect(filterVisibleDiffFiles(files, false).map((entry) => entry.path)).toEqual(["src/app.tsx"])
    expect(filterVisibleDiffFiles(files, true)).toHaveLength(3)
  })
})
