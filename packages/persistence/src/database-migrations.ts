import { Effect, Option, Predicate } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"

import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import { type Database, DatabaseError } from "./database"

interface TableInfoRow {
  readonly name: string
}

interface DatabaseMigration {
  readonly version: number
  readonly migrate: (database: Database) => Effect.Effect<void, SqlError | DatabaseError>
}

const MAX_SUPPORTED_DATABASE_SCHEMA_VERSION = 14
const REPOSITORY_IDENTITY_CAPABILITY = "repository-identity"
const REPOSITORY_IDENTITY_CAPABILITY_VERSION = 1
const REVIEW_PROVIDER_FAILURE_CAPABILITY = "review-provider-failure"
const REVIEW_PROVIDER_FAILURE_CAPABILITY_VERSION = 1
const REVIEW_MESSAGE_RUN_OWNERSHIP_CAPABILITY = "review-message-run-ownership"
const REVIEW_MESSAGE_RUN_OWNERSHIP_CAPABILITY_VERSION = 1
const WALKTHROUGH_OPERATION_ACCEPTANCE_CAPABILITY = "walkthrough-operation-acceptance"
const WALKTHROUGH_OPERATION_ACCEPTANCE_CAPABILITY_VERSION = 1
const RESOURCE_CATALOG_CAPABILITY = "resource-catalog"
const RESOURCE_CATALOG_CAPABILITY_VERSION = 1
const SNAPSHOT_BLOCK_STORAGE_CAPABILITY = "snapshot-block-storage"
const SNAPSHOT_BLOCK_STORAGE_CAPABILITY_VERSION = 1
const REVIEW_SNAPSHOT_DESCRIPTOR_CAPABILITY = "review-snapshot-descriptor"
const REVIEW_SNAPSHOT_DESCRIPTOR_CAPABILITY_VERSION = 1
const CORE_DURABLE_COMMAND_CAPABILITY = "core-durable-command"
const CORE_DURABLE_COMMAND_CAPABILITY_VERSION = 1
const PROJECT_WORKSPACE_CODE_RIBBON_CAPABILITY = "project-workspace-code-ribbon"
const PROJECT_WORKSPACE_CODE_RIBBON_CAPABILITY_VERSION = 1
const PROJECT_WORKSPACE_ACTIVITY_SELECTION_CAPABILITY = "project-workspace-activity-selection"
const PROJECT_WORKSPACE_ACTIVITY_SELECTION_CAPABILITY_VERSION = 1

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
    CHECK (
      (anchor_status IN ('active', 'carried_forward') AND current_anchor_json IS NOT NULL) OR
      (anchor_status IN ('outdated', 'unresolved_anchor') AND current_anchor_json IS NULL)
    ),
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
    migrate: Effect.fn("DatabaseMigration.1")(function* (database) {
      yield* executeSqlScript(database, BASE_SCHEMA_SQL)
      yield* migrateLegacyWalkthroughs(database)
    }),
  },
  {
    version: 2,
    migrate: Effect.fn("DatabaseMigration.2")(function* (database) {
      yield* executeSqlScript(
        database,
        `
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
      `,
      )
    }),
  },
  {
    version: 3,
    migrate: Effect.fn("DatabaseMigration.3")(function* (database) {
      yield* executeSqlScript(
        database,
        `
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
      `,
      )
    }),
  },
  {
    version: 4,
    migrate: Effect.fn("DatabaseMigration.4")(function* (database) {
      yield* addColumnIfMissing(
        database,
        "thread_memory",
        "summarized_through_sequence",
        "INTEGER NOT NULL DEFAULT 0 CHECK (summarized_through_sequence >= 0)",
      )
      yield* addColumnIfMissing(
        database,
        "thread_memory",
        "summary_algorithm",
        "TEXT NOT NULL DEFAULT 'legacy'",
      )
      yield* addColumnIfMissing(
        database,
        "thread_memory",
        "summary_version",
        "INTEGER NOT NULL DEFAULT 1 CHECK (summary_version >= 1)",
      )
    }),
  },
  {
    version: 5,
    migrate: Effect.fn("DatabaseMigration.5")(function* (database) {
      yield* addColumnIfMissing(database, "agent_runs", "usage_json", "TEXT")
    }),
  },
  {
    version: 6,
    migrate: Effect.fn("DatabaseMigration.6")(function* (database) {
      if (!(yield* tableExists(database, "review_threads"))) return
      const columns = yield* tableColumns(database, "review_threads")
      const hasOriginalAnchor = columns.some((column) => column.name === "original_anchor_json")
      const hasCurrentAnchor = columns.some((column) => column.name === "current_anchor_json")
      if (!hasOriginalAnchor || !hasCurrentAnchor) return
      yield* executeSqlScript(
        database,
        `
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
      `,
      )
    }),
  },
  {
    version: 7,
    migrate: Effect.fn("DatabaseMigration.7")(function* (database) {
      yield* executeSqlScript(
        database,
        `
        DROP TABLE IF EXISTS agent_run_artifacts;
        DROP TABLE IF EXISTS agent_runs;
        DROP TABLE IF EXISTS thread_memory;
        DROP TABLE IF EXISTS review_thread_messages;
        DROP TABLE IF EXISTS review_threads;
      `,
      )
      yield* executeSqlScript(database, SINGLE_LINE_THREAD_SCHEMA_SQL)
    }),
  },
  {
    version: 8,
    migrate: Effect.fn("DatabaseMigration.8")(function* (database) {
      if (!(yield* tableExists(database, "review_threads"))) return
      yield* database.run("UPDATE review_threads SET status = 'open', closed_at = NULL")
    }),
  },
  {
    version: 9,
    migrate: Effect.fn("DatabaseMigration.9")(function* (database) {
      if (!(yield* tableExists(database, "agent_runs"))) return
      yield* executeSqlScript(
        database,
        `
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
      `,
      )
    }),
  },
  {
    version: 10,
    migrate: Effect.fn("DatabaseMigration.10")(function* (database) {
      yield* executeSqlScript(
        database,
        `
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
      `,
      )
    }),
  },
  {
    version: 11,
    migrate: Effect.fn("DatabaseMigration.11")(function* (database) {
      if (!(yield* tableExists(database, "agent_runs"))) return
      const interrupted = "The previous local agent run was interrupted."
      yield* database.run(
        `UPDATE review_thread_messages
           SET body_markdown = ?, status = 'failed', updated_at = ?
           WHERE author = 'agent' AND status = 'pending'`,
        [interrupted, new Date().toISOString()],
      )
      yield* database.run(
        `UPDATE agent_runs
           SET status = 'failed', error = ?, completed_at = ?
           WHERE status = 'running'`,
        [interrupted, new Date().toISOString()],
      )
      yield* executeSqlScript(
        database,
        `
        UPDATE review_thread_messages
        SET agent_run_id = NULL
        WHERE agent_run_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM agent_runs
            WHERE agent_runs.id = review_thread_messages.agent_run_id
              AND agent_runs.thread_id = review_thread_messages.thread_id
          );
      `,
      )
      yield* executeSqlScript(
        database,
        `
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

        INSERT INTO review_thread_messages_v11 (
          id, thread_id, sequence, author, body_markdown, status, agent_run_id, created_at, updated_at
        )
        SELECT
          id, thread_id, sequence, author, body_markdown, status, agent_run_id, created_at, updated_at
        FROM review_thread_messages;
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
      `,
      )
    }),
  },
  {
    version: 12,
    migrate: Effect.fn("DatabaseMigration.12")(function* (database) {
      if (
        !(yield* tableExists(database, "repos")) ||
        !(yield* tableExists(database, "local_viewed_files"))
      )
        return
      yield* executeSqlScript(
        database,
        `
        DROP TABLE IF EXISTS local_viewed_files_v12;
        CREATE TABLE local_viewed_files_v12 (
          repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
          source_identity TEXT NOT NULL,
          comparison_kind TEXT NOT NULL CHECK (
            comparison_kind IN ('workingTree', 'branch', 'repositoryComparison')
          ),
          comparison_target TEXT NOT NULL,
          review_key TEXT NOT NULL,
          patch_hash TEXT NOT NULL,
          viewed_at TEXT NOT NULL,
          PRIMARY KEY (
            repo_id, source_identity, comparison_kind, comparison_target, review_key, patch_hash
          )
        );

        INSERT INTO local_viewed_files_v12
        SELECT * FROM local_viewed_files;
        DROP TABLE local_viewed_files;
        ALTER TABLE local_viewed_files_v12 RENAME TO local_viewed_files;
      `,
      )
    }),
  },
  {
    version: 13,
    migrate: Effect.fn("DatabaseMigration.13")(function* (database) {
      yield* executeSqlScript(
        database,
        `
        CREATE TABLE IF NOT EXISTS walkthrough_operations (
          id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
          review_key TEXT NOT NULL,
          base_sha TEXT NOT NULL,
          head_sha TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN (
            'accepted', 'running', 'completed', 'failed', 'cancelled',
            'superseded', 'interrupted'
          )),
          state_version INTEGER NOT NULL CHECK (state_version >= 1),
          regeneration_of_operation_id TEXT REFERENCES walkthrough_operations(id),
          superseded_by_operation_id TEXT REFERENCES walkthrough_operations(id),
          accepted_at TEXT NOT NULL,
          started_at TEXT,
          cancellation_requested_at TEXT,
          terminal_at TEXT,
          updated_at TEXT NOT NULL,
          failure_kind TEXT CHECK (failure_kind IN ('expected', 'internal')),
          failure_category TEXT CHECK (failure_category IN (
            'review-resolution', 'prompt-preparation', 'provider', 'validation',
            'artifact-persistence', 'operation-persistence', 'internal'
          )),
          failure_code TEXT,
          artifact_repo_id TEXT,
          artifact_review_key TEXT,
          artifact_base_sha TEXT,
          artifact_head_sha TEXT,
          artifact_prompt_version TEXT,
          FOREIGN KEY (
            artifact_repo_id, artifact_review_key, artifact_base_sha,
            artifact_head_sha, artifact_prompt_version
          ) REFERENCES walkthroughs (
            repo_id, review_key, base_sha, head_sha, prompt_version
          ) ON UPDATE CASCADE,
          CHECK (
            (failure_kind IS NULL AND failure_category IS NULL AND failure_code IS NULL) OR
            (failure_kind IS NOT NULL AND failure_category IS NOT NULL AND failure_code IS NOT NULL)
          ),
          CHECK (
            failure_code IS NULL OR (
              length(failure_code) BETWEEN 1 AND 100 AND
              failure_code GLOB '[a-z]*' AND
              failure_code NOT GLOB '*[^a-z0-9-]*' AND
              failure_code NOT GLOB '*--*' AND
              substr(failure_code, -1) <> '-'
            )
          ),
          CHECK (
            failure_kind IS NULL OR
            (failure_kind = 'internal' AND failure_category = 'internal' AND
             failure_code = 'unexpected-defect') OR
            (failure_kind = 'expected' AND failure_category <> 'internal')
          ),
          CHECK (
            (artifact_repo_id IS NULL AND artifact_review_key IS NULL AND
             artifact_base_sha IS NULL AND artifact_head_sha IS NULL AND
             artifact_prompt_version IS NULL) OR
            (artifact_repo_id IS NOT NULL AND artifact_review_key IS NOT NULL AND
             artifact_base_sha IS NOT NULL AND artifact_head_sha IS NOT NULL AND
             artifact_prompt_version IS NOT NULL)
          ),
          CHECK (
            (state = 'accepted' AND started_at IS NULL AND terminal_at IS NULL) OR
            (state = 'running' AND started_at IS NOT NULL AND terminal_at IS NULL) OR
            (state IN ('completed', 'failed', 'cancelled', 'superseded', 'interrupted') AND
             terminal_at IS NOT NULL)
          ),
          CHECK (
            (state = 'completed' AND started_at IS NOT NULL AND
             artifact_repo_id = repo_id AND artifact_review_key = review_key AND
             artifact_base_sha = base_sha AND artifact_head_sha = head_sha AND
             artifact_prompt_version = prompt_version) OR
            (state <> 'completed' AND artifact_repo_id IS NULL)
          ),
          CHECK (
            (state = 'failed' AND failure_kind IS NOT NULL) OR
            (state <> 'failed' AND failure_kind IS NULL)
          ),
          CHECK (
            (state = 'cancelled' AND cancellation_requested_at IS NOT NULL) OR
            (state <> 'cancelled' AND cancellation_requested_at IS NULL)
          ),
          CHECK (
            (state = 'superseded' AND superseded_by_operation_id IS NOT NULL) OR
            (state <> 'superseded' AND superseded_by_operation_id IS NULL)
          )
        );

        CREATE INDEX IF NOT EXISTS walkthrough_operations_identity_idx
          ON walkthrough_operations(
            repo_id, review_key, base_sha, head_sha, prompt_version,
            accepted_at DESC, id
          );

        CREATE UNIQUE INDEX IF NOT EXISTS walkthrough_operations_one_active_generation_idx
          ON walkthrough_operations(repo_id, review_key, base_sha, head_sha, prompt_version)
          WHERE state IN ('accepted', 'running');

        CREATE INDEX IF NOT EXISTS walkthrough_operations_active_idx
          ON walkthrough_operations(state, accepted_at, id)
          WHERE state IN ('accepted', 'running');

        CREATE INDEX IF NOT EXISTS walkthrough_operations_regeneration_idx
          ON walkthrough_operations(regeneration_of_operation_id)
          WHERE regeneration_of_operation_id IS NOT NULL;
      `,
      )
    }),
  },
  {
    version: 14,
    migrate: Effect.fn("DatabaseMigration.14")(function* (database) {
      if (!(yield* tableExists(database, "agent_runs"))) return
      const messageColumns = yield* tableColumns(database, "review_thread_messages")
      if (!messageColumns.some(({ name }) => name === "failure_json")) {
        yield* database.run("ALTER TABLE review_thread_messages ADD COLUMN failure_json TEXT")
      }
      yield* executeSqlScript(
        database,
        `
        DROP TABLE IF EXISTS agent_run_artifacts_v14;
        DROP TABLE IF EXISTS review_thread_messages_v14;
        DROP TABLE IF EXISTS agent_runs_v14;

        CREATE TABLE agent_runs_v14 (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
          review_key TEXT NOT NULL,
          base_sha TEXT NOT NULL,
          head_sha TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')
          ),
          provider_run_id TEXT,
          error TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          usage_json TEXT,
          UNIQUE(id, thread_id),
          CHECK (
            (status = 'running' AND completed_at IS NULL AND provider_run_id IS NULL AND
             usage_json IS NULL AND error IS NULL) OR
            (status = 'completed' AND completed_at IS NOT NULL AND error IS NULL) OR
            (status = 'failed' AND completed_at IS NOT NULL AND error IS NOT NULL AND
             usage_json IS NULL) OR
            (status IN ('cancelled', 'interrupted') AND completed_at IS NOT NULL AND
             provider_run_id IS NULL AND usage_json IS NULL AND error IS NULL)
          )
        );

        INSERT INTO agent_runs_v14 (
          id, thread_id, review_key, base_sha, head_sha, provider, model, prompt_version,
          status, provider_run_id, error, started_at, completed_at, usage_json
        )
        SELECT
          id, thread_id, review_key, base_sha, head_sha, provider, model, prompt_version,
          CASE status WHEN 'running' THEN 'interrupted' ELSE status END,
          CASE status WHEN 'running' THEN NULL ELSE provider_run_id END,
          CASE status WHEN 'running' THEN NULL ELSE error END,
          started_at,
          CASE status
            WHEN 'running' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            ELSE completed_at
          END,
          CASE status WHEN 'running' THEN NULL ELSE usage_json END
        FROM agent_runs;

        CREATE TABLE agent_run_artifacts_v14 (
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
          FOREIGN KEY(run_id, thread_id) REFERENCES agent_runs_v14(id, thread_id) ON DELETE CASCADE
        );

        INSERT INTO agent_run_artifacts_v14 SELECT * FROM agent_run_artifacts;

        CREATE TABLE review_thread_messages_v14 (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          author TEXT NOT NULL CHECK (author IN ('user', 'agent')),
          body_markdown TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
          agent_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          failure_json TEXT,
          UNIQUE(thread_id, sequence),
          CHECK (author = 'agent' OR agent_run_id IS NULL),
          FOREIGN KEY(agent_run_id, thread_id)
            REFERENCES agent_runs_v14(id, thread_id) ON DELETE CASCADE
        );

        INSERT INTO review_thread_messages_v14 (
          id, thread_id, sequence, author, body_markdown, status, agent_run_id,
          created_at, updated_at, failure_json
        )
        SELECT
          message.id, message.thread_id, message.sequence, message.author,
          CASE
            WHEN message.status = 'pending' AND run.status = 'running'
              THEN 'The previous local agent run was interrupted. Retry to try again.'
            ELSE message.body_markdown
          END,
          CASE
            WHEN message.status = 'pending' AND run.status = 'running' THEN 'failed'
            ELSE message.status
          END,
          message.agent_run_id, message.created_at,
          CASE
            WHEN message.status = 'pending' AND run.status = 'running'
              THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            ELSE message.updated_at
          END,
          message.failure_json
        FROM review_thread_messages AS message
        LEFT JOIN agent_runs AS run
          ON run.id = message.agent_run_id AND run.thread_id = message.thread_id;

        DROP TABLE review_thread_messages;
        DROP TABLE agent_run_artifacts;
        DROP TABLE agent_runs;
        ALTER TABLE agent_runs_v14 RENAME TO agent_runs;
        ALTER TABLE agent_run_artifacts_v14 RENAME TO agent_run_artifacts;
        ALTER TABLE review_thread_messages_v14 RENAME TO review_thread_messages;

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
        CREATE UNIQUE INDEX review_thread_messages_agent_run_idx
          ON review_thread_messages(agent_run_id) WHERE agent_run_id IS NOT NULL;
      `,
      )
    }),
  },
]

/** Highest core schema version written for rollback-compatible installations. */
export const latestDatabaseSchemaVersion = () => migrations.at(-1)?.version ?? 0

/** Highest historical or current schema version this build can safely open. */
export const maxSupportedDatabaseSchemaVersion = () => MAX_SUPPORTED_DATABASE_SCHEMA_VERSION

/** Reads the durable SQLite schema version stored in `PRAGMA user_version`. */
export const readDatabaseUserVersion = Effect.fn("readDatabaseUserVersion")(function* (
  database: Database,
) {
  const row = yield* database.get("PRAGMA user_version")
  const version = Option.isSome(row) ? row.value.user_version : undefined
  if (!Predicate.isNumber(version) || !Number.isInteger(version) || version < 0)
    return yield* new DatabaseError({
      operation: DiagnosticOperation.make("readUserVersion"),
      cause: new Error("SQLite returned an invalid user_version"),
    })
  return version
})

/** Runs pending SQLite schema migrations atomically in ascending version order. */
export const runDatabaseMigrations = Effect.fn("runDatabaseMigrations")(function* (
  database: Database,
) {
  const currentVersion = yield* readDatabaseUserVersion(database)
  const maxSupportedVersion = maxSupportedDatabaseSchemaVersion()
  if (currentVersion > maxSupportedVersion)
    return yield* new DatabaseError({
      operation: DiagnosticOperation.make("migrate"),
      cause: new Error(
        `Database schema version ${currentVersion} is newer than supported version ${maxSupportedVersion}`,
      ),
    })

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue
    yield* database.transaction(
      Effect.gen(function* () {
        yield* migration.migrate(database)
        yield* database.run(`PRAGMA user_version = ${migration.version}`)
      }),
    )
  }

  yield* runDatabaseCapabilityMigrations(database)
})

/** Returns whether opening this database would install core or additive capabilities. */
export const databaseRequiresMigration = Effect.fn("databaseRequiresMigration")(function* (
  database: Database,
) {
  const currentVersion = yield* readDatabaseUserVersion(database)
  if (currentVersion > maxSupportedDatabaseSchemaVersion()) return false
  return (
    currentVersion < latestDatabaseSchemaVersion() ||
    (yield* readCapabilityVersion(database, REPOSITORY_IDENTITY_CAPABILITY)) <
      REPOSITORY_IDENTITY_CAPABILITY_VERSION ||
    (yield* readCapabilityVersion(database, REVIEW_PROVIDER_FAILURE_CAPABILITY)) <
      REVIEW_PROVIDER_FAILURE_CAPABILITY_VERSION ||
    (yield* readCapabilityVersion(database, REVIEW_MESSAGE_RUN_OWNERSHIP_CAPABILITY)) <
      REVIEW_MESSAGE_RUN_OWNERSHIP_CAPABILITY_VERSION ||
    (yield* readCapabilityVersion(database, WALKTHROUGH_OPERATION_ACCEPTANCE_CAPABILITY)) <
      WALKTHROUGH_OPERATION_ACCEPTANCE_CAPABILITY_VERSION ||
    (yield* readCapabilityVersion(database, RESOURCE_CATALOG_CAPABILITY)) <
      RESOURCE_CATALOG_CAPABILITY_VERSION ||
    (yield* readCapabilityVersion(database, SNAPSHOT_BLOCK_STORAGE_CAPABILITY)) <
      SNAPSHOT_BLOCK_STORAGE_CAPABILITY_VERSION ||
    (yield* readCapabilityVersion(database, CORE_DURABLE_COMMAND_CAPABILITY)) <
      CORE_DURABLE_COMMAND_CAPABILITY_VERSION ||
    (yield* readCapabilityVersion(database, PROJECT_WORKSPACE_CODE_RIBBON_CAPABILITY)) <
      PROJECT_WORKSPACE_CODE_RIBBON_CAPABILITY_VERSION ||
    (yield* readCapabilityVersion(database, PROJECT_WORKSPACE_ACTIVITY_SELECTION_CAPABILITY)) <
      PROJECT_WORKSPACE_ACTIVITY_SELECTION_CAPABILITY_VERSION
  )
})

const runDatabaseCapabilityMigrations = Effect.fn("runDatabaseCapabilityMigrations")(function* (
  database: Database,
) {
  if (!(yield* tableExists(database, "repos"))) return
  if (
    (yield* readCapabilityVersion(database, CORE_DURABLE_COMMAND_CAPABILITY)) <
    CORE_DURABLE_COMMAND_CAPABILITY_VERSION
  ) {
    yield* database.transaction(
      Effect.gen(function* () {
        yield* executeSqlScript(
          database,
          `
          CREATE TABLE IF NOT EXISTS diffdash_capabilities (
            name TEXT PRIMARY KEY,
            version INTEGER NOT NULL CHECK (version >= 1),
            installed_at TEXT NOT NULL
          );

          CREATE TABLE core_commands (
            id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
            process_epoch TEXT NOT NULL CHECK (length(process_epoch) BETWEEN 1 AND 100),
            command_name TEXT NOT NULL CHECK (length(command_name) BETWEEN 1 AND 100),
            scope_name TEXT CHECK (scope_name IS NULL OR length(scope_name) BETWEEN 1 AND 100),
            scope_id TEXT CHECK (scope_id IS NULL OR length(scope_id) BETWEEN 1 AND 200),
            state TEXT NOT NULL CHECK (state IN ('accepted', 'committed', 'failed', 'acknowledged')),
            state_version INTEGER NOT NULL CHECK (state_version >= 1),
            accepted_at TEXT NOT NULL,
            terminal_at TEXT,
            acknowledged_at TEXT,
            CHECK ((scope_name IS NULL) = (scope_id IS NULL)),
            CHECK (
              (state = 'accepted' AND state_version = 1 AND terminal_at IS NULL AND acknowledged_at IS NULL) OR
              (state IN ('committed', 'failed') AND state_version >= 2 AND terminal_at IS NOT NULL AND acknowledged_at IS NULL) OR
              (state = 'acknowledged' AND state_version >= 3 AND terminal_at IS NOT NULL AND acknowledged_at IS NOT NULL)
            )
          );

          CREATE INDEX core_commands_unacknowledged_terminal_idx
            ON core_commands(state, terminal_at, id)
            WHERE state IN ('committed', 'failed');
          `,
        )
        const now = new Date().toISOString()
        yield* database.run(
          `INSERT INTO diffdash_capabilities (name, version, installed_at)
           VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET version = excluded.version, installed_at = excluded.installed_at`,
          [CORE_DURABLE_COMMAND_CAPABILITY, CORE_DURABLE_COMMAND_CAPABILITY_VERSION, now],
        )
      }),
    )
  }
  if (
    (yield* readCapabilityVersion(database, RESOURCE_CATALOG_CAPABILITY)) <
    RESOURCE_CATALOG_CAPABILITY_VERSION
  ) {
    yield* database.transaction(
      Effect.gen(function* () {
        yield* executeSqlScript(
          database,
          `
          CREATE TABLE IF NOT EXISTS diffdash_capabilities (
            name TEXT PRIMARY KEY,
            version INTEGER NOT NULL CHECK (version >= 1),
            installed_at TEXT NOT NULL
          );

          CREATE TABLE resource_roots (
            id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
            path TEXT NOT NULL UNIQUE CHECK (length(path) BETWEEN 1 AND 4096),
            created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
          );

          CREATE TABLE resources (
            id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
            parent_id TEXT REFERENCES resources(id) ON DELETE RESTRICT,
            kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 100),
            policy_class TEXT NOT NULL CHECK (
              policy_class IN ('durableUserData', 'cache', 'temporary', 'migrationBackup')
            ),
            state TEXT NOT NULL CHECK (
              state IN ('writing', 'ready', 'collecting', 'quarantined', 'deletionFailed', 'deleted')
            ),
            generation INTEGER NOT NULL CHECK (generation >= 1),
            location_kind TEXT NOT NULL CHECK (
              location_kind IN ('filesystem', 'gitRef', 'updaterPartial')
            ),
            root_id TEXT REFERENCES resource_roots(id) ON DELETE RESTRICT,
            location_value TEXT NOT NULL CHECK (length(location_value) BETWEEN 1 AND 4096),
            bytes INTEGER NOT NULL CHECK (bytes >= 0),
            reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
            created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
            updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
            last_used_at_ms INTEGER NOT NULL CHECK (last_used_at_ms >= created_at_ms),
            checksum TEXT,
            validation TEXT,
            recovery_token TEXT UNIQUE,
            failure TEXT,
            retry_at_ms INTEGER CHECK (retry_at_ms IS NULL OR retry_at_ms >= 0),
            CHECK (parent_id IS NULL OR parent_id <> id),
            CHECK (
              (location_kind = 'filesystem' AND root_id IS NOT NULL) OR
              (location_kind <> 'filesystem' AND root_id IS NULL)
            ),
            CHECK (
              policy_class <> 'durableUserData' OR
              (state = 'ready' AND recovery_token IS NULL AND failure IS NULL AND retry_at_ms IS NULL)
            ),
            CHECK (
              (state IN ('collecting', 'quarantined', 'deletionFailed') AND recovery_token IS NOT NULL) OR
              (state NOT IN ('collecting', 'quarantined', 'deletionFailed') AND recovery_token IS NULL)
            )
          );

          CREATE INDEX resources_parent_idx ON resources(parent_id, id);
          CREATE INDEX resources_collection_idx
            ON resources(policy_class, state, last_used_at_ms, id);

          CREATE TABLE resource_leases (
            id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
            resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
            owner_kind TEXT NOT NULL CHECK (length(owner_kind) BETWEEN 1 AND 100),
            owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
            application_instance_id TEXT NOT NULL CHECK (length(application_instance_id) BETWEEN 1 AND 100),
            process_epoch TEXT NOT NULL CHECK (length(process_epoch) BETWEEN 1 AND 100),
            acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
            renewed_at_ms INTEGER NOT NULL CHECK (renewed_at_ms >= acquired_at_ms),
            expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > renewed_at_ms),
            purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 200)
          );

          CREATE INDEX resource_leases_resource_idx
            ON resource_leases(resource_id, expires_at_ms, id);
          CREATE INDEX resource_leases_owner_idx
            ON resource_leases(application_instance_id, process_epoch, expires_at_ms);

          CREATE TABLE resource_reservations (
            id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
            resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
            bytes INTEGER NOT NULL CHECK (bytes > 0),
            state TEXT NOT NULL CHECK (state IN ('active', 'consumed', 'expired')),
            created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
            expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
            consumed_at_ms INTEGER,
            CHECK (
              (state = 'consumed' AND consumed_at_ms IS NOT NULL) OR
              (state <> 'consumed' AND consumed_at_ms IS NULL)
            )
          );

          CREATE INDEX resource_reservations_active_idx
            ON resource_reservations(resource_id, expires_at_ms, id) WHERE state = 'active';
          `,
        )
        const now = new Date().toISOString()
        yield* database.run(
          `INSERT INTO diffdash_capabilities (name, version, installed_at)
           VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             version = excluded.version,
             installed_at = excluded.installed_at`,
          [RESOURCE_CATALOG_CAPABILITY, RESOURCE_CATALOG_CAPABILITY_VERSION, now],
        )
      }),
    )
  }
  const repositoryIdentityInstalled =
    (yield* readCapabilityVersion(database, REPOSITORY_IDENTITY_CAPABILITY)) >=
    REPOSITORY_IDENTITY_CAPABILITY_VERSION
  const projectWorkspaceStateInstalled = yield* tableExists(database, "project_workspace_state")

  if (
    (yield* readCapabilityVersion(database, SNAPSHOT_BLOCK_STORAGE_CAPABILITY)) <
    SNAPSHOT_BLOCK_STORAGE_CAPABILITY_VERSION
  ) {
    yield* database.transaction(
      Effect.gen(function* () {
        yield* executeSqlScript(
          database,
          `
          CREATE TABLE review_file_deltas (
            id TEXT PRIMARY KEY,
            old_content_id TEXT NOT NULL,
            new_content_id TEXT NOT NULL,
            old_mode TEXT NOT NULL,
            new_mode TEXT NOT NULL,
            status TEXT NOT NULL,
            diff_options TEXT NOT NULL,
            diff_policy_identity TEXT NOT NULL,
            identity_version INTEGER NOT NULL CHECK (identity_version >= 1),
            UNIQUE (
              old_content_id, new_content_id, old_mode, new_mode, status,
              diff_options, diff_policy_identity, identity_version
            )
          );

          CREATE TABLE review_snapshot_manifests (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            review_key TEXT NOT NULL,
            base_revision TEXT NOT NULL,
            head_revision TEXT NOT NULL,
            semantic_identity TEXT NOT NULL,
            source_kind TEXT NOT NULL CHECK (source_kind IN ('managedSpool', 'exactGit')),
            spool_resource_id TEXT REFERENCES resources(id) ON DELETE RESTRICT,
            repository_identity TEXT,
            base_object TEXT,
            head_object TEXT,
            diff_policy_identity TEXT,
            created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
            CHECK (
              (source_kind = 'managedSpool' AND spool_resource_id IS NOT NULL AND
               repository_identity IS NULL AND base_object IS NULL AND head_object IS NULL) OR
              (source_kind = 'exactGit' AND spool_resource_id IS NULL AND
               repository_identity IS NOT NULL AND base_object IS NOT NULL AND
               head_object IS NOT NULL AND diff_policy_identity IS NOT NULL)
            )
          );

          CREATE TABLE review_snapshot_files (
            snapshot_id TEXT NOT NULL REFERENCES review_snapshot_manifests(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
            delta_id TEXT NOT NULL REFERENCES review_file_deltas(id) ON DELETE RESTRICT,
            file_id TEXT NOT NULL,
            path TEXT NOT NULL,
            old_path TEXT,
            additions INTEGER NOT NULL CHECK (additions >= 0),
            deletions INTEGER NOT NULL CHECK (deletions >= 0),
            status TEXT NOT NULL,
            visibility TEXT NOT NULL CHECK (visibility IN ('Visible', 'Hidden')),
            hidden_reason TEXT CHECK (hidden_reason IN ('binary', 'lockfile', 'vendored', 'generated')),
            patch_hash TEXT NOT NULL,
            hunk_count INTEGER NOT NULL CHECK (hunk_count >= 0),
            CHECK ((visibility = 'Visible' AND hidden_reason IS NULL) OR
                   (visibility = 'Hidden' AND hidden_reason IS NOT NULL)),
            PRIMARY KEY (snapshot_id, ordinal),
            UNIQUE (snapshot_id, file_id)
          );

          CREATE INDEX review_snapshot_files_delta_idx
            ON review_snapshot_files(delta_id, snapshot_id);

          CREATE TABLE review_hunks (
            id TEXT NOT NULL,
            delta_id TEXT NOT NULL REFERENCES review_file_deltas(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
            fingerprint TEXT NOT NULL,
            header TEXT NOT NULL,
            old_start INTEGER NOT NULL CHECK (old_start >= 0),
            old_lines INTEGER NOT NULL CHECK (old_lines >= 0),
            new_start INTEGER NOT NULL CHECK (new_start >= 0),
            new_lines INTEGER NOT NULL CHECK (new_lines >= 0),
            line_count INTEGER NOT NULL CHECK (line_count >= 0),
            PRIMARY KEY (delta_id, id),
            UNIQUE (delta_id, ordinal)
          );

          CREATE TABLE review_diff_blocks (
            id TEXT PRIMARY KEY,
            delta_id TEXT NOT NULL REFERENCES review_file_deltas(id) ON DELETE CASCADE,
            hunk_id TEXT,
            ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
            first_line INTEGER NOT NULL CHECK (first_line >= 0),
            line_count INTEGER NOT NULL CHECK (line_count > 0),
            byte_count INTEGER NOT NULL CHECK (byte_count > 0),
            checksum TEXT NOT NULL,
            resource_id TEXT NOT NULL UNIQUE REFERENCES resources(id) ON DELETE RESTRICT,
            reservation_id TEXT NOT NULL UNIQUE REFERENCES resource_reservations(id) ON DELETE RESTRICT,
            temporary_path TEXT NOT NULL,
            final_path TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK (state IN ('pending', 'ready')),
            created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
            FOREIGN KEY (delta_id, hunk_id)
              REFERENCES review_hunks(delta_id, id) ON DELETE CASCADE,
            UNIQUE (delta_id, ordinal)
          );

          CREATE INDEX review_diff_blocks_visibility_idx
            ON review_diff_blocks(delta_id, state, ordinal);

          CREATE TABLE review_block_placements (
            snapshot_id TEXT NOT NULL REFERENCES review_snapshot_manifests(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
            block_id TEXT NOT NULL REFERENCES review_diff_blocks(id) ON DELETE RESTRICT,
            PRIMARY KEY (snapshot_id, ordinal),
            UNIQUE (snapshot_id, block_id)
          );

          CREATE INDEX review_block_placements_block_idx
            ON review_block_placements(block_id, snapshot_id);

          CREATE TABLE review_snapshot_checkpoints (
            snapshot_id TEXT NOT NULL REFERENCES review_snapshot_manifests(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
            file_ordinal INTEGER NOT NULL CHECK (file_ordinal >= 0),
            hunk_ordinal INTEGER NOT NULL CHECK (hunk_ordinal >= 0),
            block_id TEXT NOT NULL REFERENCES review_diff_blocks(id) ON DELETE RESTRICT,
            byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
            line_offset INTEGER NOT NULL CHECK (line_offset >= 0),
            PRIMARY KEY (snapshot_id, ordinal)
          );
          `,
        )
        const now = new Date().toISOString()
        yield* database.run(
          `INSERT INTO diffdash_capabilities (name, version, installed_at)
           VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET version = excluded.version, installed_at = excluded.installed_at`,
          [SNAPSHOT_BLOCK_STORAGE_CAPABILITY, SNAPSHOT_BLOCK_STORAGE_CAPABILITY_VERSION, now],
        )
      }),
    )
  }

  if (
    (yield* readCapabilityVersion(database, REVIEW_SNAPSHOT_DESCRIPTOR_CAPABILITY)) <
    REVIEW_SNAPSHOT_DESCRIPTOR_CAPABILITY_VERSION
  ) {
    yield* database.transaction(
      Effect.gen(function* () {
        yield* database.run("ALTER TABLE review_snapshot_manifests ADD COLUMN descriptor_json TEXT")
        const now = new Date().toISOString()
        yield* database.run(
          `INSERT INTO diffdash_capabilities (name, version, installed_at)
           VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET version = excluded.version, installed_at = excluded.installed_at`,
          [
            REVIEW_SNAPSHOT_DESCRIPTOR_CAPABILITY,
            REVIEW_SNAPSHOT_DESCRIPTOR_CAPABILITY_VERSION,
            now,
          ],
        )
      }),
    )
  }

  if (!repositoryIdentityInstalled)
    yield* database.transaction(
      Effect.gen(function* () {
        yield* executeSqlScript(
          database,
          `
      CREATE TABLE IF NOT EXISTS diffdash_capabilities (
        name TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 1),
        installed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_workspace_state (
        repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
        active_surface TEXT NOT NULL CHECK (active_surface IN ('review', 'code')),
        active_activity TEXT NOT NULL CHECK (
          length(active_activity) BETWEEN 1 AND 128
        ),
        selected_review_target_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repository_identities (
        repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        provider_repository_id TEXT,
        canonical_owner TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        resolution_state TEXT NOT NULL CHECK (resolution_state IN ('parsed', 'resolved')),
        resolved_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS repository_identities_provider_repository_idx
        ON repository_identities(provider_id, provider_repository_id)
        WHERE provider_repository_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS repository_identities_locator_idx
        ON repository_identities(
          provider_id,
          canonical_owner COLLATE NOCASE,
          canonical_name COLLATE NOCASE
        );

      CREATE TABLE IF NOT EXISTS repository_aliases (
        alias_repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
        canonical_repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        reason TEXT NOT NULL CHECK (reason IN ('checkout', 'locator', 'provider')),
        created_at TEXT NOT NULL,
        CHECK (alias_repo_id <> canonical_repo_id)
      );

      CREATE INDEX IF NOT EXISTS repository_aliases_canonical_idx
        ON repository_aliases(canonical_repo_id, alias_repo_id);

      CREATE TABLE IF NOT EXISTS repository_checkouts (
        local_path TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        remote_url TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

       CREATE INDEX IF NOT EXISTS repository_checkouts_repo_idx
         ON repository_checkouts(repo_id, last_seen_at DESC, local_path);

      CREATE TABLE IF NOT EXISTS repository_identity_jobs (
        job_name TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
        cursor_repo_id TEXT,
        error TEXT,
         updated_at TEXT NOT NULL
       );
    `,
        )

        const now = new Date().toISOString()
        yield* database.run(
          `INSERT INTO repository_identities (
           repo_id, provider_id, provider_repository_id, canonical_owner, canonical_name,
           canonical_url, resolution_state, resolved_at, updated_at
         )
         SELECT id, provider, NULL, owner, name, remote_url, 'parsed', NULL, ?
         FROM repos
         WHERE provider <> 'local'
         ON CONFLICT(repo_id) DO NOTHING`,
          [now],
        )
        yield* database.run(
          `INSERT INTO repository_checkouts (local_path, repo_id, remote_url, last_seen_at)
         SELECT local_path, id, remote_url, COALESCE(last_opened_at, updated_at)
         FROM repos
         WHERE local_path IS NOT NULL
         ORDER BY CASE WHEN provider = 'local' THEN 1 ELSE 0 END, updated_at DESC
         ON CONFLICT(local_path) DO NOTHING`,
        )
        yield* database.run(
          `INSERT INTO repository_identity_jobs (
           job_name, status, cursor_repo_id, error, updated_at
         ) VALUES ('provider-backfill', 'pending', NULL, NULL, ?)
         ON CONFLICT(job_name) DO NOTHING`,
          [now],
        )
        yield* database.run(
          `INSERT INTO diffdash_capabilities (name, version, installed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           version = excluded.version,
           installed_at = excluded.installed_at`,
          [REPOSITORY_IDENTITY_CAPABILITY, REPOSITORY_IDENTITY_CAPABILITY_VERSION, now],
        )
        if (!projectWorkspaceStateInstalled) {
          yield* database.run(
            `INSERT INTO diffdash_capabilities (name, version, installed_at)
             VALUES (?, ?, ?), (?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET
               version = excluded.version,
               installed_at = excluded.installed_at`,
            [
              PROJECT_WORKSPACE_CODE_RIBBON_CAPABILITY,
              PROJECT_WORKSPACE_CODE_RIBBON_CAPABILITY_VERSION,
              now,
              PROJECT_WORKSPACE_ACTIVITY_SELECTION_CAPABILITY,
              PROJECT_WORKSPACE_ACTIVITY_SELECTION_CAPABILITY_VERSION,
              now,
            ],
          )
        }
      }),
    )

  if (
    (yield* tableExists(database, "project_workspace_state")) &&
    (yield* readCapabilityVersion(database, PROJECT_WORKSPACE_CODE_RIBBON_CAPABILITY)) <
      PROJECT_WORKSPACE_CODE_RIBBON_CAPABILITY_VERSION
  ) {
    yield* database.transaction(
      Effect.gen(function* () {
        yield* executeSqlScript(
          database,
          `
          CREATE TABLE project_workspace_state_code_ribbon (
            repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
            active_ribbon TEXT NOT NULL CHECK (
              active_ribbon IN ('reviews', 'files', 'code', 'walkthrough', 'threads')
            ),
            selected_review_target_json TEXT,
            updated_at TEXT NOT NULL
          );

          INSERT INTO project_workspace_state_code_ribbon (
            repo_id, active_ribbon, selected_review_target_json, updated_at
          )
          SELECT repo_id, active_ribbon, selected_review_target_json, updated_at
          FROM project_workspace_state;

          DROP TABLE project_workspace_state;
          ALTER TABLE project_workspace_state_code_ribbon RENAME TO project_workspace_state;
          `,
        )
        const now = new Date().toISOString()
        yield* database.run(
          `INSERT INTO diffdash_capabilities (name, version, installed_at)
           VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             version = excluded.version,
             installed_at = excluded.installed_at`,
          [
            PROJECT_WORKSPACE_CODE_RIBBON_CAPABILITY,
            PROJECT_WORKSPACE_CODE_RIBBON_CAPABILITY_VERSION,
            now,
          ],
        )
      }),
    )
  }

  if (
    (yield* tableExists(database, "project_workspace_state")) &&
    (yield* readCapabilityVersion(database, PROJECT_WORKSPACE_ACTIVITY_SELECTION_CAPABILITY)) <
      PROJECT_WORKSPACE_ACTIVITY_SELECTION_CAPABILITY_VERSION
  ) {
    yield* database.transaction(
      Effect.gen(function* () {
        yield* executeSqlScript(
          database,
          `
          CREATE TABLE project_workspace_state_activity_selection (
            repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
            active_surface TEXT NOT NULL CHECK (active_surface IN ('review', 'code')),
            active_activity TEXT NOT NULL CHECK (
              length(active_activity) BETWEEN 1 AND 128
            ),
            selected_review_target_json TEXT,
            updated_at TEXT NOT NULL
          );

          INSERT INTO project_workspace_state_activity_selection (
            repo_id, active_surface, active_activity, selected_review_target_json, updated_at
          )
          SELECT
            repo_id,
            CASE active_ribbon WHEN 'code' THEN 'code' ELSE 'review' END,
            CASE active_ribbon
              WHEN 'reviews' THEN 'diffdash.core.reviews'
              WHEN 'files' THEN 'diffdash.core.files'
              WHEN 'code' THEN 'diffdash.core.code'
              WHEN 'walkthrough' THEN 'diffdash.core.walkthrough'
              WHEN 'threads' THEN 'diffdash.builtin.review-comments.comments'
            END,
            selected_review_target_json,
            updated_at
          FROM project_workspace_state;

          DROP TABLE project_workspace_state;
          ALTER TABLE project_workspace_state_activity_selection RENAME TO project_workspace_state;
          `,
        )
        const now = new Date().toISOString()
        yield* database.run(
          `INSERT INTO diffdash_capabilities (name, version, installed_at)
           VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET version = excluded.version, installed_at = excluded.installed_at`,
          [
            PROJECT_WORKSPACE_ACTIVITY_SELECTION_CAPABILITY,
            PROJECT_WORKSPACE_ACTIVITY_SELECTION_CAPABILITY_VERSION,
            now,
          ],
        )
      }),
    )
  }

  if (
    (yield* tableExists(database, "walkthrough_operations")) &&
    (yield* readCapabilityVersion(database, WALKTHROUGH_OPERATION_ACCEPTANCE_CAPABILITY)) <
      WALKTHROUGH_OPERATION_ACCEPTANCE_CAPABILITY_VERSION
  ) {
    yield* database.transaction(
      Effect.gen(function* () {
        yield* executeSqlScript(
          database,
          `
          CREATE TABLE IF NOT EXISTS walkthrough_operation_acceptances (
            operation_id TEXT PRIMARY KEY REFERENCES walkthrough_operations(id) ON DELETE CASCADE,
            idempotency_key TEXT NOT NULL UNIQUE CHECK (
              length(idempotency_key) BETWEEN 3 AND 128 AND
              substr(idempotency_key, 1, 2) = 'w:' AND
              substr(idempotency_key, 3, 1) GLOB '[A-Za-z0-9]' AND
              substr(idempotency_key, 3) NOT GLOB '*[^A-Za-z0-9._-]*'
            ),
            evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json))
          );
          `,
        )
        const now = new Date().toISOString()
        yield* database.run(
          `INSERT INTO diffdash_capabilities (name, version, installed_at)
           VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             version = excluded.version,
             installed_at = excluded.installed_at`,
          [
            WALKTHROUGH_OPERATION_ACCEPTANCE_CAPABILITY,
            WALKTHROUGH_OPERATION_ACCEPTANCE_CAPABILITY_VERSION,
            now,
          ],
        )
      }),
    )
  }

  if (!(yield* tableExists(database, "review_thread_messages"))) return

  yield* database.transaction(
    Effect.gen(function* () {
      const columns = yield* tableColumns(database, "review_thread_messages")
      if (!columns.some((column) => column.name === "failure_json")) {
        yield* database.run("ALTER TABLE review_thread_messages ADD COLUMN failure_json TEXT")
      }
      const legacyFailure =
        "The local review agent could not complete this response. Retry to try again."
      yield* database.run(
        `UPDATE review_thread_messages
         SET body_markdown = ?
         WHERE author = 'agent' AND status = 'failed' AND body_markdown IS NOT ?`,
        [legacyFailure, legacyFailure],
      )
      yield* database.run(
        "UPDATE agent_runs SET error = ? WHERE status = 'failed' AND error IS NOT ?",
        [legacyFailure, legacyFailure],
      )
      if (
        (yield* readCapabilityVersion(database, REVIEW_PROVIDER_FAILURE_CAPABILITY)) >=
        REVIEW_PROVIDER_FAILURE_CAPABILITY_VERSION
      ) {
        return
      }
      const now = new Date().toISOString()
      yield* database.run(
        `INSERT INTO diffdash_capabilities (name, version, installed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           version = excluded.version,
           installed_at = excluded.installed_at`,
        [REVIEW_PROVIDER_FAILURE_CAPABILITY, REVIEW_PROVIDER_FAILURE_CAPABILITY_VERSION, now],
      )
    }),
  )

  if (
    (yield* readCapabilityVersion(database, REVIEW_MESSAGE_RUN_OWNERSHIP_CAPABILITY)) <
    REVIEW_MESSAGE_RUN_OWNERSHIP_CAPABILITY_VERSION
  ) {
    yield* database.transaction(
      Effect.gen(function* () {
        const duplicate = yield* database.get(
          `SELECT 1 FROM review_thread_messages
           WHERE agent_run_id IS NOT NULL
           GROUP BY agent_run_id HAVING COUNT(*) > 1
           LIMIT 1`,
        )
        if (Option.isNone(duplicate)) {
          yield* database.run(
            `CREATE UNIQUE INDEX IF NOT EXISTS review_thread_messages_agent_run_idx
             ON review_thread_messages(agent_run_id) WHERE agent_run_id IS NOT NULL`,
          )
        }
        const now = new Date().toISOString()
        yield* database.run(
          `INSERT INTO diffdash_capabilities (name, version, installed_at)
           VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             version = excluded.version,
             installed_at = excluded.installed_at`,
          [
            REVIEW_MESSAGE_RUN_OWNERSHIP_CAPABILITY,
            REVIEW_MESSAGE_RUN_OWNERSHIP_CAPABILITY_VERSION,
            now,
          ],
        )
      }),
    )
  }
})

const readCapabilityVersion = Effect.fn("readCapabilityVersion")(function* (
  database: Database,
  name: string,
) {
  if (!(yield* tableExists(database, "diffdash_capabilities"))) return 0
  const row = yield* database.get("SELECT version FROM diffdash_capabilities WHERE name = ?", [
    name,
  ])
  const version = Option.isSome(row) ? row.value.version : undefined
  return Predicate.isNumber(version) && Number.isSafeInteger(version) ? version : 0
})

const migrateLegacyWalkthroughs = Effect.fn("migrateLegacyWalkthroughs")(function* (
  database: Database,
) {
  const hasInterruptedLegacyTable = yield* tableExists(database, "walkthroughs_without_base_sha")
  const columns = yield* tableColumns(database, "walkthroughs")
  const hasBaseSha = columns.some((column) => column.name === "base_sha")

  if (hasBaseSha) {
    if (hasInterruptedLegacyTable) {
      yield* copyLegacyWalkthroughs(database, "walkthroughs_without_base_sha", "walkthroughs")
      yield* database.run("DROP TABLE walkthroughs_without_base_sha")
    }
    return
  }

  yield* executeSqlScript(
    database,
    `
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
  `,
  )
  yield* copyLegacyWalkthroughs(database, "walkthroughs", "walkthroughs_migrated_v1")
  if (hasInterruptedLegacyTable) {
    yield* copyLegacyWalkthroughs(
      database,
      "walkthroughs_without_base_sha",
      "walkthroughs_migrated_v1",
    )
  }
  yield* executeSqlScript(
    database,
    `
    DROP TABLE walkthroughs;
    DROP TABLE IF EXISTS walkthroughs_without_base_sha;
    ALTER TABLE walkthroughs_migrated_v1 RENAME TO walkthroughs;
  `,
  )
})

const copyLegacyWalkthroughs = Effect.fn("copyLegacyWalkthroughs")(function* (
  database: Database,
  sourceTable: string,
  targetTable: string,
) {
  yield* database.run(`
    INSERT OR IGNORE INTO ${targetTable} (
      repo_id, pr_number, review_key, base_sha, head_sha, prompt_version, content_json, created_at
    )
    SELECT repo_id, pr_number, review_key, head_sha, head_sha, prompt_version, content_json, created_at
    FROM ${sourceTable}
  `)
})

const tableExists = Effect.fn("tableExists")(function* (database: Database, tableName: string) {
  return Option.isSome(
    yield* database.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [
      tableName,
    ]),
  )
})

const tableColumns = Effect.fn("tableColumns")(function* (database: Database, tableName: string) {
  const rows = yield* database.all(`PRAGMA table_info(${tableName})`)
  const columns: Array<TableInfoRow> = []
  for (const row of rows) {
    if (!Predicate.isString(row.name))
      return yield* new DatabaseError({
        operation: DiagnosticOperation.make("tableColumns"),
        cause: new Error(`SQLite returned invalid table metadata for ${tableName}`),
      })
    columns.push({ name: row.name })
  }
  return columns
})

const addColumnIfMissing = Effect.fn("addColumnIfMissing")(function* (
  database: Database,
  tableName: string,
  columnName: string,
  definition: string,
) {
  if ((yield* tableColumns(database, tableName)).some((column) => column.name === columnName))
    return
  yield* database.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
})

// Current migrations contain ordinary DDL/DML statements, not trigger bodies.
const executeSqlScript = Effect.fn("executeSqlScript")(function* (
  database: Database,
  script: string,
) {
  for (const statement of splitSqlScript(script)) yield* database.run(statement)
})

const splitSqlScript = (script: string): ReadonlyArray<string> => {
  const statements: Array<string> = []
  let start = 0
  let quote: "'" | '"' | "`" | "]" | undefined
  let lineComment = false
  let blockComment = false
  let hasContent = false

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index]
    const next = script[index + 1]

    if (lineComment) {
      if (character === "\n") lineComment = false
      continue
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote !== undefined) {
      const closing = quote
      if (character !== closing) continue
      if (next === closing) {
        index += 1
        continue
      }
      quote = undefined
      continue
    }

    if (character === "-" && next === "-") {
      lineComment = true
      index += 1
    } else if (character === "/" && next === "*") {
      blockComment = true
      index += 1
    } else if (character === "'" || character === '"' || character === "`") {
      quote = character
      hasContent = true
    } else if (character === "[") {
      quote = "]"
      hasContent = true
    } else if (character === ";") {
      const statement = script.slice(start, index).trim()
      if (hasContent) statements.push(statement)
      start = index + 1
      hasContent = false
    } else if (!/\s/u.test(character ?? "")) {
      hasContent = true
    }
  }

  const statement = script.slice(start).trim()
  if (hasContent) statements.push(statement)
  return statements
}
