import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AgentPromptVersion, ThreadMemorySummaryAlgorithm } from "@diffdash/domain/agent-run"
import {
  ReviewAgentArtifact,
  type ReviewAgentProviderId,
  ReviewAgentProviderRunId,
  ReviewAgentUsage,
} from "@diffdash/domain/review-agent"
import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import {
  makeReviewKey,
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import { HostedReviewTarget, LineReviewAnchor, MarkdownBody } from "@diffdash/domain/review-thread"
import { AgentRunArtifactStore, AgentRunArtifactStoreError } from "./agent-run-artifact-store"
import { AgentRunStore } from "./agent-run-store"
import { DatabaseService } from "./database"
import { RepositoryStore } from "./repository-store"
import { ReviewThreadStore } from "./review-thread-store"
import { ReviewTurnStore } from "./review-turn-store"
import { ThreadMemoryStore, ThreadMemoryStoreError } from "./thread-memory-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-agent-run-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  Layer.mergeAll(
    RepositoryStore.layer,
    ReviewThreadStore.layer,
    ReviewTurnStore.layer,
    AgentRunStore.layer,
    AgentRunArtifactStore.layer,
    ThreadMemoryStore.layer,
  ).pipe(Layer.provideMerge(DatabaseService.layer(databasePath)))

const review = makeHostedReviewLocator("github", "fungsi", "diffdash", 69)
const reviewKey = makeReviewKey(review)
const lineAnchor = LineReviewAnchor.make({
  fileId: ReviewFileId.make("file-69"),
  filePath: "src/agent-run.ts",
  oldPath: null,
  hunkId: ReviewHunkId.make("hunk-69"),
  hunkFingerprint: ReviewHunkFingerprint.make("fingerprint-69"),
  hunkHeader: "@@ -1 +1 @@",
  side: "new",
  lineNumber: 1,
  lineContent: "const agentRun = true",
})

const beginTurn = (provider: ReviewAgentProviderId, model: string) =>
  Effect.gen(function* () {
    const repositories = yield* RepositoryStore
    const threads = yield* ReviewThreadStore
    const turns = yield* ReviewTurnStore
    const repo = yield* repositories.upsertRepository({
      provider: "github",
      owner: "fungsi",
      name: "diffdash",
      remoteUrl: "https://github.com/fungsi/diffdash",
      localPath: null,
    })
    const thread = yield* threads.create({
      repoId: repo.id,
      reviewKey,
      prNumber: 69,
      baseRevision: ReviewRevision.make("base-sha"),
      headRevision: ReviewRevision.make("head-sha"),
      anchor: lineAnchor,
      bodyMarkdown: MarkdownBody.make("Review this change"),
    })
    const targetInput = {
      threadId: thread.thread.id,
      target: HostedReviewTarget.make({ kind: "hosted", review }),
      repoId: repo.id,
      reviewKey,
      baseRevision: thread.thread.currentBaseRevision,
      headRevision: thread.thread.currentHeadRevision,
    }
    const mapping = yield* turns.validateTarget(targetInput)
    const begun = yield* turns.beginTurn({
      ...targetInput,
      mapping,
      provider,
      model,
      promptVersion: AgentPromptVersion.make("review-thread-v3"),
    })
    return { begun, thread }
  })

describe("agent run persistence", () => {
  it.scoped("FUN-69 AC: reads aggregate-owned run lifecycle records", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const { begun, thread } = yield* beginTurn("claude", "claude-sonnet-4")
        const runs = yield* AgentRunStore
        const turns = yield* ReviewTurnStore
        const database = yield* DatabaseService
        const providerRunId = ReviewAgentProviderRunId.make("claude-session-1")
        const usage = ReviewAgentUsage.make({
          inputTokens: 120,
          outputTokens: 40,
          cacheReadTokens: 20,
          cacheWriteTokens: null,
          costUsd: 0.0042,
        })
        yield* turns.completeTurn({
          threadId: thread.thread.id,
          runId: begun.run.id,
          messageId: begun.pendingMessage.id,
          bodyMarkdown: MarkdownBody.make("Completed response"),
          artifacts: [],
          providerRunId,
          usage,
          memoryUpdate: null,
        })
        const completed = yield* runs.get(begun.run.id)

        expect(begun.run).toMatchObject({
          status: "running",
          completedAt: null,
          usage: null,
          error: null,
        })
        expect(completed).toMatchObject({
          status: "completed",
          providerRunId,
          usage,
          error: null,
        })
        expect(completed.completedAt).not.toBeNull()

        const listed = yield* runs.listForThread(thread.thread.id)

        expect(listed.map(({ id }) => id)).toEqual([begun.run.id])

        yield* database.run("UPDATE agent_runs SET model = '' WHERE id = ?", [begun.run.id])
        const malformed = yield* Effect.either(runs.get(begun.run.id))
        expect(Either.isLeft(malformed)).toBe(true)
        if (Either.isLeft(malformed)) expect(malformed.left.operation).toBe("get.decode")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-69 AC: persists normalized artifacts and queries them by run and thread", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const { begun, thread } = yield* beginTurn("claude", "claude-sonnet-4")
        const artifacts = yield* AgentRunArtifactStore
        const database = yield* DatabaseService
        const normalized = ReviewAgentArtifact.make({
          type: "file_read",
          provider: "claude",
          title: "Read src/main.ts",
          content: "export const answer = 42\n",
          contentDigest: "digest-file-read",
          metadata: { toolName: "Read", path: "src/main.ts", sourceProvider: "claude" },
          originalSize: 25,
          truncated: false,
        })
        const first = yield* artifacts.save({
          runId: begun.run.id,
          threadId: thread.thread.id,
          artifact: normalized,
        })
        const second = yield* artifacts.save({
          runId: begun.run.id,
          threadId: thread.thread.id,
          artifact: ReviewAgentArtifact.make({
            ...normalized,
            type: "provider_message",
            title: "Provider note",
          }),
        })
        const byRun = yield* artifacts.listForRun(begun.run.id)
        const byThread = yield* artifacts.listForThread(thread.thread.id)

        expect(byRun).toHaveLength(2)
        expect(byRun.map(({ id }) => id)).toEqual(expect.arrayContaining([first.id, second.id]))
        expect(byThread).toHaveLength(2)
        expect(byThread.map(({ id }) => id)).toEqual(expect.arrayContaining([first.id, second.id]))
        expect(first.artifact).toMatchObject({
          contentDigest: normalized.contentDigest,
          metadata: expect.objectContaining({
            path: "src/main.ts",
            sourceProvider: "claude",
            toolName: "Read",
          }),
        })

        const wrongProvider = ReviewAgentArtifact.make({ ...normalized, provider: "codex" })
        const rejected = yield* Effect.either(
          artifacts.save({
            runId: begun.run.id,
            threadId: thread.thread.id,
            artifact: wrongProvider,
          }),
        )
        expect(Either.isLeft(rejected)).toBe(true)
        if (Either.isLeft(rejected)) {
          expect(rejected.left).toBeInstanceOf(AgentRunArtifactStoreError)
        }

        yield* database.run("UPDATE agent_run_artifacts SET metadata_json = ? WHERE id = ?", [
          "not-json",
          first.id,
        ])
        const malformed = yield* Effect.either(artifacts.listForRun(begun.run.id))
        expect(Either.isLeft(malformed)).toBe(true)
        if (Either.isLeft(malformed)) expect(malformed.left.operation).toBe("listForRun.decode")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-69 AC: replaces compact thread memory and rejects malformed rows", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const { begun, thread } = yield* beginTurn("opencode", "configured-model")
        const artifacts = yield* AgentRunArtifactStore
        const memory = yield* ThreadMemoryStore
        const database = yield* DatabaseService
        const normalized = ReviewAgentArtifact.make({
          type: "mcp_tool_result",
          provider: "opencode",
          title: "getDiffHunk",
          content: "@@ -1 +1 @@\n-old\n+new",
          contentDigest: "digest-mcp-result",
          metadata: { toolName: "getDiffHunk", hunkId: "hunk-1" },
          originalSize: 24,
          truncated: false,
        })
        const artifact = yield* artifacts.save({
          runId: begun.run.id,
          threadId: thread.thread.id,
          artifact: normalized,
        })

        const initial = yield* memory.upsert({
          threadId: thread.thread.id,
          summary: "The thread is discussing hunk 1.",
          summarizedThroughSequence: 1,
          summaryAlgorithm: ThreadMemorySummaryAlgorithm.make("provider-summary"),
          summaryVersion: 1,
          importantArtifactIds: [artifact.id],
        })
        const updated = yield* memory.upsert({
          threadId: thread.thread.id,
          summary: "The concern was resolved.",
          summarizedThroughSequence: 2,
          summaryAlgorithm: ThreadMemorySummaryAlgorithm.make("provider-summary"),
          summaryVersion: 1,
          importantArtifactIds: [],
        })

        expect(initial.importantArtifactIds).toEqual([artifact.id])
        expect(updated).toMatchObject({
          summary: "The concern was resolved.",
          summarizedThroughSequence: 2,
          summaryAlgorithm: "provider-summary",
          summaryVersion: 1,
          importantArtifactIds: [],
        })

        yield* database.run(
          "UPDATE thread_memory SET important_artifact_ids_json = ? WHERE thread_id = ?",
          ["not-json", thread.thread.id],
        )
        const malformed = yield* Effect.either(memory.get(thread.thread.id))
        expect(Either.isLeft(malformed)).toBe(true)
        if (Either.isLeft(malformed)) {
          expect(malformed.left).toBeInstanceOf(ThreadMemoryStoreError)
          expect(malformed.left.operation).toBe("get.decode")
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
