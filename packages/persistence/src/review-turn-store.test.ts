import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentPromptVersion, ThreadMemorySummaryAlgorithm } from "@diffdash/domain/agent-run"
import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { LocalReviewTarget } from "@diffdash/domain/local-review"
import {
  ReviewAgentArtifact,
  ReviewAgentArtifactId,
  ReviewAgentUsage,
} from "@diffdash/domain/review-agent"
import {
  makeReviewKey,
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  HostedReviewTarget,
  LineReviewAnchor,
  MarkdownBody,
  type ReviewThreadId,
} from "@diffdash/domain/review-thread"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer, ManagedRuntime, Schema } from "effect"
import { AgentRunArtifactStore } from "./agent-run-artifact-store"
import { AgentRunStore } from "./agent-run-store"
import { DatabaseService } from "./database"
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
import { ThreadMemoryStore } from "./thread-memory-store"

const review = makeHostedReviewLocator("github", "fungsi", "diffdash", 10)
const reviewKey = makeReviewKey(review)
const baseRevision = ReviewRevision.make("base-10")
const headRevision = ReviewRevision.make("head-10")
const target = HostedReviewTarget.make({ kind: "hosted", review })
const anchor = LineReviewAnchor.make({
  fileId: ReviewFileId.make("file-10"),
  filePath: "src/review-turn.ts",
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

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-review-turn-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string, afterWrite?: (step: ReviewTurnWriteStep) => void) => {
  const database = DatabaseService.layer(databasePath)
  return Layer.mergeAll(
    RepositoryStore.layer,
    ReviewThreadStore.layer,
    AgentRunStore.layer,
    AgentRunArtifactStore.layer,
    ThreadMemoryStore.layer,
    ReviewTurnStore.layerWith(afterWrite === undefined ? {} : { afterWrite }),
  ).pipe(Layer.provideMerge(database))
}

const createHostedThread = Effect.gen(function* () {
  const repository = yield* (yield* RepositoryStore).upsertRepository({
    provider: "github",
    owner: "fungsi",
    name: "diffdash",
    remoteUrl: "https://github.com/fungsi/diffdash",
    localPath: "/workspace/diffdash",
  })
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

const validateInput = (threadId: ReviewThreadId, repoId: string) => ({
  threadId,
  target,
  repoId,
  reviewKey,
  baseRevision,
  headRevision,
})

const beginInput = (threadId: ReviewThreadId, repoId: string, mapping: ReviewTurnMappingToken) => ({
  ...validateInput(threadId, repoId),
  mapping,
  provider: "opencode",
  model: "test-model",
  promptVersion: AgentPromptVersion.make("review-thread-v3"),
})

const readCounts = Effect.gen(function* () {
  const database = yield* DatabaseService
  const row = yield* database.get(`SELECT
      (SELECT COUNT(*) FROM agent_runs) AS runs,
      (SELECT COUNT(*) FROM review_thread_messages
        WHERE author = 'agent' AND status = 'pending') AS pending_messages,
      (SELECT COUNT(*) FROM agent_run_artifacts) AS artifacts,
      (SELECT COUNT(*) FROM thread_memory) AS memory`)
  return yield* Schema.decodeUnknown(CountsRow)(row)
})

describe("ReviewTurnStore", () => {
  it.scoped("rolls back beginTurn after every aggregate write", () =>
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
          const result = yield* Effect.either(
            turns.beginTurn(beginInput(details.thread.id, repository.id, mapping)),
          )
          expect(Either.isLeft(result)).toBe(true)
          if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(ReviewTurnStoreError)
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

  it.scoped("rolls back all artifacts, message, run, and memory after every completion write", () =>
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
                  provider: "opencode",
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
          const result = yield* Effect.either(complete())
          expect(Either.isLeft(result)).toBe(true)
          const run = yield* (yield* AgentRunStore).get(begun.run.id)
          const persisted = yield* (yield* ReviewThreadStore).get(details.thread.id)
          expect(run.status).toBe("running")
          expect(persisted.messages.at(-1)?.status).toBe("pending")
          expect(yield* readCounts).toEqual({
            runs: 1,
            pending_messages: 1,
            artifacts: 0,
            memory: 0,
          })
        }

        failAt = null
        const completed = yield* complete()
        expect(completed.messages.at(-1)?.status).toBe("complete")
        expect((yield* (yield* AgentRunStore).get(begun.run.id)).status).toBe("completed")
        expect(yield* readCounts).toEqual({
          runs: 1,
          pending_messages: 0,
          artifacts: 1,
          memory: 1,
        })
      }).pipe(Effect.provide(layer))
    }),
  )

  it.scoped("keeps failed run and message status in agreement after every failure write", () =>
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
          })

        for (const step of ["fail.message", "fail.run", "fail.thread"] as const) {
          failAt = step
          expect(Either.isLeft(yield* Effect.either(fail()))).toBe(true)
          expect((yield* (yield* AgentRunStore).get(begun.run.id)).status).toBe("running")
          expect(
            (yield* (yield* ReviewThreadStore).get(details.thread.id)).messages.at(-1)?.status,
          ).toBe("pending")
        }

        failAt = null
        const failed = yield* fail()
        expect(failed.messages.at(-1)?.status).toBe("failed")
        expect((yield* (yield* AgentRunStore).get(begun.run.id)).status).toBe("failed")
      }).pipe(Effect.provide(layer))
    }),
  )

  it.scoped("rejects wrong targets, stale revisions, and mapping races without mutation", () =>
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
        const wrongLocal = LocalReviewTarget.make({ kind: "local", rootPath: "/wrong/repo" })

        for (const input of [
          { ...valid, target: wrongReview },
          { ...valid, target: wrongLocal },
          { ...valid, repoId: "github:fungsi/other" },
          { ...valid, headRevision: ReviewRevision.make("stale-head") },
        ]) {
          const result = yield* Effect.either(turns.validateTarget(input))
          expect(Either.isLeft(result)).toBe(true)
          if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(ReviewTurnTargetError)
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
            currentAnchor: movedAnchor,
            anchorStatus: "active",
          },
        ])
        const raced = yield* Effect.either(
          turns.beginTurn(beginInput(details.thread.id, repository.id, mapping)),
        )
        expect(Either.isLeft(raced)).toBe(true)
        if (Either.isLeft(raced)) expect(raced.left).toBeInstanceOf(ReviewTurnTargetError)
        expect(yield* readCounts).toEqual({
          runs: 0,
          pending_messages: 0,
          artifacts: 0,
          memory: 0,
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("rejects completion and failure that do not own the active run/message pair", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const { repository, details } = yield* createHostedThread
        const turns = yield* ReviewTurnStore
        const mapping = yield* turns.validateTarget(validateInput(details.thread.id, repository.id))
        const begun = yield* turns.beginTurn(beginInput(details.thread.id, repository.id, mapping))
        const wrongMessageId = begun.details.messages[0]?.id
        if (wrongMessageId === undefined) throw new Error("Expected initial user message")
        const completion = yield* Effect.either(
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
        const failure = yield* Effect.either(
          turns.failTurn({
            threadId: details.thread.id,
            runId: begun.run.id,
            messageId: wrongMessageId,
            diagnostic: MarkdownBody.make("Wrong owner."),
          }),
        )
        expect(Either.isLeft(completion)).toBe(true)
        expect(Either.isLeft(failure)).toBe(true)
        if (Either.isLeft(completion)) {
          expect(completion.left).toBeInstanceOf(ReviewTurnOwnershipError)
        }
        if (Either.isLeft(failure)) expect(failure.left).toBeInstanceOf(ReviewTurnOwnershipError)
        expect((yield* (yield* AgentRunStore).get(begun.run.id)).status).toBe("running")
        expect(
          (yield* (yield* ReviewThreadStore).get(details.thread.id)).messages.at(-1)?.status,
        ).toBe("pending")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("leaves committed interrupted state untouched when a target check fails", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const { repository, details } = yield* createHostedThread
        const turns = yield* ReviewTurnStore
        const valid = validateInput(details.thread.id, repository.id)
        const mapping = yield* turns.validateTarget(valid)
        const begun = yield* turns.beginTurn(beginInput(details.thread.id, repository.id, mapping))
        const rejected = yield* Effect.either(
          turns.validateTarget({ ...valid, repoId: "github:fungsi/wrong" }),
        )
        expect(Either.isLeft(rejected)).toBe(true)
        if (Either.isLeft(rejected)) expect(rejected.left).toBeInstanceOf(ReviewTurnTargetError)
        expect((yield* (yield* AgentRunStore).get(begun.run.id)).status).toBe("running")
        const persisted = yield* (yield* ReviewThreadStore).get(details.thread.id)
        expect(persisted.messages.at(-1)?.status).toBe("pending")
        expect(persisted.messages.at(-1)?.id).toBe(begun.pendingMessage.id)
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
          const run = yield* (yield* AgentRunStore).get(begun.run.id)
          const details = yield* (yield* ReviewThreadStore).get(begun.run.threadId)
          return { run, message: details.messages.at(-1) }
        }),
      )
      expect(recovered.run.status).toBe("failed")
      expect(recovered.message).toMatchObject({
        id: begun.pendingMessage.id,
        status: "failed",
        agentRunId: begun.run.id,
      })
      expect(recovered.run.error).toBe(recovered.message?.bodyMarkdown)
    } finally {
      await beforeCrash.dispose()
      await afterCrash.dispose()
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
