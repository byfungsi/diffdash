import { Context, Effect, Layer, Schema } from "effect"

import type {
  HostedRepositoryLocator,
  ResolvedHostedRepository,
} from "@diffdash/domain/git-provider"
import { Repo, RepoProvider, type UpsertRepositoryInput } from "@diffdash/domain/repository"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { DatabaseService, type DatabaseTransaction } from "./database"

export type { ReviewProjectId } from "@diffdash/domain/review-identity"

const RepoRow = Schema.Struct({
  id: Schema.String,
  provider: RepoProvider,
  owner: Schema.String,
  name: Schema.String,
  remote_url: Schema.String,
  local_path: Schema.NullOr(Schema.String),
  is_favorite: Schema.Literal(0, 1),
  last_opened_at: Schema.NullOr(Schema.String),
  last_synced_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
})

const RepoRows = Schema.Array(RepoRow)

const LocalAliasRow = Schema.Struct({ id: Schema.String })
const LocalAliasRows = Schema.Array(LocalAliasRow)
const RepositoryIdRow = Schema.Struct({ id: Schema.String })
const RepositoryIdRows = Schema.Array(RepositoryIdRow)
const ThreadMergeRows = Schema.Array(
  Schema.Struct({ alias_thread_id: Schema.String, canonical_thread_id: Schema.String }),
)
const MaxSequenceRow = Schema.Struct({ max_sequence: Schema.Number })

/** Counts local repository aliases matched, removed, or retained during reconciliation. */
export interface ReconcileLocalAliasesResult {
  readonly matchedAliasCount: number
  readonly removedAliasCount: number
  readonly preservedAliasCount: number
}

/** A typed failure from repository persistence operations. */
export class RepositoryStoreError extends Schema.TaggedError<RepositoryStoreError>()(
  "RepositoryStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Domain-oriented persistence service for local and remote-only repositories. */
export class RepositoryStore extends Context.Tag("@diffdash/RepositoryStore")<
  RepositoryStore,
  {
    readonly list: (query?: string) => Effect.Effect<readonly Repo[], RepositoryStoreError>
    /** Finds the preferred persisted repository for a local checkout path. */
    readonly findByLocalPath: (
      localPath: string,
    ) => Effect.Effect<Repo | null, RepositoryStoreError>
    /** Finds a canonical repository by its current case-insensitive hosted locator. */
    readonly findHosted: (
      repository: HostedRepositoryLocator,
    ) => Effect.Effect<Repo | null, RepositoryStoreError>
    /** Finds a canonical repository by a provider-owned stable identifier. */
    readonly findByProviderRepositoryId: (
      providerId: string,
      providerRepositoryId: string,
    ) => Effect.Effect<Repo | null, RepositoryStoreError>
    /** Records authoritative provider identity and binds an optional checkout. */
    readonly attachResolvedIdentity: (
      repoId: ReviewProjectId,
      resolved: ResolvedHostedRepository,
      localPath: string | null,
      remoteUrl: string,
    ) => Effect.Effect<Repo, RepositoryStoreError>
    /** Moves legacy local-project data to a canonical hosted project when collisions permit. */
    readonly reconcileLocalAliases: (
      canonicalProjectId: ReviewProjectId,
      localPath: string,
    ) => Effect.Effect<ReconcileLocalAliasesResult, RepositoryStoreError>
    /** Reconciles every deterministic local/hosted checkout alias without network access. */
    readonly repairLocalAliases: () => Effect.Effect<
      ReconcileLocalAliasesResult,
      RepositoryStoreError
    >
    /** Records resumable provider-backfill lifecycle without changing repository data. */
    readonly setIdentityRepairStatus: (
      status: "pending" | "running" | "completed" | "failed",
      error?: string,
    ) => Effect.Effect<void, RepositoryStoreError>
    readonly upsertRepository: (
      input: UpsertRepositoryInput,
    ) => Effect.Effect<Repo, RepositoryStoreError>
    readonly setFavorite: (
      id: string,
      isFavorite: boolean,
    ) => Effect.Effect<Repo, RepositoryStoreError>
    readonly touch: (id: string) => Effect.Effect<Repo, RepositoryStoreError>
    /** Hides a project from Home without deleting its repository or related records. */
    readonly forget: (id: ReviewProjectId) => Effect.Effect<Repo, RepositoryStoreError>
  }
>() {
  static readonly layer = Layer.effect(
    RepositoryStore,
    Effect.gen(function* () {
      const database = yield* DatabaseService

      const getById = (id: string) =>
        database.get(`${repoSelectSql} WHERE r.id = ${canonicalRepositoryIdSql}`, [id, id]).pipe(
          Effect.mapError((cause) =>
            RepositoryStoreError.make({ operation: "getById.query", cause }),
          ),
          Effect.flatMap((row) =>
            row === undefined
              ? RepositoryStoreError.make({
                  operation: "getById.notFound",
                  cause: new Error(`Repo not found: ${id}`),
                })
              : decodeRepo("getById.decode", row),
          ),
        )

      const findLegacyByLocalPath = (localPath: string) =>
        database
          .get(
            `SELECT r.id
             FROM repos AS r
             LEFT JOIN repository_aliases AS alias ON alias.alias_repo_id = r.id
             WHERE alias.alias_repo_id IS NULL AND r.local_path = ?
             ORDER BY CASE WHEN r.provider = 'local' THEN 1 ELSE 0 END,
               MAX(r.updated_at, COALESCE(r.last_opened_at, r.updated_at)) DESC,
               r.id
             LIMIT 1`,
            [localPath],
          )
          .pipe(
            Effect.mapError((cause) =>
              RepositoryStoreError.make({ operation: "findByLocalPath.legacyQuery", cause }),
            ),
            Effect.flatMap((row) =>
              decodeOptionalRepositoryId("findByLocalPath.legacyDecode", row),
            ),
            Effect.flatMap((id) => (id === null ? Effect.succeed(null) : getById(id))),
          )

      const recordCompatibilityIdentity = (id: string, input: UpsertRepositoryInput, now: string) =>
        database.transaction("repositories.recordCompatibilityIdentity", (transaction) => {
          if (input.provider !== "local") {
            transaction.run(
              `INSERT INTO repository_identities (
                 repo_id, provider_id, provider_repository_id, canonical_owner, canonical_name,
                 canonical_url, resolution_state, resolved_at, updated_at
               ) VALUES (?, ?, NULL, ?, ?, ?, 'parsed', NULL, ?)
               ON CONFLICT(repo_id) DO UPDATE SET
                 canonical_owner = CASE
                   WHEN repository_identities.resolution_state = 'resolved'
                     THEN repository_identities.canonical_owner
                   ELSE excluded.canonical_owner
                 END,
                 canonical_name = CASE
                   WHEN repository_identities.resolution_state = 'resolved'
                     THEN repository_identities.canonical_name
                   ELSE excluded.canonical_name
                 END,
                 canonical_url = CASE
                   WHEN repository_identities.resolution_state = 'resolved'
                     THEN repository_identities.canonical_url
                   ELSE excluded.canonical_url
                 END,
                 updated_at = excluded.updated_at`,
              [id, input.provider, input.owner, input.name, input.remoteUrl, now],
            )
          }
          if (input.localPath !== null) {
            transaction.run(
              `INSERT INTO repository_checkouts (local_path, repo_id, remote_url, last_seen_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(local_path) DO UPDATE SET
                 repo_id = excluded.repo_id,
                 remote_url = excluded.remote_url,
                 last_seen_at = excluded.last_seen_at
               WHERE (SELECT provider FROM repos WHERE id = repository_checkouts.repo_id) = 'local'
                  OR ? <> 'local'`,
              [input.localPath, id, input.remoteUrl, now, input.provider],
            )
          }
        })

      return RepositoryStore.of({
        list: Effect.fn("RepositoryStore.list")(function (query?: string) {
          const search = query?.trim()
          const hasSearch = search !== undefined && search.length > 0
          const sql = hasSearch
            ? `${repoSelectSql}
               WHERE alias.alias_repo_id IS NULL AND (
                 COALESCE(identity.canonical_owner, r.owner) LIKE ? OR
                 COALESCE(identity.canonical_name, r.name) LIKE ? OR
                 COALESCE(identity.canonical_owner, r.owner) || '/' ||
                   COALESCE(identity.canonical_name, r.name) LIKE ?
               )
               ORDER BY r.is_favorite DESC, r.last_opened_at DESC NULLS LAST,
                 owner ASC, name ASC`
            : `${repoSelectSql}
               WHERE alias.alias_repo_id IS NULL
               ORDER BY r.is_favorite DESC, r.last_opened_at DESC NULLS LAST,
                 owner ASC, name ASC`
          const params = hasSearch ? [`%${search}%`, `%${search}%`, `%${search}%`] : []
          return database.all(sql, params).pipe(
            Effect.mapError((cause) =>
              RepositoryStoreError.make({ operation: "list.query", cause }),
            ),
            Effect.flatMap((rows) => decodeRepos("list.decode", rows)),
          )
        }),
        findByLocalPath: Effect.fn("RepositoryStore.findByLocalPath")(function (localPath) {
          return database
            .get(
              `SELECT COALESCE(alias.canonical_repo_id, checkout.repo_id) AS id
               FROM repository_checkouts AS checkout
               LEFT JOIN repository_aliases AS alias ON alias.alias_repo_id = checkout.repo_id
               WHERE checkout.local_path = ?
               LIMIT 1`,
              [localPath],
            )
            .pipe(
              Effect.mapError((cause) =>
                RepositoryStoreError.make({ operation: "findByLocalPath.query", cause }),
              ),
              Effect.flatMap((row) => decodeOptionalRepositoryId("findByLocalPath.decode", row)),
              Effect.flatMap((id) =>
                id === null ? findLegacyByLocalPath(localPath) : getById(id),
              ),
            )
        }),
        findHosted: Effect.fn("RepositoryStore.findHosted")(function (repository) {
          return database
            .get(
              `SELECT r.id
               FROM repos AS r
               LEFT JOIN repository_identities AS identity ON identity.repo_id = r.id
               LEFT JOIN repository_aliases AS alias ON alias.alias_repo_id = r.id
               WHERE alias.alias_repo_id IS NULL
                 AND r.provider = ?
                 AND COALESCE(identity.canonical_owner, r.owner) = ? COLLATE NOCASE
                 AND COALESCE(identity.canonical_name, r.name) = ? COLLATE NOCASE
               LIMIT 1`,
              [repository.providerId, repository.namespace, repository.name],
            )
            .pipe(
              Effect.mapError((cause) =>
                RepositoryStoreError.make({ operation: "findHosted.query", cause }),
              ),
              Effect.flatMap((row) => decodeOptionalRepositoryId("findHosted.decode", row)),
              Effect.flatMap((id) => (id === null ? Effect.succeed(null) : getById(id))),
            )
        }),
        findByProviderRepositoryId: Effect.fn("RepositoryStore.findByProviderRepositoryId")(
          function (providerId, providerRepositoryId) {
            return database
              .get(
                `SELECT identity.repo_id AS id
                 FROM repository_identities AS identity
                 LEFT JOIN repository_aliases AS alias ON alias.alias_repo_id = identity.repo_id
                 WHERE alias.alias_repo_id IS NULL
                   AND identity.provider_id = ?
                   AND identity.provider_repository_id = ?
                 LIMIT 1`,
                [providerId, providerRepositoryId],
              )
              .pipe(
                Effect.mapError((cause) =>
                  RepositoryStoreError.make({
                    operation: "findByProviderRepositoryId.query",
                    cause,
                  }),
                ),
                Effect.flatMap((row) =>
                  decodeOptionalRepositoryId("findByProviderRepositoryId.decode", row),
                ),
                Effect.flatMap((id) => (id === null ? Effect.succeed(null) : getById(id))),
              )
          },
        ),
        attachResolvedIdentity: Effect.fn("RepositoryStore.attachResolvedIdentity")(
          function (repoId, resolved, localPath, remoteUrl) {
            return database
              .transaction("repositories.attachResolvedIdentity", (transaction) => {
                const stable =
                  resolved.providerRepositoryId === null
                    ? undefined
                    : transaction.get(
                        `SELECT repo_id AS id FROM repository_identities
                         WHERE provider_id = ? AND provider_repository_id = ?`,
                        [resolved.locator.providerId, resolved.providerRepositoryId],
                      )
                const stableId = decodeOptionalRepositoryIdSync(stable)
                let canonicalId = stableId ?? repoId

                const locatorRows = Schema.decodeUnknownSync(RepositoryIdRows)(
                  transaction.all(
                    `SELECT r.id
                     FROM repos AS r
                     LEFT JOIN repository_identities AS identity ON identity.repo_id = r.id
                     WHERE r.provider = ?
                       AND COALESCE(identity.canonical_owner, r.owner) = ? COLLATE NOCASE
                       AND COALESCE(identity.canonical_name, r.name) = ? COLLATE NOCASE
                       AND r.id <> ?`,
                    [
                      resolved.locator.providerId,
                      resolved.locator.namespace,
                      resolved.locator.name,
                      canonicalId,
                    ],
                  ),
                )
                if (canonicalId !== repoId) {
                  mergeRepositoryAlias(transaction, canonicalId, repoId, "provider")
                }
                for (const row of locatorRows) {
                  if (row.id !== canonicalId) {
                    mergeRepositoryAlias(transaction, canonicalId, row.id, "locator")
                  }
                }

                const now = new Date().toISOString()
                transaction.run(
                  `INSERT INTO repository_identities (
                     repo_id, provider_id, provider_repository_id, canonical_owner,
                     canonical_name, canonical_url, resolution_state, resolved_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, 'resolved', ?, ?)
                   ON CONFLICT(repo_id) DO UPDATE SET
                     provider_id = excluded.provider_id,
                     provider_repository_id = COALESCE(
                       excluded.provider_repository_id,
                       repository_identities.provider_repository_id
                     ),
                     canonical_owner = excluded.canonical_owner,
                     canonical_name = excluded.canonical_name,
                     canonical_url = excluded.canonical_url,
                     resolution_state = 'resolved',
                     resolved_at = excluded.resolved_at,
                     updated_at = excluded.updated_at`,
                  [
                    canonicalId,
                    resolved.locator.providerId,
                    resolved.providerRepositoryId,
                    resolved.locator.namespace,
                    resolved.locator.name,
                    resolved.url,
                    now,
                    now,
                  ],
                )
                transaction.run(
                  `UPDATE repos SET remote_url = ?, local_path = COALESCE(?, local_path),
                     updated_at = ? WHERE id = ?`,
                  [resolved.url, localPath, now, canonicalId],
                )
                if (localPath !== null) {
                  const previous = transaction.get(
                    "SELECT repo_id AS id FROM repository_checkouts WHERE local_path = ?",
                    [localPath],
                  )
                  const previousId = decodeOptionalRepositoryIdSync(previous)
                  if (previousId !== null && previousId !== canonicalId) {
                    mergeRepositoryAlias(transaction, canonicalId, previousId, "checkout")
                  }
                  transaction.run(
                    `INSERT INTO repository_checkouts (local_path, repo_id, remote_url, last_seen_at)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(local_path) DO UPDATE SET
                       repo_id = excluded.repo_id,
                       remote_url = excluded.remote_url,
                       last_seen_at = excluded.last_seen_at`,
                    [localPath, canonicalId, remoteUrl, now],
                  )
                }
                return canonicalId
              })
              .pipe(
                Effect.mapError((cause) =>
                  RepositoryStoreError.make({ operation: "attachResolvedIdentity", cause }),
                ),
                Effect.flatMap(getById),
              )
          },
        ),
        reconcileLocalAliases: Effect.fn("RepositoryStore.reconcileLocalAliases")(
          function (canonicalProjectId, localPath) {
            return database
              .transaction("repositories.reconcileLocalAliases", (transaction) =>
                reconcileLocalAliases(transaction, canonicalProjectId, localPath),
              )
              .pipe(
                Effect.mapError((cause) =>
                  RepositoryStoreError.make({ operation: "reconcileLocalAliases", cause }),
                ),
              )
          },
        ),
        repairLocalAliases: Effect.fn("RepositoryStore.repairLocalAliases")(function () {
          return database
            .transaction("repositories.repairLocalAliases", (transaction) => {
              const pairs = Schema.decodeUnknownSync(
                Schema.Array(
                  Schema.Struct({ alias_id: Schema.String, canonical_id: Schema.String }),
                ),
              )(
                transaction.all(
                  `SELECT local.id AS alias_id, hosted.id AS canonical_id
                   FROM repos AS local
                   INNER JOIN repos AS hosted ON hosted.local_path = local.local_path
                   WHERE local.provider = 'local'
                     AND hosted.provider <> 'local'
                     AND local.local_path IS NOT NULL
                   ORDER BY local.id, hosted.updated_at DESC`,
                ),
              )
              let removedAliasCount = 0
              for (const pair of pairs) {
                const removed = mergeRepositoryAlias(
                  transaction,
                  pair.canonical_id,
                  pair.alias_id,
                  "checkout",
                )
                if (removed) removedAliasCount += 1
              }
              return {
                matchedAliasCount: pairs.length,
                removedAliasCount,
                preservedAliasCount: pairs.length - removedAliasCount,
              }
            })
            .pipe(
              Effect.mapError((cause) =>
                RepositoryStoreError.make({ operation: "repairLocalAliases", cause }),
              ),
            )
        }),
        setIdentityRepairStatus: Effect.fn("RepositoryStore.setIdentityRepairStatus")(
          function (status, error) {
            return database
              .run(
                `INSERT INTO repository_identity_jobs (
                   job_name, status, cursor_repo_id, error, updated_at
                 ) VALUES ('provider-backfill', ?, NULL, ?, ?)
                 ON CONFLICT(job_name) DO UPDATE SET
                   status = excluded.status,
                   error = excluded.error,
                   updated_at = excluded.updated_at`,
                [status, error ?? null, new Date().toISOString()],
              )
              .pipe(
                Effect.mapError((cause) =>
                  RepositoryStoreError.make({ operation: "setIdentityRepairStatus", cause }),
                ),
              )
          },
        ),
        upsertRepository: Effect.fn("RepositoryStore.upsertRepository")(function (input) {
          const id = repoId(input.provider, input.owner, input.name)
          const now = new Date().toISOString()
          return database
            .run(
              `INSERT INTO repos (
              id, provider, owner, name, remote_url, local_path, is_favorite,
              last_opened_at, last_synced_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider, owner, name) DO UPDATE SET
              remote_url = excluded.remote_url,
              local_path = COALESCE(excluded.local_path, repos.local_path),
              is_favorite = CASE WHEN excluded.is_favorite = 1 THEN 1 ELSE repos.is_favorite END,
              last_opened_at = excluded.last_opened_at,
              last_synced_at = excluded.last_synced_at,
              updated_at = excluded.updated_at`,
              [
                id,
                input.provider,
                input.owner,
                input.name,
                input.remoteUrl,
                input.localPath,
                input.isFavorite === true ? 1 : 0,
                now,
                now,
                now,
                now,
              ],
            )
            .pipe(
              Effect.mapError((cause) =>
                RepositoryStoreError.make({ operation: "upsertRepository", cause }),
              ),
              Effect.flatMap(() => recordCompatibilityIdentity(id, input, now)),
              Effect.mapError((cause) =>
                RepositoryStoreError.make({ operation: "upsertRepository.identity", cause }),
              ),
              Effect.flatMap(() => getById(id)),
            )
        }),
        setFavorite: Effect.fn("RepositoryStore.setFavorite")(function (id, isFavorite) {
          return database
            .run("UPDATE repos SET is_favorite = ?, updated_at = ? WHERE id = ?", [
              isFavorite ? 1 : 0,
              new Date().toISOString(),
              id,
            ])
            .pipe(
              Effect.mapError((cause) =>
                RepositoryStoreError.make({ operation: "setFavorite", cause }),
              ),
              Effect.flatMap(() => getById(id)),
            )
        }),
        touch: Effect.fn("RepositoryStore.touch")(function (id) {
          return database
            .run("UPDATE repos SET last_opened_at = ?, updated_at = ? WHERE id = ?", [
              new Date().toISOString(),
              new Date().toISOString(),
              id,
            ])
            .pipe(
              Effect.mapError((cause) => RepositoryStoreError.make({ operation: "touch", cause })),
              Effect.flatMap(() => getById(id)),
            )
        }),
        forget: Effect.fn("RepositoryStore.forget")(function (id) {
          return database
            .run(
              "UPDATE repos SET is_favorite = 0, last_opened_at = NULL, updated_at = ? WHERE id = ?",
              [new Date().toISOString(), id],
            )
            .pipe(
              Effect.mapError((cause) => RepositoryStoreError.make({ operation: "forget", cause })),
              Effect.flatMap(() => getById(id)),
            )
        }),
      })
    }),
  )
}

const reconcileLocalAliases = (
  transaction: DatabaseTransaction,
  canonicalProjectId: ReviewProjectId,
  localPath: string,
): ReconcileLocalAliasesResult => {
  const canonical = transaction.get("SELECT id FROM repos WHERE id = ? AND provider <> 'local'", [
    canonicalProjectId,
  ])
  if (canonical === undefined) {
    throw new Error(`Canonical hosted repository not found: ${canonicalProjectId}`)
  }

  const aliases = Schema.decodeUnknownSync(LocalAliasRows)(
    transaction.all(
      `SELECT id FROM repos
       WHERE provider = 'local' AND local_path = ? AND id <> ?
       ORDER BY id ASC`,
      [localPath, canonicalProjectId],
    ),
  )
  let removedAliasCount = 0

  for (const alias of aliases) {
    if (mergeRepositoryAlias(transaction, canonicalProjectId, alias.id, "checkout")) {
      removedAliasCount += 1
    }
  }

  return {
    matchedAliasCount: aliases.length,
    removedAliasCount,
    preservedAliasCount: aliases.length - removedAliasCount,
  }
}

const mergeRepositoryAlias = (
  transaction: DatabaseTransaction,
  canonicalProjectId: string,
  aliasProjectId: string,
  reason: "checkout" | "locator" | "provider",
) => {
  if (canonicalProjectId === aliasProjectId) return false
  const canonical = transaction.get("SELECT id FROM repos WHERE id = ?", [canonicalProjectId])
  const alias = transaction.get("SELECT id FROM repos WHERE id = ?", [aliasProjectId])
  if (canonical === undefined || alias === undefined) return alias === undefined

  transaction.run("DELETE FROM repository_identities WHERE repo_id = ?", [aliasProjectId])
  transaction.run(
    `UPDATE repos AS canonical
     SET is_favorite = MAX(
           canonical.is_favorite,
           COALESCE((SELECT is_favorite FROM repos WHERE id = ?), 0)
         ),
         last_opened_at = CASE
           WHEN canonical.last_opened_at IS NULL THEN (SELECT last_opened_at FROM repos WHERE id = ?)
           WHEN (SELECT last_opened_at FROM repos WHERE id = ?) IS NULL THEN canonical.last_opened_at
           ELSE MAX(canonical.last_opened_at, (SELECT last_opened_at FROM repos WHERE id = ?))
         END,
         last_synced_at = CASE
           WHEN canonical.last_synced_at IS NULL THEN (SELECT last_synced_at FROM repos WHERE id = ?)
           WHEN (SELECT last_synced_at FROM repos WHERE id = ?) IS NULL THEN canonical.last_synced_at
           ELSE MAX(canonical.last_synced_at, (SELECT last_synced_at FROM repos WHERE id = ?))
         END,
         updated_at = MAX(canonical.updated_at, (SELECT updated_at FROM repos WHERE id = ?))
     WHERE canonical.id = ?`,
    [
      aliasProjectId,
      aliasProjectId,
      aliasProjectId,
      aliasProjectId,
      aliasProjectId,
      aliasProjectId,
      aliasProjectId,
      aliasProjectId,
      canonicalProjectId,
    ],
  )
  moveAliasRows(transaction, ReviewProjectId.make(canonicalProjectId), aliasProjectId)
  transaction.run("UPDATE repository_checkouts SET repo_id = ? WHERE repo_id = ?", [
    canonicalProjectId,
    aliasProjectId,
  ])
  transaction.run(
    `DELETE FROM repos
     WHERE id = ?
       AND NOT EXISTS (SELECT 1 FROM pull_requests WHERE repo_id = ?)
       AND NOT EXISTS (SELECT 1 FROM walkthroughs WHERE repo_id = ?)
       AND NOT EXISTS (SELECT 1 FROM review_threads WHERE repo_id = ?)
       AND NOT EXISTS (SELECT 1 FROM hosted_viewed_files WHERE repo_id = ?)
       AND NOT EXISTS (SELECT 1 FROM local_viewed_files WHERE repo_id = ?)
       AND NOT EXISTS (SELECT 1 FROM project_workspace_state WHERE repo_id = ?)`,
    [
      aliasProjectId,
      aliasProjectId,
      aliasProjectId,
      aliasProjectId,
      aliasProjectId,
      aliasProjectId,
      aliasProjectId,
    ],
  )
  const removed =
    transaction.get("SELECT 1 FROM repos WHERE id = ?", [aliasProjectId]) === undefined
  if (!removed) {
    transaction.run(
      `INSERT INTO repository_aliases (alias_repo_id, canonical_repo_id, reason, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(alias_repo_id) DO UPDATE SET
         canonical_repo_id = excluded.canonical_repo_id,
         reason = excluded.reason`,
      [aliasProjectId, canonicalProjectId, reason, new Date().toISOString()],
    )
  }
  return removed
}

const moveAliasRows = (
  transaction: DatabaseTransaction,
  canonicalProjectId: ReviewProjectId,
  aliasProjectId: string,
) => {
  transaction.run(
    `UPDATE pull_requests AS alias_pull_request
     SET repo_id = ?
     WHERE alias_pull_request.repo_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM pull_requests AS canonical_pull_request
         WHERE canonical_pull_request.repo_id = ?
           AND canonical_pull_request.number = alias_pull_request.number
       )`,
    [canonicalProjectId, aliasProjectId, canonicalProjectId],
  )
  transaction.run("DELETE FROM pull_requests WHERE repo_id = ?", [aliasProjectId])

  transaction.run(
    `INSERT OR IGNORE INTO walkthroughs (
       repo_id, pr_number, review_key, base_sha, head_sha, prompt_version, content_json, created_at
     )
     SELECT ?, pr_number, review_key, base_sha, head_sha, prompt_version, content_json, created_at
     FROM walkthroughs WHERE repo_id = ?`,
    [canonicalProjectId, aliasProjectId],
  )
  transaction.run("DELETE FROM walkthroughs WHERE repo_id = ?", [aliasProjectId])

  const threadMerges = Schema.decodeUnknownSync(ThreadMergeRows)(
    transaction.all(
      `SELECT alias_thread.id AS alias_thread_id,
              canonical_thread.id AS canonical_thread_id
       FROM review_threads AS alias_thread
       INNER JOIN review_threads AS canonical_thread
         ON canonical_thread.repo_id = ?
        AND canonical_thread.review_key = alias_thread.review_key
        AND canonical_thread.original_anchor_json = alias_thread.original_anchor_json
       WHERE alias_thread.repo_id = ?`,
      [canonicalProjectId, aliasProjectId],
    ),
  )
  if (threadMerges.length > 0) transaction.run("PRAGMA defer_foreign_keys = ON")
  for (const merge of threadMerges) mergeThreadConversation(transaction, merge)
  transaction.run("UPDATE review_threads SET repo_id = ? WHERE repo_id = ?", [
    canonicalProjectId,
    aliasProjectId,
  ])

  transaction.run(
    `INSERT OR IGNORE INTO hosted_viewed_files (
       repo_id, pr_number, base_ref_name, review_key, patch_hash, viewed_at
     )
     SELECT ?, pr_number, base_ref_name, review_key, patch_hash, viewed_at
     FROM hosted_viewed_files WHERE repo_id = ?`,
    [canonicalProjectId, aliasProjectId],
  )
  transaction.run("DELETE FROM hosted_viewed_files WHERE repo_id = ?", [aliasProjectId])

  transaction.run(
    `INSERT OR IGNORE INTO local_viewed_files (
       repo_id, source_identity, comparison_kind, comparison_target,
       review_key, patch_hash, viewed_at
     )
     SELECT ?, source_identity, comparison_kind, comparison_target,
            review_key, patch_hash, viewed_at
     FROM local_viewed_files WHERE repo_id = ?`,
    [canonicalProjectId, aliasProjectId],
  )
  transaction.run("DELETE FROM local_viewed_files WHERE repo_id = ?", [aliasProjectId])

  transaction.run(
    `INSERT INTO project_workspace_state (
       repo_id, active_ribbon, selected_review_target_json, updated_at
     )
     SELECT ?, active_ribbon, selected_review_target_json, updated_at
     FROM project_workspace_state WHERE repo_id = ?
     ON CONFLICT(repo_id) DO UPDATE SET
       active_ribbon = excluded.active_ribbon,
       selected_review_target_json = excluded.selected_review_target_json,
       updated_at = excluded.updated_at
     WHERE excluded.updated_at > project_workspace_state.updated_at`,
    [canonicalProjectId, aliasProjectId],
  )
  transaction.run("DELETE FROM project_workspace_state WHERE repo_id = ?", [aliasProjectId])
}

const mergeThreadConversation = (
  transaction: DatabaseTransaction,
  merge: { readonly alias_thread_id: string; readonly canonical_thread_id: string },
) => {
  const maxSequence = Schema.decodeUnknownSync(MaxSequenceRow)(
    transaction.get(
      `SELECT COALESCE(MAX(sequence), 0) AS max_sequence
       FROM review_thread_messages WHERE thread_id = ?`,
      [merge.canonical_thread_id],
    ),
  ).max_sequence
  transaction.run(
    `UPDATE review_thread_messages
     SET sequence = sequence + ?, thread_id = ?
     WHERE thread_id = ?`,
    [maxSequence, merge.canonical_thread_id, merge.alias_thread_id],
  )
  transaction.run("UPDATE agent_run_artifacts SET thread_id = ? WHERE thread_id = ?", [
    merge.canonical_thread_id,
    merge.alias_thread_id,
  ])
  transaction.run("UPDATE agent_runs SET thread_id = ? WHERE thread_id = ?", [
    merge.canonical_thread_id,
    merge.alias_thread_id,
  ])
  const canonicalMemory = transaction.get("SELECT 1 FROM thread_memory WHERE thread_id = ?", [
    merge.canonical_thread_id,
  ])
  if (canonicalMemory === undefined) {
    transaction.run("UPDATE thread_memory SET thread_id = ? WHERE thread_id = ?", [
      merge.canonical_thread_id,
      merge.alias_thread_id,
    ])
  } else {
    transaction.run("DELETE FROM thread_memory WHERE thread_id = ?", [merge.alias_thread_id])
  }
  transaction.run("DELETE FROM review_threads WHERE id = ?", [merge.alias_thread_id])
}

const repoId = (provider: RepoProvider, owner: string, name: string) =>
  provider === "local"
    ? `${provider}:${owner}/${name}`
    : `${provider}:${normalizeIdentityPart(owner)}/${normalizeIdentityPart(name)}`

const normalizeIdentityPart = (value: string) => value.toLocaleLowerCase("en-US")

const repoSelectSql = `SELECT
  r.id,
  r.provider,
  COALESCE(identity.canonical_owner, r.owner) AS owner,
  COALESCE(identity.canonical_name, r.name) AS name,
  COALESCE(identity.canonical_url, r.remote_url) AS remote_url,
  COALESCE(
    (
      SELECT checkout.local_path
      FROM repository_checkouts AS checkout
      WHERE checkout.repo_id = r.id
      ORDER BY checkout.last_seen_at DESC, checkout.local_path
      LIMIT 1
    ),
    r.local_path
  ) AS local_path,
  r.is_favorite,
  r.last_opened_at,
  r.last_synced_at,
  r.created_at,
  r.updated_at
FROM repos AS r
LEFT JOIN repository_identities AS identity ON identity.repo_id = r.id
LEFT JOIN repository_aliases AS alias ON alias.alias_repo_id = r.id`

const canonicalRepositoryIdSql = `COALESCE(
  (SELECT canonical_repo_id FROM repository_aliases WHERE alias_repo_id = ?),
  ?
)`

const toRepo = (row: typeof RepoRow.Type) =>
  Repo.make({
    id: row.id,
    provider: row.provider,
    owner: row.owner,
    name: row.name,
    remoteUrl: row.remote_url,
    localPath: row.local_path,
    isFavorite: row.is_favorite === 1,
    lastOpenedAt: row.last_opened_at,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

const decodeRepo = (operation: string, input: unknown) =>
  Schema.decodeUnknown(RepoRow)(input).pipe(
    Effect.map(toRepo),
    Effect.mapError((cause) => RepositoryStoreError.make({ operation, cause })),
  )

const decodeRepos = (operation: string, input: readonly unknown[]) =>
  Schema.decodeUnknown(RepoRows)(input).pipe(
    Effect.map((rows) => rows.map(toRepo)),
    Effect.mapError((cause) => RepositoryStoreError.make({ operation, cause })),
  )

const decodeOptionalRepositoryId = (operation: string, input: unknown) =>
  input === undefined
    ? Effect.succeed(null)
    : Schema.decodeUnknown(RepositoryIdRow)(input).pipe(
        Effect.map(({ id }) => id),
        Effect.mapError((cause) => RepositoryStoreError.make({ operation, cause })),
      )

const decodeOptionalRepositoryIdSync = (input: unknown) =>
  input === undefined ? null : Schema.decodeUnknownSync(RepositoryIdRow)(input).id
