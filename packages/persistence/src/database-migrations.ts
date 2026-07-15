import type { Database as BetterSqliteDatabase } from "better-sqlite3"

interface TableInfoRow {
  readonly name: string
}

interface DatabaseMigration {
  readonly version: number
  readonly migrate: (database: BetterSqliteDatabase) => void
}

const BASE_SCHEMA_SQL = `
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

const SINGLE_LINE_THREAD_SCHEMA_SQL = `
  CREATE TABLE review_threads (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    review_key TEXT NOT NULL,
    pr_number INTEGER,
    base_sha TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    current_base_sha TEXT NOT NULL,
    current_head_sha TEXT NOT NULL,
    original_anchor_json TEXT NOT NULL,
    current_anchor_json TEXT,
    anchor_status TEXT NOT NULL CHECK (
      anchor_status IN ('active', 'carried_forward', 'outdated', 'unresolved_anchor')
    ),
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    closed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(repo_id, review_key, original_anchor_json)
  );

  CREATE INDEX review_threads_review_idx
    ON review_threads(repo_id, review_key, updated_at DESC, id);

  CREATE INDEX review_threads_revision_idx
    ON review_threads(repo_id, review_key, current_head_sha, updated_at DESC, id);

  CREATE TABLE review_thread_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('user', 'agent')),
    body_markdown TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
    agent_run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(thread_id, sequence)
  );

  CREATE INDEX review_thread_messages_thread_idx
    ON review_thread_messages(thread_id, sequence);

  CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('opencode', 'codex', 'claude')),
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    provider_run_id TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    usage_json TEXT,
    UNIQUE(id, thread_id),
    CHECK (
      (status = 'running' AND completed_at IS NULL AND error IS NULL) OR
      (status = 'completed' AND completed_at IS NOT NULL AND error IS NULL) OR
      (status = 'failed' AND completed_at IS NOT NULL AND error IS NOT NULL)
    )
  );

  CREATE INDEX agent_runs_thread_idx
    ON agent_runs(thread_id, started_at DESC, id);

  CREATE TABLE agent_run_artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN (
      'file_read', 'search_result', 'shell_output', 'web_result',
      'diff_context', 'mcp_tool_result', 'provider_message', 'unknown'
    )),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
    original_size INTEGER NOT NULL CHECK (original_size >= 0),
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id, thread_id) REFERENCES agent_runs(id, thread_id) ON DELETE CASCADE
  );

  CREATE INDEX agent_run_artifacts_run_idx
    ON agent_run_artifacts(run_id, created_at ASC, id);

  CREATE INDEX agent_run_artifacts_thread_idx
    ON agent_run_artifacts(thread_id, created_at ASC, id);

  CREATE TABLE thread_memory (
    thread_id TEXT PRIMARY KEY REFERENCES review_threads(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    important_artifact_ids_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    summarized_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (summarized_through_sequence >= 0),
    summary_algorithm TEXT NOT NULL DEFAULT 'legacy',
    summary_version INTEGER NOT NULL DEFAULT 1 CHECK (summary_version >= 1)
  );
`

const migrations: readonly DatabaseMigration[] = [
  {
    version: 1,
    migrate: (database) => {
      database.exec(BASE_SCHEMA_SQL)
      migrateLegacyWalkthroughs(database)
    },
  },
  {
    version: 2,
    migrate: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS review_threads (
          id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
          review_key TEXT NOT NULL,
          pr_number INTEGER,
          base_sha TEXT NOT NULL,
          head_sha TEXT NOT NULL,
          current_base_sha TEXT NOT NULL,
          current_head_sha TEXT NOT NULL,
          original_anchor_json TEXT NOT NULL,
          current_anchor_json TEXT,
          anchor_status TEXT NOT NULL CHECK (
            anchor_status IN ('active', 'carried_forward', 'outdated', 'unresolved_anchor')
          ),
          status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
          resolved_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS review_threads_review_idx
          ON review_threads(repo_id, review_key, updated_at DESC, id);

        CREATE INDEX IF NOT EXISTS review_threads_revision_idx
          ON review_threads(repo_id, review_key, current_head_sha, updated_at DESC, id);

        CREATE TABLE IF NOT EXISTS review_thread_messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          author TEXT NOT NULL CHECK (author IN ('user', 'agent')),
          body_markdown TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
          agent_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(thread_id, sequence)
        );

        CREATE INDEX IF NOT EXISTS review_thread_messages_thread_idx
          ON review_thread_messages(thread_id, sequence);
      `)
    },
  },
  {
    version: 3,
    migrate: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS agent_runs (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
          provider TEXT NOT NULL CHECK (provider IN ('opencode', 'codex', 'claude')),
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
          provider_run_id TEXT,
          error TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE(id, thread_id),
          CHECK (
            (status = 'running' AND completed_at IS NULL AND error IS NULL) OR
            (status = 'completed' AND completed_at IS NOT NULL AND error IS NULL) OR
            (status = 'failed' AND completed_at IS NOT NULL AND error IS NOT NULL)
          )
        );

        CREATE INDEX IF NOT EXISTS agent_runs_thread_idx
          ON agent_runs(thread_id, started_at DESC, id);

        CREATE TABLE IF NOT EXISTS agent_run_artifacts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN (
            'file_read', 'search_result', 'shell_output', 'web_result',
            'diff_context', 'mcp_tool_result', 'provider_message', 'unknown'
          )),
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          content_digest TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
          original_size INTEGER NOT NULL CHECK (original_size >= 0),
          created_at TEXT NOT NULL,
          FOREIGN KEY(run_id, thread_id) REFERENCES agent_runs(id, thread_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS agent_run_artifacts_run_idx
          ON agent_run_artifacts(run_id, created_at ASC, id);

        CREATE INDEX IF NOT EXISTS agent_run_artifacts_thread_idx
          ON agent_run_artifacts(thread_id, created_at ASC, id);

        CREATE TABLE IF NOT EXISTS thread_memory (
          thread_id TEXT PRIMARY KEY REFERENCES review_threads(id) ON DELETE CASCADE,
          summary TEXT NOT NULL,
          important_artifact_ids_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
    },
  },
  {
    version: 4,
    migrate: (database) => {
      addColumnIfMissing(
        database,
        "thread_memory",
        "summarized_through_sequence",
        "INTEGER NOT NULL DEFAULT 0 CHECK (summarized_through_sequence >= 0)",
      )
      addColumnIfMissing(
        database,
        "thread_memory",
        "summary_algorithm",
        "TEXT NOT NULL DEFAULT 'legacy'",
      )
      addColumnIfMissing(
        database,
        "thread_memory",
        "summary_version",
        "INTEGER NOT NULL DEFAULT 1 CHECK (summary_version >= 1)",
      )
    },
  },
  {
    version: 5,
    migrate: (database) => {
      addColumnIfMissing(database, "agent_runs", "usage_json", "TEXT")
    },
  },
  {
    version: 6,
    migrate: (database) => {
      if (!tableExists(database, "review_threads")) return
      const columns = tableColumns(database, "review_threads")
      const hasOriginalAnchor = columns.some((column) => column.name === "original_anchor_json")
      const hasCurrentAnchor = columns.some((column) => column.name === "current_anchor_json")
      if (!hasOriginalAnchor || !hasCurrentAnchor) return
      database.exec(`
        DELETE FROM review_threads
        WHERE CASE
          WHEN json_valid(original_anchor_json) THEN json_extract(original_anchor_json, '$._tag')
          ELSE NULL
        END IS NOT 'line';

        UPDATE review_threads
        SET current_anchor_json = NULL, anchor_status = 'unresolved_anchor'
        WHERE current_anchor_json IS NOT NULL
          AND CASE
            WHEN json_valid(current_anchor_json) THEN json_extract(current_anchor_json, '$._tag')
            ELSE NULL
          END IS NOT 'line';
      `)
    },
  },
  {
    version: 7,
    migrate: (database) => {
      database.exec(`
        DROP TABLE IF EXISTS agent_run_artifacts;
        DROP TABLE IF EXISTS agent_runs;
        DROP TABLE IF EXISTS thread_memory;
        DROP TABLE IF EXISTS review_thread_messages;
        DROP TABLE IF EXISTS review_threads;
      `)
      database.exec(SINGLE_LINE_THREAD_SCHEMA_SQL)
    },
  },
  {
    version: 8,
    migrate: (database) => {
      if (!tableExists(database, "review_threads")) return
      database.exec("UPDATE review_threads SET status = 'open', closed_at = NULL")
    },
  },
]

/** Runs pending SQLite schema migrations atomically in ascending version order. */
export const runDatabaseMigrations = (database: BetterSqliteDatabase) => {
  const currentVersion = readUserVersion(database)
  const latestVersion = migrations.at(-1)?.version ?? 0
  if (currentVersion > latestVersion) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than supported version ${latestVersion}`,
    )
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue
    database.transaction(() => {
      migration.migrate(database)
      database.pragma(`user_version = ${migration.version}`)
    })()
  }
}

const readUserVersion = (database: BetterSqliteDatabase) => {
  const version: unknown = database.pragma("user_version", { simple: true })
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new Error("SQLite returned an invalid user_version")
  }
  return version
}

const migrateLegacyWalkthroughs = (database: BetterSqliteDatabase) => {
  const hasInterruptedLegacyTable = tableExists(database, "walkthroughs_without_base_sha")
  const columns = tableColumns(database, "walkthroughs")
  const hasBaseSha = columns.some((column) => column.name === "base_sha")

  if (hasBaseSha) {
    if (hasInterruptedLegacyTable) {
      copyLegacyWalkthroughs(database, "walkthroughs_without_base_sha", "walkthroughs")
      database.exec("DROP TABLE walkthroughs_without_base_sha")
    }
    return
  }

  database.exec(`
    DROP TABLE IF EXISTS walkthroughs_migrated_v1;

    CREATE TABLE walkthroughs_migrated_v1 (
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
  `)
  copyLegacyWalkthroughs(database, "walkthroughs", "walkthroughs_migrated_v1")
  if (hasInterruptedLegacyTable) {
    copyLegacyWalkthroughs(database, "walkthroughs_without_base_sha", "walkthroughs_migrated_v1")
  }
  database.exec(`
    DROP TABLE walkthroughs;
    DROP TABLE IF EXISTS walkthroughs_without_base_sha;
    ALTER TABLE walkthroughs_migrated_v1 RENAME TO walkthroughs;
  `)
}

const copyLegacyWalkthroughs = (
  database: BetterSqliteDatabase,
  sourceTable: string,
  targetTable: string,
) => {
  database.exec(`
    INSERT OR IGNORE INTO ${targetTable} (
      repo_id, pr_number, review_key, base_sha, head_sha, prompt_version, content_json, created_at
    )
    SELECT repo_id, pr_number, review_key, head_sha, head_sha, prompt_version, content_json, created_at
    FROM ${sourceTable};
  `)
}

const tableExists = (database: BetterSqliteDatabase, tableName: string) =>
  database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) !== undefined

const tableColumns = (database: BetterSqliteDatabase, tableName: string) =>
  // SAFETY: SQLite PRAGMA table_info always returns rows containing the `name` column used here.
  database.prepare(`PRAGMA table_info(${tableName})`).all() as readonly TableInfoRow[]

const addColumnIfMissing = (
  database: BetterSqliteDatabase,
  tableName: string,
  columnName: string,
  definition: string,
) => {
  if (tableColumns(database, tableName).some((column) => column.name === columnName)) return
  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
}
