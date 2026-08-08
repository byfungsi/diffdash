import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer, Option } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  noRepositoryLocalPath,
  repositoryLocalPath,
  repositorySource,
} from "@diffdash/domain/repository"
import {
  HostedRepositorySource,
  LocalRepositorySource,
  makeHostedRepositoryLocator,
  ProviderRepositoryId,
  ResolvedHostedRepository,
} from "@diffdash/domain/git-provider"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { DatabaseService } from "./database"
import { RepositoryStore, RepositoryStoreError } from "./repository-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  RepositoryStore.layer.pipe(Layer.provideMerge(DatabaseService.layer(databasePath)))

const INSERT_REVIEW_THREAD_SQL = `INSERT INTO review_threads (
  id, repo_id, review_key, pr_number, base_sha, head_sha,
  current_base_sha, current_head_sha, original_anchor_json, current_anchor_json,
  anchor_status, status, closed_at, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'open', NULL, ?, ?)`

describe("RepositoryStore", () => {
  it.scoped("persists local and remote-only repositories", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const remote = yield* store.upsertRepository({
          isFavorite: true,
          localPath: noRepositoryLocalPath,
          name: "remote-repo",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/remote-repo",
        })
        const local = yield* store.upsertRepository({
          isFavorite: false,
          localPath: repositoryLocalPath("/tmp/local-repo"),
          name: "local-repo",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/local-repo",
        })
        const repos = yield* store.list()

        expect(remote.localPath).toBeNull()
        expect(remote.isFavorite).toBe(true)
        expect(local.localPath).toBe("/tmp/local-repo")
        expect(repos.map((repo) => repo.id)).toEqual([remote.id, local.id])
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("updates favorite state and supports search", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const database = yield* DatabaseService
        const repo = yield* store.upsertRepository({
          localPath: noRepositoryLocalPath,
          name: "searchable",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/searchable",
        })

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

  it.scoped("prefers a hosted repository when legacy rows share a local path", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const hosted = yield* store.upsertRepository({
          localPath: repositoryLocalPath("/tmp/shared-repo"),
          name: "shared-repo",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/shared-repo",
        })
        yield* store.upsertRepository({
          localPath: repositoryLocalPath("/tmp/shared-repo"),
          name: "shared-repo-local",
          owner: "local",
          provider: "local",
          remoteUrl: "",
        })

        const found = yield* store.findByLocalPath("/tmp/shared-repo")

        expect(Option.getOrUndefined(found)).toMatchObject({
          id: hosted.id,
          provider: "github",
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("returns None when no repository matches a lookup", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore

        expect(Option.isNone(yield* store.findByLocalPath("/tmp/missing-repo"))).toBe(true)
        expect(
          Option.isNone(
            yield* store.findHosted(
              makeHostedRepositoryLocator("github", "fungsi", "missing-repo"),
            ),
          ),
        ).toBe(true)
        expect(Option.isNone(yield* store.findByProviderRepositoryId("github", "R_missing"))).toBe(
          true,
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("reconciles local repository artifacts into the canonical hosted project", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const database = yield* DatabaseService
        const localPath = "/tmp/reconciled-repo"
        const hosted = yield* store.upsertRepository({
          localPath: repositoryLocalPath(localPath),
          name: "reconciled-repo",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/reconciled-repo",
        })
        const alias = yield* store.upsertRepository({
          localPath: repositoryLocalPath(localPath),
          name: "reconciled-repo-local",
          owner: "local",
          provider: "local",
          remoteUrl: "file:///tmp/reconciled-repo",
        })
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
            repo_id, active_ribbon, selected_review_target_json, updated_at
          ) VALUES (?, ?, ?, ?)`,
          [alias.id, "threads", null, "2026-08-02T01:00:00.000Z"],
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
          localPath,
        )

        expect(result).toEqual({
          matchedAliasCount: 1,
          removedAliasCount: 1,
          preservedAliasCount: 0,
        })
        expect(yield* database.get("SELECT id FROM repos WHERE id = ?", [alias.id])).toBeUndefined()
        expect(
          yield* database.get("SELECT repo_id FROM pull_requests WHERE id = ?", ["alias-pr"]),
        ).toEqual({ repo_id: hosted.id })
        expect(
          yield* database.get("SELECT repo_id FROM walkthroughs WHERE review_key = ?", [
            "github:17",
          ]),
        ).toEqual({ repo_id: hosted.id })
        expect(
          yield* database.get("SELECT repo_id FROM hosted_viewed_files WHERE patch_hash = ?", [
            "hosted-patch",
          ]),
        ).toEqual({ repo_id: hosted.id })
        expect(
          yield* database.get("SELECT repo_id FROM local_viewed_files WHERE patch_hash = ?", [
            "local-patch",
          ]),
        ).toEqual({ repo_id: hosted.id })
        expect(
          yield* database.get(
            "SELECT repo_id, active_ribbon FROM project_workspace_state WHERE repo_id = ?",
            [hosted.id],
          ),
        ).toEqual({ repo_id: hosted.id, active_ribbon: "threads" })
        expect(
          yield* database.get("SELECT id, repo_id FROM review_threads WHERE id = ?", [
            "alias-thread",
          ]),
        ).toEqual({ id: "alias-thread", repo_id: hosted.id })
        expect(
          yield* database.get(
            "SELECT thread_id, agent_run_id FROM review_thread_messages WHERE id = ?",
            ["alias-message"],
          ),
        ).toEqual({ thread_id: "alias-thread", agent_run_id: "alias-run" })
        expect(
          yield* database.get("SELECT thread_id FROM agent_runs WHERE id = ?", ["alias-run"]),
        ).toEqual({ thread_id: "alias-thread" })
        expect(
          yield* database.get("SELECT run_id, thread_id FROM agent_run_artifacts WHERE id = ?", [
            "alias-artifact",
          ]),
        ).toEqual({ run_id: "alias-run", thread_id: "alias-thread" })
        expect(
          yield* database.get("SELECT thread_id FROM thread_memory WHERE thread_id = ?", [
            "alias-thread",
          ]),
        ).toEqual({ thread_id: "alias-thread" })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("merges colliding alias conversations into the canonical thread", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const database = yield* DatabaseService
        const localPath = "/tmp/conflicting-repo"
        const hosted = yield* store.upsertRepository({
          localPath: repositoryLocalPath(localPath),
          name: "conflicting-repo",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/conflicting-repo",
        })
        const alias = yield* store.upsertRepository({
          localPath: repositoryLocalPath(localPath),
          name: "conflicting-repo-local",
          owner: "local",
          provider: "local",
          remoteUrl: "file:///tmp/conflicting-repo",
        })
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
          `INSERT INTO project_workspace_state (
            repo_id, active_ribbon, selected_review_target_json, updated_at
          ) VALUES (?, ?, NULL, ?)`,
          [hosted.id, "reviews", "2026-08-02T04:00:00.000Z"],
        )
        yield* database.run(
          `INSERT INTO project_workspace_state (
            repo_id, active_ribbon, selected_review_target_json, updated_at
          ) VALUES (?, ?, NULL, ?)`,
          [alias.id, "threads", "2026-08-02T03:00:00.000Z"],
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
          localPath,
        )

        expect(result).toEqual({
          matchedAliasCount: 1,
          removedAliasCount: 1,
          preservedAliasCount: 0,
        })
        expect(yield* database.get("SELECT id FROM repos WHERE id = ?", [alias.id])).toBeUndefined()
        expect(
          yield* database.get(
            "SELECT viewed_at FROM local_viewed_files WHERE repo_id = ? AND patch_hash = ?",
            [hosted.id, "same-patch"],
          ),
        ).toEqual({ viewed_at: "2026-08-02T02:00:00.000Z" })
        expect(
          yield* database.get("SELECT 1 FROM local_viewed_files WHERE repo_id = ?", [alias.id]),
        ).toBeUndefined()
        expect(
          yield* database.get(
            "SELECT content_json FROM walkthroughs WHERE repo_id = ? AND review_key = ?",
            [hosted.id, "github:4"],
          ),
        ).toEqual({ content_json: "canonical" })
        expect(
          yield* database.get(
            "SELECT active_ribbon, updated_at FROM project_workspace_state WHERE repo_id = ?",
            [hosted.id],
          ),
        ).toEqual({
          active_ribbon: "reviews",
          updated_at: "2026-08-02T04:00:00.000Z",
        })
        expect(
          yield* database.get("SELECT repo_id FROM review_threads WHERE id = ?", [
            "canonical-thread",
          ]),
        ).toEqual({ repo_id: hosted.id })
        expect(
          yield* database.get("SELECT repo_id FROM review_threads WHERE id = ?", [
            "alias-conflicting-thread",
          ]),
        ).toBeUndefined()
        expect(
          yield* database.get("SELECT thread_id FROM review_thread_messages WHERE id = ?", [
            "alias-conflicting-message",
          ]),
        ).toEqual({ thread_id: "canonical-thread" })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("forgets Home state without deleting the repository and touch restores recency", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const repo = yield* store.upsertRepository({
          isFavorite: true,
          localPath: repositoryLocalPath("/tmp/forgettable-repo"),
          name: "forgettable-repo",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/forgettable-repo",
        })

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

  it.scoped("upgrades a hosted favorite with its local checkout without duplicating it", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const hosted = yield* store.upsertRepository({
          isFavorite: true,
          localPath: noRepositoryLocalPath,
          name: "diffdash",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/diffdash",
        })
        const linked = yield* store.upsertRepository({
          isFavorite: false,
          localPath: repositoryLocalPath("/tmp/diffdash"),
          name: "diffdash",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/diffdash.git",
        })
        const repositories = yield* store.list()

        expect(repositories).toHaveLength(1)
        expect(linked.id).toBe(hosted.id)
        expect(linked.createdAt).toBe(hosted.createdAt)
        expect(linked.localPath).toBe("/tmp/diffdash")
        expect(linked.isFavorite).toBe(true)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("converges renamed hosted locators through the stable provider repository ID", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const old = yield* store.upsertRepository({
          isFavorite: true,
          localPath: repositoryLocalPath("/tmp/xenith-operator-dashboard-fe"),
          name: "xenith-operator-dashboard-fe",
          owner: "xenithlabs",
          provider: "github",
          remoteUrl: "git@github.com:xenithlabs/xenith-operator-dashboard-fe.git",
        })
        const current = yield* store.upsertRepository({
          localPath: noRepositoryLocalPath,
          name: "xenith-dashboard",
          owner: "xenithlabs",
          provider: "github",
          remoteUrl: "https://github.com/xenithlabs/xenith-dashboard",
        })
        const resolved = ResolvedHostedRepository.make({
          locator: makeHostedRepositoryLocator("github", "xenithlabs", "xenith-dashboard"),
          providerRepositoryId: ProviderRepositoryId.make("R_xenith_dashboard"),
          url: "https://github.com/xenithlabs/xenith-dashboard",
        })

        const attached = yield* store.attachResolvedIdentity(
          ReviewProjectId.make(old.id),
          resolved,
          old.localPath,
          old.remoteUrl,
        )
        const repositories = yield* store.list()

        expect(attached.id).toBe(old.id)
        expect(attached.owner).toBe("xenithlabs")
        expect(attached.name).toBe("xenith-dashboard")
        expect(attached.isFavorite).toBe(true)
        expect(repositories.filter((repo) => repo.name === "xenith-dashboard")).toHaveLength(1)
        expect(repositories.some((repo) => repo.id === current.id)).toBe(false)
        expect(
          Option.getOrUndefined(
            yield* store.findByProviderRepositoryId("github", "R_xenith_dashboard"),
          ),
        ).toMatchObject({ id: old.id, name: "xenith-dashboard" })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("repairs same-checkout local aliases while preserving their artifacts", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const database = yield* DatabaseService
        const localPath = "/tmp/diffdash"
        const hosted = yield* store.upsertRepository({
          localPath: repositoryLocalPath(localPath),
          name: "diffdash",
          owner: "byfungsi",
          provider: "github",
          remoteUrl: "git@github.com:byfungsi/diffdash.git",
        })
        const local = yield* store.upsertRepository({
          localPath: repositoryLocalPath(localPath),
          name: "diffdash-local",
          owner: "local",
          provider: "local",
          remoteUrl: "file:///tmp/diffdash",
        })
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
          yield* database.get("SELECT repo_id FROM local_viewed_files WHERE patch_hash = 'patch'"),
        ).toEqual({ repo_id: hosted.id })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-130 AC: isolates nested repositories across provider IDs", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const github = yield* store.upsertRepository({
          localPath: noRepositoryLocalPath,
          name: "service",
          owner: "platform/backend",
          provider: "github",
          remoteUrl: "https://github.com/platform/backend/service",
        })
        const enterprise = yield* store.upsertRepository({
          localPath: noRepositoryLocalPath,
          name: "service",
          owner: "platform/backend",
          provider: "github-enterprise",
          remoteUrl: "https://git.example.com/platform/backend/service",
        })
        const legacyLocal = yield* store.upsertRepository({
          localPath: repositoryLocalPath("/tmp/service"),
          name: "service-local-id",
          owner: "local",
          provider: "local",
          remoteUrl: "",
        })

        expect(github.id).toBe("github:platform/backend/service")
        expect(enterprise.id).toBe("github-enterprise:platform/backend/service")
        expect(repositorySource(github)).toBeInstanceOf(HostedRepositorySource)
        expect(repositorySource(legacyLocal)).toBeInstanceOf(LocalRepositorySource)
        expect(yield* store.list()).toHaveLength(3)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("rejects corrupt repository text, nullable, and favorite columns", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const database = yield* DatabaseService
        const repo = yield* store.upsertRepository({
          localPath: repositoryLocalPath("/tmp/corrupt-repo"),
          name: "corrupt-repo",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/corrupt-repo",
        })

        yield* database.run("UPDATE repos SET owner = x'01' WHERE id = ?", [repo.id])
        yield* database.run(
          "UPDATE repository_identities SET canonical_owner = x'01' WHERE repo_id = ?",
          [repo.id],
        )
        const corruptText = yield* Effect.either(store.list())
        expect(Either.isLeft(corruptText)).toBe(true)
        if (Either.isLeft(corruptText)) {
          expect(corruptText.left).toBeInstanceOf(RepositoryStoreError)
          expect(corruptText.left.operation).toBe("list.decode")
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
        const corruptNullable = yield* Effect.either(store.touch(repo.id))
        expect(Either.isLeft(corruptNullable)).toBe(true)
        if (Either.isLeft(corruptNullable)) {
          expect(corruptNullable.left).toBeInstanceOf(RepositoryStoreError)
          expect(corruptNullable.left.operation).toBe("getById.decode")
        }

        yield* database.run("UPDATE repos SET local_path = NULL, is_favorite = 2 WHERE id = ?", [
          repo.id,
        ])
        const corruptFavorite = yield* Effect.either(store.list())
        expect(Either.isLeft(corruptFavorite)).toBe(true)
        if (Either.isLeft(corruptFavorite)) {
          expect(corruptFavorite.left).toBeInstanceOf(RepositoryStoreError)
          expect(corruptFavorite.left.operation).toBe("list.decode")
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
