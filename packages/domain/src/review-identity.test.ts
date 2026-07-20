import { describe, expect, it } from "@effect/vitest"

import { parseUnifiedDiff } from "./diff-parser"
import { makeHostedReviewLocator } from "./git-provider"
import {
  BranchComparison,
  LocalReviewTarget,
  localReviewTargetKey,
  workingTreeReviewTarget,
} from "./local-review"
import {
  makeReviewDiffIdentity,
  makeReviewKey,
  makeReviewSnapshotId,
  ReviewKey,
  ReviewRevision,
} from "./review-identity"

const shiftedDiff = (oldStart: number, newStart: number) => `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -${oldStart},2 +${newStart},2 @@
 const before = true
-const value = "old"
+const value = "new"`

const binaryDiffFile = (newObject: string) =>
  parseUnifiedDiff(`diff --git a/assets/logo.png b/assets/logo.png
index 1111111..${newObject} 100644
Binary files a/assets/logo.png and b/assets/logo.png differ`).files[0]

const modeDiffFile = (newMode: string) =>
  parseUnifiedDiff(`diff --git a/scripts/run.sh b/scripts/run.sh
old mode 100644
new mode ${newMode}`).files[0]

describe("review identity", () => {
  it("derives deterministic revision-and-diff keyed snapshot IDs", () => {
    const input = {
      reviewKey: ReviewKey.make("github:fungsi/diffdash#51"),
      baseRevision: ReviewRevision.make("base"),
      headRevision: ReviewRevision.make("head"),
      diffIdentity: makeReviewDiffIdentity("diff --git a/a b/a"),
    }

    expect(makeReviewSnapshotId(input)).toBe(makeReviewSnapshotId(input))
    expect(
      makeReviewSnapshotId({
        ...input,
        diffIdentity: makeReviewDiffIdentity("diff --git a/a b/a\n+changed"),
      }),
    ).not.toBe(makeReviewSnapshotId(input))
  })

  it("FUN-80 AC: creates canonical provider review keys", () => {
    expect(makeReviewKey(makeHostedReviewLocator("github", "fungsi", "diffdash", 51))).toBe(
      "github:fungsi/diffdash#51",
    )
  })

  it("keeps hosted, working-tree, branch, and frozen branch revisions distinct", () => {
    const workingTree = workingTreeReviewTarget("/repo")
    const mainAtA = LocalReviewTarget.make({
      kind: "local",
      rootPath: "/repo",
      comparison: BranchComparison.make({
        branchName: "main",
        baseRef: "refs/heads/main",
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    })
    const mainAtB = LocalReviewTarget.make({
      kind: "local",
      rootPath: "/repo",
      comparison: BranchComparison.make({
        branchName: "main",
        baseRef: "refs/heads/main",
        baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    })
    const develop = LocalReviewTarget.make({
      kind: "local",
      rootPath: "/repo",
      comparison: BranchComparison.make({
        branchName: "develop",
        baseRef: "refs/heads/develop",
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    })
    const keys = [
      makeReviewKey(makeHostedReviewLocator("github", "fungsi", "diffdash", 51)),
      localReviewTargetKey(workingTree),
      localReviewTargetKey(mainAtA),
      localReviewTargetKey(mainAtB),
      localReviewTargetKey(develop),
    ]

    expect(new Set(keys)).toHaveLength(keys.length)
  })

  it("FUN-80 AC: creates deterministic file and hunk identities", () => {
    const first = parseUnifiedDiff(shiftedDiff(1, 1)).files[0]
    const repeated = parseUnifiedDiff(shiftedDiff(1, 1)).files[0]

    expect(first?.fileId).toBe(repeated?.fileId)
    expect(first?.hunks[0]?.id).toBe(repeated?.hunks[0]?.id)
    expect(first?.hunks[0]?.fingerprint).toBe(repeated?.hunks[0]?.fingerprint)
    expect(first?.patchHash).toBe(repeated?.patchHash)
  })

  it("keeps file patch hashes stable across blob-only metadata changes", () => {
    const first = parseUnifiedDiff(shiftedDiff(1, 1)).files[0]
    const second = parseUnifiedDiff(
      shiftedDiff(1, 1).replace("index 1111111..2222222", "index aaaaaaa..bbbbbbb"),
    ).files[0]

    expect(first?.patch).not.toBe(second?.patch)
    expect(first?.patchHash).toBe(second?.patchHash)
  })

  it("changes file patch hashes when content changes but not when line ranges shift", () => {
    const original = parseUnifiedDiff(shiftedDiff(1, 1)).files[0]
    const changedBody = parseUnifiedDiff(
      shiftedDiff(1, 1).replace('+const value = "new"', '+const value = "newer"'),
    ).files[0]
    const shifted = parseUnifiedDiff(shiftedDiff(20, 20)).files[0]

    expect(original?.patchHash).not.toBe(changedBody?.patchHash)
    expect(original?.patchHash).toBe(shifted?.patchHash)
  })

  it("changes file patch hashes for binary content and mode-only changes", () => {
    expect(binaryDiffFile("2222222")?.patchHash).not.toBe(binaryDiffFile("3333333")?.patchHash)
    expect(modeDiffFile("100755")?.patchHash).not.toBe(modeDiffFile("100600")?.patchHash)
  })

  it("FUN-80 AC: keeps content fingerprints stable when a hunk moves", () => {
    const original = parseUnifiedDiff(shiftedDiff(1, 1)).files[0]?.hunks[0]
    const shifted = parseUnifiedDiff(shiftedDiff(20, 20)).files[0]?.hunks[0]

    expect(original?.id).not.toBe(shifted?.id)
    expect(original?.fingerprint).toBe(shifted?.fingerprint)
  })

  it("FUN-80 AC: assigns distinct non-ordinal IDs to multiple hunks", () => {
    const parsed = parseUnifiedDiff(`diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-first old
+first new
@@ -20 +20 @@
-second old
+second new`)
    const hunks = parsed.files[0]?.hunks ?? []

    expect(hunks).toHaveLength(2)
    expect(hunks[0]?.id).not.toBe(hunks[1]?.id)
    expect(hunks.every(({ id }) => !id.includes(":h1"))).toBe(true)
  })

  it("FUN-80 AC: includes rename metadata in deterministic file IDs", () => {
    const renamed = `diff --git a/src/old.ts b/src/new.ts
similarity index 90%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1 +1 @@
-old
+new`

    const first = parseUnifiedDiff(renamed).files[0]
    const repeated = parseUnifiedDiff(renamed).files[0]

    expect(first?.oldPath).toBe("src/old.ts")
    expect(first?.fileId).toBe(repeated?.fileId)
  })
})
