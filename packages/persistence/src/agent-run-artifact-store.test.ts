import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AgentPromptVersion } from "@diffdash/domain/agent-run"
import { ReviewAgentArtifact, ReviewAgentProviderId } from "@diffdash/domain/review-agent"
import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  makeReviewKey,
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import { HostedReviewTarget, LineReviewAnchor, MarkdownBody } from "@diffdash/domain/review-thread"
import { AgentRunArtifactStore, AgentRunArtifactStoreError } from "./agent-run-artifact-store"
import { makeDatabase } from "./database"
import * as DatabaseNode from "./database-node"
import { RepositoryStore } from "./repository-store"
import { ReviewThreadStore } from "./review-thread-store"
import { ReviewTurnStore } from "./review-turn-store"
import { hostedTestRepositoryInput } from "./test-support/repository"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-agent-run-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  Layer.mergeAll(
    RepositoryStore.layer,
    ReviewThreadStore.layer,
    ReviewTurnStore.layer,
    AgentRunArtifactStore.layer,
  ).pipe(Layer.provideMerge(DatabaseNode.layer(databasePath)))

const review = makeHostedReviewLocator("github", "fungsi", "diffdash", 69)
const reviewKey = makeReviewKey(review)
const lineAnchor = LineReviewAnchor.make({
  fileId: ReviewFileId.make("file-69"),
  filePath: RepositoryRelativePath.make("src/agent-run.ts"),
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
    const repo = yield* repositories.upsertRepository(hostedTestRepositoryInput())
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

describe("AgentRunArtifactStore", () => {
  it.effect("FUN-69 AC: persists normalized artifacts and queries them by run and thread", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const { begun, thread } = yield* beginTurn(
          ReviewAgentProviderId.make("claude"),
          "claude-sonnet-4",
        )
        const artifacts = yield* AgentRunArtifactStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const normalized = ReviewAgentArtifact.make({
          type: "file_read",
          provider: ReviewAgentProviderId.make("claude"),
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

        const wrongProvider = ReviewAgentArtifact.make({
          ...normalized,
          provider: ReviewAgentProviderId.make("codex"),
        })
        const rejected = yield* Effect.result(
          artifacts.save({
            runId: begun.run.id,
            threadId: thread.thread.id,
            artifact: wrongProvider,
          }),
        )
        expect(Result.isFailure(rejected)).toBe(true)
        if (Result.isFailure(rejected)) {
          expect(rejected.failure).toBeInstanceOf(AgentRunArtifactStoreError)
        }

        yield* database.run("UPDATE agent_run_artifacts SET metadata_json = ? WHERE id = ?", [
          "not-json",
          first.id,
        ])
        const malformed = yield* Effect.result(artifacts.listForRun(begun.run.id))
        expect(Result.isFailure(malformed)).toBe(true)
        if (Result.isFailure(malformed))
          expect(malformed.failure.operation).toBe("listForRun.decode")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
