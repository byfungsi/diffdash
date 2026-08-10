import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"

import { DiffFileVisibility, HiddenDiffFileReason, ParsedDiffFile } from "./diff"
import { RepositoryRelativePath } from "./repository-path"
import { ReviewFileId, ReviewFilePatchHash, ReviewKey } from "./review-identity"

const parsedFileSource = {
  additions: 1,
  deletions: 0,
  fileId: ReviewFileId.make("visibility-file"),
  patchHash: ReviewFilePatchHash.make("visibility-patch"),
  reviewKey: ReviewKey.make("visibility-review"),
  path: RepositoryRelativePath.make("src/app.tsx"),
  oldPath: null,
  status: "modified" as const,
  hunks: [],
  patch: "diff --git a/src/app.tsx b/src/app.tsx",
}

describe("diff file visibility schemas", () => {
  it("accepts every hidden reason and rejects unknown reasons", () => {
    for (const reason of ["binary", "lockfile", "vendored", "generated"] as const) {
      expect(Schema.decodeUnknownSync(HiddenDiffFileReason)(reason)).toBe(reason)
      expect(Schema.decodeUnknownSync(DiffFileVisibility)({ _tag: "Hidden", reason })).toEqual({
        _tag: "Hidden",
        reason,
      })
    }

    expect(Result.isFailure(Schema.decodeUnknownResult(HiddenDiffFileReason)("noise"))).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(DiffFileVisibility)({ _tag: "Hidden", reason: "noise" }),
      ),
    ).toBe(true)
  })

  it("classifies binary files before every other category", () => {
    expect(
      Schema.decodeUnknownSync(ParsedDiffFile)({
        ...parsedFileSource,
        path: RepositoryRelativePath.make("vendor/pnpm-lock.yaml"),
        status: "binary",
      }).visibility,
    ).toEqual({
      _tag: "Hidden",
      reason: "binary",
    })
    expect(
      Schema.decodeUnknownSync(ParsedDiffFile)({
        ...parsedFileSource,
        path: RepositoryRelativePath.make("assets/logo.png"),
      }).visibility,
    ).toEqual({ _tag: "Hidden", reason: "binary" })
  })

  it("classifies lockfiles before vendored and generated files", () => {
    expect(
      Schema.decodeUnknownSync(ParsedDiffFile)({
        ...parsedFileSource,
        path: RepositoryRelativePath.make("vendor/generated/pnpm-lock.yaml"),
      }).visibility,
    ).toEqual({
      _tag: "Hidden",
      reason: "lockfile",
    })
  })

  it("classifies vendored files before generated files", () => {
    expect(
      Schema.decodeUnknownSync(ParsedDiffFile)({
        ...parsedFileSource,
        path: RepositoryRelativePath.make("vendor/generated/client.ts"),
      }).visibility,
    ).toEqual({
      _tag: "Hidden",
      reason: "vendored",
    })
    expect(
      Schema.decodeUnknownSync(ParsedDiffFile)({
        ...parsedFileSource,
        path: RepositoryRelativePath.make("packages/app/node_modules/lib/index.js"),
      }).visibility,
    ).toEqual({
      _tag: "Hidden",
      reason: "vendored",
    })
  })

  it("classifies generated files and keeps normal source files visible", () => {
    expect(
      Schema.decodeUnknownSync(ParsedDiffFile)({
        ...parsedFileSource,
        path: RepositoryRelativePath.make("src/__generated__/api.ts"),
      }).visibility,
    ).toEqual({
      _tag: "Hidden",
      reason: "generated",
    })
    expect(
      Schema.decodeUnknownSync(ParsedDiffFile)({
        ...parsedFileSource,
        path: RepositoryRelativePath.make("src/client.gen.ts"),
      }).visibility,
    ).toEqual({
      _tag: "Hidden",
      reason: "generated",
    })
    expect(Schema.decodeUnknownSync(ParsedDiffFile)(parsedFileSource).visibility).toEqual({
      _tag: "Visible",
    })
  })

  it("strips derived visibility when encoding parsed files", () => {
    const classified = Schema.decodeUnknownSync(ParsedDiffFile)({
      ...parsedFileSource,
      path: RepositoryRelativePath.make("pnpm-lock.yaml"),
    })

    expect(Schema.encodeSync(ParsedDiffFile)(classified)).toEqual({
      ...parsedFileSource,
      path: "pnpm-lock.yaml",
    })
  })
})
