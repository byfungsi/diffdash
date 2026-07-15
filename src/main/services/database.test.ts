import { describe, expect, it } from "@effect/vitest"
import BetterSqlite3 from "better-sqlite3"
import { Effect, Either, Layer } from "effect"
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { AgentRunId, ReviewAgentArtifactId } from "../../shared/review-agent"
import { ReviewKey, ReviewRevision } from "../../shared/review-identity"
import { ReviewThreadId } from "../../shared/review-thread"
import { AgentRunArtifactStore, AgentRunArtifactStoreError } from "./agent-run-artifact-store"
import { AgentRunStore, AgentRunStoreError } from "./agent-run-store"
import { AppConfig } from "./app-config"
import { DatabaseError, DatabaseService } from "./database"
import { RepositoryStore } from "./repository-store"
import { ReviewThreadStore, ReviewThreadStoreError } from "./review-thread-store"
import { ThreadMemoryStore, ThreadMemoryStoreError } from "./thread-memory-store"
import { ViewedFileStore } from "./viewed-file-store"
import { WalkthroughStore, WalkthroughStoreError } from "./walkthrough-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-database-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  DatabaseService.layer.pipe(
    Layer.provide(
      AppConfig.layer({
        databasePath,
        settingsPath: join(dirname(databasePath), "settings.json"),
        tempDir: tmpdir(),
      }),
    ),
  )

const makeCompatibilityLayer = (databasePath: string) =>
  Layer.mergeAll(
    RepositoryStore.layer,
    ViewedFileStore.layer,
    WalkthroughStore.layer,
    ReviewThreadStore.layer,
    AgentRunStore.layer,
    AgentRunArtifactStore.layer,
    ThreadMemoryStore.layer,
  ).pipe(Layer.provideMerge(makeLayer(databasePath)))

interface CountRow {
  readonly count: number
}

interface WalkthroughRow {
  readonly base_sha: string
  readonly content_json: string
  readonly head_sha: string
}

interface ThreadMemoryMigrationRow {
  readonly summary: string
  readonly summarized_through_sequence: number
  readonly summary_algorithm: string
  readonly summary_version: number
}

interface AgentRunUsageMigrationRow {
  readonly id: string
  readonly usage_json: string | null
}

interface ThreadMigrationCountRow {
  readonly count: number
}

interface ThreadLifecycleMigrationRow {
  readonly closed_at: string | null
  readonly status: string
}

interface PullRequestFixtureRow {
  readonly author: string
  readonly base_ref: string
  readonly head_ref: string
  readonly head_sha: string
  readonly id: string
  readonly last_fetched_at: string
  readonly number: number
  readonly repo_id: string
  readonly state: string
  readonly title: string
}

describe("DatabaseService", () => {
  it.scoped("FUN-82 AC: creates and versions a fresh database", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const database = yield* DatabaseService
        const tables = yield* database.all<{ readonly name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )

        expect(tables.map(({ name }) => name)).toEqual([
          "agent_run_artifacts",
          "agent_runs",
          "pull_requests",
          "repos",
          "review_thread_messages",
          "review_threads",
          "thread_memory",
          "viewed_files",
          "walkthroughs",
        ])
        const memoryColumns = yield* database.all<{ readonly name: string }>(
          "PRAGMA table_info(thread_memory)",
        )
        expect(memoryColumns.map(({ name }) => name)).toEqual(
          expect.arrayContaining([
            "summarized_through_sequence",
            "summary_algorithm",
            "summary_version",
          ]),
        )
        const agentRunColumns = yield* database.all<{ readonly name: string }>(
          "PRAGMA table_info(agent_runs)",
        )
        expect(agentRunColumns.map(({ name }) => name)).toContain("usage_json")
      }).pipe(Effect.provide(makeLayer(databasePath)))

      const sqlite = new BetterSqlite3(databasePath)
      expect(sqlite.pragma("user_version", { simple: true })).toBe(8)
      sqlite.close()
    }),
  )

  it.scoped("FUN-148 AC: preserves the populated version-8 graph across fresh layers", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      copyFileSync(resolve("src/main/services/fixtures/database-v8-populated.sqlite"), databasePath)

      yield* Effect.scoped(
        assertPopulatedVersion8Fixture.pipe(Effect.provide(makeCompatibilityLayer(databasePath))),
      )
      yield* Effect.scoped(
        assertPopulatedVersion8Fixture.pipe(Effect.provide(makeCompatibilityLayer(databasePath))),
      )

      const sqlite = new BetterSqlite3(databasePath)
      expect(sqlite.pragma("user_version", { simple: true })).toBe(8)
      expect(sqlite.pragma("integrity_check", { simple: true })).toBe("ok")
      expect(sqlite.pragma("foreign_key_check")).toEqual([])
      sqlite.close()
    }),
  )

  it.scoped("FUN-148 AC: reports a corrupt database as a typed open failure", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      writeFileSync(databasePath, "not a sqlite database")

      const result = yield* Effect.either(
        Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath)))),
      )

      expect(Either.isLeft(result) && result.left).toEqual(
        expect.objectContaining<Partial<DatabaseError>>({
          _tag: "DatabaseError",
          operation: "open",
        }),
      )
    }),
  )

  it.scoped("FUN-148 AC: reports malformed durable JSON at typed store boundaries", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      copyFileSync(resolve("src/main/services/fixtures/database-v8-populated.sqlite"), databasePath)
      const sqlite = new BetterSqlite3(databasePath)
      sqlite.prepare("UPDATE walkthroughs SET content_json = '{'").run()
      sqlite.prepare("UPDATE review_threads SET current_anchor_json = '{}'").run()
      sqlite.prepare("UPDATE agent_runs SET usage_json = '{}'").run()
      sqlite.prepare("UPDATE agent_run_artifacts SET metadata_json = 'null'").run()
      sqlite.prepare("UPDATE thread_memory SET important_artifact_ids_json = '[\"\"]'").run()
      sqlite.close()

      const results = yield* Effect.gen(function* () {
        const walkthroughs = yield* WalkthroughStore
        const threads = yield* ReviewThreadStore
        const runs = yield* AgentRunStore
        const artifacts = yield* AgentRunArtifactStore
        const memory = yield* ThreadMemoryStore

        return {
          walkthrough: yield* Effect.either(
            walkthroughs.get({
              repoId: "github:byfungsi/diffdash",
              reviewKey: "github:byfungsi/diffdash#147",
              baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              promptVersion: "walkthrough-v4",
            }),
          ),
          thread: yield* Effect.either(threads.get(ReviewThreadId.make("thread-v8"))),
          run: yield* Effect.either(runs.get(AgentRunId.make("run-v8"))),
          artifact: yield* Effect.either(artifacts.get(ReviewAgentArtifactId.make("artifact-v8"))),
          memory: yield* Effect.either(memory.get(ReviewThreadId.make("thread-v8"))),
        }
      }).pipe(Effect.provide(makeCompatibilityLayer(databasePath)))

      expect(Either.isLeft(results.walkthrough) && results.walkthrough.left).toEqual(
        expect.objectContaining<Partial<WalkthroughStoreError>>({
          _tag: "WalkthroughStoreError",
          operation: "decodeContentJson.parse",
        }),
      )
      expect(Either.isLeft(results.thread) && results.thread.left).toEqual(
        expect.objectContaining<Partial<ReviewThreadStoreError>>({
          _tag: "ReviewThreadStoreError",
          operation: "get",
        }),
      )
      expect(Either.isLeft(results.run) && results.run.left).toEqual(
        expect.objectContaining<Partial<AgentRunStoreError>>({
          _tag: "AgentRunStoreError",
          operation: "get.decode",
        }),
      )
      expect(Either.isLeft(results.artifact) && results.artifact.left).toEqual(
        expect.objectContaining<Partial<AgentRunArtifactStoreError>>({
          _tag: "AgentRunArtifactStoreError",
          operation: "get.decode",
        }),
      )
      expect(Either.isLeft(results.memory) && results.memory.left).toEqual(
        expect.objectContaining<Partial<ThreadMemoryStoreError>>({
          _tag: "ThreadMemoryStoreError",
          operation: "get.decode",
        }),
      )
    }),
  )

  it.scoped("FUN-82 AC: migrates a legacy walkthrough schema without losing data", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      createLegacyDatabase(databasePath)

      yield* Effect.gen(function* () {
        const database = yield* DatabaseService
        const row = yield* database.get<WalkthroughRow>(
          "SELECT base_sha, head_sha, content_json FROM walkthroughs",
        )

        expect(row).toEqual({
          base_sha: "legacy-head",
          content_json: '{"title":"Legacy"}',
          head_sha: "legacy-head",
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-82 AC: safely retries an already applied migration", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))
      const sqlite = new BetterSqlite3(databasePath)
      sqlite.pragma("user_version = 0")
      sqlite.close()
      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))

      const reopened = new BetterSqlite3(databasePath)
      expect(reopened.pragma("user_version", { simple: true })).toBe(8)
      reopened.close()
    }),
  )

  it.scoped("FUN-67 AC: clears v3 thread memory during the single-thread reset", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      createVersion3ThreadMemoryDatabase(databasePath)

      yield* Effect.gen(function* () {
        const database = yield* DatabaseService
        const memory = yield* database.get<ThreadMemoryMigrationRow>(
          `SELECT summary, summarized_through_sequence, summary_algorithm, summary_version
           FROM thread_memory WHERE thread_id = ?`,
          ["thread-76"],
        )

        expect(memory).toBeUndefined()
      }).pipe(Effect.provide(makeLayer(databasePath)))

      const sqlite = new BetterSqlite3(databasePath)
      expect(sqlite.pragma("user_version", { simple: true })).toBe(8)
      sqlite.close()
    }),
  )

  it.scoped("FUN-67 AC: clears v4 agent runs during the single-thread reset", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      createVersion4AgentRunsDatabase(databasePath)

      yield* Effect.gen(function* () {
        const database = yield* DatabaseService
        const row = yield* database.get<AgentRunUsageMigrationRow>(
          "SELECT id, usage_json FROM agent_runs WHERE id = ?",
          ["run-72"],
        )

        expect(row).toBeUndefined()
      }).pipe(Effect.provide(makeLayer(databasePath)))

      const sqlite = new BetterSqlite3(databasePath)
      expect(sqlite.pragma("user_version", { simple: true })).toBe(8)
      sqlite.close()
    }),
  )

  it.scoped("FUN-67 AC: clears all legacy thread data for the single-thread model", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))

      const sqlite = new BetterSqlite3(databasePath)
      sqlite.pragma("foreign_keys = ON")
      sqlite
        .prepare(
          `INSERT INTO repos (
          id, provider, owner, name, remote_url, local_path, is_favorite,
          last_opened_at, last_synced_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "github:fungsi/diffdash",
          "github",
          "fungsi",
          "diffdash",
          "https://github.com/fungsi/diffdash",
          null,
          0,
          null,
          null,
          "2026-07-12T00:00:00.000Z",
          "2026-07-12T00:00:00.000Z",
        )
      const insertThread = sqlite.prepare(
        `INSERT INTO review_threads (
          id, repo_id, review_key, pr_number, base_sha, head_sha, current_base_sha,
          current_head_sha, original_anchor_json, current_anchor_json, anchor_status,
          status, closed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'open', NULL, ?, ?)`,
      )
      insertThread.run(
        "thread-review",
        "github:fungsi/diffdash",
        "github:fungsi/diffdash#67",
        67,
        "base-sha",
        "head-sha",
        "base-sha",
        "head-sha",
        '{"_tag":"review"}',
        '{"_tag":"review"}',
        "2026-07-12T00:00:00.000Z",
        "2026-07-12T00:00:00.000Z",
      )
      insertThread.run(
        "thread-line",
        "github:fungsi/diffdash",
        "github:fungsi/diffdash#67",
        67,
        "base-sha",
        "head-sha",
        "base-sha",
        "head-sha",
        '{"_tag":"line","fileId":"file-67","filePath":"src/app.ts","oldPath":null,"hunkId":"hunk-67","hunkFingerprint":"fingerprint-67","hunkHeader":"@@ -1 +1 @@","side":"new","lineNumber":1,"lineContent":"const value = true"}',
        '{"_tag":"line","fileId":"file-67","filePath":"src/app.ts","oldPath":null,"hunkId":"hunk-67","hunkFingerprint":"fingerprint-67","hunkHeader":"@@ -1 +1 @@","side":"new","lineNumber":1,"lineContent":"const value = true"}',
        "2026-07-12T00:00:00.000Z",
        "2026-07-12T00:00:00.000Z",
      )
      sqlite
        .prepare(
          `INSERT INTO review_thread_messages (
          id, thread_id, sequence, author, body_markdown, status, agent_run_id, created_at, updated_at
        ) VALUES (?, ?, 1, 'user', 'Legacy comment', 'complete', NULL, ?, ?)`,
        )
        .run(
          "message-review",
          "thread-review",
          "2026-07-12T00:00:00.000Z",
          "2026-07-12T00:00:00.000Z",
        )
      sqlite
        .prepare(
          `INSERT INTO agent_runs (
          id, thread_id, provider, model, prompt_version, status, provider_run_id, error,
          started_at, completed_at, usage_json
        ) VALUES (?, ?, 'codex', 'gpt-5', 'thread-v1', 'completed', NULL, NULL, ?, ?, NULL)`,
        )
        .run("run-review", "thread-review", "2026-07-12T00:00:00.000Z", "2026-07-12T00:00:01.000Z")
      sqlite
        .prepare(
          `INSERT INTO agent_run_artifacts (
          id, run_id, thread_id, type, title, content, content_digest, metadata_json,
          truncated, original_size, created_at
        ) VALUES (?, ?, ?, 'provider_message', 'Legacy', 'Legacy', 'sha256:legacy', '{}', 0, 6, ?)`,
        )
        .run("artifact-review", "run-review", "thread-review", "2026-07-12T00:00:01.000Z")
      sqlite
        .prepare(
          `INSERT INTO thread_memory (
          thread_id, summary, important_artifact_ids_json, updated_at,
          summarized_through_sequence, summary_algorithm, summary_version
        ) VALUES (?, 'Legacy', '[]', ?, 1, 'legacy', 1)`,
        )
        .run("thread-review", "2026-07-12T00:00:01.000Z")
      sqlite.pragma("user_version = 5")
      sqlite.close()

      yield* Effect.gen(function* () {
        const database = yield* DatabaseService
        const threads = yield* database.all<{ readonly id: string }>(
          "SELECT id FROM review_threads ORDER BY id",
        )
        const messages = yield* database.get<ThreadMigrationCountRow>(
          "SELECT COUNT(*) AS count FROM review_thread_messages",
        )
        const runs = yield* database.get<ThreadMigrationCountRow>(
          "SELECT COUNT(*) AS count FROM agent_runs",
        )
        const artifacts = yield* database.get<ThreadMigrationCountRow>(
          "SELECT COUNT(*) AS count FROM agent_run_artifacts",
        )
        const memory = yield* database.get<ThreadMigrationCountRow>(
          "SELECT COUNT(*) AS count FROM thread_memory",
        )

        expect(threads).toEqual([])
        expect(messages?.count).toBe(0)
        expect(runs?.count).toBe(0)
        expect(artifacts?.count).toBe(0)
        expect(memory?.count).toBe(0)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-67 AC: reopens threads closed by the removed lifecycle control", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))

      const sqlite = new BetterSqlite3(databasePath)
      sqlite
        .prepare(
          `INSERT INTO repos (
            id, provider, owner, name, remote_url, local_path, is_favorite,
            last_opened_at, last_synced_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "github:fungsi/diffdash",
          "github",
          "fungsi",
          "diffdash",
          "https://github.com/fungsi/diffdash",
          null,
          0,
          null,
          null,
          "2026-07-13T00:00:00.000Z",
          "2026-07-13T00:00:00.000Z",
        )
      sqlite
        .prepare(
          `INSERT INTO review_threads (
            id, repo_id, review_key, pr_number, base_sha, head_sha, current_base_sha,
            current_head_sha, original_anchor_json, current_anchor_json, anchor_status,
            status, closed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'closed', ?, ?, ?)`,
        )
        .run(
          "thread-closed",
          "github:fungsi/diffdash",
          "github:fungsi/diffdash#67",
          67,
          "base-sha",
          "head-sha",
          "base-sha",
          "head-sha",
          '{"_tag":"line","fileId":"file-67","filePath":"src/app.ts","oldPath":null,"hunkId":"hunk-67","hunkFingerprint":"fingerprint-67","hunkHeader":"@@ -1 +1 @@","side":"new","lineNumber":1,"lineContent":"const value = true"}',
          '{"_tag":"line","fileId":"file-67","filePath":"src/app.ts","oldPath":null,"hunkId":"hunk-67","hunkFingerprint":"fingerprint-67","hunkHeader":"@@ -1 +1 @@","side":"new","lineNumber":1,"lineContent":"const value = true"}',
          "2026-07-13T00:00:01.000Z",
          "2026-07-13T00:00:00.000Z",
          "2026-07-13T00:00:01.000Z",
        )
      sqlite.pragma("user_version = 7")
      sqlite.close()

      yield* Effect.gen(function* () {
        const database = yield* DatabaseService
        const thread = yield* database.get<ThreadLifecycleMigrationRow>(
          "SELECT status, closed_at FROM review_threads WHERE id = ?",
          ["thread-closed"],
        )

        expect(thread).toEqual({ status: "open", closed_at: null })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-82 AC: recovers rows left by the previous interrupted migration", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      createInterruptedLegacyDatabase(databasePath)

      yield* Effect.gen(function* () {
        const database = yield* DatabaseService
        const row = yield* database.get<WalkthroughRow>(
          "SELECT base_sha, head_sha, content_json FROM walkthroughs",
        )

        expect(row).toEqual({
          base_sha: "interrupted-head",
          content_json: '{"title":"Interrupted"}',
          head_sha: "interrupted-head",
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-82 AC: commits successful transaction callbacks", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const database = yield* DatabaseService
        yield* database.transaction("test.commit", (transaction) => {
          transaction.run("INSERT INTO repos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
            "github:fungsi/diffdash",
            "github",
            "fungsi",
            "diffdash",
            "https://github.com/fungsi/diffdash",
            null,
            0,
            null,
            null,
            "2026-07-12T00:00:00.000Z",
            "2026-07-12T00:00:00.000Z",
          ])
        })

        const row = yield* database.get<CountRow>("SELECT COUNT(*) AS count FROM repos")
        expect(row?.count).toBe(1)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-82 AC: rolls back failed transaction callbacks", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const database = yield* DatabaseService
        yield* database
          .transaction("test.rollback", (transaction) => {
            transaction.run("INSERT INTO repos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
              "github:fungsi/diffdash",
              "github",
              "fungsi",
              "diffdash",
              "https://github.com/fungsi/diffdash",
              null,
              0,
              null,
              null,
              "2026-07-12T00:00:00.000Z",
              "2026-07-12T00:00:00.000Z",
            ])
            throw new Error("rollback")
          })
          .pipe(Effect.catchAll(() => Effect.void))

        const row = yield* database.get<CountRow>("SELECT COUNT(*) AS count FROM repos")
        expect(row?.count).toBe(0)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-82 AC: rejects suspended transaction callbacks and rolls them back", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const database = yield* DatabaseService
        const result = yield* Effect.either(
          database.transaction("test.async", (transaction) => {
            transaction.run("INSERT INTO repos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
              "github:fungsi/diffdash",
              "github",
              "fungsi",
              "diffdash",
              "https://github.com/fungsi/diffdash",
              null,
              0,
              null,
              null,
              "2026-07-12T00:00:00.000Z",
              "2026-07-12T00:00:00.000Z",
            ])
            return Promise.resolve()
          }),
        )
        const row = yield* database.get<CountRow>("SELECT COUNT(*) AS count FROM repos")

        expect(Either.isLeft(result)).toBe(true)
        expect(row?.count).toBe(0)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})

const assertPopulatedVersion8Fixture = Effect.gen(function* () {
  const database = yield* DatabaseService
  const repositories = yield* RepositoryStore
  const viewedFiles = yield* ViewedFileStore
  const walkthroughs = yield* WalkthroughStore
  const threads = yield* ReviewThreadStore
  const runs = yield* AgentRunStore
  const artifacts = yield* AgentRunArtifactStore
  const memory = yield* ThreadMemoryStore

  const counts = yield* database.get<{
    readonly agent_run_artifacts: number
    readonly agent_runs: number
    readonly pull_requests: number
    readonly repos: number
    readonly review_thread_messages: number
    readonly review_threads: number
    readonly thread_memory: number
    readonly viewed_files: number
    readonly walkthroughs: number
  }>(`SELECT
    (SELECT COUNT(*) FROM repos) AS repos,
    (SELECT COUNT(*) FROM pull_requests) AS pull_requests,
    (SELECT COUNT(*) FROM viewed_files) AS viewed_files,
    (SELECT COUNT(*) FROM walkthroughs) AS walkthroughs,
    (SELECT COUNT(*) FROM review_threads) AS review_threads,
    (SELECT COUNT(*) FROM review_thread_messages) AS review_thread_messages,
    (SELECT COUNT(*) FROM agent_runs) AS agent_runs,
    (SELECT COUNT(*) FROM agent_run_artifacts) AS agent_run_artifacts,
    (SELECT COUNT(*) FROM thread_memory) AS thread_memory`)
  expect(counts).toEqual({
    repos: 1,
    pull_requests: 1,
    viewed_files: 1,
    walkthroughs: 1,
    review_threads: 1,
    review_thread_messages: 3,
    agent_runs: 1,
    agent_run_artifacts: 1,
    thread_memory: 1,
  })

  const repositoryRows = yield* repositories.list()
  expect(repositoryRows).toEqual([
    expect.objectContaining({
      id: "github:byfungsi/diffdash",
      provider: "github",
      owner: "byfungsi",
      name: "diffdash",
      remoteUrl: "https://github.com/byfungsi/diffdash",
      localPath: "/fixtures/diffdash",
      isFavorite: true,
    }),
  ])

  const pullRequest = yield* database.get<PullRequestFixtureRow>(
    "SELECT * FROM pull_requests WHERE id = ?",
    ["pr-v8"],
  )
  expect(pullRequest).toEqual({
    id: "pr-v8",
    repo_id: "github:byfungsi/diffdash",
    number: 147,
    title: "Persist version 8 compatibility",
    author: "fixture-author",
    head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    base_ref: "main",
    head_ref: "fixture/v8",
    state: "OPEN",
    last_fetched_at: "2026-07-15T12:00:02.000Z",
  })

  expect(
    yield* viewedFiles.list({
      repoId: "github:byfungsi/diffdash",
      prNumber: 147,
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
  ).toEqual(["src/main/services/database.ts"])
  expect(
    yield* viewedFiles.list({
      repoId: "github:byfungsi/diffdash",
      prNumber: 147,
      headSha: "cccccccccccccccccccccccccccccccccccccccc",
    }),
  ).toEqual([])

  const walkthrough = yield* walkthroughs.get({
    repoId: "github:byfungsi/diffdash",
    reviewKey: "github:byfungsi/diffdash#147",
    baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    promptVersion: "walkthrough-v4",
  })
  expect(walkthrough).toEqual(
    expect.objectContaining({
      repoId: "github:byfungsi/diffdash",
      prNumber: 147,
      reviewKey: "github:byfungsi/diffdash#147",
      baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      promptVersion: "walkthrough-v4",
      walkthrough: expect.objectContaining({
        title: "Version 8 review path",
        summary: "Verify the persisted database graph.",
      }),
    }),
  )
  expect(
    yield* walkthroughs.get({
      repoId: "github:byfungsi/diffdash",
      reviewKey: "github:byfungsi/diffdash#147",
      baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      headSha: "cccccccccccccccccccccccccccccccccccccccc",
      promptVersion: "walkthrough-v4",
    }),
  ).toBeNull()

  const threadId = ReviewThreadId.make("thread-v8")
  const reviewKey = ReviewKey.make("github:byfungsi/diffdash#147")
  const headRevision = ReviewRevision.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  const thread = yield* threads.get(threadId)
  expect(thread.thread).toEqual(
    expect.objectContaining({
      id: threadId,
      repoId: "github:byfungsi/diffdash",
      reviewKey: "github:byfungsi/diffdash#147",
      anchorStatus: "active",
      currentAnchor: expect.objectContaining({
        _tag: "line",
        filePath: "src/main/services/database.ts",
        lineNumber: 1,
      }),
    }),
  )
  expect(
    thread.messages.map(({ author, bodyMarkdown, sequence, status, agentRunId }) => ({
      author,
      bodyMarkdown,
      sequence,
      status,
      agentRunId,
    })),
  ).toEqual([
    {
      author: "user",
      bodyMarkdown: "Why must this survive restart?",
      sequence: 1,
      status: "complete",
      agentRunId: null,
    },
    {
      author: "agent",
      bodyMarkdown: "SQLite retains the thread and its related records.",
      sequence: 2,
      status: "complete",
      agentRunId: "run-v8",
    },
    {
      author: "user",
      bodyMarkdown: "Confirm it still exists after reopening.",
      sequence: 3,
      status: "complete",
      agentRunId: null,
    },
  ])
  expect(
    (yield* threads.listForReview({
      repoId: "github:byfungsi/diffdash",
      reviewKey,
    })).map(({ id }) => id),
  ).toEqual([threadId])
  expect(
    (yield* threads.listForRevision({
      repoId: "github:byfungsi/diffdash",
      reviewKey,
      headRevision,
    })).map(({ id }) => id),
  ).toEqual([threadId])

  const runId = AgentRunId.make("run-v8")
  expect(yield* runs.get(runId)).toEqual(
    expect.objectContaining({
      id: runId,
      threadId,
      provider: "claude",
      model: "claude-sonnet-4",
      promptVersion: "thread-v1",
      status: "completed",
      providerRunId: "claude-session-v8",
      usage: {
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: 20,
        cacheWriteTokens: null,
        costUsd: 0.0042,
      },
    }),
  )
  expect((yield* runs.listForThread(threadId)).map(({ id }) => id)).toEqual([runId])

  const artifactId = ReviewAgentArtifactId.make("artifact-v8")
  expect(yield* artifacts.get(artifactId)).toEqual(
    expect.objectContaining({
      id: artifactId,
      runId,
      threadId,
      artifact: {
        type: "file_read",
        provider: "claude",
        title: "Read database.ts",
        content: "fixture",
        contentDigest: "sha256:fixture-v8",
        metadata: {
          path: "src/main/services/database.ts",
          sourceProvider: "claude",
        },
        truncated: false,
        originalSize: 7,
      },
    }),
  )
  expect((yield* artifacts.listForRun(runId)).map(({ id }) => id)).toEqual([artifactId])
  expect((yield* artifacts.listForThread(threadId)).map(({ id }) => id)).toEqual([artifactId])

  expect(yield* memory.get(threadId)).toEqual(
    expect.objectContaining({
      threadId,
      summary: "The discussion verifies version-8 persistence across reopen.",
      summarizedThroughSequence: 3,
      summaryAlgorithm: "deterministic-transcript",
      summaryVersion: 1,
      importantArtifactIds: [artifactId],
    }),
  )
})

const createLegacyDatabase = (databasePath: string) => {
  const sqlite = new BetterSqlite3(databasePath)
  sqlite.exec(`
    CREATE TABLE repos (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      remote_url TEXT NOT NULL,
      local_path TEXT,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      last_opened_at TEXT,
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider, owner, name)
    );

    CREATE TABLE walkthroughs (
      repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      pr_number INTEGER,
      review_key TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(repo_id, review_key, head_sha, prompt_version)
    );

    INSERT INTO repos VALUES (
      'github:fungsi/diffdash', 'github', 'fungsi', 'diffdash',
      'https://github.com/fungsi/diffdash', NULL, 0, NULL, NULL,
      '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'
    );

    INSERT INTO walkthroughs VALUES (
      'github:fungsi/diffdash', 51, 'github:fungsi/diffdash#51', 'legacy-head',
      'walkthrough-v1', '{"title":"Legacy"}', '2026-07-12T00:00:00.000Z'
    );
  `)
  sqlite.close()
}

const createInterruptedLegacyDatabase = (databasePath: string) => {
  createLegacyDatabase(databasePath)
  const sqlite = new BetterSqlite3(databasePath)
  sqlite.exec(`
    ALTER TABLE walkthroughs RENAME TO walkthroughs_without_base_sha;
    UPDATE walkthroughs_without_base_sha
    SET head_sha = 'interrupted-head', content_json = '{"title":"Interrupted"}';
  `)
  sqlite.close()
}

const createVersion3ThreadMemoryDatabase = (databasePath: string) => {
  const sqlite = new BetterSqlite3(databasePath)
  sqlite.exec(`
    CREATE TABLE review_threads (id TEXT PRIMARY KEY);
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_run_id TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE thread_memory (
      thread_id TEXT PRIMARY KEY REFERENCES review_threads(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      important_artifact_ids_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO review_threads VALUES ('thread-76');
    INSERT INTO thread_memory VALUES (
      'thread-76', 'Existing v3 summary', '[]', '2026-07-12T00:00:00.000Z'
    );
    PRAGMA user_version = 3;
  `)
  sqlite.close()
}

const createVersion4AgentRunsDatabase = (databasePath: string) => {
  const sqlite = new BetterSqlite3(databasePath)
  sqlite.exec(`
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_run_id TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    INSERT INTO agent_runs VALUES (
      'run-72', 'thread-72', 'claude', 'claude-sonnet-4', 'thread-v1',
      'completed', NULL, NULL, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:01.000Z'
    );
    PRAGMA user_version = 4;
  `)
  sqlite.close()
}
