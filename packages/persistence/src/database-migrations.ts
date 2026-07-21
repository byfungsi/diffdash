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
    provider TEXT NOT NULL,
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
  {
    version: 9,
    migrate: (database) => {
      if (!tableExists(database, "agent_runs")) return
      database.exec(`
        DROP TABLE IF EXISTS agent_run_artifacts_v9;
        DROP TABLE IF EXISTS agent_runs_v9;

        CREATE TABLE agent_runs_v9 (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
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

        INSERT INTO agent_runs_v9 (
          id, thread_id, provider, model, prompt_version, status, provider_run_id, error,
          started_at, completed_at, usage_json
        )
        SELECT
          id, thread_id, provider, model, prompt_version, status, provider_run_id, error,
          started_at, completed_at, usage_json
        FROM agent_runs;

        CREATE TABLE agent_run_artifacts_v9 (
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
          FOREIGN KEY(run_id, thread_id) REFERENCES agent_runs_v9(id, thread_id) ON DELETE CASCADE
        );

        INSERT INTO agent_run_artifacts_v9 (
          id, run_id, thread_id, type, title, content, content_digest, metadata_json,
          truncated, original_size, created_at
        )
        SELECT
          id, run_id, thread_id, type, title, content, content_digest, metadata_json,
          truncated, original_size, created_at
        FROM agent_run_artifacts;

        DROP TABLE agent_run_artifacts;
        DROP TABLE agent_runs;
        ALTER TABLE agent_runs_v9 RENAME TO agent_runs;
        ALTER TABLE agent_run_artifacts_v9 RENAME TO agent_run_artifacts;

        CREATE INDEX agent_runs_thread_idx
          ON agent_runs(thread_id, started_at DESC, id);
        CREATE INDEX agent_run_artifacts_run_idx
          ON agent_run_artifacts(run_id, created_at ASC, id);
        CREATE INDEX agent_run_artifacts_thread_idx
          ON agent_run_artifacts(thread_id, created_at ASC, id);
      `)
    },
  },
  {
    version: 10,
    migrate: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS hosted_viewed_files (
          repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
          pr_number INTEGER NOT NULL,
          base_ref_name TEXT NOT NULL,
          review_key TEXT NOT NULL,
          patch_hash TEXT NOT NULL,
          viewed_at TEXT NOT NULL,
          PRIMARY KEY (repo_id, pr_number, base_ref_name, review_key, patch_hash)
        );

        CREATE TABLE IF NOT EXISTS local_viewed_files (
          repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
          source_identity TEXT NOT NULL,
          comparison_kind TEXT NOT NULL CHECK (comparison_kind IN ('workingTree', 'branch')),
          comparison_target TEXT NOT NULL,
          review_key TEXT NOT NULL,
          patch_hash TEXT NOT NULL,
          viewed_at TEXT NOT NULL,
          PRIMARY KEY (
            repo_id, source_identity, comparison_kind, comparison_target, review_key, patch_hash
          )
        );

        DROP TABLE IF EXISTS viewed_files;
      `)
    },
  },
  {
    version: 11,
    migrate: (database) => {
      if (!tableExists(database, "agent_runs")) return
      const interrupted = "The previous local agent run was interrupted."
      database
        .prepare(
          `UPDATE review_thread_messages
           SET body_markdown = ?, status = 'failed', updated_at = ?
           WHERE author = 'agent' AND status = 'pending'`,
        )
        .run(interrupted, new Date().toISOString())
      database
        .prepare(
          `UPDATE agent_runs
           SET status = 'failed', error = ?, completed_at = ?
           WHERE status = 'running'`,
        )
        .run(interrupted, new Date().toISOString())
      database.exec(`
        UPDATE review_thread_messages
        SET agent_run_id = NULL
        WHERE agent_run_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM agent_runs
            WHERE agent_runs.id = review_thread_messages.agent_run_id
              AND agent_runs.thread_id = review_thread_messages.thread_id
          );
      `)
      database.exec(`
        DROP TABLE IF EXISTS agent_run_artifacts_v11;
        DROP TABLE IF EXISTS agent_runs_v11;
        DROP TABLE IF EXISTS review_thread_messages_v11;

        CREATE TABLE agent_runs_v11 (
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
          UNIQUE(id, thread_id),
          CHECK (
            (status = 'running' AND completed_at IS NULL AND error IS NULL) OR
            (status = 'completed' AND completed_at IS NOT NULL AND error IS NULL) OR
            (status = 'failed' AND completed_at IS NOT NULL AND error IS NOT NULL)
          )
        );

        INSERT INTO agent_runs_v11 (
          id, thread_id, review_key, base_sha, head_sha, provider, model, prompt_version,
          status, provider_run_id, error, started_at, completed_at, usage_json
        )
        SELECT
          run.id, run.thread_id, thread.review_key, thread.current_base_sha,
          thread.current_head_sha, run.provider, run.model, run.prompt_version, run.status,
          run.provider_run_id, run.error, run.started_at, run.completed_at, run.usage_json
        FROM agent_runs AS run
        INNER JOIN review_threads AS thread ON thread.id = run.thread_id;

        CREATE TABLE agent_run_artifacts_v11 (
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
          FOREIGN KEY(run_id, thread_id) REFERENCES agent_runs_v11(id, thread_id) ON DELETE CASCADE
        );

        INSERT INTO agent_run_artifacts_v11
        SELECT * FROM agent_run_artifacts;

        DROP TABLE agent_run_artifacts;
        DROP TABLE agent_runs;
        ALTER TABLE agent_runs_v11 RENAME TO agent_runs;
        ALTER TABLE agent_run_artifacts_v11 RENAME TO agent_run_artifacts;

        CREATE TABLE review_thread_messages_v11 (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          author TEXT NOT NULL CHECK (author IN ('user', 'agent')),
          body_markdown TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
          agent_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(thread_id, sequence),
          CHECK (author = 'agent' OR agent_run_id IS NULL),
          FOREIGN KEY(agent_run_id, thread_id) REFERENCES agent_runs(id, thread_id) ON DELETE CASCADE
        );

        INSERT INTO review_thread_messages_v11
        SELECT * FROM review_thread_messages;
        DROP TABLE review_thread_messages;
        ALTER TABLE review_thread_messages_v11 RENAME TO review_thread_messages;

        CREATE INDEX agent_runs_thread_idx
          ON agent_runs(thread_id, started_at DESC, id);
        CREATE UNIQUE INDEX agent_runs_one_running_per_thread_idx
          ON agent_runs(thread_id) WHERE status = 'running';
        CREATE INDEX agent_run_artifacts_run_idx
          ON agent_run_artifacts(run_id, created_at ASC, id);
        CREATE INDEX agent_run_artifacts_thread_idx
          ON agent_run_artifacts(thread_id, created_at ASC, id);
        CREATE INDEX review_thread_messages_thread_idx
          ON review_thread_messages(thread_id, sequence);
        CREATE UNIQUE INDEX review_thread_messages_one_pending_agent_per_thread_idx
          ON review_thread_messages(thread_id) WHERE author = 'agent' AND status = 'pending';
      `)
    },
  },
]

/** Highest schema version applied by DiffDash migrations. */
export const latestDatabaseSchemaVersion = () => migrations.at(-1)?.version ?? 0

/** Reads the durable SQLite schema version stored in `PRAGMA user_version`. */
export const readDatabaseUserVersion = (database: BetterSqliteDatabase) => {
  const version: unknown = database.pragma("user_version", { simple: true })
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new Error("SQLite returned an invalid user_version")
  }
  return version
}

/** Runs pending SQLite schema migrations atomically in ascending version order. */
export const runDatabaseMigrations = (database: BetterSqliteDatabase) => {
  const currentVersion = readDatabaseUserVersion(database)
  const latestVersion = latestDatabaseSchemaVersion()
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
