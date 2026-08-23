import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Layer, Option } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  hostedRepositoryInput,
  linkedRepositoryCheckout,
  localRepositoryInput,
  remoteOnlyRepositoryCheckout,
  RepositoryCheckoutPath,
} from "@diffdash/domain/repository"
import {
  HostedRepositorySource,
  GitProviderId,
  LocalRepositorySource,
  makeHostedRepositoryLocator,
  ProviderRepositoryId,
  ResolvedHostedRepository,
} from "@diffdash/domain/git-provider"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { WebUrl } from "@diffdash/domain/web-url"
import { type Database, makeDatabase, type SqlParams } from "./database"
import * as DatabaseNode from "./database-node"
import { RepositoryCheckoutRecord, RepositoryStore, RepositoryStoreError } from "./repository-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  RepositoryStore.layer.pipe(Layer.provideMerge(DatabaseNode.layer(databasePath)))

const githubProviderId = GitProviderId.make("github")
const githubEnterpriseProviderId = GitProviderId.make("github-enterprise")

const hostedInput = (
  owner: string,
  name: string,
  remoteUrl: string,
  localPath: string | null = null,
  providerId: GitProviderId = githubProviderId,
  favorite: "preserve" | "mark" = "preserve",
) =>
  hostedRepositoryInput(
    makeHostedRepositoryLocator(providerId, owner, name),
    localPath === null
      ? remoteOnlyRepositoryCheckout(remoteUrl)
      : linkedRepositoryCheckout(remoteUrl, localPath),
    favorite,
  )

const localInput = (localPath: string, remoteUrl: string) =>
  localRepositoryInput(linkedRepositoryCheckout(remoteUrl, localPath), "preserve")

const getRow = (database: Database, statement: string, params?: SqlParams) =>
  database.get(statement, params).pipe(Effect.map(Option.getOrUndefined))

const INSERT_REVIEW_THREAD_SQL = `INSERT INTO review_threads (
  id, repo_id, review_key, pr_number, base_sha, head_sha,
  current_base_sha, current_head_sha, original_anchor_json, current_anchor_json,
  anchor_status, status, closed_at, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'open', NULL, ?, ?)`

describe("RepositoryStore", () => {
  it.effect("persists local and remote-only repositories", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const remote = yield* store.upsertRepository(
          hostedInput(
            "fungsi",
            "remote-repo",
            "https://github.com/fungsi/remote-repo",
            null,
            githubProviderId,
            "mark",
          ),
        )
        const local = yield* store.upsertRepository(
          hostedInput(
            "fungsi",
            "local-repo",
            "https://github.com/fungsi/local-repo",
            "/tmp/local-repo",
          ),
        )
        const repos = yield* store.list()

        expect(remote.localPath).toBeNull()
        expect(remote.isFavorite).toBe(true)
        expect(local.localPath).toBe("/tmp/local-repo")
        expect(repos.map((repo) => repo.id)).toEqual([remote.id, local.id])
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("reconciles surviving checkouts and clears stale compatibility paths", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const remoteUrl = "https://github.com/fungsi/recoverable"
        const stalePath = RepositoryCheckoutPath.make("/tmp/recoverable-deleted")
        const mainPath = RepositoryCheckoutPath.make("/tmp/recoverable-main")
        const siblingPath = RepositoryCheckoutPath.make("/tmp/aaa-linked-worktree")
        const repo = yield* store.upsertRepository(
          hostedInput("fungsi", "recoverable", remoteUrl, stalePath),
        )
        yield* store.upsertRepository(hostedInput("fungsi", "recoverable", remoteUrl, mainPath))

        const recovered = yield* store.reconcileCheckouts(
          repo.id,
          [
            RepositoryCheckoutRecord.make({ path: siblingPath, remoteUrl }),
            RepositoryCheckoutRecord.make({ path: mainPath, remoteUrl }),
          ],
          Option.some(mainPath),
        )
        expect(recovered.localPath).toBe(mainPath)
        expect((yield* store.getById(repo.id)).localPath).toBe(mainPath)
        expect((yield* store.listCheckouts(repo.id)).map(({ path }) => path)).toEqual(
          expect.arrayContaining([mainPath, siblingPath]),
        )

        const unavailable = yield* store.reconcileCheckouts(repo.id, [], Option.none())
        const row = yield* getRow(database, "SELECT local_path FROM repos WHERE id = ?", [repo.id])
        expect(unavailable.localPath).toBeNull()
        expect(row).toEqual({ local_path: null })
        expect(yield* store.listCheckouts(repo.id)).toEqual([])
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rolls back repository upserts when compatibility writes fail", () =>
    Effect.gen(function* () {
      for (const table of ["repository_identities", "repository_checkouts"] as const) {
        const databasePath = yield* makeTempDatabasePath
        yield* Effect.gen(function* () {
          const store = yield* RepositoryStore
          const database = makeDatabase(yield* SqlClient.SqlClient)
          yield* database.run(
            `CREATE TRIGGER fail_${table}_insert
             BEFORE INSERT ON ${table}
             BEGIN
               SELECT RAISE(FAIL, 'injected ${table} failure');
             END`,
          )

          const result = yield* Effect.result(
            store.upsertRepository(
              hostedInput(
                "fungsi",
                `rollback-${table}`,
                `https://github.com/fungsi/rollback-${table}`,
                `/tmp/rollback-${table}`,
              ),
            ),
          )

          expect(Result.isFailure(result)).toBe(true)
          expect(
            yield* getRow(database, "SELECT id FROM repos WHERE name = ?", [`rollback-${table}`]),
          ).toBeUndefined()
          expect(
            yield* getRow(database, "SELECT repo_id FROM repository_identities LIMIT 1"),
          ).toBeUndefined()
          expect(
            yield* getRow(database, "SELECT repo_id FROM repository_checkouts LIMIT 1"),
          ).toBeUndefined()
        }).pipe(Effect.provide(makeLayer(databasePath)))
      }
    }),
  )

  it.effect("updates favorite state and supports search", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const repo = yield* store.upsertRepository(
          hostedInput("fungsi", "searchable", "https://github.com/fungsi/searchable"),
        )

        const updated = yield* store.setFavorite(repo.id, true)
        const matches = yield* store.list("fungsi/search")
        yield* database.run(
          "UPDATE repos SET last_opened_at = '2000-01-01T00:00:00.000Z', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
          [repo.id],
        )
        const touched = yield* store.touch(repo.id)

        expect(updated.isFavorite).toBe(true)
        expect(matches).toHaveLength(1)
        expect(matches[0]?.id).toBe(repo.id)
        expect(touched.lastOpenedAt).not.toBe("2000-01-01T00:00:00.000Z")
        expect(touched.updatedAt).not.toBe("2000-01-01T00:00:00.000Z")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("marks or preserves favorites on upsert and only setFavorite can unmark", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const input = hostedInput(
          "fungsi",
          "favorite-intent",
          "https://github.com/fungsi/favorite-intent",
        )

        const initial = yield* store.upsertRepository(input)
        const marked = yield* store.upsertRepository(
          hostedInput(
            "fungsi",
            "favorite-intent",
            "https://github.com/fungsi/favorite-intent",
            null,
            githubProviderId,
            "mark",
          ),
        )
        const preservedFavorite = yield* store.upsertRepository(input)
        const unmarked = yield* store.setFavorite(marked.id, false)
        const preservedUnmarked = yield* store.upsertRepository(input)

        expect(initial.isFavorite).toBe(false)
        expect(marked.isFavorite).toBe(true)
        expect(preservedFavorite.isFavorite).toBe(true)
        expect(unmarked.isFavorite).toBe(false)
        expect(preservedUnmarked.isFavorite).toBe(false)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("prefers a hosted repository when legacy rows share a local path", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const hosted = yield* store.upsertRepository(
          hostedInput(
            "fungsi",
            "shared-repo",
            "https://github.com/fungsi/shared-repo",
            "/tmp/shared-repo",
          ),
        )
        yield* store.upsertRepository(localInput("/tmp/shared-repo", "file:///tmp/shared-repo"))

        const found = yield* store.findByLocalPath(RepositoryCheckoutPath.make("/tmp/shared-repo"))

        expect(Option.getOrUndefined(found)).toMatchObject({
          id: hosted.id,
          source: { locator: { providerId: githubProviderId } },
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("returns None when no repository matches a lookup", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore

        expect(
          Option.isNone(
            yield* store.findByLocalPath(RepositoryCheckoutPath.make("/tmp/missing-repo")),
          ),
        ).toBe(true)
        expect(
          Option.isNone(
            yield* store.findHosted(
              makeHostedRepositoryLocator("github", "fungsi", "missing-repo"),
            ),
          ),
        ).toBe(true)
        expect(
          Option.isNone(
            yield* store.findByProviderRepositoryId(
              GitProviderId.make("github"),
              ProviderRepositoryId.make("R_missing"),
            ),
          ),
        ).toBe(true)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("reconciles local repository artifacts into the canonical hosted project", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const localPath = "/tmp/reconciled-repo"
        const hosted = yield* store.upsertRepository(
          hostedInput(
            "fungsi",
            "reconciled-repo",
            "https://github.com/fungsi/reconciled-repo",
            localPath,
          ),
        )
        const alias = yield* store.upsertRepository(
          localInput(localPath, "file:///tmp/reconciled-repo"),
        )
        const anchor = '{"_tag":"line","path":"src/index.ts","side":"right","line":1}'

        yield* database.run(
          `INSERT INTO pull_requests (
            id, repo_id, number, title, author, head_sha, base_ref, head_ref, state,
            last_fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "alias-pr",
            alias.id,
            17,
            "Alias pull request",
            "hanif",
            "head",
            "main",
            "feature",
            "open",
            "2026-08-02T00:00:00.000Z",
          ],
        )
        yield* database.run(
          `INSERT INTO walkthroughs (
            repo_id, pr_number, review_key, base_sha, head_sha, prompt_version,
            content_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [alias.id, 17, "github:17", "base", "head", "v1", "{}", "2026-08-02T00:00:00.000Z"],
        )
        yield* database.run(
          `INSERT INTO walkthrough_operations (
            id, repo_id, review_key, base_sha, head_sha, prompt_version, state,
            state_version, accepted_at, started_at, terminal_at, updated_at,
            artifact_repo_id, artifact_review_key, artifact_base_sha,
            artifact_head_sha, artifact_prompt_version
          ) VALUES (?, ?, ?, ?, ?, ?, 'completed', 3, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "alias-walkthrough-operation",
            alias.id,
            "github:17",
            "base",
            "head",
            "v1",
            "2026-08-02T00:00:00.000Z",
            "2026-08-02T00:00:01.000Z",
            "2026-08-02T00:00:02.000Z",
            "2026-08-02T00:00:02.000Z",
            alias.id,
            "github:17",
            "base",
            "head",
            "v1",
          ],
        )
        yield* database.run(
          `INSERT INTO hosted_viewed_files (
            repo_id, pr_number, base_ref_name, review_key, patch_hash, viewed_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [alias.id, 17, "main", "github:17", "hosted-patch", "2026-08-02T00:00:00.000Z"],
        )
        yield* database.run(
          `INSERT INTO local_viewed_files (
            repo_id, source_identity, comparison_kind, comparison_target,
            review_key, patch_hash, viewed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            alias.id,
            "working-tree",
            "workingTree",
            "",
            "local:working-tree",
            "local-patch",
            "2026-08-02T00:00:00.000Z",
          ],
        )
        yield* database.run(
          `INSERT INTO project_workspace_state (
            repo_id, active_surface, active_activity, selected_review_target_json, updated_at
          ) VALUES (?, ?, ?, ?, ?)`,
          [
            alias.id,
            "review",
            "diffdash.builtin.review-comments.comments",
            null,
            "2026-08-02T01:00:00.000Z",
          ],
        )
        yield* database.run(INSERT_REVIEW_THREAD_SQL, [
          "alias-thread",
          alias.id,
          "github:17",
          17,
          "base",
          "head",
          "base",
          "head",
          anchor,
          anchor,
          "2026-08-02T00:00:00.000Z",
          "2026-08-02T01:00:00.000Z",
        ])
        yield* database.run(
          `INSERT INTO agent_runs (
            id, thread_id, review_key, base_sha, head_sha, provider, model,
            prompt_version, status, provider_run_id, error, started_at, completed_at, usage_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, NULL, ?, ?, ?)`,
          [
            "alias-run",
            "alias-thread",
            "github:17",
            "base",
            "head",
            "codex",
            "test-model",
            "v1",
            "provider-run",
            "2026-08-02T00:00:00.000Z",
            "2026-08-02T00:01:00.000Z",
            null,
          ],
        )
        yield* database.run(
          `INSERT INTO review_thread_messages (
            id, thread_id, sequence, author, body_markdown, status,
            agent_run_id, created_at, updated_at
          ) VALUES (?, ?, ?, 'agent', ?, 'complete', ?, ?, ?)`,
          [
            "alias-message",
            "alias-thread",
            1,
            "Conversation remains intact.",
            "alias-run",
            "2026-08-02T00:00:00.000Z",
            "2026-08-02T00:01:00.000Z",
          ],
        )
        yield* database.run(
          `INSERT INTO agent_run_artifacts (
            id, run_id, thread_id, type, title, content, content_digest,
            metadata_json, truncated, original_size, created_at
          ) VALUES (?, ?, ?, 'shell_output', ?, ?, ?, ?, 0, ?, ?)`,
          [
            "alias-artifact",
            "alias-run",
            "alias-thread",
            "Test output",
            "content",
            "digest",
            "{}",
            7,
            "2026-08-02T00:01:00.000Z",
          ],
        )
        yield* database.run(
          `INSERT INTO thread_memory (
            thread_id, summary, important_artifact_ids_json, updated_at
          ) VALUES (?, ?, ?, ?)`,
          ["alias-thread", "summary", '["alias-artifact"]', "2026-08-02T00:01:00.000Z"],
        )

        const result = yield* store.reconcileLocalAliases(
          ReviewProjectId.make(hosted.id),
          RepositoryCheckoutPath.make(localPath),
        )

        expect(result).toEqual({
          matchedAliasCount: 1,
          removedAliasCount: 1,
          preservedAliasCount: 0,
        })
        expect(
          yield* getRow(database, "SELECT id FROM repos WHERE id = ?", [alias.id]),
        ).toBeUndefined()
        expect(
          yield* getRow(database, "SELECT repo_id FROM pull_requests WHERE id = ?", ["alias-pr"]),
        ).toEqual({ repo_id: hosted.id })
        expect(
          yield* getRow(database, "SELECT repo_id FROM walkthroughs WHERE review_key = ?", [
            "github:17",
          ]),
        ).toEqual({ repo_id: hosted.id })
        expect(
          yield* getRow(
            database,
            `SELECT repo_id, artifact_repo_id FROM walkthrough_operations WHERE id = ?`,
            ["alias-walkthrough-operation"],
          ),
        ).toEqual({ repo_id: hosted.id, artifact_repo_id: hosted.id })
        expect(
          yield* getRow(database, "SELECT repo_id FROM hosted_viewed_files WHERE patch_hash = ?", [
            "hosted-patch",
          ]),
        ).toEqual({ repo_id: hosted.id })
        expect(
          yield* getRow(database, "SELECT repo_id FROM local_viewed_files WHERE patch_hash = ?", [
            "local-patch",
          ]),
        ).toEqual({ repo_id: hosted.id })
        expect(
          yield* getRow(
            database,
            `SELECT repo_id, active_surface, active_activity
             FROM project_workspace_state WHERE repo_id = ?`,
            [hosted.id],
          ),
        ).toEqual({
          repo_id: hosted.id,
          active_surface: "review",
          active_activity: "diffdash.builtin.review-comments.comments",
        })
        expect(
          yield* getRow(database, "SELECT id, repo_id FROM review_threads WHERE id = ?", [
            "alias-thread",
          ]),
        ).toEqual({ id: "alias-thread", repo_id: hosted.id })
        expect(
          yield* getRow(
            database,
            "SELECT thread_id, agent_run_id FROM review_thread_messages WHERE id = ?",
            ["alias-message"],
          ),
        ).toEqual({ thread_id: "alias-thread", agent_run_id: "alias-run" })
        expect(
          yield* getRow(database, "SELECT thread_id FROM agent_runs WHERE id = ?", ["alias-run"]),
        ).toEqual({ thread_id: "alias-thread" })
        expect(
          yield* getRow(
            database,
            "SELECT run_id, thread_id FROM agent_run_artifacts WHERE id = ?",
            ["alias-artifact"],
          ),
        ).toEqual({ run_id: "alias-run", thread_id: "alias-thread" })
        expect(
          yield* getRow(database, "SELECT thread_id FROM thread_memory WHERE thread_id = ?", [
            "alias-thread",
          ]),
        ).toEqual({ thread_id: "alias-thread" })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("merges collisions by newest durable timestamp and keeps canonical ties", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const localPath = "/tmp/conflicting-repo"
        const hosted = yield* store.upsertRepository(
          hostedInput(
            "fungsi",
            "conflicting-repo",
            "https://github.com/fungsi/conflicting-repo",
            localPath,
          ),
        )
        const alias = yield* store.upsertRepository(
          localInput(localPath, "file:///tmp/conflicting-repo"),
        )
        const anchor = '{"_tag":"line","path":"src/conflict.ts","side":"right","line":4}'
        const viewedFileValues = [
          "working-tree",
          "workingTree",
          "",
          "local:working-tree",
          "same-patch",
        ] as const

        yield* database.run(
          `INSERT INTO local_viewed_files (
            repo_id, source_identity, comparison_kind, comparison_target,
            review_key, patch_hash, viewed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [hosted.id, ...viewedFileValues, "2026-08-02T02:00:00.000Z"],
        )
        yield* database.run(
          `INSERT INTO local_viewed_files (
            repo_id, source_identity, comparison_kind, comparison_target,
            review_key, patch_hash, viewed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [alias.id, ...viewedFileValues, "2026-08-02T03:00:00.000Z"],
        )
        const hostedViewedFileValues = [5, "main", "github:5", "hosted-same-patch"] as const
        yield* database.run(
          `INSERT INTO hosted_viewed_files (
            repo_id, pr_number, base_ref_name, review_key, patch_hash, viewed_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [hosted.id, ...hostedViewedFileValues, "2026-08-04T03:00:00.000Z"],
        )
        yield* database.run(
          `INSERT INTO hosted_viewed_files (
            repo_id, pr_number, base_ref_name, review_key, patch_hash, viewed_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [alias.id, ...hostedViewedFileValues, "2026-08-04T02:00:00.000Z"],
        )
        yield* database.run(
          `INSERT INTO walkthroughs (
            repo_id, pr_number, review_key, base_sha, head_sha, prompt_version,
            content_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [hosted.id, 4, "github:4", "base", "head", "v1", "canonical", "2026-08-02"],
        )
        yield* database.run(
          `INSERT INTO walkthroughs (
            repo_id, pr_number, review_key, base_sha, head_sha, prompt_version,
            content_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [alias.id, 4, "github:4", "base", "head", "v1", "alias", "2026-08-03"],
        )
        yield* database.run(
          `INSERT INTO walkthroughs (
            repo_id, pr_number, review_key, base_sha, head_sha, prompt_version,
            content_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [hosted.id, 5, "github:5", "base", "head", "v1", "canonical-newer", "2026-08-05"],
        )
        yield* database.run(
          `INSERT INTO walkthroughs (
            repo_id, pr_number, review_key, base_sha, head_sha, prompt_version,
            content_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [alias.id, 5, "github:5", "base", "head", "v1", "alias-older", "2026-08-04"],
        )
        yield* database.run(
          `INSERT INTO walkthroughs (
            repo_id, pr_number, review_key, base_sha, head_sha, prompt_version,
            content_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [hosted.id, 6, "github:6", "base", "head", "v1", "canonical-tie", "2026-08-06"],
        )
        yield* database.run(
          `INSERT INTO walkthroughs (
            repo_id, pr_number, review_key, base_sha, head_sha, prompt_version,
            content_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [alias.id, 6, "github:6", "base", "head", "v1", "alias-tie", "2026-08-06"],
        )
        yield* database.run(
          `INSERT INTO walkthrough_operations (
            id, repo_id, review_key, base_sha, head_sha, prompt_version,
            state, state_version, accepted_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 1, ?, ?)`,
          [
            "canonical-active-operation",
            hosted.id,
            "github:4",
            "base",
            "head",
            "v1",
            "2026-08-02T00:00:00.000Z",
            "2026-08-02T00:00:00.000Z",
          ],
        )
        yield* database.run(
          `INSERT INTO walkthrough_operations (
            id, repo_id, review_key, base_sha, head_sha, prompt_version,
            state, state_version, accepted_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 1, ?, ?)`,
          [
            "alias-active-operation",
            alias.id,
            "github:4",
            "base",
            "head",
            "v1",
            "2026-08-03T00:00:00.000Z",
            "2026-08-03T00:00:00.000Z",
          ],
        )
        yield* database.run(
          `INSERT INTO project_workspace_state (
            repo_id, active_surface, active_activity, selected_review_target_json, updated_at
          ) VALUES (?, ?, ?, NULL, ?)`,
          [hosted.id, "review", "diffdash.core.reviews", "2026-08-02T04:00:00.000Z"],
        )
        yield* database.run(
          `INSERT INTO project_workspace_state (
            repo_id, active_surface, active_activity, selected_review_target_json, updated_at
          ) VALUES (?, ?, ?, NULL, ?)`,
          [
            alias.id,
            "review",
            "diffdash.builtin.review-comments.comments",
            "2026-08-02T03:00:00.000Z",
          ],
        )
        yield* database.run(INSERT_REVIEW_THREAD_SQL, [
          "canonical-thread",
          hosted.id,
          "github:4",
          4,
          "base",
          "head",
          "base",
          "head",
          anchor,
          anchor,
          "2026-08-02T00:00:00.000Z",
          "2026-08-02T00:00:00.000Z",
        ])
        yield* database.run(INSERT_REVIEW_THREAD_SQL, [
          "alias-conflicting-thread",
          alias.id,
          "github:4",
          4,
          "base",
          "head",
          "base",
          "head",
          anchor,
          anchor,
          "2026-08-02T00:00:00.000Z",
          "2026-08-02T01:00:00.000Z",
        ])
        yield* database.run(
          `INSERT INTO review_thread_messages (
            id, thread_id, sequence, author, body_markdown, status,
            agent_run_id, created_at, updated_at
          ) VALUES (?, ?, 1, 'user', ?, 'complete', NULL, ?, ?)`,
          [
            "alias-conflicting-message",
            "alias-conflicting-thread",
            "Preserve this conversation.",
            "2026-08-02T01:00:00.000Z",
            "2026-08-02T01:00:00.000Z",
          ],
        )

        const result = yield* store.reconcileLocalAliases(
          ReviewProjectId.make(hosted.id),
          RepositoryCheckoutPath.make(localPath),
        )

        expect(result).toEqual({
          matchedAliasCount: 1,
          removedAliasCount: 1,
          preservedAliasCount: 0,
        })
        expect(
          yield* getRow(database, "SELECT id FROM repos WHERE id = ?", [alias.id]),
        ).toBeUndefined()
        expect(
          yield* getRow(
            database,
            "SELECT viewed_at FROM local_viewed_files WHERE repo_id = ? AND patch_hash = ?",
            [hosted.id, "same-patch"],
          ),
        ).toEqual({ viewed_at: "2026-08-02T03:00:00.000Z" })
        expect(
          yield* getRow(
            database,
            "SELECT viewed_at FROM hosted_viewed_files WHERE repo_id = ? AND patch_hash = ?",
            [hosted.id, "hosted-same-patch"],
          ),
        ).toEqual({ viewed_at: "2026-08-04T03:00:00.000Z" })
        expect(
          yield* getRow(database, "SELECT 1 FROM local_viewed_files WHERE repo_id = ?", [alias.id]),
        ).toBeUndefined()
        expect(
          yield* getRow(
            database,
            "SELECT content_json, created_at FROM walkthroughs WHERE repo_id = ? AND review_key = ?",
            [hosted.id, "github:4"],
          ),
        ).toEqual({ content_json: "alias", created_at: "2026-08-03" })
        expect(
          yield* getRow(
            database,
            "SELECT content_json, created_at FROM walkthroughs WHERE repo_id = ? AND review_key = ?",
            [hosted.id, "github:5"],
          ),
        ).toEqual({ content_json: "canonical-newer", created_at: "2026-08-05" })
        expect(
          yield* getRow(
            database,
            "SELECT content_json, created_at FROM walkthroughs WHERE repo_id = ? AND review_key = ?",
            [hosted.id, "github:6"],
          ),
        ).toEqual({ content_json: "canonical-tie", created_at: "2026-08-06" })
        expect(
          yield* getRow(
            database,
            `SELECT repo_id, state, state_version, superseded_by_operation_id
             FROM walkthrough_operations WHERE id = ?`,
            ["alias-active-operation"],
          ),
        ).toEqual({
          repo_id: hosted.id,
          state: "superseded",
          state_version: 2,
          superseded_by_operation_id: "canonical-active-operation",
        })
        expect(
          yield* getRow(
            database,
            `SELECT active_surface, active_activity, updated_at
             FROM project_workspace_state WHERE repo_id = ?`,
            [hosted.id],
          ),
        ).toEqual({
          active_surface: "review",
          active_activity: "diffdash.core.reviews",
          updated_at: "2026-08-02T04:00:00.000Z",
        })
        expect(
          yield* getRow(database, "SELECT repo_id FROM review_threads WHERE id = ?", [
            "canonical-thread",
          ]),
        ).toEqual({ repo_id: hosted.id })
        expect(
          yield* getRow(database, "SELECT repo_id FROM review_threads WHERE id = ?", [
            "alias-conflicting-thread",
          ]),
        ).toBeUndefined()
        expect(
          yield* getRow(database, "SELECT thread_id FROM review_thread_messages WHERE id = ?", [
            "alias-conflicting-message",
          ]),
        ).toEqual({ thread_id: "canonical-thread" })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("forgets Home state without deleting the repository and touch restores recency", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const repo = yield* store.upsertRepository(
          hostedInput(
            "fungsi",
            "forgettable-repo",
            "https://github.com/fungsi/forgettable-repo",
            "/tmp/forgettable-repo",
            githubProviderId,
            "mark",
          ),
        )

        const forgotten = yield* store.forget(ReviewProjectId.make(repo.id))
        const persisted = (yield* store.list()).find((candidate) => candidate.id === repo.id)

        expect(forgotten.id).toBe(repo.id)
        expect(forgotten.isFavorite).toBe(false)
        expect(forgotten.lastOpenedAt).toBeNull()
        expect(persisted).toEqual(forgotten)

        const touched = yield* store.touch(repo.id)

        expect(touched.lastOpenedAt).not.toBeNull()
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("upgrades a hosted favorite with its local checkout without duplicating it", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const hosted = yield* store.upsertRepository(
          hostedInput(
            "fungsi",
            "diffdash",
            "https://github.com/fungsi/diffdash",
            null,
            githubProviderId,
            "mark",
          ),
        )
        const linked = yield* store.upsertRepository(
          hostedInput(
            "fungsi",
            "diffdash",
            "https://github.com/fungsi/diffdash.git",
            "/tmp/diffdash",
          ),
        )
        const repositories = yield* store.list()

        expect(repositories).toHaveLength(1)
        expect(linked.id).toBe(hosted.id)
        expect(linked.createdAt).toBe(hosted.createdAt)
        expect(linked.localPath).toBe("/tmp/diffdash")
        expect(linked.isFavorite).toBe(true)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("converges renamed hosted locators through the stable provider repository ID", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const old = yield* store.upsertRepository(
          hostedInput(
            "xenithlabs",
            "xenith-operator-dashboard-fe",
            "git@github.com:xenithlabs/xenith-operator-dashboard-fe.git",
            "/tmp/xenith-operator-dashboard-fe",
            githubProviderId,
            "mark",
          ),
        )
        const current = yield* store.upsertRepository(
          hostedInput(
            "xenithlabs",
            "xenith-dashboard",
            "https://github.com/xenithlabs/xenith-dashboard",
          ),
        )
        const resolved = ResolvedHostedRepository.make({
          locator: makeHostedRepositoryLocator("github", "xenithlabs", "xenith-dashboard"),
          providerRepositoryId: ProviderRepositoryId.make("R_xenith_dashboard"),
          url: WebUrl.make("https://github.com/xenithlabs/xenith-dashboard"),
        })

        const attached = yield* store.attachResolvedIdentity(
          ReviewProjectId.make(old.id),
          resolved,
          old.checkout,
        )
        const repositories = yield* store.list()

        expect(attached.id).toBe(old.id)
        expect(attached.displayIdentity).toBe("xenithlabs/xenith-dashboard")
        expect(attached.isFavorite).toBe(true)
        expect(
          repositories.filter((repo) => repo.displayIdentity === "xenithlabs/xenith-dashboard"),
        ).toHaveLength(1)
        expect(repositories.some((repo) => repo.id === current.id)).toBe(false)
        expect(
          Option.getOrUndefined(
            yield* store.findByProviderRepositoryId(
              GitProviderId.make("github"),
              ProviderRepositoryId.make("R_xenith_dashboard"),
            ),
          ),
        ).toMatchObject({ id: old.id })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("repairs same-checkout local aliases while preserving their artifacts", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const localPath = "/tmp/diffdash"
        const hosted = yield* store.upsertRepository(
          hostedInput("byfungsi", "diffdash", "git@github.com:byfungsi/diffdash.git", localPath),
        )
        const local = yield* store.upsertRepository(localInput(localPath, "file:///tmp/diffdash"))
        yield* database.run(
          `INSERT INTO local_viewed_files (
             repo_id, source_identity, comparison_kind, comparison_target,
             review_key, patch_hash, viewed_at
           ) VALUES (?, 'working-tree', 'workingTree', '', 'local:working-tree', 'patch', ?)`,
          [local.id, "2026-08-03T00:00:00.000Z"],
        )

        const result = yield* store.repairLocalAliases()
        const repositories = yield* store.list()

        expect(result).toEqual({
          matchedAliasCount: 1,
          removedAliasCount: 1,
          preservedAliasCount: 0,
        })
        expect(repositories.filter((repo) => repo.localPath === localPath)).toEqual([
          expect.objectContaining({ id: hosted.id }),
        ])
        expect(
          yield* getRow(
            database,
            "SELECT repo_id FROM local_viewed_files WHERE patch_hash = 'patch'",
          ),
        ).toEqual({ repo_id: hosted.id })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-130 AC: isolates nested repositories across provider IDs", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const github = yield* store.upsertRepository(
          hostedInput("platform/backend", "service", "https://github.com/platform/backend/service"),
        )
        const enterprise = yield* store.upsertRepository(
          hostedInput(
            "platform/backend",
            "service",
            "https://git.example.com/platform/backend/service",
            null,
            githubEnterpriseProviderId,
          ),
        )
        const legacyLocal = yield* store.upsertRepository(
          localInput("/tmp/service", "file:///tmp/service"),
        )

        expect(github.id).toBe("github:platform/backend/service")
        expect(enterprise.id).toBe("github-enterprise:platform/backend/service")
        expect(github.source).toBeInstanceOf(HostedRepositorySource)
        expect(legacyLocal.source).toBeInstanceOf(LocalRepositorySource)
        expect(yield* store.list()).toHaveLength(3)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rejects legacy rows that cannot form valid repository source and checkout pairs", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const local = yield* store.upsertRepository(
          localInput("/tmp/local-invalid", "file:///tmp/local-invalid"),
        )

        yield* database.run("DELETE FROM repository_checkouts WHERE repo_id = ?", [local.id])
        yield* database.run("UPDATE repos SET local_path = NULL WHERE id = ?", [local.id])
        const unlinkedLocal = yield* Effect.result(store.list())

        expect(Result.isFailure(unlinkedLocal)).toBe(true)
        if (Result.isFailure(unlinkedLocal)) {
          expect(unlinkedLocal.failure.operation).toBe("list.decode")
        }

        yield* database.run("UPDATE repos SET local_path = ? WHERE id = ?", [
          "/tmp/local-invalid",
          local.id,
        ])
        const hosted = yield* store.upsertRepository(
          hostedInput("fungsi", "invalid-hosted", "https://github.com/fungsi/invalid-hosted"),
        )
        yield* database.run(
          "UPDATE repository_identities SET canonical_owner = ? WHERE repo_id = ?",
          ["bad:owner", hosted.id],
        )
        const malformedHosted = yield* Effect.result(store.list())

        expect(Result.isFailure(malformedHosted)).toBe(true)
        if (Result.isFailure(malformedHosted)) {
          expect(malformedHosted.failure.operation).toBe("list.decode")
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rejects corrupt repository text, nullable, and favorite columns", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const repo = yield* store.upsertRepository(
          hostedInput(
            "fungsi",
            "corrupt-repo",
            "https://github.com/fungsi/corrupt-repo",
            "/tmp/corrupt-repo",
          ),
        )

        yield* database.run("UPDATE repos SET owner = x'01' WHERE id = ?", [repo.id])
        yield* database.run(
          "UPDATE repository_identities SET canonical_owner = x'01' WHERE repo_id = ?",
          [repo.id],
        )
        const corruptText = yield* Effect.result(store.list())
        expect(Result.isFailure(corruptText)).toBe(true)
        if (Result.isFailure(corruptText)) {
          expect(corruptText.failure).toBeInstanceOf(RepositoryStoreError)
          expect(corruptText.failure.operation).toBe("list.decode")
        }

        yield* database.run("UPDATE repos SET owner = ?, local_path = x'01' WHERE id = ?", [
          "fungsi",
          repo.id,
        ])
        yield* database.run(
          "UPDATE repository_identities SET canonical_owner = ? WHERE repo_id = ?",
          ["fungsi", repo.id],
        )
        yield* database.run(
          "UPDATE repository_checkouts SET local_path = x'01' WHERE repo_id = ?",
          [repo.id],
        )
        const corruptNullable = yield* Effect.result(store.touch(repo.id))
        expect(Result.isFailure(corruptNullable)).toBe(true)
        if (Result.isFailure(corruptNullable)) {
          expect(corruptNullable.failure).toBeInstanceOf(RepositoryStoreError)
          expect(corruptNullable.failure.operation).toBe("getById.decode")
        }

        yield* database.run("UPDATE repos SET local_path = NULL, is_favorite = 2 WHERE id = ?", [
          repo.id,
        ])
        const corruptFavorite = yield* Effect.result(store.list())
        expect(Result.isFailure(corruptFavorite)).toBe(true)
        if (Result.isFailure(corruptFavorite)) {
          expect(corruptFavorite.failure).toBeInstanceOf(RepositoryStoreError)
          expect(corruptFavorite.failure.operation).toBe("list.decode")
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
