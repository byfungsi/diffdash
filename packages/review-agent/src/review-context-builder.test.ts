import { describe, expect, it } from "@effect/vitest"
import { Effect, Either } from "effect"
import { Buffer } from "node:buffer"

import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { ParsedDiff } from "@diffdash/domain/diff"
import { LocalReviewDetail, LocalReviewDiff } from "@diffdash/domain/local-review"
import { ReviewAgentArtifact, ReviewAgentArtifactId } from "@diffdash/domain/review-agent"
import { LocalReviewSnapshot, type ReviewSnapshot } from "@diffdash/domain/review-context"
import { ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import {
  LineReviewAnchor,
  MarkdownBody,
  type ReviewThreadAnchor,
  ReviewThread,
  ReviewThreadId,
  ReviewThreadMessage,
  ReviewThreadMessageId,
} from "@diffdash/domain/review-thread"
import {
  type BuildReviewPromptContextInput,
  ReviewContextBuilder,
  ReviewContextBuilderError,
} from "./review-context-builder"

const inventoryDiff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-const value = 1
+const value = 2
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-const unrelated = false
+const unrelated = "UNRELATED_PATCH_SENTINEL"
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 88%
rename from src/old-name.ts
rename to src/new-name.ts
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1 +1 @@
-export const renamed = false
+export const renamed = true`

const laterAnchorDiff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-${"UNRELATED_LARGE_PATCH".repeat(3_000)}
+${"UNRELATED_LARGE_REPLACEMENT".repeat(3_000)}
diff --git a/src/z.ts b/src/z.ts
index 3333333..4444444 100644
--- a/src/z.ts
+++ b/src/z.ts
@@ -40 +40 @@
-export const enabled = false
+export const enabled = true`

const makeHugeHunkDiff = () => {
  const before = Array.from(
    { length: 1_200 },
    (_, index) => ` before-${String(index).padStart(4, "0")}-${"x".repeat(32)}`,
  )
  const after = Array.from(
    { length: 1_200 },
    (_, index) => ` after-${String(index).padStart(4, "0")}-${"y".repeat(32)}`,
  )
  return [
    "diff --git a/src/huge.ts b/src/huge.ts",
    "index 1111111..2222222 100644",
    "--- a/src/huge.ts",
    "+++ b/src/huge.ts",
    "@@ -1,2400 +1,2401 @@",
    ...before,
    "+ANCHOR_TARGET_IN_HUGE_HUNK",
    ...after,
  ].join("\n")
}

const makeSnapshot = (diff: string) =>
  LocalReviewSnapshot.make({
    reviewKey: ReviewKey.make("local:/workspace/diffdash"),
    baseRevision: ReviewRevision.make("base-sha"),
    headRevision: ReviewRevision.make("head-sha"),
    detail: LocalReviewDetail.make({
      rootPath: "/workspace/diffdash",
      repoName: "diffdash",
      branchName: "feature/review-context",
      baseSha: "base-sha",
      headSha: "head-sha",
      diffHash: "diff-hash",
      title: "Local changes on feature/review-context",
      files: [],
      fetchedAt: "2026-07-12T00:00:00.000Z",
    }),
    diff: LocalReviewDiff.make({
      rootPath: "/workspace/diffdash",
      baseSha: "base-sha",
      headSha: "head-sha",
      diffHash: "diff-hash",
      diff,
      fetchedAt: "2026-07-12T00:00:00.000Z",
    }),
    parsedDiff: parseUnifiedDiff(diff),
  })

const anchorForSnapshot = (
  snapshot: ReviewSnapshot,
  path = snapshot.parsedDiff.files[0]?.path,
  lineContent?: string,
) => {
  const file = snapshot.parsedDiff.files.find((candidate) => candidate.path === path)
  const hunk = file?.hunks.find(
    (candidate) =>
      lineContent === undefined || candidate.lines.some((line) => line === `+${lineContent}`),
  )
  if (file === undefined || hunk === undefined) throw new Error("Expected anchor hunk fixture")

  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  for (const line of hunk.lines) {
    if (line.startsWith(" ")) {
      oldLine += 1
      newLine += 1
      continue
    }
    if (line.startsWith("-")) {
      oldLine += 1
      continue
    }
    if (line.startsWith("+")) {
      if (lineContent === undefined || line.slice(1) === lineContent) {
        return LineReviewAnchor.make({
          fileId: file.fileId,
          filePath: file.path,
          oldPath: file.oldPath,
          hunkId: hunk.id,
          hunkFingerprint: hunk.fingerprint,
          hunkHeader: hunk.header,
          side: "new",
          lineNumber: newLine,
          lineContent: line.slice(1),
        })
      }
      newLine += 1
    }
  }
  throw new Error("Expected added anchor line fixture")
}

const makeThread = (anchor: ReviewThreadAnchor, updatedAt = "2026-07-12T00:00:00.000Z") =>
  ReviewThread.make({
    id: ReviewThreadId.make("thread-1"),
    repoId: "repo-1",
    reviewKey: ReviewKey.make("local:/workspace/diffdash"),
    prNumber: null,
    baseRevision: ReviewRevision.make("base-sha"),
    headRevision: ReviewRevision.make("head-sha"),
    currentBaseRevision: ReviewRevision.make("base-sha"),
    currentHeadRevision: ReviewRevision.make("head-sha"),
    originalAnchor: anchor,
    currentAnchor: anchor,
    anchorStatus: "active",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt,
  })

const makeMessage = (sequence: number, author: "user" | "agent", body: string) =>
  ReviewThreadMessage.make({
    id: ReviewThreadMessageId.make(`message-${sequence}`),
    threadId: ReviewThreadId.make("thread-1"),
    sequence,
    author,
    bodyMarkdown: MarkdownBody.make(body),
    status: "complete",
    agentRunId: null,
    createdAt: `2026-07-12T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    updatedAt: `2026-07-12T00:00:${String(sequence).padStart(2, "0")}.000Z`,
  })

const makeInput = (
  snapshot = makeSnapshot(inventoryDiff),
  overrides: Partial<BuildReviewPromptContextInput> = {},
): BuildReviewPromptContextInput => {
  const latestUserMessage = makeMessage(2, "user", "Is this boundary safe?")
  const anchor = anchorForSnapshot(snapshot)
  return {
    snapshot,
    thread: makeThread(anchor),
    messages: [makeMessage(1, "agent", "Earlier answer"), latestUserMessage],
    latestUserMessage,
    threadSummary: "The thread is checking the changed boundary.",
    priorArtifacts: [],
    ...overrides,
  }
}

describe("ReviewContextBuilder", () => {
  it.effect(
    "keeps every compact file path while excluding unrelated patch and complete hunk metadata",
    () =>
      Effect.gen(function* () {
        const service = yield* ReviewContextBuilder
        const input = makeInput()
        const result = yield* service.build(input)
        const anchor = input.thread.currentAnchor
        if (anchor === null) throw new Error("Expected current anchor")

        expect(result.stablePromptPrefix).toContain("# DiffDash review thread context v2")
        expect(result.stablePromptPrefix).toContain("## Thread-mode safety")
        expect(result.stablePromptPrefix).toContain("## Required response schema")
        expect(result.stablePromptPrefix).toContain("## Compact changed-file inventory")
        for (const file of input.snapshot.parsedDiff.files) {
          expect(result.stablePromptPrefix).toContain(file.path)
        }
        expect(result.stablePromptPrefix).toContain('"oldPath":"src/old-name.ts"')
        expect(result.stablePromptPrefix).toContain('"hunkCount":1')
        expect(result.stablePromptPrefix).not.toContain("UNRELATED_PATCH_SENTINEL")
        expect(result.dynamicPromptSuffix).not.toContain("UNRELATED_PATCH_SENTINEL")
        expect(result.stablePromptPrefix).not.toContain(anchor.hunkId)
        expect(result.stablePromptPrefix).not.toContain(anchor.hunkHeader)
        expect(result.dynamicPromptSuffix).toContain("const value = 2")
        expect(result.includedHunkIds).toEqual([anchor.hunkId])
      }).pipe(Effect.provide(ReviewContextBuilder.layer)),
  )

  it.effect("includes the exact anchored hunk even when it is later in the diff", () =>
    Effect.gen(function* () {
      const service = yield* ReviewContextBuilder
      const snapshot = makeSnapshot(laterAnchorDiff)
      const anchor = anchorForSnapshot(snapshot, "src/z.ts", "export const enabled = true")
      const result = yield* service.build(makeInput(snapshot, { thread: makeThread(anchor) }))

      expect(result.dynamicPromptSuffix).toContain("@@ -40 +40 @@")
      expect(result.dynamicPromptSuffix).toContain("-export const enabled = false")
      expect(result.dynamicPromptSuffix).toContain("+export const enabled = true")
      expect(result.dynamicPromptSuffix).not.toContain("UNRELATED_LARGE_PATCH")
      expect(result.stablePromptPrefix).not.toContain("UNRELATED_LARGE_PATCH")
      expect(result.includedHunkIds).toEqual([anchor.hunkId])
    }).pipe(Effect.provide(ReviewContextBuilder.layer)),
  )

  it.effect("hard-bounds a huge hunk and total prompt with an anchor-centered marker", () =>
    Effect.gen(function* () {
      const service = yield* ReviewContextBuilder
      const snapshot = makeSnapshot(makeHugeHunkDiff())
      const anchor = anchorForSnapshot(snapshot, "src/huge.ts", "ANCHOR_TARGET_IN_HUGE_HUNK")
      const latest = makeMessage(20, "user", `Question ${"q".repeat(30_000)}`)
      const artifact = ReviewAgentArtifact.make({
        type: "search_result",
        provider: "claude",
        title: "Huge search",
        content: "artifact".repeat(10_000),
        contentDigest: "sha256:huge",
        metadata: {},
        truncated: false,
        originalSize: 80_000,
      })
      const result = yield* service.build(
        makeInput(snapshot, {
          thread: makeThread(anchor),
          messages: [makeMessage(1, "agent", "history".repeat(10_000)), latest],
          latestUserMessage: latest,
          threadSummary: "summary".repeat(10_000),
          priorArtifacts: [{ id: ReviewAgentArtifactId.make("artifact-huge"), artifact }],
        }),
      )
      const promptBytes = Buffer.byteLength(
        `${result.stablePromptPrefix}${result.dynamicPromptSuffix}`,
        "utf8",
      )

      expect(promptBytes).toBeLessThanOrEqual(64 * 1024)
      expect(result.dynamicPromptSuffix).toContain("DIFFDASH_HUNK_SLICE")
      expect(result.dynamicPromptSuffix).toContain("anchorCentered=true")
      expect(result.dynamicPromptSuffix).toContain("ANCHOR_TARGET_IN_HUGE_HUNK")
      expect(result.dynamicPromptSuffix).not.toContain("before-0000")
      expect(result.dynamicPromptSuffix).not.toContain("after-1199")
      expect(result.includedHunkIds).toEqual([])
      expect(result.omittedHunkIds).toContain(anchor.hunkId)
    }).pipe(Effect.provide(ReviewContextBuilder.layer)),
  )

  it.effect("bounds history and artifacts while retaining normal thread context", () =>
    Effect.gen(function* () {
      const service = yield* ReviewContextBuilder
      const snapshot = makeSnapshot(inventoryDiff)
      const history = Array.from({ length: 12 }, (_, index) =>
        makeMessage(index + 1, index % 2 === 0 ? "user" : "agent", `history-${index + 1}`),
      )
      const latest = makeMessage(13, "user", "latest-unique-message")
      const artifact = ReviewAgentArtifact.make({
        type: "search_result",
        provider: "claude",
        title: "Boundary search",
        content: "Search result content",
        contentDigest: "sha256:artifact",
        metadata: {},
        truncated: false,
        originalSize: 21,
      })
      const result = yield* service.build(
        makeInput(snapshot, {
          messages: [...history, latest],
          latestUserMessage: latest,
          threadSummary: "Summary included once.",
          priorArtifacts: [
            { id: ReviewAgentArtifactId.make("artifact-b"), artifact },
            { id: ReviewAgentArtifactId.make("artifact-a"), artifact },
          ],
        }),
      )

      expect(result.dynamicPromptSuffix).not.toContain('history-1"')
      expect(result.dynamicPromptSuffix).not.toContain('history-2"')
      for (let index = 3; index <= 12; index += 1) {
        expect(result.dynamicPromptSuffix).toContain(`history-${index}`)
      }
      expect(result.dynamicPromptSuffix).toContain("Summary included once.")
      expect(result.dynamicPromptSuffix.match(/latest-unique-message/g)).toHaveLength(1)
      expect(result.dynamicPromptSuffix.indexOf("artifact-a")).toBeLessThan(
        result.dynamicPromptSuffix.indexOf("artifact-b"),
      )
    }).pipe(Effect.provide(ReviewContextBuilder.layer)),
  )

  it.effect("keeps the immutable prefix byte-identical across turns and parser ordering", () =>
    Effect.gen(function* () {
      const service = yield* ReviewContextBuilder
      const snapshot = makeSnapshot(inventoryDiff)
      const first = yield* service.build(makeInput(snapshot))
      const anchor = anchorForSnapshot(snapshot)
      const changedLatest = makeMessage(20, "user", "A different follow-up")
      const second = yield* service.build(
        makeInput(snapshot, {
          thread: makeThread(anchor, "2026-07-12T01:00:00.000Z"),
          messages: [changedLatest],
          latestUserMessage: changedLatest,
          threadSummary: "Changed summary",
        }),
      )
      const reversedFiles = [...snapshot.parsedDiff.files]
      // oxlint-disable-next-line unicorn/no-array-reverse -- This mutates only the test-local copy.
      reversedFiles.reverse()
      const reversedSnapshot = LocalReviewSnapshot.make({
        ...snapshot,
        parsedDiff: ParsedDiff.make({ files: reversedFiles }),
      })
      const reversed = yield* service.build(
        makeInput(reversedSnapshot, { thread: makeThread(anchor) }),
      )

      expect(second.stablePromptPrefix).toBe(first.stablePromptPrefix)
      expect(second.dynamicPromptSuffix).not.toBe(first.dynamicPromptSuffix)
      expect(reversed.stablePromptPrefix).toBe(first.stablePromptPrefix)
      expect(first.stablePromptPrefix.indexOf('"path":"src/a.ts"')).toBeLessThan(
        first.stablePromptPrefix.indexOf('"path":"src/b.ts"'),
      )
      expect(first.dynamicPromptSuffix.indexOf("## Latest user message")).toBeLessThan(
        first.dynamicPromptSuffix.indexOf("## Current anchor"),
      )
      expect(first.dynamicPromptSuffix.indexOf("## Current anchor")).toBeLessThan(
        first.dynamicPromptSuffix.indexOf("## Current anchor hunk"),
      )
    }).pipe(Effect.provide(ReviewContextBuilder.layer)),
  )

  it.effect("fails closed when the required stable prefix cannot fit", () =>
    Effect.gen(function* () {
      const service = yield* ReviewContextBuilder
      const result = yield* Effect.either(
        service.build(makeInput(undefined, { totalPromptBudgetBytes: 1 })),
      )

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isRight(result)) return
      expect(result.left).toBeInstanceOf(ReviewContextBuilderError)
      expect(result.left.requiredBytes).toBeGreaterThan(result.left.budgetBytes)
    }).pipe(Effect.provide(ReviewContextBuilder.layer)),
  )
})
