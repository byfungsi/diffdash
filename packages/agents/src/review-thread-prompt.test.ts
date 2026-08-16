import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import {
  AgentRunId,
  ReviewAgentArtifact,
  ReviewAgentArtifactId,
  ReviewAgentProviderId,
} from "@diffdash/domain/review-agent"
import { LocalReviewDescriptor } from "@diffdash/domain/review-context"
import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  CompletedAgentReviewThreadMessage,
  CurrentReviewAnchor,
  LineReviewAnchor,
  MarkdownBody,
  ReviewThread,
  ReviewThreadId,
  ReviewThreadMessageId,
  UserReviewThreadMessage,
} from "@diffdash/domain/review-thread"
import { workingTreeReviewTarget } from "@diffdash/domain/local-review"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import {
  REVIEW_THREAD_PROMPT_CONTEXT_LIMITS,
  ReviewPromptFile,
  ReviewPromptIdentity,
  type ReviewThreadPromptHunkExcerpt,
  type ReviewThreadPromptInput,
  ReviewThreadPromptError,
  buildReviewThreadPrompt,
} from "./review-thread"

const review = ReviewPromptIdentity.make({
  reviewKey: ReviewKey.make("local:/workspace/diffdash"),
  baseRevision: ReviewRevision.make("base-sha"),
  headRevision: ReviewRevision.make("head-sha"),
  descriptor: LocalReviewDescriptor.make({
    target: workingTreeReviewTarget(RepositoryCheckoutPath.make("/workspace/diffdash")),
    repoName: "diffdash",
    branchName: RepositoryComparisonRef.make("feature/review-context"),
    title: "Local changes on feature/review-context",
    fetchedAt: "2026-07-12T00:00:00.000Z",
  }),
})

const files = [
  ReviewPromptFile.make({
    fileId: ReviewFileId.make("file-a"),
    path: RepositoryRelativePath.make("src/a.ts"),
    oldPath: null,
    status: "modified",
    additions: 1,
    deletions: 1,
    hunkCount: 1,
  }),
  ReviewPromptFile.make({
    fileId: ReviewFileId.make("file-b"),
    path: RepositoryRelativePath.make("src/b.ts"),
    oldPath: null,
    status: "modified",
    additions: 1,
    deletions: 1,
    hunkCount: 1,
  }),
  ReviewPromptFile.make({
    fileId: ReviewFileId.make("file-renamed"),
    path: RepositoryRelativePath.make("src/new-name.ts"),
    oldPath: RepositoryRelativePath.make("src/old-name.ts"),
    status: "renamed",
    additions: 1,
    deletions: 1,
    hunkCount: 1,
  }),
]

const anchor = LineReviewAnchor.make({
  fileId: ReviewFileId.make("file-a"),
  filePath: RepositoryRelativePath.make("src/a.ts"),
  oldPath: null,
  hunkId: ReviewHunkId.make("hunk-a"),
  hunkFingerprint: ReviewHunkFingerprint.make("fingerprint-a"),
  hunkHeader: "@@ -1 +1 @@",
  side: "new",
  lineNumber: 1,
  lineContent: "const value = 2",
})

const anchorHunk: ReviewThreadPromptHunkExcerpt = {
  fileId: anchor.fileId,
  hunkId: anchor.hunkId,
  header: anchor.hunkHeader,
  lines: ["-const value = 1", "+const value = 2"],
  anchorLineIndex: 1,
  omittedBefore: 0,
  omittedAfter: 0,
}

const makeThread = (updatedAt = "2026-07-12T00:00:00.000Z") =>
  ReviewThread.make({
    id: ReviewThreadId.make("thread-1"),
    repoId: ReviewProjectId.make("repo-1"),
    reviewKey: review.reviewKey,
    prNumber: null,
    baseRevision: review.baseRevision,
    headRevision: review.headRevision,
    currentBaseRevision: review.baseRevision,
    currentHeadRevision: review.headRevision,
    originalAnchor: anchor,
    currentAnchor: CurrentReviewAnchor.cases.Active.make({ anchor }),
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt,
  })

function makeMessage(sequence: number, author: "user", body: string): UserReviewThreadMessage
function makeMessage(
  sequence: number,
  author: "agent",
  body: string,
): CompletedAgentReviewThreadMessage
function makeMessage(
  sequence: number,
  author: "user" | "agent",
  body: string,
): UserReviewThreadMessage | CompletedAgentReviewThreadMessage
function makeMessage(sequence: number, author: "user" | "agent", body: string) {
  const identity = {
    id: ReviewThreadMessageId.make(`message-${sequence}`),
    threadId: ReviewThreadId.make("thread-1"),
    sequence,
    createdAt: `2026-07-12T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    updatedAt: `2026-07-12T00:00:${String(sequence).padStart(2, "0")}.000Z`,
  }
  return author === "user"
    ? UserReviewThreadMessage.make({ ...identity, bodyMarkdown: MarkdownBody.make(body) })
    : CompletedAgentReviewThreadMessage.make({
        ...identity,
        bodyMarkdown: MarkdownBody.make(body),
        agentRunId: AgentRunId.make(`run-${sequence}`),
      })
}

const makeInput = (overrides: Partial<ReviewThreadPromptInput> = {}): ReviewThreadPromptInput => {
  const latestUserMessage = makeMessage(2, "user", "Is this boundary safe?")
  return {
    review,
    fileInventory: { totalFiles: files.length, files },
    anchorHunk,
    thread: makeThread(),
    messages: [makeMessage(1, "agent", "Earlier answer"), latestUserMessage],
    latestUserMessage,
    threadSummary: "The thread is checking the changed boundary.",
    priorArtifacts: [],
    ...overrides,
  }
}

describe("ReviewThreadPrompt", () => {
  it.effect("uses only bounded inventory and the already-selected anchor hunk", () =>
    Effect.gen(function* () {
      const result = yield* buildReviewThreadPrompt(makeInput())

      expect(result.stablePromptPrefix).toContain("# DiffDash review thread context v2")
      expect(result.stablePromptPrefix).toContain("## Thread-mode safety")
      expect(result.stablePromptPrefix).toContain("## Required response schema")
      expect(result.stablePromptPrefix).toContain("## Bounded changed-file inventory")
      for (const file of files) expect(result.stablePromptPrefix).toContain(file.path)
      expect(result.stablePromptPrefix).toContain('"oldPath":"src/old-name.ts"')
      expect(result.stablePromptPrefix).toContain('"hunkCount":1')
      expect(result.stablePromptPrefix).not.toContain("UNRELATED_PATCH_SENTINEL")
      expect(result.stablePromptPrefix).not.toContain(anchor.hunkId)
      expect(result.dynamicPromptSuffix).toContain("const value = 2")
      expect(result.includedHunkIds).toEqual([anchor.hunkId])
      expect(result.omittedFileIds).toEqual([files[1]?.fileId, files[2]?.fileId])
    }),
  )

  it.effect("does not search other files when a later hunk excerpt is selected", () =>
    Effect.gen(function* () {
      const selectedAnchor = LineReviewAnchor.make({
        ...anchor,
        fileId: ReviewFileId.make("file-z"),
        filePath: RepositoryRelativePath.make("src/z.ts"),
        hunkId: ReviewHunkId.make("hunk-z"),
        hunkHeader: "@@ -40 +40 @@",
        lineNumber: 40,
        lineContent: "export const enabled = true",
      })
      const selectedHunk: ReviewThreadPromptHunkExcerpt = {
        fileId: selectedAnchor.fileId,
        hunkId: selectedAnchor.hunkId,
        header: selectedAnchor.hunkHeader,
        lines: ["-export const enabled = false", "+export const enabled = true"],
        anchorLineIndex: 1,
        omittedBefore: 0,
        omittedAfter: 0,
      }
      const result = yield* buildReviewThreadPrompt(
        makeInput({
          thread: ReviewThread.make({
            ...makeThread(),
            originalAnchor: selectedAnchor,
            currentAnchor: CurrentReviewAnchor.cases.Active.make({ anchor: selectedAnchor }),
          }),
          anchorHunk: selectedHunk,
        }),
      )

      expect(result.dynamicPromptSuffix).toContain("@@ -40 +40 @@")
      expect(result.dynamicPromptSuffix).toContain("+export const enabled = true")
      expect(result.dynamicPromptSuffix).not.toContain("UNRELATED_LARGE_PATCH")
      expect(result.includedHunkIds).toEqual([selectedAnchor.hunkId])
    }),
  )

  it.effect("retains an explicitly bounded anchor-centered excerpt and total prompt budget", () =>
    Effect.gen(function* () {
      const before = Array.from({ length: 120 }, (_, index) => ` before-${index}-${"x".repeat(32)}`)
      const after = Array.from({ length: 120 }, (_, index) => ` after-${index}-${"y".repeat(32)}`)
      const lines = [...before, "+const value = 2", ...after]
      const latest = makeMessage(20, "user", `Question ${"q".repeat(30_000)}`)
      const artifact = ReviewAgentArtifact.make({
        type: "search_result",
        provider: ReviewAgentProviderId.make("claude"),
        title: "Huge search",
        content: "artifact".repeat(10_000),
        contentDigest: "sha256:huge",
        metadata: {},
        truncated: false,
        originalSize: 80_000,
      })
      const result = yield* buildReviewThreadPrompt(
        makeInput({
          anchorHunk: {
            ...anchorHunk,
            lines,
            anchorLineIndex: before.length,
            omittedBefore: 1_000,
            omittedAfter: 1_000,
          },
          messages: [makeMessage(1, "agent", "history".repeat(10_000)), latest],
          latestUserMessage: latest,
          threadSummary: "summary".repeat(10_000),
          priorArtifacts: [{ id: ReviewAgentArtifactId.make("artifact-huge"), artifact }],
        }),
      )
      const promptBytes = new TextEncoder().encode(
        `${result.stablePromptPrefix}${result.dynamicPromptSuffix}`,
      ).byteLength

      expect(lines).toHaveLength(241)
      expect(lines.length).toBeLessThanOrEqual(
        REVIEW_THREAD_PROMPT_CONTEXT_LIMITS.maxAnchorHunkLines,
      )
      expect(promptBytes).toBeLessThanOrEqual(64 * 1024)
      expect(result.dynamicPromptSuffix).toContain("DIFFDASH_HUNK_SLICE")
      expect(result.dynamicPromptSuffix).toContain("anchorCentered=true")
      expect(result.dynamicPromptSuffix).toContain("const value = 2")
      expect(result.includedHunkIds).toEqual([])
      expect(result.omittedHunkIds).toEqual([anchor.hunkId])
    }),
  )

  it.effect("bounds history and artifacts while retaining normal thread context", () =>
    Effect.gen(function* () {
      const history = Array.from({ length: 12 }, (_, index) =>
        makeMessage(index + 1, index % 2 === 0 ? "user" : "agent", `history-${index + 1}`),
      )
      const latest = makeMessage(13, "user", "latest-unique-message")
      const artifact = ReviewAgentArtifact.make({
        type: "search_result",
        provider: ReviewAgentProviderId.make("claude"),
        title: "Boundary search",
        content: "Search result content",
        contentDigest: "sha256:artifact",
        metadata: {},
        truncated: false,
        originalSize: 21,
      })
      const result = yield* buildReviewThreadPrompt(
        makeInput({
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
    }),
  )

  it.effect("keeps the immutable prefix byte-identical across turns", () =>
    Effect.gen(function* () {
      const first = yield* buildReviewThreadPrompt(makeInput())
      const changedLatest = makeMessage(20, "user", "A different follow-up")
      const second = yield* buildReviewThreadPrompt(
        makeInput({
          thread: makeThread("2026-07-12T01:00:00.000Z"),
          messages: [changedLatest],
          latestUserMessage: changedLatest,
          threadSummary: "Changed summary",
        }),
      )

      expect(second.stablePromptPrefix).toBe(first.stablePromptPrefix)
      expect(second.dynamicPromptSuffix).not.toBe(first.dynamicPromptSuffix)
      expect(first.stablePromptPrefix.indexOf('"path":"src/a.ts"')).toBeLessThan(
        first.stablePromptPrefix.indexOf('"path":"src/b.ts"'),
      )
    }),
  )

  it.effect("retains bounded inventory totals without accepting the complete inventory", () =>
    Effect.gen(function* () {
      const result = yield* buildReviewThreadPrompt(
        makeInput({ fileInventory: { totalFiles: 1_000, files } }),
      )

      expect(files).toHaveLength(3)
      expect(files.length).toBeLessThanOrEqual(
        REVIEW_THREAD_PROMPT_CONTEXT_LIMITS.maxFileInventoryCount,
      )
      expect(result.stablePromptPrefix).toContain('"totalFiles":1000')
      expect(result.stablePromptPrefix).toContain('"omittedFiles":997')
    }),
  )

  it.effect("rejects inventory and hunk excerpts above explicit input limits", () =>
    Effect.gen(function* () {
      const tooManyFiles = Array.from(
        { length: REVIEW_THREAD_PROMPT_CONTEXT_LIMITS.maxFileInventoryCount + 1 },
        (_, index) =>
          ReviewPromptFile.make({
            fileId: ReviewFileId.make(`file-${index}`),
            path: RepositoryRelativePath.make(`src/generated-${index}.ts`),
            oldPath: null,
            status: "modified",
            additions: 1,
            deletions: 1,
            hunkCount: 1,
          }),
      )
      const inventoryResult = yield* Effect.result(
        buildReviewThreadPrompt(
          makeInput({ fileInventory: { totalFiles: tooManyFiles.length, files: tooManyFiles } }),
        ),
      )
      const oversizedInventoryFile = ReviewPromptFile.make({
        fileId: ReviewFileId.make("file-oversized"),
        path: RepositoryRelativePath.make(
          `src/${"segment".repeat(REVIEW_THREAD_PROMPT_CONTEXT_LIMITS.maxFileInventoryBytes)}.ts`,
        ),
        oldPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        hunkCount: 1,
      })
      const inventoryBytesResult = yield* Effect.result(
        buildReviewThreadPrompt(
          makeInput({ fileInventory: { totalFiles: 1, files: [oversizedInventoryFile] } }),
        ),
      )
      const hunkResult = yield* Effect.result(
        buildReviewThreadPrompt(
          makeInput({
            anchorHunk: {
              ...anchorHunk,
              lines: Array.from(
                { length: REVIEW_THREAD_PROMPT_CONTEXT_LIMITS.maxAnchorHunkLines + 1 },
                () => "+const value = 2",
              ),
              anchorLineIndex: 0,
            },
          }),
        ),
      )
      const hunkBytesResult = yield* Effect.result(
        buildReviewThreadPrompt(
          makeInput({
            anchorHunk: {
              ...anchorHunk,
              lines: [`+${"x".repeat(REVIEW_THREAD_PROMPT_CONTEXT_LIMITS.maxAnchorHunkBytes)}`],
              anchorLineIndex: 0,
            },
          }),
        ),
      )

      expect(Result.isFailure(inventoryResult)).toBe(true)
      expect(Result.isFailure(inventoryBytesResult)).toBe(true)
      expect(Result.isFailure(hunkResult)).toBe(true)
      expect(Result.isFailure(hunkBytesResult)).toBe(true)
    }),
  )

  it.effect("fails closed when required context is absent or cannot fit", () =>
    Effect.gen(function* () {
      const missingHunk = yield* Effect.result(
        buildReviewThreadPrompt(makeInput({ anchorHunk: null })),
      )
      const tinyBudget = yield* Effect.result(
        buildReviewThreadPrompt(makeInput({ totalPromptBudgetBytes: 1 })),
      )

      expect(Result.isFailure(missingHunk)).toBe(true)
      expect(Result.isFailure(tinyBudget)).toBe(true)
      if (Result.isSuccess(tinyBudget)) return
      expect(tinyBudget.failure).toBeInstanceOf(ReviewThreadPromptError)
      expect(tinyBudget.failure.requiredBytes).toBeGreaterThan(tinyBudget.failure.budgetBytes)
    }),
  )
})
