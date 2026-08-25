import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ThreadMemorySummaryAlgorithm } from "@diffdash/domain/agent-run"
import {
  AgentRunId,
  ReviewAgentArtifactId,
  ReviewAgentProviderId,
  ReviewAgentProviderRunId,
  ReviewAgentUsage,
} from "@diffdash/domain/review-agent"
import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import { ReviewKey, ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { ReviewThreadId } from "@diffdash/domain/review-thread"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import { AgentRunArtifactStore, AgentRunArtifactStoreError } from "./agent-run-artifact-store"
import { DatabaseError, makeDatabase } from "./database"
import { layer as databaseNodeLayer } from "./database-node"
import { RepositoryStore } from "./repository-store"
import { ReviewThreadStore, ReviewThreadStoreError } from "./review-thread-store"
import { ReviewConversationAgentRunReuseError } from "./review-turn-row"
import { ViewedFileStore } from "./viewed-file-store"
import { WalkthroughStore, WalkthroughStoreError } from "./walkthrough-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-database-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) => databaseNodeLayer(databasePath)

const makeCompatibilityLayer = (databasePath: string) =>
  Layer.mergeAll(
    RepositoryStore.layer,
    ViewedFileStore.layer,
    WalkthroughStore.layer,
    ReviewThreadStore.layer,
    AgentRunArtifactStore.layer,
  ).pipe(Layer.provideMerge(makeLayer(databasePath)))

const ColumnNameRows = Schema.Array(Schema.Struct({ name: Schema.String }))
const CountRow = Schema.Struct({ count: Schema.Number })
const WalkthroughMigrationRow = Schema.Struct({
  base_sha: Schema.String,
  content_json: Schema.String,
  head_sha: Schema.String,
})
const JournalModeRow = Schema.Struct({ journal_mode: Schema.String })
const ForeignKeysRow = Schema.Struct({ foreign_keys: Schema.Number })
const ThreadIdRows = Schema.Array(Schema.Struct({ id: Schema.String }))
const ThreadLifecycleMigrationRow = Schema.Struct({
  closed_at: Schema.NullOr(Schema.String),
  status: Schema.String,
})
const PullRequestFixtureRow = Schema.Struct({
  author: Schema.String,
  base_ref: Schema.String,
  head_ref: Schema.String,
  head_sha: Schema.String,
  id: Schema.String,
  last_fetched_at: Schema.String,
  number: Schema.Number,
  repo_id: Schema.String,
  state: Schema.String,
  title: Schema.String,
})
const CompatibilityCountsRow = Schema.Struct({
  agent_run_artifacts: Schema.Number,
  agent_runs: Schema.Number,
  pull_requests: Schema.Number,
  repos: Schema.Number,
  review_thread_messages: Schema.Number,
  review_threads: Schema.Number,
  thread_memory: Schema.Number,
  hosted_viewed_files: Schema.Number,
  local_viewed_files: Schema.Number,
  walkthrough_operations: Schema.Number,
  walkthroughs: Schema.Number,
})
const TableSqlRow = Schema.Struct({ sql: Schema.String })
const UserVersionRow = Schema.Struct({ user_version: Schema.Number })
const IntegrityCheckRow = Schema.Struct({ integrity_check: Schema.String })
const WorkspaceStateRow = Schema.Struct({
  repo_id: Schema.String,
  active_surface: Schema.String,
  active_activity: Schema.String,
  navigation_contribution_id: Schema.String,
  navigation_location_json: Schema.String,
  updated_at: Schema.String,
})
const WorkspaceTableInfoRows = Schema.Array(
  Schema.Struct({
    cid: Schema.Number,
    name: Schema.String,
    type: Schema.String,
    notnull: Schema.Number,
    dflt_value: Schema.NullOr(Schema.String),
    pk: Schema.Number,
  }),
)
const WorkspaceForeignKeyRows = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    seq: Schema.Number,
    table: Schema.String,
    from: Schema.String,
    to: Schema.String,
    on_update: Schema.String,
    on_delete: Schema.String,
    match: Schema.String,
  }),
)
const AgentRunFixtureRow = Schema.Struct({
  id: AgentRunId,
  thread_id: ReviewThreadId,
  provider: ReviewAgentProviderId,
  model: Schema.NonEmptyString,
  prompt_version: Schema.NonEmptyString,
  review_key: ReviewKey,
  base_sha: ReviewRevision,
  head_sha: ReviewRevision,
  status: Schema.Literals(["running", "completed", "failed"]),
  provider_run_id: Schema.NullOr(ReviewAgentProviderRunId),
  usage_json: Schema.NullOr(Schema.fromJsonString(ReviewAgentUsage)),
})
const ThreadMemoryFixtureRow = Schema.Struct({
  thread_id: ReviewThreadId,
  summary: Schema.String,
  summarized_through_sequence: Schema.Int,
  summary_algorithm: ThreadMemorySummaryAlgorithm,
  summary_version: Schema.Int,
  important_artifact_ids_json: Schema.fromJsonString(Schema.Array(ReviewAgentArtifactId)),
})

const decodeColumnNameRows = Schema.decodeUnknownSync(ColumnNameRows)
const decodeCountRow = (row: Option.Option<unknown>) =>
  Schema.decodeUnknownSync(CountRow)(Option.getOrThrow(row))
const decodeWalkthroughMigrationRow = (row: Option.Option<unknown>) =>
  Schema.decodeUnknownSync(WalkthroughMigrationRow)(Option.getOrThrow(row))
const decodeJournalModeRow = (row: Option.Option<unknown>) =>
  Schema.decodeUnknownSync(JournalModeRow)(Option.getOrThrow(row))
const decodeForeignKeysRow = (row: Option.Option<unknown>) =>
  Schema.decodeUnknownSync(ForeignKeysRow)(Option.getOrThrow(row))
const decodeThreadIdRows = Schema.decodeUnknownSync(ThreadIdRows)
const decodeThreadLifecycleMigrationRow = (row: Option.Option<unknown>) =>
  Schema.decodeUnknownSync(ThreadLifecycleMigrationRow)(Option.getOrThrow(row))
const decodePullRequestFixtureRow = (row: Option.Option<unknown>) =>
  Schema.decodeUnknownSync(PullRequestFixtureRow)(Option.getOrThrow(row))
const decodeCompatibilityCountsRow = (row: Option.Option<unknown>) =>
  Schema.decodeUnknownSync(CompatibilityCountsRow)(Option.getOrThrow(row))
const decodeTableSqlRow = (row: Option.Option<unknown>) =>
  Schema.decodeUnknownSync(TableSqlRow)(Option.getOrThrow(row))
const decodeUserVersionRow = (row: Option.Option<unknown>) =>
  Schema.decodeUnknownSync(UserVersionRow)(Option.getOrThrow(row))
const decodeIntegrityCheckRow = (row: Option.Option<unknown>) =>
  Schema.decodeUnknownSync(IntegrityCheckRow)(Option.getOrThrow(row))
const decodeAgentRunFixtureRow = (row: Option.Option<unknown>) =>
  Schema.decodeUnknownSync(AgentRunFixtureRow)(Option.getOrThrow(row))
const decodeThreadMemoryFixtureRow = (row: Option.Option<unknown>) =>
  Schema.decodeUnknownSync(ThreadMemoryFixtureRow)(Option.getOrThrow(row))

describe("database-node", () => {
  it.effect("FUN-82 AC: creates and versions a fresh database", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const client: SqlClient.SqlClient = yield* SqlClient.SqlClient
        const database = makeDatabase(client)
        expect(client).toBeDefined()
        expect(client.withTransaction).toEqual(expect.any(Function))
        const tables = decodeColumnNameRows(
          yield* database.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"),
        )

        expect(tables.map(({ name }) => name)).toEqual([
          "agent_run_artifacts",
          "agent_runs",
          "core_commands",
          "diffdash_capabilities",
          "hosted_viewed_files",
          "local_viewed_files",
          "project_workspace_state",
          "pull_requests",
          "repos",
          "repository_aliases",
          "repository_checkouts",
          "repository_identities",
          "repository_identity_jobs",
          "resource_leases",
          "resource_reservations",
          "resource_roots",
          "resources",
          "review_block_placements",
          "review_diff_blocks",
          "review_file_deltas",
          "review_hunks",
          "review_snapshot_checkpoints",
          "review_snapshot_files",
          "review_snapshot_manifests",
          "review_thread_messages",
          "review_threads",
          "thread_memory",
          "walkthrough_operation_acceptances",
          "walkthrough_operations",
          "walkthroughs",
        ])
        const memoryColumns = decodeColumnNameRows(
          yield* database.all("PRAGMA table_info(thread_memory)"),
        )
        expect(memoryColumns.map(({ name }) => name)).toEqual(
          expect.arrayContaining([
            "summarized_through_sequence",
            "summary_algorithm",
            "summary_version",
          ]),
        )
        const agentRunColumns = decodeColumnNameRows(
          yield* database.all("PRAGMA table_info(agent_runs)"),
        )
        expect(agentRunColumns.map(({ name }) => name)).toEqual(
          expect.arrayContaining(["usage_json", "review_key", "base_sha", "head_sha"]),
        )
        const messageColumns = decodeColumnNameRows(
          yield* database.all("PRAGMA table_info(review_thread_messages)"),
        )
        expect(messageColumns.map(({ name }) => name)).toContain("failure_json")
        expect(
          Option.getOrThrow(
            yield* database.get("SELECT name, version FROM diffdash_capabilities WHERE name = ?", [
              "review-provider-failure",
            ]),
          ),
        ).toEqual({ name: "review-provider-failure", version: 1 })
        const turnIndexes = decodeColumnNameRows(
          yield* database.all(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name LIKE '%one_%_per_thread_idx' ORDER BY name`,
          ),
        )
        expect(turnIndexes.map(({ name }) => name)).toEqual([
          "agent_runs_one_running_per_thread_idx",
          "review_thread_messages_one_pending_agent_per_thread_idx",
        ])
        expect(
          Option.getOrThrow(
            yield* database.get(
              `SELECT name FROM sqlite_master
               WHERE type = 'index' AND name = 'review_thread_messages_agent_run_idx'`,
            ),
          ),
        ).toEqual({ name: "review_thread_messages_agent_run_idx" })
        const reviewThreadsTable = decodeTableSqlRow(
          yield* database.get(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'review_threads'",
          ),
        )
        expect(reviewThreadsTable.sql).toContain(
          "anchor_status IN ('active', 'carried_forward') AND current_anchor_json IS NOT NULL",
        )
        const workspaceTable = decodeTableSqlRow(
          yield* database.get(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_workspace_state'",
          ),
        )
        expect(workspaceTable.sql).toContain("REFERENCES repos(id) ON DELETE CASCADE")
        expect(workspaceTable.sql).toContain("active_surface IN ('review', 'code')")
        expect(workspaceTable.sql).toContain("length(active_activity) BETWEEN 1 AND 128")
        expect(workspaceTable.sql).toContain(
          "length(CAST(navigation_location_json AS BLOB)) <= 1048576",
        )
        const localViewedFilesTable = decodeTableSqlRow(
          yield* database.get(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_viewed_files'",
          ),
        )
        expect(localViewedFilesTable.sql).toContain("'repositoryComparison'")
        expect(decodeUserVersionRow(yield* database.get("PRAGMA user_version")).user_version).toBe(
          16,
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("migrates legacy workspace ribbons into source surfaces and activity IDs", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const freshSchema = yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        return {
          columns: Schema.decodeUnknownSync(WorkspaceTableInfoRows)(
            yield* database.all("PRAGMA table_info(project_workspace_state)"),
          ),
          foreignKeys: Schema.decodeUnknownSync(WorkspaceForeignKeyRows)(
            yield* database.all("PRAGMA foreign_key_list(project_workspace_state)"),
          ),
        }
      }).pipe(Effect.provide(makeLayer(`${databasePath}.fresh`)))

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* database.run(
          "DELETE FROM diffdash_capabilities WHERE name = 'project-workspace-code-ribbon'",
        )
        yield* database.run(
          "DELETE FROM diffdash_capabilities WHERE name = 'project-workspace-activity-selection'",
        )
        yield* database.run("PRAGMA user_version = 14")
        yield* database.run("DROP TABLE project_workspace_state")
        yield* database.run(`CREATE TABLE project_workspace_state (
          repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
          active_ribbon TEXT NOT NULL CHECK (
            active_ribbon IN ('reviews', 'files', 'code', 'walkthrough', 'threads')
          ),
          selected_review_target_json TEXT,
          updated_at TEXT NOT NULL
        )`)
        yield* database.run(`INSERT INTO repos (
          id, provider, owner, name, remote_url, local_path, is_favorite,
          last_opened_at, last_synced_at, created_at, updated_at
        ) VALUES
          ('repo-workspace-reviews', 'github', 'fungsi', 'workspace-reviews',
           'https://github.com/fungsi/workspace-reviews', NULL, 0, NULL, NULL,
           '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'),
          ('repo-workspace-files', 'github', 'fungsi', 'workspace-files',
           'https://github.com/fungsi/workspace-files', NULL, 0, NULL, NULL,
           '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'),
          ('repo-workspace-code', 'github', 'fungsi', 'workspace-code',
           'https://github.com/fungsi/workspace-code', NULL, 0, NULL, NULL,
           '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'),
          ('repo-workspace-walkthrough', 'github', 'fungsi', 'workspace-walkthrough',
           'https://github.com/fungsi/workspace-walkthrough', NULL, 0, NULL, NULL,
           '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'),
          ('repo-workspace-threads', 'github', 'fungsi', 'workspace-threads',
           'https://github.com/fungsi/workspace-threads', NULL, 0, NULL, NULL,
           '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`)
        yield* database.run(`INSERT INTO project_workspace_state (
          repo_id, active_ribbon, selected_review_target_json, updated_at
        ) VALUES
          ('repo-workspace-reviews', 'reviews', '{', '2026-08-20T00:00:00.000Z'),
          ('repo-workspace-files', 'files',
           '{"kind":"local","rootPath":"/workspace/files","comparison":{"_tag":"workingTree"}}',
           '2026-08-20T00:00:00.000Z'),
          ('repo-workspace-code', 'code', NULL, '2026-08-20T00:00:00.000Z'),
          ('repo-workspace-walkthrough', 'walkthrough',
           '{"kind":"repositoryComparison","repository":{"providerId":"github","namespace":"fungsi","name":"workspace-walkthrough"},"baseRef":"v1","headRef":"v2","baseSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","mergeBaseSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
           '2026-08-20T00:00:00.000Z'),
          ('repo-workspace-threads', 'threads',
           '{"kind":"hosted","review":{"repository":{"providerId":"github","namespace":"fungsi","name":"workspace-threads"},"number":42}}',
           '2026-08-20T00:00:00.000Z')`)
      }).pipe(Effect.provide(makeLayer(databasePath)))

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const workspaceTable = decodeTableSqlRow(
          yield* database.get(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_workspace_state'",
          ),
        )
        const workspaceStates = Schema.decodeUnknownSync(Schema.Array(WorkspaceStateRow))(
          yield* database.all("SELECT * FROM project_workspace_state ORDER BY repo_id"),
        )
        const migratedSchema = {
          columns: Schema.decodeUnknownSync(WorkspaceTableInfoRows)(
            yield* database.all("PRAGMA table_info(project_workspace_state)"),
          ),
          foreignKeys: Schema.decodeUnknownSync(WorkspaceForeignKeyRows)(
            yield* database.all("PRAGMA foreign_key_list(project_workspace_state)"),
          ),
        }

        expect(migratedSchema).toEqual(freshSchema)
        expect(workspaceTable.sql).toContain("active_surface IN ('review', 'code')")
        expect(workspaceTable.sql).toContain("length(active_activity) BETWEEN 1 AND 128")
        expect(workspaceTable.sql).toContain(
          "length(CAST(navigation_location_json AS BLOB)) <= 1048576",
        )
        expect(workspaceTable.sql).toContain("REFERENCES repos(id) ON DELETE CASCADE")
        expect(workspaceStates).toEqual([
          {
            repo_id: "repo-workspace-code",
            active_surface: "code",
            active_activity: "diffdash.core.code",
            navigation_contribution_id: "diffdash.builtin.code.navigation",
            navigation_location_json:
              '{"target":{"_tag":"projectHead","projectId":"repo-workspace-code"},"path":null,"revealRange":null,"fileStatuses":[],"lineChanges":[]}',
            updated_at: "2026-08-20T00:00:00.000Z",
          },
          {
            repo_id: "repo-workspace-files",
            active_surface: "review",
            active_activity: "diffdash.core.files",
            navigation_contribution_id: "diffdash.builtin.review.navigation",
            navigation_location_json:
              '{"selectedReview":{"kind":"localDiff","target":{"kind":"local","rootPath":"/workspace/files","comparison":{"_tag":"workingTree"}}}}',
            updated_at: "2026-08-20T00:00:00.000Z",
          },
          {
            repo_id: "repo-workspace-reviews",
            active_surface: "review",
            active_activity: "diffdash.core.reviews",
            navigation_contribution_id: "diffdash.builtin.review.navigation",
            navigation_location_json: '{"selectedReview":null}',
            updated_at: "2026-08-20T00:00:00.000Z",
          },
          {
            repo_id: "repo-workspace-threads",
            active_surface: "review",
            active_activity: "diffdash.builtin.review-comments.comments",
            navigation_contribution_id: "diffdash.builtin.review.navigation",
            navigation_location_json:
              '{"selectedReview":{"kind":"hosted","review":{"repository":{"providerId":"github","namespace":"fungsi","name":"workspace-threads"},"number":42}}}',
            updated_at: "2026-08-20T00:00:00.000Z",
          },
          {
            repo_id: "repo-workspace-walkthrough",
            active_surface: "review",
            active_activity: "diffdash.core.walkthrough",
            navigation_contribution_id: "diffdash.builtin.review.navigation",
            navigation_location_json:
              '{"selectedReview":{"kind":"repositoryComparison","target":{"kind":"repositoryComparison","repository":{"providerId":"github","namespace":"fungsi","name":"workspace-walkthrough"},"baseRef":"v1","headRef":"v2","baseSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","mergeBaseSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}',
            updated_at: "2026-08-20T00:00:00.000Z",
          },
        ])
        expect(
          Option.getOrThrow(
            yield* database.get(
              "SELECT version FROM diffdash_capabilities WHERE name = 'project-workspace-code-ribbon'",
            ),
          ),
        ).toEqual({ version: 1 })
        expect(
          Option.getOrThrow(
            yield* database.get(
              "SELECT version FROM diffdash_capabilities WHERE name = 'project-workspace-activity-selection'",
            ),
          ),
        ).toEqual({ version: 1 })

        yield* database.run("DELETE FROM repos WHERE id = 'repo-workspace-threads'")
        expect(
          decodeCountRow(
            yield* database.get("SELECT COUNT(*) AS count FROM project_workspace_state"),
          ).count,
        ).toBe(4)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("migrates activity-selected Code and malformed Review navigation by owner", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* database.run("PRAGMA user_version = 14")
        yield* database.run("DROP TABLE project_workspace_state")
        yield* database.run(`CREATE TABLE project_workspace_state (
          repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
          active_surface TEXT NOT NULL CHECK (active_surface IN ('review', 'code')),
          active_activity TEXT NOT NULL,
          selected_review_target_json TEXT,
          updated_at TEXT NOT NULL
        )`)
        yield* database.run(`INSERT INTO repos (
          id, provider, owner, name, remote_url, local_path, is_favorite,
          last_opened_at, last_synced_at, created_at, updated_at
        ) VALUES
          ('repo-activity-code', 'github', 'fungsi', 'activity-code',
           'https://github.com/fungsi/activity-code', NULL, 0, NULL, NULL,
           '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z'),
          ('repo-activity-review', 'github', 'fungsi', 'activity-review',
           'https://github.com/fungsi/activity-review', NULL, 0, NULL, NULL,
           '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')`)
        yield* database.run(`INSERT INTO project_workspace_state (
          repo_id, active_surface, active_activity, selected_review_target_json, updated_at
        ) VALUES
          ('repo-activity-code', 'code', 'diffdash.core.code',
           '{"kind":"hosted","review":{"repository":{"providerId":"github","namespace":"fungsi","name":"activity-code"},"number":7}}',
           '2026-08-21T00:00:00.000Z'),
          ('repo-activity-review', 'review', 'diffdash.core.reviews', '{',
           '2026-08-21T00:00:00.000Z')`)
      }).pipe(Effect.provide(makeLayer(databasePath)))

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const workspaceStates = Schema.decodeUnknownSync(Schema.Array(WorkspaceStateRow))(
          yield* database.all("SELECT * FROM project_workspace_state ORDER BY repo_id"),
        )

        expect(workspaceStates).toEqual([
          {
            repo_id: "repo-activity-code",
            active_surface: "code",
            active_activity: "diffdash.core.code",
            navigation_contribution_id: "diffdash.builtin.code.navigation",
            navigation_location_json:
              '{"target":{"_tag":"projectHead","projectId":"repo-activity-code"},"path":null,"revealRange":null,"fileStatuses":[],"lineChanges":[]}',
            updated_at: "2026-08-21T00:00:00.000Z",
          },
          {
            repo_id: "repo-activity-review",
            active_surface: "review",
            active_activity: "diffdash.core.reviews",
            navigation_contribution_id: "diffdash.builtin.review.navigation",
            navigation_location_json: '{"selectedReview":null}',
            updated_at: "2026-08-21T00:00:00.000Z",
          },
        ])
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("migrates version 15 navigation storage to a UTF-8 byte constraint", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* database.run("DROP TABLE project_workspace_state")
        yield* database.run(`CREATE TABLE project_workspace_state (
          repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
          active_surface TEXT NOT NULL CHECK (active_surface IN ('review', 'code')),
          active_activity TEXT NOT NULL CHECK (length(active_activity) BETWEEN 1 AND 128),
          navigation_contribution_id TEXT NOT NULL CHECK (
            length(navigation_contribution_id) BETWEEN 1 AND 128
          ),
          navigation_location_json TEXT NOT NULL CHECK (
            json_valid(navigation_location_json) AND length(navigation_location_json) <= 1048576
          ),
          updated_at TEXT NOT NULL
        )`)
        yield* database.run(
          `INSERT INTO repos (
          id, provider, owner, name, remote_url, local_path, is_favorite,
          last_opened_at, last_synced_at, created_at, updated_at
        ) VALUES (?, 'github', 'fungsi', 'utf8-migration', 'https://github.com/fungsi/utf8-migration',
          NULL, 0, NULL, NULL, ?, ?)`,
          ["github:fungsi/utf8-migration", "2026-08-25T00:00:00.000Z", "2026-08-25T00:00:00.000Z"],
        )
        yield* database.run(
          `INSERT INTO repos (
          id, provider, owner, name, remote_url, local_path, is_favorite,
          last_opened_at, last_synced_at, created_at, updated_at
        ) VALUES (?, 'github', 'fungsi', 'oversized', 'https://github.com/fungsi/oversized',
          NULL, 0, NULL, NULL, ?, ?)`,
          ["github:fungsi/oversized", "2026-08-25T00:00:00.000Z", "2026-08-25T00:00:00.000Z"],
        )
        yield* database.run(
          `INSERT INTO project_workspace_state (
          repo_id, active_surface, active_activity, navigation_contribution_id,
          navigation_location_json, updated_at
        ) VALUES (?, 'review', 'diffdash.core.reviews', 'diffdash.builtin.review.navigation', ?, ?)`,
          ["github:fungsi/utf8-migration", '{"payload":"🚀"}', "2026-08-25T00:00:00.000Z"],
        )
        yield* database.run(
          `INSERT INTO project_workspace_state (
          repo_id, active_surface, active_activity, navigation_contribution_id,
          navigation_location_json, updated_at
        ) VALUES (?, 'code', 'diffdash.core.code', 'example.stale.navigation', ?, ?)`,
          [
            "github:fungsi/oversized",
            JSON.stringify({ payload: "🚀".repeat(300_000) }),
            "2026-08-25T00:00:00.000Z",
          ],
        )
        yield* database.run("PRAGMA user_version = 15")
      }).pipe(Effect.provide(makeLayer(databasePath)))

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const workspaceTable = decodeTableSqlRow(
          yield* database.get(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_workspace_state'",
          ),
        )
        const states = yield* database.all("SELECT * FROM project_workspace_state ORDER BY repo_id")
        const oversizedState = Schema.decodeUnknownSync(WorkspaceStateRow)(states[0])
        const state = Schema.decodeUnknownSync(WorkspaceStateRow)(states[1])

        expect(workspaceTable.sql).toContain(
          "length(CAST(navigation_location_json AS BLOB)) <= 1048576",
        )
        expect(state.navigation_location_json).toBe('{"payload":"🚀"}')
        expect(oversizedState.navigation_contribution_id).toBe("diffdash.builtin.code.navigation")
        expect(JSON.parse(oversizedState.navigation_location_json)).toEqual({
          target: {
            _tag: "projectHead",
            projectId: "github:fungsi/oversized",
          },
          path: null,
          revealRange: null,
          fileStatuses: [],
          lineChanges: [],
        })
        expect(decodeUserVersionRow(yield* database.get("PRAGMA user_version")).user_version).toBe(
          16,
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("installs durable walkthrough acceptance evidence without bumping user_version", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* database.run("DROP TABLE walkthrough_operation_acceptances")
        yield* database.run(
          "DELETE FROM diffdash_capabilities WHERE name = 'walkthrough-operation-acceptance'",
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const acceptanceTable = decodeTableSqlRow(
          yield* database.get(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'walkthrough_operation_acceptances'",
          ),
        )

        expect(acceptanceTable.sql).toContain("idempotency_key TEXT NOT NULL UNIQUE")
        expect(acceptanceTable.sql).toContain("CHECK (json_valid(evidence_json))")
        expect(acceptanceTable.sql).toContain("ON DELETE CASCADE")
        expect(
          Option.getOrThrow(
            yield* database.get(
              "SELECT version FROM diffdash_capabilities WHERE name = 'walkthrough-operation-acceptance'",
            ),
          ),
        ).toEqual({ version: 1 })
        expect(decodeUserVersionRow(yield* database.get("PRAGMA user_version")).user_version).toBe(
          16,
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("keeps duplicate legacy run links readable while surfacing typed corruption", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))

      const sqlite = new DatabaseSync(databasePath)
      sqlite.exec(`
        DROP INDEX review_thread_messages_agent_run_idx;
        DELETE FROM diffdash_capabilities WHERE name = 'review-message-run-ownership';
        INSERT INTO repos (
          id, provider, owner, name, remote_url, local_path, is_favorite,
          last_opened_at, last_synced_at, created_at, updated_at
        ) VALUES (
          'repo-duplicate-run', 'local', 'local', 'duplicate-run', 'file:///duplicate-run',
          '/duplicate-run', 0, NULL, NULL,
          '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
        );
        INSERT INTO review_threads (
          id, repo_id, review_key, pr_number, base_sha, head_sha, current_base_sha,
          current_head_sha, original_anchor_json, current_anchor_json, anchor_status,
          status, closed_at, created_at, updated_at
        ) VALUES (
          'thread-duplicate-run', 'repo-duplicate-run', 'local:duplicate-run', NULL,
          'base', 'head', 'base', 'head',
          '{"_tag":"line","fileId":"file","filePath":"src/app.ts","oldPath":null,"hunkId":"hunk","hunkFingerprint":"fingerprint","hunkHeader":"@@ -1 +1 @@","side":"new","lineNumber":1,"lineContent":"line"}',
          '{"_tag":"line","fileId":"file","filePath":"src/app.ts","oldPath":null,"hunkId":"hunk","hunkFingerprint":"fingerprint","hunkHeader":"@@ -1 +1 @@","side":"new","lineNumber":1,"lineContent":"line"}',
          'active', 'open', NULL,
          '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
        );
        INSERT INTO agent_runs (
          id, thread_id, review_key, base_sha, head_sha, provider, model, prompt_version,
          status, provider_run_id, error, started_at, completed_at, usage_json
        ) VALUES (
          'run-duplicate', 'thread-duplicate-run', 'local:duplicate-run', 'base', 'head',
          'fixture', 'fixture-model', 'fixture-v1', 'completed', NULL, NULL,
          '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:01.000Z', NULL
        );
        INSERT INTO review_thread_messages (
          id, thread_id, sequence, author, body_markdown, status, agent_run_id,
          created_at, updated_at, failure_json
        ) VALUES
          ('message-duplicate-1', 'thread-duplicate-run', 1, 'agent', 'First', 'complete',
           'run-duplicate', '2026-08-10T00:00:01.000Z', '2026-08-10T00:00:01.000Z', NULL),
          ('message-duplicate-2', 'thread-duplicate-run', 2, 'agent', 'Second', 'complete',
           'run-duplicate', '2026-08-10T00:00:02.000Z', '2026-08-10T00:00:02.000Z', NULL);
      `)
      sqlite.close()

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const result = yield* Effect.result(
          (yield* ReviewThreadStore).get(ReviewThreadId.make("thread-duplicate-run")),
        )

        expect(
          yield* database.get(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name = 'review_thread_messages_agent_run_idx'`,
          ),
        ).toEqual(Option.none())
        expect(
          Option.getOrThrow(
            yield* database.get(
              "SELECT version FROM diffdash_capabilities WHERE name = 'review-message-run-ownership'",
            ),
          ),
        ).toEqual({ version: 1 })
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(ReviewThreadStoreError)
          expect(result.failure.cause).toBeInstanceOf(ReviewConversationAgentRunReuseError)
        }
      }).pipe(Effect.provide(makeCompatibilityLayer(databasePath)))
    }),
  )

  it.effect("upgrades version 12 with durable walkthrough operation constraints", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* database.run("DROP TABLE walkthrough_operations")
        yield* database.run("PRAGMA user_version = 12")
      }).pipe(Effect.provide(makeLayer(databasePath)))

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const operationTable = decodeTableSqlRow(
          yield* database.get(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'walkthrough_operations'",
          ),
        )
        const operationIndexes = decodeColumnNameRows(
          yield* database.all(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND tbl_name = 'walkthrough_operations' ORDER BY name`,
          ),
        )

        expect(operationTable.sql).toContain("state_version INTEGER NOT NULL CHECK")
        expect(operationTable.sql).toContain("REFERENCES repos(id) ON DELETE CASCADE")
        expect(operationTable.sql).toContain("REFERENCES walkthroughs")
        expect(operationIndexes.map(({ name }) => name)).toEqual(
          expect.arrayContaining([
            "walkthrough_operations_active_idx",
            "walkthrough_operations_identity_idx",
            "walkthrough_operations_one_active_generation_idx",
            "walkthrough_operations_regeneration_idx",
          ]),
        )
        expect(decodeUserVersionRow(yield* database.get("PRAGMA user_version")).user_version).toBe(
          16,
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-148 AC: enables WAL mode and enforces foreign keys", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const journalMode = decodeJournalModeRow(yield* database.get("PRAGMA journal_mode"))
        const foreignKeys = decodeForeignKeysRow(yield* database.get("PRAGMA foreign_keys"))
        const busyTimeout = Option.getOrThrow(yield* database.get("PRAGMA busy_timeout"))
        const orphan = yield* Effect.result(
          database.run(
            `INSERT INTO hosted_viewed_files (
              repo_id, pr_number, base_ref_name, review_key, patch_hash, viewed_at
            ) VALUES ('missing-repo', 1, 'main', 'src/orphan.ts', 'patch', '2026-07-15T00:00:00.000Z')`,
          ),
        )

        expect(journalMode.journal_mode).toBe("wal")
        expect(foreignKeys.foreign_keys).toBe(1)
        expect(busyTimeout.timeout).toBe(5_000)
        expect(Result.isFailure(orphan)).toBe(true)
        if (Result.isFailure(orphan)) expect(SqlError.isSqlError(orphan.failure)).toBe(true)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("upgrades legacy review failures to typed-safe generic records idempotently", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* database.run(`INSERT INTO repos (
          id, provider, owner, name, remote_url, local_path, is_favorite,
          last_opened_at, last_synced_at, created_at, updated_at
        ) VALUES (
          'repo-failure', 'local', 'local', 'failure', 'file:///failure', '/failure', 0,
          NULL, NULL, '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z'
        )`)
        yield* database.run(`INSERT INTO review_threads (
          id, repo_id, review_key, pr_number, base_sha, head_sha, current_base_sha,
          current_head_sha, original_anchor_json, current_anchor_json, anchor_status,
          status, closed_at, created_at, updated_at
        ) VALUES (
          'thread-failure', 'repo-failure', 'local:failure', NULL, 'base', 'head', 'base', 'head',
          '{"_tag":"line","fileId":"file","filePath":"src/app.ts","oldPath":null,"hunkId":"hunk","hunkFingerprint":"fingerprint","hunkHeader":"@@ -1 +1 @@","side":"new","lineNumber":1,"lineContent":"line"}',
          '{"_tag":"line","fileId":"file","filePath":"src/app.ts","oldPath":null,"hunkId":"hunk","hunkFingerprint":"fingerprint","hunkHeader":"@@ -1 +1 @@","side":"new","lineNumber":1,"lineContent":"line"}',
          'active', 'open', NULL, '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z'
        )`)
        yield* database.run(`INSERT INTO agent_runs (
          id, thread_id, review_key, base_sha, head_sha, provider, model, prompt_version,
          status, provider_run_id, error, started_at, completed_at, usage_json
        ) VALUES (
          'run-failure', 'thread-failure', 'local:failure', 'base', 'head', 'claude', 'model',
          'review-thread-v3', 'failed', NULL, 'private legacy provider output',
          '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:01.000Z', NULL
        )`)
        yield* database.run(`INSERT INTO review_thread_messages (
          id, thread_id, sequence, author, body_markdown, status, agent_run_id,
          created_at, updated_at, failure_json
        ) VALUES
          ('message-user', 'thread-failure', 1, 'user', 'keep this message', 'complete', NULL,
           '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z', NULL),
          ('message-failure', 'thread-failure', 2, 'agent', 'private legacy provider output',
           'failed', 'run-failure', '2026-08-06T00:00:01.000Z',
           '2026-08-06T00:00:01.000Z', NULL)`)
        yield* database.run(
          "DELETE FROM diffdash_capabilities WHERE name = 'review-provider-failure'",
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))

      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* database.run(
          "UPDATE review_thread_messages SET body_markdown = ?, failure_json = ? WHERE id = ?",
          [
            "private downgraded provider output",
            '{"version":1,"providerId":"claude","capability":"review-thread","category":"authentication","processKind":null,"exitCode":null,"signal":null,"httpStatus":null,"retryAfterSeconds":null,"resetsAt":null}',
            "message-failure",
          ],
        )
        yield* database.run("UPDATE agent_runs SET error = ? WHERE id = ?", [
          "private downgraded provider output",
          "run-failure",
        ])
      }).pipe(Effect.provide(makeLayer(databasePath)))

      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))

      const generic = "The local review agent could not complete this response. Retry to try again."
      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        expect(
          Option.getOrThrow(
            yield* database.get("SELECT body_markdown FROM review_thread_messages WHERE id = ?", [
              "message-failure",
            ]),
          ).body_markdown,
        ).toBe(generic)
        expect(
          Option.getOrThrow(
            yield* database.get("SELECT failure_json FROM review_thread_messages WHERE id = ?", [
              "message-failure",
            ]),
          ).failure_json,
        ).toContain('"category":"authentication"')
        expect(
          Option.getOrThrow(
            yield* database.get("SELECT body_markdown FROM review_thread_messages WHERE id = ?", [
              "message-user",
            ]),
          ).body_markdown,
        ).toBe("keep this message")
        expect(
          Option.getOrThrow(
            yield* database.get("SELECT error FROM agent_runs WHERE id = ?", ["run-failure"]),
          ).error,
        ).toBe(generic)
        expect(
          Option.getOrThrow(
            yield* database.get("SELECT version FROM diffdash_capabilities WHERE name = ?", [
              "review-provider-failure",
            ]),
          ).version,
        ).toBe(1)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-148 AC: enforces every version-8 durable uniqueness boundary", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      copyFileSync(resolve("src/fixtures/database-v8-populated.sqlite"), databasePath)

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* database.run(
          `INSERT INTO hosted_viewed_files
           VALUES ('github:byfungsi/diffdash', 147, 'main', 'src/main.ts', 'patch-a', '2026-07-15T00:00:00.000Z')`,
        )
        yield* database.run(
          `INSERT INTO local_viewed_files
           VALUES ('github:byfungsi/diffdash', 'branch:feature', 'branch', 'main',
             'src/main.ts', 'patch-a', '2026-07-15T00:00:00.000Z')`,
        )
        const duplicateStatements = [
          `INSERT INTO repos
           SELECT 'github:duplicate/diffdash', provider, owner, name, remote_url, local_path,
             is_favorite, last_opened_at, last_synced_at, created_at, updated_at FROM repos`,
          `INSERT INTO pull_requests
           SELECT 'pr-v8-duplicate', repo_id, number, title, author, head_sha, base_ref, head_ref,
             state, last_fetched_at FROM pull_requests`,
          "INSERT INTO hosted_viewed_files SELECT * FROM hosted_viewed_files",
          "INSERT INTO local_viewed_files SELECT * FROM local_viewed_files",
          "INSERT INTO walkthroughs SELECT * FROM walkthroughs",
          `INSERT INTO review_threads
           SELECT 'thread-v8-duplicate', repo_id, review_key, pr_number, base_sha, head_sha,
             current_base_sha, current_head_sha, original_anchor_json, current_anchor_json,
             anchor_status, status, closed_at, created_at, updated_at FROM review_threads`,
          `INSERT INTO review_thread_messages
           SELECT 'message-v8-duplicate', thread_id, sequence, author, body_markdown, status,
             agent_run_id, created_at, updated_at FROM review_thread_messages WHERE sequence = 1`,
          "INSERT INTO agent_runs SELECT * FROM agent_runs",
          "INSERT INTO agent_run_artifacts SELECT * FROM agent_run_artifacts",
          "INSERT INTO thread_memory SELECT * FROM thread_memory",
        ]

        for (const statement of duplicateStatements) {
          const result = yield* Effect.result(database.run(statement))
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) expect(SqlError.isSqlError(result.failure)).toBe(true)
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-148 AC: cascades repository deletion through the complete durable graph", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      copyFileSync(resolve("src/fixtures/database-v8-populated.sqlite"), databasePath)

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* database.run(
          `INSERT INTO hosted_viewed_files
           VALUES ('github:byfungsi/diffdash', 147, 'main', 'src/main.ts', 'patch-a', '2026-07-15T00:00:00.000Z')`,
        )
        yield* database.run(
          `INSERT INTO local_viewed_files
           VALUES ('github:byfungsi/diffdash', 'branch:feature', 'branch', 'main',
             'src/main.ts', 'patch-a', '2026-07-15T00:00:00.000Z')`,
        )
        yield* database.run("DELETE FROM repos WHERE id = ?", ["github:byfungsi/diffdash"])

        for (const table of [
          "repos",
          "pull_requests",
          "hosted_viewed_files",
          "local_viewed_files",
          "walkthrough_operations",
          "walkthroughs",
          "review_threads",
          "review_thread_messages",
          "agent_runs",
          "agent_run_artifacts",
          "thread_memory",
        ]) {
          const row = decodeCountRow(yield* database.get(`SELECT COUNT(*) AS count FROM ${table}`))
          expect(row.count).toBe(0)
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-148 AC: rejects newer database versions without mutating them", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const sqlite = new DatabaseSync(databasePath)
      sqlite.exec(
        "CREATE TABLE future_marker (value TEXT NOT NULL); INSERT INTO future_marker VALUES ('preserve-me')",
      )
      sqlite.exec("PRAGMA user_version = 17")
      sqlite.close()

      const result = yield* Effect.result(
        Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath)))),
      )
      expect(Result.isFailure(result) && result.failure).toEqual(
        expect.objectContaining<Partial<DatabaseError>>({
          _tag: "DatabaseError",
          operation: DiagnosticOperation.make("open"),
        }),
      )
      if (Result.isFailure(result)) {
        expect(String(result.failure.cause)).toContain(
          "Database schema version 17 is newer than supported version 16",
        )
      }

      const reopened = new DatabaseSync(databasePath, { readOnly: true })
      expect(reopened.prepare("PRAGMA user_version").get()).toEqual({ user_version: 17 })
      expect(reopened.prepare("SELECT value FROM future_marker").get()).toEqual({
        value: "preserve-me",
      })
      reopened.close()
    }),
  )

  it.effect("FUN-131 AC: migrates and preserves the populated version-8 agent graph", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      copyFileSync(resolve("src/fixtures/database-v8-populated.sqlite"), databasePath)

      yield* Effect.scoped(
        assertPopulatedVersion8Fixture.pipe(Effect.provide(makeCompatibilityLayer(databasePath))),
      )
      yield* Effect.scoped(
        assertPopulatedVersion8Fixture.pipe(Effect.provide(makeCompatibilityLayer(databasePath))),
      )

      const directory = resolve(databasePath, "..")
      const backups = readdirSync(directory).filter((name) => name.includes(".pre-migration-v8-"))
      expect(backups).toHaveLength(1)
      expect(existsSync(join(directory, backups[0] ?? ""))).toBe(true)
      const backupSqlite = new DatabaseSync(join(directory, backups[0] ?? ""), { readOnly: true })
      expect(backupSqlite.prepare("PRAGMA user_version").get()).toEqual({ user_version: 8 })
      expect(
        backupSqlite
          .prepare("SELECT is_favorite FROM repos WHERE id = ?")
          .get("github:byfungsi/diffdash"),
      ).toEqual({ is_favorite: 1 })
      backupSqlite.close()

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        expect(decodeUserVersionRow(yield* database.get("PRAGMA user_version")).user_version).toBe(
          16,
        )
        const agentRunsSql = decodeTableSqlRow(
          yield* database.get(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'",
          ),
        ).sql
        expect(agentRunsSql).not.toContain("provider IN")
        expect(agentRunsSql).toContain("review_key TEXT NOT NULL")
        const messagesSql = decodeTableSqlRow(
          yield* database.get(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'review_thread_messages'",
          ),
        ).sql
        expect(messagesSql).toContain("FOREIGN KEY(agent_run_id, thread_id)")
        expect(
          yield* database.all(
            `SELECT kind, policy_class, state, bytes, location_kind, location_value
             FROM resources WHERE kind = 'migrationBackup'`,
          ),
        ).toEqual([
          {
            kind: "migrationBackup",
            policy_class: "migrationBackup",
            state: "ready",
            bytes: statSync(join(directory, backups[0] ?? "")).size,
            location_kind: "filesystem",
            location_value: backups[0],
          },
        ])
        yield* database.run(
          `INSERT INTO agent_runs (
            id, thread_id, review_key, base_sha, head_sha, provider, model, prompt_version,
            status, provider_run_id, error,
            started_at, completed_at, usage_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, NULL, NULL)`,
          [
            "run-future-provider",
            "thread-v8",
            "github:byfungsi/diffdash#147",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "future-provider",
            "future-model",
            "thread-v1",
            "2026-07-16T00:00:00.000Z",
          ],
        )
        expect(
          decodeIntegrityCheckRow(yield* database.get("PRAGMA integrity_check")).integrity_check,
        ).toBe("ok")
        expect(yield* database.all("PRAGMA foreign_key_check")).toEqual([])
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-148 AC: reports a corrupt database as a typed open failure", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      writeFileSync(databasePath, "not a sqlite database")

      const result = yield* Effect.result(
        Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath)))),
      )

      expect(Result.isFailure(result) && result.failure).toEqual(
        expect.objectContaining<Partial<DatabaseError>>({
          _tag: "DatabaseError",
          operation: DiagnosticOperation.make("open"),
        }),
      )
    }),
  )

  it.effect("FUN-148 AC: reports malformed durable JSON at typed store boundaries", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      copyFileSync(resolve("src/fixtures/database-v8-populated.sqlite"), databasePath)
      const sqlite = new DatabaseSync(databasePath)
      sqlite.exec(readFileSync(resolve("src/fixtures/database-v8-malformed-json.sql"), "utf8"))
      sqlite.close()

      const results = yield* Effect.gen(function* () {
        const walkthroughs = yield* WalkthroughStore
        const threads = yield* ReviewThreadStore
        const artifacts = yield* AgentRunArtifactStore

        return {
          walkthrough: yield* Effect.result(
            walkthroughs.get({
              repoId: ReviewProjectId.make("github:byfungsi/diffdash"),
              reviewKey: ReviewKey.make("github:byfungsi/diffdash#147"),
              baseSha: ReviewRevision.make("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
              headSha: ReviewRevision.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
              promptVersion: "walkthrough-v4",
            }),
          ),
          thread: yield* Effect.result(threads.get(ReviewThreadId.make("thread-v8"))),
          artifact: yield* Effect.result(artifacts.get(ReviewAgentArtifactId.make("artifact-v8"))),
        }
      }).pipe(Effect.provide(makeCompatibilityLayer(databasePath)))

      expect(Result.isFailure(results.walkthrough) && results.walkthrough.failure).toEqual(
        expect.objectContaining<Partial<WalkthroughStoreError>>({
          _tag: "WalkthroughStoreError",
          operation: "get.decodeContent",
        }),
      )
      expect(Result.isFailure(results.thread) && results.thread.failure).toEqual(
        expect.objectContaining<Partial<ReviewThreadStoreError>>({
          _tag: "ReviewThreadStoreError",
          operation: "get",
        }),
      )
      expect(Result.isFailure(results.artifact) && results.artifact.failure).toEqual(
        expect.objectContaining<Partial<AgentRunArtifactStoreError>>({
          _tag: "AgentRunArtifactStoreError",
          operation: "get.decode",
        }),
      )
    }),
  )

  it.effect("FUN-82 AC: migrates a legacy walkthrough schema without losing data", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      createLegacyDatabase(databasePath)

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const row = decodeWalkthroughMigrationRow(
          yield* database.get("SELECT base_sha, head_sha, content_json FROM walkthroughs"),
        )

        expect(row).toEqual({
          base_sha: "legacy-head",
          content_json: '{"title":"Legacy"}',
          head_sha: "legacy-head",
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-82 AC: safely retries an already applied migration", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))
      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* database.run(
          `INSERT INTO repos (
            id, provider, owner, name, remote_url, local_path, is_favorite,
            last_opened_at, last_synced_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "github:byfungsi/diffdash",
            "github",
            "byfungsi",
            "diffdash",
            "https://github.com/byfungsi/diffdash",
            null,
            1,
            "2026-07-16T00:00:00.000Z",
            "2026-07-16T00:00:00.000Z",
            "2026-07-16T00:00:00.000Z",
            "2026-07-16T00:00:00.000Z",
          ],
        )
        yield* database.run("PRAGMA user_version = 0")
      }).pipe(Effect.provide(makeLayer(databasePath)))
      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))

      const directory = resolve(databasePath, "..")
      const backups = readdirSync(directory).filter((name) => name.includes(".pre-migration-v0-"))
      expect(backups).toHaveLength(1)
      const backupSqlite = new DatabaseSync(join(directory, backups[0] ?? ""), { readOnly: true })
      expect(backupSqlite.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 })
      expect(
        backupSqlite
          .prepare("SELECT is_favorite FROM repos WHERE id = ?")
          .get("github:byfungsi/diffdash"),
      ).toEqual({ is_favorite: 1 })
      backupSqlite.close()

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        expect(decodeUserVersionRow(yield* database.get("PRAGMA user_version")).user_version).toBe(
          16,
        )
        expect(
          Option.getOrThrow(
            yield* database.get("SELECT is_favorite FROM repos WHERE id = ?", [
              "github:byfungsi/diffdash",
            ]),
          ).is_favorite,
        ).toBe(1)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-67 AC: clears v3 thread memory during the single-thread reset", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      createVersion3ThreadMemoryDatabase(databasePath)

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const memory = yield* database.get(
          `SELECT summary, summarized_through_sequence, summary_algorithm, summary_version
           FROM thread_memory WHERE thread_id = ?`,
          ["thread-76"],
        )

        expect(Option.isNone(memory)).toBe(true)
        expect(decodeUserVersionRow(yield* database.get("PRAGMA user_version")).user_version).toBe(
          16,
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-67 AC: clears v4 agent runs during the single-thread reset", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      createVersion4AgentRunsDatabase(databasePath)

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const row = yield* database.get("SELECT id, usage_json FROM agent_runs WHERE id = ?", [
          "run-72",
        ])

        expect(Option.isNone(row)).toBe(true)
        expect(decodeUserVersionRow(yield* database.get("PRAGMA user_version")).user_version).toBe(
          16,
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-67 AC: clears all legacy thread data for the single-thread model", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))

      const sqlite = new DatabaseSync(databasePath)
      sqlite.exec("PRAGMA foreign_keys = ON")
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
          id, thread_id, review_key, base_sha, head_sha, provider, model, prompt_version,
          status, provider_run_id, error,
          started_at, completed_at, usage_json
        ) VALUES (?, ?, ?, ?, ?, 'codex', 'gpt-5', 'thread-v1',
          'completed', NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          "run-review",
          "thread-review",
          "github:fungsi/diffdash#67",
          "base-sha",
          "head-sha",
          "2026-07-12T00:00:00.000Z",
          "2026-07-12T00:00:01.000Z",
        )
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
      sqlite.exec("PRAGMA user_version = 5")
      sqlite.close()

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const threads = decodeThreadIdRows(
          yield* database.all("SELECT id FROM review_threads ORDER BY id"),
        )
        const messages = decodeCountRow(
          yield* database.get("SELECT COUNT(*) AS count FROM review_thread_messages"),
        )
        const runs = decodeCountRow(yield* database.get("SELECT COUNT(*) AS count FROM agent_runs"))
        const artifacts = decodeCountRow(
          yield* database.get("SELECT COUNT(*) AS count FROM agent_run_artifacts"),
        )
        const memory = decodeCountRow(
          yield* database.get("SELECT COUNT(*) AS count FROM thread_memory"),
        )

        expect(threads).toEqual([])
        expect(messages.count).toBe(0)
        expect(runs.count).toBe(0)
        expect(artifacts.count).toBe(0)
        expect(memory.count).toBe(0)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-67 AC: reopens threads closed by the removed lifecycle control", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))

      const sqlite = new DatabaseSync(databasePath)
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
      sqlite.exec("PRAGMA user_version = 7")
      sqlite.close()

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const thread = decodeThreadLifecycleMigrationRow(
          yield* database.get("SELECT status, closed_at FROM review_threads WHERE id = ?", [
            "thread-closed",
          ]),
        )

        expect(thread).toEqual({ status: "open", closed_at: null })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-82 AC: recovers rows left by the previous interrupted migration", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      createInterruptedLegacyDatabase(databasePath)

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const row = decodeWalkthroughMigrationRow(
          yield* database.get("SELECT base_sha, head_sha, content_json FROM walkthroughs"),
        )

        expect(row).toEqual({
          base_sha: "interrupted-head",
          content_json: '{"title":"Interrupted"}',
          head_sha: "interrupted-head",
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-82 AC: commits successful effectful transactions", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* database.transaction(
          database.run("INSERT INTO repos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
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
          ]),
        )

        const row = decodeCountRow(yield* database.get("SELECT COUNT(*) AS count FROM repos"))
        expect(row.count).toBe(1)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-82 AC: rolls back failed effectful transactions", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        yield* database
          .transaction(
            Effect.gen(function* () {
              yield* database.run("INSERT INTO repos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
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
              return yield* new DatabaseError({
                operation: DiagnosticOperation.make("test.rollback"),
                cause: new Error("rollback"),
              })
            }),
          )
          .pipe(Effect.catch(() => Effect.void))

        const row = decodeCountRow(yield* database.get("SELECT COUNT(*) AS count FROM repos"))
        expect(row.count).toBe(0)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-82 AC: rolls back failed suspended effectful transactions", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const result = yield* Effect.result(
          database.transaction(
            Effect.gen(function* () {
              yield* database.run("INSERT INTO repos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
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
              yield* Effect.yieldNow
              return yield* new DatabaseError({
                operation: DiagnosticOperation.make("test.suspendedRollback"),
                cause: new Error("rollback after suspension"),
              })
            }),
          ),
        )
        const row = decodeCountRow(yield* database.get("SELECT COUNT(*) AS count FROM repos"))

        expect(Result.isFailure(result)).toBe(true)
        expect(row.count).toBe(0)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})

const assertPopulatedVersion8Fixture = Effect.gen(function* () {
  const database = makeDatabase(yield* SqlClient.SqlClient)
  const repositories = yield* RepositoryStore
  const walkthroughs = yield* WalkthroughStore
  const threads = yield* ReviewThreadStore
  const artifacts = yield* AgentRunArtifactStore

  const counts = decodeCompatibilityCountsRow(
    yield* database.get(`SELECT
    (SELECT COUNT(*) FROM repos) AS repos,
    (SELECT COUNT(*) FROM pull_requests) AS pull_requests,
    (SELECT COUNT(*) FROM hosted_viewed_files) AS hosted_viewed_files,
    (SELECT COUNT(*) FROM local_viewed_files) AS local_viewed_files,
    (SELECT COUNT(*) FROM walkthrough_operations) AS walkthrough_operations,
    (SELECT COUNT(*) FROM walkthroughs) AS walkthroughs,
    (SELECT COUNT(*) FROM review_threads) AS review_threads,
    (SELECT COUNT(*) FROM review_thread_messages) AS review_thread_messages,
    (SELECT COUNT(*) FROM agent_runs) AS agent_runs,
    (SELECT COUNT(*) FROM agent_run_artifacts) AS agent_run_artifacts,
    (SELECT COUNT(*) FROM thread_memory) AS thread_memory`),
  )
  expect(counts).toEqual({
    repos: 1,
    pull_requests: 1,
    hosted_viewed_files: 0,
    local_viewed_files: 0,
    walkthrough_operations: 0,
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
      source: expect.objectContaining({
        locator: expect.objectContaining({
          providerId: "github",
          namespace: "byfungsi",
          name: "diffdash",
        }),
      }),
      checkout: expect.objectContaining({
        remoteUrl: "https://github.com/byfungsi/diffdash",
        path: "/fixtures/diffdash",
      }),
      isFavorite: true,
    }),
  ])

  const pullRequest = decodePullRequestFixtureRow(
    yield* database.get("SELECT * FROM pull_requests WHERE id = ?", ["pr-v8"]),
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

  const walkthrough = yield* walkthroughs.get({
    repoId: ReviewProjectId.make("github:byfungsi/diffdash"),
    reviewKey: ReviewKey.make("github:byfungsi/diffdash#147"),
    baseSha: ReviewRevision.make("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    headSha: ReviewRevision.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    promptVersion: "walkthrough-v4",
  })
  expect(Option.isSome(walkthrough)).toBe(true)
  if (Option.isNone(walkthrough)) throw new Error("Expected the version 8 walkthrough fixture")
  expect(walkthrough.value).toEqual(
    expect.objectContaining({
      repoId: ReviewProjectId.make("github:byfungsi/diffdash"),
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
  const missingWalkthrough = yield* walkthroughs.get({
    repoId: ReviewProjectId.make("github:byfungsi/diffdash"),
    reviewKey: ReviewKey.make("github:byfungsi/diffdash#147"),
    baseSha: ReviewRevision.make("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    headSha: ReviewRevision.make("cccccccccccccccccccccccccccccccccccccccc"),
    promptVersion: "walkthrough-v4",
  })
  expect(Option.isNone(missingWalkthrough)).toBe(true)

  const threadId = ReviewThreadId.make("thread-v8")
  const reviewKey = ReviewKey.make("github:byfungsi/diffdash#147")
  const headRevision = ReviewRevision.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  const thread = yield* threads.get(threadId)
  expect(thread.thread).toEqual(
    expect.objectContaining({
      id: threadId,
      repoId: ReviewProjectId.make("github:byfungsi/diffdash"),
      reviewKey: "github:byfungsi/diffdash#147",
      currentAnchor: expect.objectContaining({
        _tag: "Active",
        anchor: expect.objectContaining({
          _tag: "line",
          filePath: "src/main/services/database.ts",
          lineNumber: 1,
        }),
      }),
    }),
  )
  expect(
    thread.conversation.map((turn) => ({
      tag: turn._tag,
      bodyMarkdown: "bodyMarkdown" in turn.message ? turn.message.bodyMarkdown : undefined,
      sequence: turn.message.sequence,
      agentRunId: "agentRunId" in turn.message ? turn.message.agentRunId : undefined,
    })),
  ).toEqual([
    {
      tag: "User",
      bodyMarkdown: "Why must this survive restart?",
      sequence: 1,
      agentRunId: undefined,
    },
    {
      tag: "Completed",
      bodyMarkdown: "SQLite retains the thread and its related records.",
      sequence: 2,
      agentRunId: "run-v8",
    },
    {
      tag: "User",
      bodyMarkdown: "Confirm it still exists after reopening.",
      sequence: 3,
      agentRunId: undefined,
    },
  ])
  expect(
    (yield* threads.listForReview({
      repoId: ReviewProjectId.make("github:byfungsi/diffdash"),
      reviewKey,
    })).map(({ id }) => id),
  ).toEqual([threadId])
  expect(
    (yield* threads.listForRevision({
      repoId: ReviewProjectId.make("github:byfungsi/diffdash"),
      reviewKey,
      headRevision,
    })).map(({ id }) => id),
  ).toEqual([threadId])

  const runId = AgentRunId.make("run-v8")
  expect(
    decodeAgentRunFixtureRow(
      yield* database.get(
        `SELECT id, thread_id, provider, model, prompt_version, review_key, base_sha, head_sha,
                status, provider_run_id, usage_json
         FROM agent_runs WHERE id = ?`,
        [runId],
      ),
    ),
  ).toEqual(
    expect.objectContaining({
      id: runId,
      thread_id: threadId,
      provider: "claude",
      model: "claude-sonnet-4",
      prompt_version: "thread-v1",
      review_key: reviewKey,
      base_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      head_sha: headRevision,
      status: "completed",
      provider_run_id: "claude-session-v8",
      usage_json: {
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: 20,
        cacheWriteTokens: null,
        costUsd: 0.0042,
      },
    }),
  )

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

  expect(
    decodeThreadMemoryFixtureRow(
      yield* database.get(
        `SELECT thread_id, summary, summarized_through_sequence, summary_algorithm,
                summary_version, important_artifact_ids_json
         FROM thread_memory WHERE thread_id = ?`,
        [threadId],
      ),
    ),
  ).toEqual(
    expect.objectContaining({
      thread_id: threadId,
      summary: "The discussion verifies version-8 persistence across reopen.",
      summarized_through_sequence: 3,
      summary_algorithm: "deterministic-transcript",
      summary_version: 1,
      important_artifact_ids_json: [artifactId],
    }),
  )
})

const createLegacyDatabase = (databasePath: string) => {
  const sqlite = new DatabaseSync(databasePath)
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
  const sqlite = new DatabaseSync(databasePath)
  sqlite.exec(`
    ALTER TABLE walkthroughs RENAME TO walkthroughs_without_base_sha;
    UPDATE walkthroughs_without_base_sha
    SET head_sha = 'interrupted-head', content_json = '{"title":"Interrupted"}';
  `)
  sqlite.close()
}

const createVersion3ThreadMemoryDatabase = (databasePath: string) => {
  const sqlite = new DatabaseSync(databasePath)
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
  const sqlite = new DatabaseSync(databasePath)
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
