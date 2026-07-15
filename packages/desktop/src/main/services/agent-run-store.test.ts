import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { AgentPromptVersion, ThreadMemorySummaryAlgorithm } from "@diffdash/domain/agent-run"
import {
  ReviewAgentArtifact,
  ReviewAgentProviderRunId,
  ReviewAgentUsage,
} from "@diffdash/domain/review-agent"
import {
  makePullRequestReviewKey,
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import { LineReviewAnchor, MarkdownBody } from "@diffdash/domain/review-thread"
import { AgentArtifactNormalizer } from "./agent-artifact-normalizer"
import { AgentRunArtifactStore, AgentRunArtifactStoreError } from "./agent-run-artifact-store"
import { AgentRunStore, AgentRunStoreError } from "./agent-run-store"
import { AppConfig } from "./app-config"
import { DatabaseService } from "./database"
import { RepositoryStore } from "./repository-store"
import { ReviewThreadStore } from "./review-thread-store"
import { ThreadMemoryStore, ThreadMemoryStoreError } from "./thread-memory-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-agent-run-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  Layer.mergeAll(
    RepositoryStore.layer,
    ReviewThreadStore.layer,
    AgentRunStore.layer,
    AgentRunArtifactStore.layer,
    ThreadMemoryStore.layer,
    AgentArtifactNormalizer.layer,
  ).pipe(
    Layer.provideMerge(DatabaseService.layer),
    Layer.provide(
      AppConfig.layer({
        databasePath,
        settingsPath: join(dirname(databasePath), "settings.json"),
        tempDir: tmpdir(),
      }),
    ),
  )

const reviewKey = makePullRequestReviewKey("github", "fungsi", "diffdash", 69)
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

const createThread = Effect.gen(function* () {
  const repositories = yield* RepositoryStore
  const threads = yield* ReviewThreadStore
  const repo = yield* repositories.upsertRepository({
    provider: "github",
    owner: "fungsi",
    name: "diffdash",
    remoteUrl: "https://github.com/fungsi/diffdash",
    localPath: null,
  })
  return yield* threads.create({
    repoId: repo.id,
    reviewKey,
    prNumber: 69,
    baseRevision: ReviewRevision.make("base-sha"),
    headRevision: ReviewRevision.make("head-sha"),
    anchor: lineAnchor,
    bodyMarkdown: MarkdownBody.make("Review this change"),
  })
})

describe("agent run persistence", () => {
  it.scoped("FUN-69 AC: persists successful and failed run lifecycle transitions", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const thread = yield* createThread
        const runs = yield* AgentRunStore
        const database = yield* DatabaseService
        const providerRunId = ReviewAgentProviderRunId.make("claude-session-1")
        const started = yield* runs.start({
          threadId: thread.thread.id,
          provider: "claude",
          model: "claude-sonnet-4",
          promptVersion: AgentPromptVersion.make("thread-v1"),
        })
        const attached = yield* runs.setProviderRunId({ runId: started.id, providerRunId })
        const usage = ReviewAgentUsage.make({
          inputTokens: 120,
          outputTokens: 40,
          cacheReadTokens: 20,
          cacheWriteTokens: null,
          costUsd: 0.0042,
        })
        const completed = yield* runs.complete({ runId: started.id, usage })

        expect(started).toMatchObject({
          status: "running",
          completedAt: null,
          usage: null,
          error: null,
        })
        expect(attached.providerRunId).toBe(providerRunId)
        expect(completed).toMatchObject({
          status: "completed",
          providerRunId,
          usage,
          error: null,
        })
        expect(completed.completedAt).not.toBeNull()

        const failedRun = yield* runs.start({
          threadId: thread.thread.id,
          provider: "codex",
          model: "gpt-5-codex",
          promptVersion: AgentPromptVersion.make("thread-v1"),
        })
        const failed = yield* runs.fail({ runId: failedRun.id, error: "Provider exited" })
        const terminalTransition = yield* Effect.either(
          runs.complete({ runId: failedRun.id, usage: null }),
        )
        const listed = yield* runs.listForThread(thread.thread.id)

        expect(failed).toMatchObject({ status: "failed", usage: null, error: "Provider exited" })
        expect(listed.map(({ id }) => id)).toEqual(
          expect.arrayContaining([started.id, failedRun.id]),
        )
        expect(Either.isLeft(terminalTransition)).toBe(true)
        if (Either.isLeft(terminalTransition)) {
          expect(terminalTransition.left).toBeInstanceOf(AgentRunStoreError)
        }

        yield* database.run("UPDATE agent_runs SET model = '' WHERE id = ?", [started.id])
        const malformed = yield* Effect.either(runs.get(started.id))
        expect(Either.isLeft(malformed)).toBe(true)
        if (Either.isLeft(malformed)) expect(malformed.left.operation).toBe("get.decode")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-69 AC: persists normalized artifacts and queries them by run and thread", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const thread = yield* createThread
        const runs = yield* AgentRunStore
        const artifacts = yield* AgentRunArtifactStore
        const normalizer = yield* AgentArtifactNormalizer
        const database = yield* DatabaseService
        const run = yield* runs.start({
          threadId: thread.thread.id,
          provider: "claude",
          model: "claude-sonnet-4",
          promptVersion: AgentPromptVersion.make("thread-v1"),
        })
        const normalized = yield* normalizer.normalize({
          type: "file_read",
          provider: "claude",
          title: "Read src/main.ts",
          content: "export const answer = 42\n",
          metadata: { toolName: "Read", path: "src/main.ts" },
        })
        const first = yield* artifacts.save({
          runId: run.id,
          threadId: thread.thread.id,
          artifact: normalized,
        })
        const second = yield* artifacts.save({
          runId: run.id,
          threadId: thread.thread.id,
          artifact: ReviewAgentArtifact.make({
            ...normalized,
            type: "provider_message",
            title: "Provider note",
          }),
        })
        const byRun = yield* artifacts.listForRun(run.id)
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
            runId: run.id,
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
        const malformed = yield* Effect.either(artifacts.listForRun(run.id))
        expect(Either.isLeft(malformed)).toBe(true)
        if (Either.isLeft(malformed)) expect(malformed.left.operation).toBe("listForRun.decode")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-69 AC: replaces compact thread memory and rejects malformed rows", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const thread = yield* createThread
        const runs = yield* AgentRunStore
        const artifacts = yield* AgentRunArtifactStore
        const memory = yield* ThreadMemoryStore
        const normalizer = yield* AgentArtifactNormalizer
        const database = yield* DatabaseService
        const run = yield* runs.start({
          threadId: thread.thread.id,
          provider: "opencode",
          model: "configured-model",
          promptVersion: AgentPromptVersion.make("thread-v1"),
        })
        const normalized = yield* normalizer.normalize({
          type: "mcp_tool_result",
          provider: "opencode",
          title: "getDiffHunk",
          content: "@@ -1 +1 @@\n-old\n+new",
          metadata: { toolName: "getDiffHunk", hunkId: "hunk-1" },
        })
        const artifact = yield* artifacts.save({
          runId: run.id,
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
