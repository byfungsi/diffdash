import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"

import { makeDatabase } from "./database"
import * as DatabaseNode from "./database-node"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const MigratedRows = Schema.Struct({
  run_status: Schema.Literal("interrupted"),
  completed_at: Schema.String,
  error: Schema.Null,
  message_status: Schema.Literal("failed"),
  body_markdown: Schema.String,
})

const makeLegacyDatabase = () => {
  const directory = mkdtempSync(join(tmpdir(), "diffdash-agent-run-migration-"))
  const path = join(directory, "test.sqlite")
  const database = new DatabaseSync(path)
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE review_threads (id TEXT PRIMARY KEY);
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
      review_key TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      provider_run_id TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      usage_json TEXT,
      UNIQUE(id, thread_id)
    );
    CREATE TABLE agent_run_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      truncated INTEGER NOT NULL,
      original_size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id, thread_id) REFERENCES agent_runs(id, thread_id) ON DELETE CASCADE
    );
    CREATE TABLE review_thread_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      author TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      status TEXT NOT NULL,
      agent_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      failure_json TEXT,
      UNIQUE(thread_id, sequence),
      FOREIGN KEY(agent_run_id, thread_id) REFERENCES agent_runs(id, thread_id) ON DELETE CASCADE
    );
    INSERT INTO review_threads VALUES ('thread-1');
    INSERT INTO agent_runs VALUES (
      'run-1', 'thread-1', 'review-1', 'base', 'head', 'fixture', 'model',
      'prompt-v1', 'running', NULL, NULL, '2026-08-16T00:00:00.000Z', NULL, NULL
    );
    INSERT INTO review_thread_messages VALUES (
      'message-1', 'thread-1', 1, 'agent', '', 'pending', 'run-1',
      '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z', NULL
    );
    PRAGMA user_version = 13;
  `)
  database.close()
  return { directory, path }
}

describe("agent run lifecycle migration", () => {
  it.effect("atomically converts abandoned v13 runs and responses to interrupted terminals", () =>
    Effect.acquireUseRelease(
      Effect.sync(makeLegacyDatabase),
      ({ path }) =>
        Effect.gen(function* () {
          const database = makeDatabase(yield* SqlClient.SqlClient)
          const row = yield* database.get(`SELECT
            run.status AS run_status,
            run.completed_at,
            run.error,
            message.status AS message_status,
            message.body_markdown
          FROM agent_runs AS run
          INNER JOIN review_thread_messages AS message ON message.agent_run_id = run.id
          WHERE run.id = 'run-1'`)
          const migrated = yield* Schema.decodeUnknownEffect(MigratedRows)(Option.getOrThrow(row))

          expect(migrated.completed_at).toMatch(/^2026-|^20\d\d-/u)
          expect(migrated.body_markdown).toContain("interrupted")
        }).pipe(Effect.provide(DatabaseNode.layer(path))),
      ({ directory }) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
    ),
  )
})
