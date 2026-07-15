import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import {
  LocalReviewDetail,
  PullRequestCommit,
  PullRequestDetail,
  PullRequestFile,
  ReviewActor,
} from "../../shared/domain"
import { WalkthroughGenerationDetails, type WalkthroughHunkDigest } from "../../shared/walkthrough"
import { AIAgent, type AIAgentReasoningEffort } from "./ai-agent"
import { WalkthroughService } from "./walkthrough"

const pullRequest = PullRequestDetail.make({
  author: ReviewActor.make({ login: "octocat" }),
  baseRefName: "main",
  baseRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  body: "Adds a walkthrough mode.",
  commits: [
    PullRequestCommit.make({
      authoredDate: "2026-07-08T00:00:00Z",
      messageHeadline: "Add walkthrough mode",
      oid: "cccccccccccccccccccccccccccccccccccccccc",
    }),
  ],
  createdAt: "2026-07-08T00:00:00Z",
  files: [
    PullRequestFile.make({
      additions: 10,
      changeType: "modified",
      deletions: 2,
      path: "src/app.tsx",
    }),
    PullRequestFile.make({
      additions: 5,
      changeType: "modified",
      deletions: 1,
      path: "src/service.ts",
    }),
  ],
  headRefName: "feature/walkthrough",
  headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  isDraft: false,
  number: 51,
  repoName: "diffdash",
  repoOwner: "fungsi",
  state: "OPEN",
  title: "Add walkthrough mode",
  updatedAt: "2026-07-08T01:00:00Z",
  url: "https://github.com/fungsi/diffdash/pull/51",
})

const generationInput = {
  changedFileTree: "",
  diff: `diff --git a/src/app.tsx b/src/app.tsx
--- a/src/app.tsx
+++ b/src/app.tsx
@@ -1,1 +1,1 @@
-old
+new`,
  hunkDigest: [
    {
      additions: 1,
      deletions: 1,
      header: "@@ -1,1 +1,1 @@",
      id: "src/app.tsx:pull-request:51:h1",
      path: "src/app.tsx",
      synthetic: false,
    },
    {
      additions: 1,
      deletions: 0,
      header: "@@ -10,0 +10,1 @@",
      id: "src/service.ts:pull-request:51:h1",
      path: "src/service.ts",
      synthetic: false,
    },
  ] satisfies readonly WalkthroughHunkDigest[],
  generation: WalkthroughGenerationDetails.make({
    mode: "standard",
    totalFiles: 2,
    analyzedFiles: 2,
    totalFolders: 1,
    analyzedFolders: 1,
  }),
  review: { kind: "pullRequest" as const, pullRequest },
}

const localReview = LocalReviewDetail.make({
  baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  branchName: "feature/walkthrough",
  diffHash: "local-diff-hash",
  fetchedAt: "2026-07-08T01:00:00Z",
  files: pullRequest.files,
  headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  repoName: "diffdash",
  rootPath: "/workspace/repo",
  title: "Local changes in diffdash",
})

const localGenerationInput = {
  ...generationInput,
  review: { kind: "localDiff" as const, localReview },
}

const validOutput = JSON.stringify({
  title: "Review path",
  summary: "Review app entry first, then the service support change.",
  chapters: [
    {
      id: "c1",
      summary: "Runtime changes.",
      title: "Runtime",
      stops: [
        {
          hunkIds: ["h1"],
          id: "s1",
          risk: "critical",
          summary: "Entry point controls the visible walkthrough behavior.",
          title: "Entry point",
        },
      ],
    },
  ],
})

const invalidCoverageOutput = JSON.stringify({
  title: "Invalid path",
  summary: "Incomplete output.",
  chapters: [
    {
      id: "c1",
      summary: "Runtime changes.",
      title: "Runtime",
      stops: [
        {
          hunkIds: ["h999"],
          id: "s1",
          risk: "critical",
          summary: "Unknown hunk.",
          title: "Entry point",
        },
      ],
    },
  ],
  support: [],
})

const makeLayer = (outputs: readonly string[]) => {
  const calls: Array<{
    readonly cwd: string | undefined
    readonly prompt: string
    readonly reasoningEffort: AIAgentReasoningEffort | undefined
    readonly timeoutMs: number | undefined
  }> = []
  let index = 0
  const layer = WalkthroughService.layer.pipe(
    Layer.provide(
      Layer.succeed(
        AIAgent,
        AIAgent.of({
          generateText: (prompt, options) =>
            Effect.sync(() => {
              calls.push({
                cwd: options?.cwd,
                prompt,
                reasoningEffort: options?.reasoningEffort,
                timeoutMs: options?.timeoutMs,
              })
              const stdout = outputs[Math.min(index, outputs.length - 1)] ?? ""
              index += 1
              return stdout
            }),
          isAvailable: Effect.succeed(true),
        }),
      ),
    ),
  )

  return { calls, layer }
}

describe("WalkthroughService", () => {
  it.effect("FUN-48 AC: returns validated walkthrough data from valid generation", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([validOutput])

      const walkthrough = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(Effect.provide(layer))

      expect(walkthrough.chapters[0]?.stops.map((stop) => stop.title)).toEqual(["Entry point"])
      expect(walkthrough.chapters[0]?.stops[0]?.hunkIds).toEqual(["src/app.tsx:pull-request:51:h1"])
      expect(walkthrough.support.map((item) => item.title)).toEqual(["Other changes"])
      expect(walkthrough.support[0]?.hunkIds).toEqual(["src/service.ts:pull-request:51:h1"])
      expect(walkthrough.generation?.mode).toBe("standard")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.cwd).toBeUndefined()
      expect(calls[0]?.prompt).toContain("Return JSON only")
      expect(calls[0]?.prompt).toContain('"h":"h1"')
      expect(calls[0]?.prompt).toContain('"context":"diff-only"')
      expect(calls[0]?.prompt).toContain('"baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"')
      expect(calls[0]?.prompt).toContain('"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')
      expect(calls[0]?.prompt).not.toContain("src/app.tsx:pull-request:51:h1")
    }),
  )

  it.effect("FUN-48 AC: invalid JSON retries once and then succeeds", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer(["not json", validOutput])

      const walkthrough = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(Effect.provide(layer))

      expect(walkthrough.summary).toContain("Review app entry")
      expect(calls).toHaveLength(2)
    }),
  )

  it.effect("FUN-48 AC: invalid coverage retries once and then fails if still invalid", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([invalidCoverageOutput, invalidCoverageOutput])

      const error = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error["_tag"]).toBe("WalkthroughValidationError")
      expect(calls).toHaveLength(2)
    }),
  )

  it.effect("FUN-48 AC: generation passes fast generation options to the AI agent", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([validOutput])

      yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(generationInput)
      }).pipe(Effect.provide(layer))

      expect(calls[0]?.reasoningEffort).toBe("low")
      expect(calls[0]?.timeoutMs).toBe(10 * 60 * 1_000)
    }),
  )

  it.effect("passes local repository cwd for local walkthrough generation", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([validOutput])

      yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate(localGenerationInput)
      }).pipe(Effect.provide(layer))

      expect(calls[0]?.cwd).toBe("/workspace/repo")
      expect(calls[0]?.prompt).toContain('"type":"local-diff"')
    }),
  )

  it.effect("uses bounded diff excerpts and prompt preparation stats", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([validOutput])
      const firstHunk = generationInput.hunkDigest[0]
      if (firstHunk === undefined) throw new Error("Expected hunk fixture")
      const noisyPullRequest = PullRequestDetail.make({
        ...pullRequest,
        files: [
          ...pullRequest.files,
          PullRequestFile.make({
            additions: 1_000,
            changeType: "modified",
            deletions: 1_000,
            path: "pnpm-lock.yaml",
          }),
        ],
      })

      yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate({
          ...generationInput,
          diff: "### h1 src/app.tsx\n+new bounded excerpt",
          hunkDigest: [firstHunk],
          review: { kind: "pullRequest", pullRequest: noisyPullRequest },
          promptStats: {
            hiddenFiles: 1,
            omittedFiles: 2,
            omittedHunks: 3,
            selectedFiles: 4,
            selectedHunks: 5,
            totalFiles: 6,
            totalHunks: 8,
            truncatedByCharBudget: true,
            truncatedHunks: 1,
            usedHiddenFallback: false,
          },
        })
      }).pipe(Effect.provide(layer))

      expect(calls[0]?.prompt).toContain("Bounded diff excerpts")
      expect(calls[0]?.prompt).not.toContain("Unified diff:")
      expect(calls[0]?.prompt).toContain('"omittedFiles":2')
      expect(calls[0]?.prompt).toContain("new bounded excerpt")
      expect(calls[0]?.prompt).not.toContain("pnpm-lock.yaml")
    }),
  )

  it.effect("uses the changed file tree for sampled walkthrough generation", () =>
    Effect.gen(function* () {
      const { calls, layer } = makeLayer([validOutput])
      const generation = WalkthroughGenerationDetails.make({
        mode: "sampled-tree",
        totalFiles: 120,
        analyzedFiles: 4,
        totalFolders: 8,
        analyzedFolders: 4,
      })

      const result = yield* Effect.gen(function* () {
        const service = yield* WalkthroughService
        return yield* service.generate({
          ...generationInput,
          changedFileTree: "src/auth (60 files, +600 -200)\nsrc/billing (60 files, +400 -100)",
          generation,
        })
      }).pipe(Effect.provide(layer))

      expect(calls[0]?.prompt).toContain("sampled-tree walkthrough")
      expect(calls[0]?.prompt).toContain("src/auth (60 files")
      expect(calls[0]?.prompt).toContain("representative samples")
      expect(result.generation).toEqual(generation)
    }),
  )
})
