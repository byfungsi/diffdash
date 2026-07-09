import BetterSqlite3, { type Database as BetterSqliteDatabase } from "better-sqlite3"
import { Context, Effect, Layer, Schema } from "effect"
import { dirname } from "node:path"
import { mkdirSync } from "node:fs"

import { AppConfig } from "./app-config"

type SqlParams = readonly unknown[] | Record<string, unknown>

interface TableInfoRow {
  readonly name: string
}

/** A typed SQLite persistence failure. */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

/** Main-process SQLite service with typed Effect errors. */
export class DatabaseService extends Context.Tag("@diffdash/DatabaseService")<
  DatabaseService,
  {
    readonly get: <A>(
      sql: string,
      params?: SqlParams,
    ) => Effect.Effect<A | undefined, DatabaseError>
    readonly all: <A>(sql: string, params?: SqlParams) => Effect.Effect<readonly A[], DatabaseError>
    readonly run: (sql: string, params?: SqlParams) => Effect.Effect<void, DatabaseError>
  }
>() {
  static readonly layer = Layer.scoped(
    DatabaseService,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            mkdirSync(dirname(config.databasePath), { recursive: true })
            const database = new BetterSqlite3(config.databasePath)
            database.pragma("journal_mode = WAL")
            database.pragma("foreign_keys = ON")
            database.exec(schemaSql)
            migrateWalkthroughsBaseSha(database)
            return database
          },
          catch: (cause) => DatabaseError.make({ operation: "open", cause }),
        }),
        (database) => Effect.sync(() => database.close()),
      )

      return DatabaseService.of({
        get: <A>(sql: string, params: SqlParams = []) =>
          runStatement(db, "get", () => {
            // SAFETY: Callers choose `A` at repository boundaries immediately before parsing rows into domain types.
            return db.prepare(sql).get(params) as A | undefined
          }),
        all: <A>(sql: string, params: SqlParams = []) =>
          runStatement(db, "all", () => {
            // SAFETY: Callers choose `A` at repository boundaries immediately before parsing rows into domain types.
            return db.prepare(sql).all(params) as readonly A[]
          }),
        run: (sql: string, params: SqlParams = []) =>
          runStatement(db, "run", () => {
            db.prepare(sql).run(params)
          }),
      })
    }),
  )
}

const runStatement = <A>(_db: BetterSqliteDatabase, operation: string, execute: () => A) =>
  Effect.try({
    try: execute,
    catch: (cause) => DatabaseError.make({ operation, cause }),
  })

const schemaSql = `
CREATE TABLE IF NOT EXISTS repos (
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

CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  last_fetched_at TEXT NOT NULL,
  UNIQUE(repo_id, number)
);

CREATE TABLE IF NOT EXISTS viewed_files (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number INTEGER,
  review_key TEXT NOT NULL,
  file_path TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  viewed_at TEXT NOT NULL,
  PRIMARY KEY(repo_id, review_key, file_path, head_sha)
);

CREATE TABLE IF NOT EXISTS walkthroughs (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number INTEGER,
  review_key TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(repo_id, review_key, base_sha, head_sha, prompt_version)
);
`

const migrateWalkthroughsBaseSha = (database: BetterSqliteDatabase) => {
  const columns = database
    .prepare("PRAGMA table_info(walkthroughs)")
    .all() as readonly TableInfoRow[]
  if (columns.some((column) => column.name === "base_sha")) return

  database.exec(`
    DROP TABLE IF EXISTS walkthroughs_without_base_sha;

    ALTER TABLE walkthroughs RENAME TO walkthroughs_without_base_sha;

    CREATE TABLE walkthroughs (
      repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      pr_number INTEGER,
      review_key TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(repo_id, review_key, base_sha, head_sha, prompt_version)
    );

    INSERT INTO walkthroughs (
      repo_id, pr_number, review_key, base_sha, head_sha, prompt_version, content_json, created_at
    )
    SELECT repo_id, pr_number, review_key, head_sha, head_sha, prompt_version, content_json, created_at
    FROM walkthroughs_without_base_sha;

    DROP TABLE walkthroughs_without_base_sha;
  `)
}
