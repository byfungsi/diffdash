import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentPromptVersion, ThreadMemorySummaryAlgorithm } from "@diffdash/domain/agent-run"
import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { LocalReviewTarget } from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  ReviewAgentArtifact,
  ReviewAgentArtifactId,
  ReviewAgentProviderId,
  ReviewAgentProviderRunId,
  ReviewAgentUsage,
} from "@diffdash/domain/review-agent"
import {
  makeReviewKey,
  ReviewKey,
  ReviewProjectId,
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  CurrentReviewAnchor,
  HostedReviewTarget,
  LineReviewAnchor,
  MarkdownBody,
  type ReviewThreadId,
} from "@diffdash/domain/review-thread"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Layer, ManagedRuntime, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { AgentRunArtifactStore } from "./agent-run-artifact-store"
import { makeDatabase } from "./database"
import * as DatabaseNode from "./database-node"
import { RepositoryStore } from "./repository-store"
import { ReviewThreadStore } from "./review-thread-store"
import {
  ReviewTurnOwnershipError,
  type ReviewTurnMappingToken,
  ReviewTurnStore,
  ReviewTurnStoreError,
  ReviewTurnTargetError,
  type ReviewTurnWriteStep,
} from "./review-turn-store"
import { hostedTestRepositoryInput } from "./test-support/repository"

const review = makeHostedReviewLocator("github", "fungsi", "diffdash", 10)
const reviewKey = makeReviewKey(review)
const baseRevision = ReviewRevision.make("base-10")
const headRevision = ReviewRevision.make("head-10")
const target = HostedReviewTarget.make({ kind: "hosted", review })
const anchor = LineReviewAnchor.make({
  fileId: ReviewFileId.make("file-10"),
  filePath: RepositoryRelativePath.make("src/review-turn.ts"),
  oldPath: null,
  hunkId: ReviewHunkId.make("hunk-10"),
  hunkFingerprint: ReviewHunkFingerprint.make("fingerprint-10"),
  hunkHeader: "@@ -1 +1 @@",
  side: "new",
  lineNumber: 1,
  lineContent: "const transactional = true",
})

const CountsRow = Schema.Struct({
  runs: Schema.Number,
  pending_messages: Schema.Number,
  artifacts: Schema.Number,
  memory: Schema.Number,
})

const RunInspectionRow = Schema.Struct({
  status: Schema.Literals(["running", "completed", "failed"]),
  error: Schema.NullOr(Schema.String),
})

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-review-turn-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string, afterWrite?: (step: ReviewTurnWriteStep) => void) => {
  const database = DatabaseNode.layer(databasePath)
  return Layer.mergeAll(
    RepositoryStore.layer,
    ReviewThreadStore.layer,
    AgentRunArtifactStore.layer,
    ReviewTurnStore.layerWith(afterWrite === undefined ? {} : { afterWrite }),
  ).pipe(Layer.provideMerge(database))
}

const createHostedThread = Effect.gen(function* () {
  const repository = yield* (yield* RepositoryStore).upsertRepository(
    hostedTestRepositoryInput({ localPath: "/workspace/diffdash" }),
  )
  const details = yield* (yield* ReviewThreadStore).create({
    repoId: repository.id,
    reviewKey,
    prNumber: 10,
    baseRevision,
    headRevision,
    anchor,
    bodyMarkdown: MarkdownBody.make("Review this transaction."),
  })
  return { repository, details }
})

const validateInput = (threadId: ReviewThreadId, repoId: ReviewProjectId) => ({
  threadId,
  target,
  repoId,
  reviewKey,
  baseRevision,
  headRevision,
})

const beginInput = (
  threadId: ReviewThreadId,
  repoId: ReviewProjectId,
  mapping: ReviewTurnMappingToken,
) => ({
  ...validateInput(threadId, repoId),
  mapping,
  provider: ReviewAgentProviderId.make("opencode"),
  model: "test-model",
  promptVersion: AgentPromptVersion.make("review-thread-v3"),
})

const readCounts = Effect.gen(function* () {
  const database = makeDatabase(yield* SqlClient.SqlClient)
  const row = yield* database.get(`SELECT
      (SELECT COUNT(*) FROM agent_runs) AS runs,
      (SELECT COUNT(*) FROM review_thread_messages
        WHERE author = 'agent' AND status = 'pending') AS pending_messages,
      (SELECT COUNT(*) FROM agent_run_artifacts) AS artifacts,
      (SELECT COUNT(*) FROM thread_memory) AS memory`)
  return yield* Schema.decodeUnknownEffect(CountsRow)(Option.getOrThrow(row))
})

const inspectRun = (runId: string) =>
  Effect.gen(function* () {
    const database = makeDatabase(yield* SqlClient.SqlClient)
    const row = yield* database.get("SELECT status, error FROM agent_runs WHERE id = ?", [runId])
    return yield* Effect.fromOption(row).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RunInspectionRow)),
    )
  })

describe("ReviewTurnStore", () => {
  it.effect("accepts a legacy carried_forward active mapping", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const { repository, details } = yield* createHostedThread
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* database.run(
          "UPDATE review_threads SET anchor_status = 'carried_forward' WHERE id = ?",
          [details.thread.id],
        )

        const mapping = yield* (yield* ReviewTurnStore).validateTarget(
          validateInput(details.thread.id, repository.id),
        )
        expect(mapping.currentAnchor).toEqual(anchor)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("accepts a local review under a linked hosted project identity", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const rootPath = RepositoryCheckoutPath.make("/workspace/diffdash")
        const localTarget = LocalReviewTarget.make({ kind: "local", rootPath })
        const localKey = ReviewKey.make(
          `local:${createHash("sha256").update(rootPath).digest("hex")}`,
        )
        const repository = yield* (yield* RepositoryStore).upsertRepository(
          hostedTestRepositoryInput({ localPath: rootPath }),
        )
        const details = yield* (yield* ReviewThreadStore).create({
          repoId: repository.id,
          reviewKey: localKey,
          prNumber: null,
          baseRevision,
          headRevision,
          anchor,
          bodyMarkdown: MarkdownBody.make("Review the linked working tree."),
        })

        const mapping = yield* (yield* ReviewTurnStore).validateTarget({
          threadId: details.thread.id,
          target: localTarget,
          repoId: repository.id,
          reviewKey: localKey,
          baseRevision,
          headRevision,
        })

        expect(mapping.repoId).toBe(repository.id)
        expect(mapping.reviewKey).toBe(localKey)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rolls back beginTurn after every aggregate write", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      let failAt: ReviewTurnWriteStep | null = null
      const layer = makeLayer(databasePath, (step) => {
        if (step === failAt) throw new Error(`fault:${step}`)
      })

      yield* Effect.gen(function* () {
        const { repository, details } = yield* createHostedThread
        const turns = yield* ReviewTurnStore
        const mapping = yield* turns.validateTarget(validateInput(details.thread.id, repository.id))
        for (const step of ["begin.run", "begin.message", "begin.thread"] as const) {
          failAt = step
          const result = yield* Effect.result(
            turns.beginTurn(beginInput(details.thread.id, repository.id, mapping)),
          )
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(ReviewTurnStoreError)
          expect(yield* readCounts).toEqual({
            runs: 0,
            pending_messages: 0,
            artifacts: 0,
            memory: 0,
          })
          expect((yield* (yield* ReviewThreadStore).get(details.thread.id)).messages).toHaveLength(
            1,
          )
        }
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("rolls back all artifacts, message, run, and memory after every completion write", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      let failAt: ReviewTurnWriteStep | null = null
      const layer = makeLayer(databasePath, (step) => {
        if (step === failAt) throw new Error(`fault:${step}`)
      })

      yield* Effect.gen(function* () {
        const { repository, details } = yield* createHostedThread
        const turns = yield* ReviewTurnStore
        const mapping = yield* turns.validateTarget(validateInput(details.thread.id, repository.id))
        const begun = yield* turns.beginTurn(beginInput(details.thread.id, repository.id, mapping))
        const artifactId = ReviewAgentArtifactId.make("artifact-complete")
        const complete = () =>
          turns.completeTurn({
            threadId: details.thread.id,
            runId: begun.run.id,
            messageId: begun.pendingMessage.id,
            bodyMarkdown: MarkdownBody.make("Atomic response."),
            artifacts: [
              {
                id: artifactId,
                artifact: ReviewAgentArtifact.make({
                  type: "provider_message",
                  provider: ReviewAgentProviderId.make("opencode"),
                  title: "Provider response",
                  content: "Atomic response.",
                  contentDigest: "sha256:complete",
                  metadata: { sourceProvider: "opencode" },
                  truncated: false,
                  originalSize: 16,
                }),
              },
            ],
            providerRunId: null,
            usage: ReviewAgentUsage.make({
              inputTokens: 10,
              outputTokens: 4,
              cacheReadTokens: null,
              cacheWriteTokens: null,
              costUsd: null,
            }),
            memoryUpdate: {
              threadId: details.thread.id,
              summary: "Atomic response.",
              summarizedThroughSequence: begun.pendingMessage.sequence,
              summaryAlgorithm: ThreadMemorySummaryAlgorithm.make("provider-summary"),
              summaryVersion: 1,
              importantArtifactIds: [artifactId],
            },
          })

        for (const step of [
          "complete.artifact",
          "complete.message",
          "complete.run",
          "complete.memory",
          "complete.thread",
        ] as const) {
          failAt = step
          const result = yield* Effect.result(complete())
          expect(Result.isFailure(result)).toBe(true)
          const run = yield* inspectRun(begun.run.id)
          const persisted = yield* (yield* ReviewThreadStore).get(details.thread.id)
          expect(run.status).toBe("running")
          expect(persisted.messages.at(-1)?._tag).toBe("Pending")
          expect(yield* readCounts).toEqual({
            runs: 1,
            pending_messages: 1,
            artifacts: 0,
            memory: 0,
          })
        }

        failAt = null
        const completed = yield* complete()
        expect(completed.messages.at(-1)?._tag).toBe("Completed")
        expect((yield* inspectRun(begun.run.id)).status).toBe("completed")
        expect(yield* readCounts).toEqual({
          runs: 1,
          pending_messages: 0,
          artifacts: 1,
          memory: 1,
        })
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("keeps failed run and message status in agreement after every failure write", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      let failAt: ReviewTurnWriteStep | null = null
      const layer = makeLayer(databasePath, (step) => {
        if (step === failAt) throw new Error(`fault:${step}`)
      })

      yield* Effect.gen(function* () {
        const { repository, details } = yield* createHostedThread
        const turns = yield* ReviewTurnStore
        const mapping = yield* turns.validateTarget(validateInput(details.thread.id, repository.id))
        const begun = yield* turns.beginTurn(beginInput(details.thread.id, repository.id, mapping))
        const fail = () =>
          turns.failTurn({
            threadId: details.thread.id,
            runId: begun.run.id,
            messageId: begun.pendingMessage.id,
            diagnostic: MarkdownBody.make("Bounded failure."),
            failure: null,
          })

        for (const step of ["fail.message", "fail.run", "fail.thread"] as const) {
          failAt = step
          expect(Result.isFailure(yield* Effect.result(fail()))).toBe(true)
          expect((yield* inspectRun(begun.run.id)).status).toBe("running")
          expect(
            (yield* (yield* ReviewThreadStore).get(details.thread.id)).messages.at(-1)?._tag,
          ).toBe("Pending")
        }

        failAt = null
        const failed = yield* fail()
        expect(failed.messages.at(-1)?._tag).toBe("Failed")
        expect((yield* inspectRun(begun.run.id)).status).toBe("failed")
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("rejects wrong targets, stale revisions, and mapping races without mutation", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const { repository, details } = yield* createHostedThread
        const turns = yield* ReviewTurnStore
        const valid = validateInput(details.thread.id, repository.id)
        const mapping = yield* turns.validateTarget(valid)
        const wrongReview = HostedReviewTarget.make({
          kind: "hosted",
          review: makeHostedReviewLocator("github", "fungsi", "other", 10),
        })
        const wrongLocal = LocalReviewTarget.make({
          kind: "local",
          rootPath: RepositoryCheckoutPath.make("/wrong/repo"),
        })

        for (const input of [
          { ...valid, target: wrongReview },
          { ...valid, target: wrongLocal },
          { ...valid, repoId: ReviewProjectId.make("github:fungsi/other") },
          { ...valid, headRevision: ReviewRevision.make("stale-head") },
        ]) {
          const result = yield* Effect.result(turns.validateTarget(input))
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(ReviewTurnTargetError)
          expect(yield* readCounts).toEqual({
            runs: 0,
            pending_messages: 0,
            artifacts: 0,
            memory: 0,
          })
        }

        const movedAnchor = LineReviewAnchor.make({ ...anchor, lineNumber: 2 })
        yield* (yield* ReviewThreadStore).updateCurrentMappings([
          {
            threadId: details.thread.id,
            currentBaseRevision: baseRevision,
            currentHeadRevision: headRevision,
            currentAnchor: CurrentReviewAnchor.cases.Active.make({ anchor: movedAnchor }),
          },
        ])
        const raced = yield* Effect.result(
          turns.beginTurn(beginInput(details.thread.id, repository.id, mapping)),
        )
        expect(Result.isFailure(raced)).toBe(true)
        if (Result.isFailure(raced)) expect(raced.failure).toBeInstanceOf(ReviewTurnTargetError)
        expect(yield* readCounts).toEqual({
          runs: 0,
          pending_messages: 0,
          artifacts: 0,
          memory: 0,
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rejects completion and failure that do not own the active run/message pair", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const { repository, details } = yield* createHostedThread
        const turns = yield* ReviewTurnStore
        const mapping = yield* turns.validateTarget(validateInput(details.thread.id, repository.id))
        const begun = yield* turns.beginTurn(beginInput(details.thread.id, repository.id, mapping))
        const wrongMessageId = begun.details.messages[0]?.id
        if (wrongMessageId === undefined) throw new Error("Expected initial user message")
        const completion = yield* Effect.result(
          turns.completeTurn({
            threadId: details.thread.id,
            runId: begun.run.id,
            messageId: wrongMessageId,
            bodyMarkdown: MarkdownBody.make("Wrong owner."),
            artifacts: [],
            providerRunId: null,
            usage: null,
            memoryUpdate: null,
          }),
        )
        const failure = yield* Effect.result(
          turns.failTurn({
            threadId: details.thread.id,
            runId: begun.run.id,
            messageId: wrongMessageId,
            diagnostic: MarkdownBody.make("Wrong owner."),
            failure: null,
          }),
        )
        expect(Result.isFailure(completion)).toBe(true)
        expect(Result.isFailure(failure)).toBe(true)
        if (Result.isFailure(completion)) {
          expect(completion.failure).toBeInstanceOf(ReviewTurnOwnershipError)
        }
        if (Result.isFailure(failure))
          expect(failure.failure).toBeInstanceOf(ReviewTurnOwnershipError)
        expect((yield* inspectRun(begun.run.id)).status).toBe("running")
        expect(
          (yield* (yield* ReviewThreadStore).get(details.thread.id)).messages.at(-1)?._tag,
        ).toBe("Pending")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("leaves committed interrupted state untouched when a target check fails", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const { repository, details } = yield* createHostedThread
        const turns = yield* ReviewTurnStore
        const valid = validateInput(details.thread.id, repository.id)
        const mapping = yield* turns.validateTarget(valid)
        const begun = yield* turns.beginTurn(beginInput(details.thread.id, repository.id, mapping))
        const rejected = yield* Effect.result(
          turns.validateTarget({
            ...valid,
            repoId: ReviewProjectId.make("github:fungsi/wrong"),
          }),
        )
        expect(Result.isFailure(rejected)).toBe(true)
        if (Result.isFailure(rejected))
          expect(rejected.failure).toBeInstanceOf(ReviewTurnTargetError)
        expect((yield* inspectRun(begun.run.id)).status).toBe("running")
        const persisted = yield* (yield* ReviewThreadStore).get(details.thread.id)
        expect(persisted.messages.at(-1)?._tag).toBe("Pending")
        expect(persisted.messages.at(-1)?.id).toBe(begun.pendingMessage.id)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rejects malformed aggregate run and memory rows at the review-turn boundary", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const { repository, details } = yield* createHostedThread
        const threads = yield* ReviewThreadStore
        const turns = yield* ReviewTurnStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const targetInput = validateInput(details.thread.id, repository.id)
        const mapping = yield* turns.validateTarget(targetInput)
        const begun = yield* turns.beginTurn(beginInput(details.thread.id, repository.id, mapping))
        yield* turns.completeTurn({
          threadId: details.thread.id,
          runId: begun.run.id,
          messageId: begun.pendingMessage.id,
          bodyMarkdown: MarkdownBody.make("Initial response."),
          artifacts: [],
          providerRunId: ReviewAgentProviderRunId.make("provider-run-1"),
          usage: null,
          memoryUpdate: null,
        })
        yield* threads.addUserMessage({
          threadId: details.thread.id,
          bodyMarkdown: MarkdownBody.make("Follow-up question."),
        })

        yield* database.run("UPDATE agent_runs SET usage_json = ? WHERE id = ?", [
          "not-json",
          begun.run.id,
        ])
        const malformedRun = yield* Effect.result(
          turns.beginTurn(beginInput(details.thread.id, repository.id, mapping)),
        )
        expect(Result.isFailure(malformedRun) && malformedRun.failure).toEqual(
          expect.objectContaining<Partial<ReviewTurnStoreError>>({
            operation: DiagnosticOperation.make("decode.run"),
          }),
        )

        yield* database.run("UPDATE agent_runs SET usage_json = NULL WHERE id = ?", [begun.run.id])
        yield* database.run(
          `INSERT INTO thread_memory (
             thread_id, summary, summarized_through_sequence, summary_algorithm,
             summary_version, important_artifact_ids_json, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            details.thread.id,
            "Malformed memory",
            begun.pendingMessage.sequence,
            "provider-summary",
            1,
            "not-json",
            new Date().toISOString(),
          ],
        )
        const malformedMemory = yield* Effect.result(
          turns.beginTurn(beginInput(details.thread.id, repository.id, mapping)),
        )
        expect(Result.isFailure(malformedMemory) && malformedMemory.failure).toEqual(
          expect.objectContaining<Partial<ReviewTurnStoreError>>({
            operation: DiagnosticOperation.make("decode.memory"),
          }),
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it("allows only one begin across two service instances sharing one SQLite database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "diffdash-review-turn-concurrency-"))
    const databasePath = join(directory, "test.sqlite")
    const setup = ManagedRuntime.make(makeLayer(databasePath))
    const first = ManagedRuntime.make(makeLayer(databasePath))
    const second = ManagedRuntime.make(makeLayer(databasePath))
    try {
      const input = await setup.runPromise(
        Effect.gen(function* () {
          const { repository, details } = yield* createHostedThread
          const turns = yield* ReviewTurnStore
          const mapping = yield* turns.validateTarget(
            validateInput(details.thread.id, repository.id),
          )
          return beginInput(details.thread.id, repository.id, mapping)
        }),
      )
      await setup.dispose()

      const results = await Promise.allSettled([
        first.runPromise(Effect.flatMap(ReviewTurnStore, (turns) => turns.beginTurn(input))),
        second.runPromise(Effect.flatMap(ReviewTurnStore, (turns) => turns.beginTurn(input))),
      ])
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1)
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1)
      expect(await first.runPromise(readCounts)).toEqual({
        runs: 1,
        pending_messages: 1,
        artifacts: 0,
        memory: 0,
      })
    } finally {
      await Promise.allSettled([setup.dispose(), first.dispose(), second.dispose()])
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it("recovers a committed begin after closing and reopening the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "diffdash-review-turn-reopen-"))
    const databasePath = join(directory, "test.sqlite")
    const beforeCrash = ManagedRuntime.make(makeLayer(databasePath))
    const afterCrash = ManagedRuntime.make(makeLayer(databasePath))
    try {
      const begun = await beforeCrash.runPromise(
        Effect.gen(function* () {
          const { repository, details } = yield* createHostedThread
          const turns = yield* ReviewTurnStore
          const mapping = yield* turns.validateTarget(
            validateInput(details.thread.id, repository.id),
          )
          return yield* turns.beginTurn(beginInput(details.thread.id, repository.id, mapping))
        }),
      )
      await beforeCrash.dispose()

      expect(
        await afterCrash.runPromise(
          Effect.flatMap(ReviewTurnStore, (turns) => turns.recoverInterruptedTurns),
        ),
      ).toBe(1)
      const recovered = await afterCrash.runPromise(
        Effect.gen(function* () {
          const run = yield* inspectRun(begun.run.id)
          const details = yield* (yield* ReviewThreadStore).get(begun.run.threadId)
          return { run, message: details.messages.at(-1) }
        }),
      )
      expect(recovered.run.status).toBe("failed")
      expect(recovered.message).toMatchObject({
        id: begun.pendingMessage.id,
        _tag: "Failed",
        agentRunId: begun.run.id,
      })
      expect(recovered.run.error).toBe(
        "The previous local agent run was interrupted. Retry to try again.",
      )
    } finally {
      await beforeCrash.dispose()
      await afterCrash.dispose()
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
