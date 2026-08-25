import { Context, Effect, Layer, Match, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { createHash } from "node:crypto"
import { basename } from "node:path"

import {
  GitProviderId,
  type HostedRepositoryLocator,
  HostedRepositoryName,
  HostedRepositorySource,
  LocalRepositorySource,
  makeHostedRepositoryLocator,
  ProviderRepositoryId,
  RepositoryNamespace,
  type ResolvedHostedRepository,
} from "@diffdash/domain/git-provider"
import {
  LinkedCheckout,
  RemoteOnly,
  Repo,
  type RepositoryCheckout,
  RepositoryCheckoutPath,
  UpsertRepositoryInput,
} from "@diffdash/domain/repository"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { ReviewThreadId } from "@diffdash/domain/review-thread"
import { type Database, type DatabaseRow, makeDatabase } from "./database"

export type { ReviewProjectId } from "@diffdash/domain/review-identity"

const RepositoryRowProvider = Schema.Union([Schema.Literal("local"), GitProviderId])
type RepositoryRowProvider = typeof RepositoryRowProvider.Type

const RepoRowFields = {
  id: ReviewProjectId,
  remote_url: Schema.String,
  is_favorite: Schema.Literals([0, 1]),
  last_opened_at: Schema.NullOr(Schema.String),
  last_synced_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
} as const

const RepoRow = Schema.Union([
  Schema.Struct({
    ...RepoRowFields,
    provider: Schema.Literal("local"),
    owner: Schema.String,
    name: Schema.String,
    local_path: RepositoryCheckoutPath,
  }),
  Schema.Struct({
    ...RepoRowFields,
    provider: GitProviderId,
    owner: RepositoryNamespace,
    name: HostedRepositoryName,
    local_path: Schema.NullOr(RepositoryCheckoutPath),
  }),
])

const RepoRows = Schema.Array(RepoRow)

const LocalAliasRow = Schema.Struct({ id: ReviewProjectId })
const LocalAliasRows = Schema.Array(LocalAliasRow)
const RepositoryIdRow = Schema.Struct({ id: ReviewProjectId })
const RepositoryIdRows = Schema.Array(RepositoryIdRow)
const RepositoryCheckoutRows = Schema.Array(
  Schema.Struct({
    path: RepositoryCheckoutPath,
    remoteUrl: Schema.String,
  }),
)
const ThreadMergeRows = Schema.Array(
  Schema.Struct({ alias_thread_id: ReviewThreadId, canonical_thread_id: ReviewThreadId }),
)
const MaxSequenceRow = Schema.Struct({ max_sequence: Schema.Number })

const RepositoryStoreOperation = Schema.Literals([
  "getById.query",
  "getById.notFound",
  "getById.decode",
  "findByLocalPath.legacyQuery",
  "findByLocalPath.legacyDecode",
  "list.query",
  "list.decode",
  "findByLocalPath.query",
  "findByLocalPath.decode",
  "findHosted.query",
  "findHosted.decode",
  "findByProviderRepositoryId.query",
  "findByProviderRepositoryId.decode",
  "attachResolvedIdentity.stableDecode",
  "attachResolvedIdentity.checkoutDecode",
  "attachResolvedIdentity",
  "reconcileLocalAliases",
  "repairLocalAliases",
  "setIdentityRepairStatus",
  "upsertRepository",
  "upsertRepository.identity",
  "setFavorite",
  "touch",
  "forget",
  "listCheckouts.query",
  "listCheckouts.decode",
  "reconcileCheckouts",
  "reconcileLocalAliases.canonicalNotFound",
  "mergeThreadConversation.maxSequenceNotFound",
])
type RepositoryStoreOperation = typeof RepositoryStoreOperation.Type

/** Counts local repository aliases matched, removed, or retained during reconciliation. */
export interface ReconcileLocalAliasesResult {
  readonly matchedAliasCount: number
  readonly removedAliasCount: number
  readonly preservedAliasCount: number
}

/** One persisted checkout candidate for repository availability recovery. */
export class RepositoryCheckoutRecord extends Schema.Class<RepositoryCheckoutRecord>(
  "RepositoryCheckoutRecord",
)({
  path: RepositoryCheckoutPath,
  remoteUrl: Schema.String,
}) {}

/** A typed failure from repository persistence operations. */
export class RepositoryStoreError extends Schema.TaggedError<RepositoryStoreError>()(
  "RepositoryStoreError",
  {
    operation: RepositoryStoreOperation,
    cause: Schema.ErrorInstance(),
  },
) {}

/** Domain-oriented persistence service for local and remote-only repositories. */
export class RepositoryStore extends Context.Service<
  RepositoryStore,
  {
    readonly getById: (id: ReviewProjectId) => Effect.Effect<Repo, RepositoryStoreError>
    readonly list: (query?: string) => Effect.Effect<readonly Repo[], RepositoryStoreError>
    /** Finds the preferred persisted repository for a local checkout path. */
    readonly findByLocalPath: (
      localPath: RepositoryCheckoutPath,
    ) => Effect.Effect<Option.Option<Repo>, RepositoryStoreError>
    /** Finds a canonical repository by its current case-insensitive hosted locator. */
    readonly findHosted: (
      repository: HostedRepositoryLocator,
    ) => Effect.Effect<Option.Option<Repo>, RepositoryStoreError>
    /** Finds a canonical repository by a provider-owned stable identifier. */
    readonly findByProviderRepositoryId: (
      providerId: GitProviderId,
      providerRepositoryId: ProviderRepositoryId,
    ) => Effect.Effect<Option.Option<Repo>, RepositoryStoreError>
    /** Records authoritative provider identity and binds an optional checkout. */
    readonly attachResolvedIdentity: (
      repoId: ReviewProjectId,
      resolved: ResolvedHostedRepository,
      checkout: RepositoryCheckout,
    ) => Effect.Effect<Repo, RepositoryStoreError>
    /** Moves legacy local-project data to a canonical hosted project when collisions permit. */
    readonly reconcileLocalAliases: (
      canonicalProjectId: ReviewProjectId,
      localPath: RepositoryCheckoutPath,
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
      id: ReviewProjectId,
      isFavorite: boolean,
    ) => Effect.Effect<Repo, RepositoryStoreError>
    readonly touch: (id: ReviewProjectId) => Effect.Effect<Repo, RepositoryStoreError>
    /** Lists every checkout path previously associated with a repository. */
    readonly listCheckouts: (
      id: ReviewProjectId,
    ) => Effect.Effect<readonly RepositoryCheckoutRecord[], RepositoryStoreError>
    /** Atomically replaces a hosted repository's surviving checkout catalog and preference. */
    readonly reconcileCheckouts: (
      id: ReviewProjectId,
      surviving: readonly RepositoryCheckoutRecord[],
      preferredPath: Option.Option<RepositoryCheckoutPath>,
    ) => Effect.Effect<Repo, RepositoryStoreError>
    /** Hides a project from Home without deleting its repository or related records. */
    readonly forget: (id: ReviewProjectId) => Effect.Effect<Repo, RepositoryStoreError>
  }
>()("@diffdash/RepositoryStore") {
  static readonly layer = Layer.effect(
    RepositoryStore,
    Effect.gen(function* () {
      const database = makeDatabase(yield* SqlClient.SqlClient)

      const getById = (id: ReviewProjectId) =>
        database.get(`${repoSelectSql} WHERE r.id = ${canonicalRepositoryIdSql}`, [id, id]).pipe(
          Effect.mapError((cause) =>
            RepositoryStoreError.make({ operation: "getById.query", cause }),
          ),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                RepositoryStoreError.make({
                  operation: "getById.notFound",
                  cause: new Error(`Repo not found: ${id}`),
                }),
              onSome: (row) => decodeRepo("getById.decode", row),
            }),
          ),
        )

      const findLegacyByLocalPath = (localPath: RepositoryCheckoutPath) =>
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
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(Option.none<Repo>()),
                onSome: (id) => getById(id).pipe(Effect.map(Option.some)),
              }),
            ),
          )

      const recordCompatibilityIdentity = (
        id: ReviewProjectId,
        row: RepositoryCompatibilityInput,
        now: string,
      ) =>
        Effect.gen(function* () {
          if (row.provider !== "local") {
            yield* database.run(
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
              [id, row.provider, row.owner, row.name, row.remoteUrl, now],
            )
          }
          if (row.localPath !== null) {
            yield* database.run(
              `INSERT INTO repository_checkouts (local_path, repo_id, remote_url, last_seen_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(local_path) DO UPDATE SET
                 repo_id = excluded.repo_id,
                 remote_url = excluded.remote_url,
                 last_seen_at = excluded.last_seen_at
               WHERE (SELECT provider FROM repos WHERE id = repository_checkouts.repo_id) = 'local'
                  OR ? <> 'local'`,
              [row.localPath, id, row.remoteUrl, now, row.provider],
            )
          }
        })

      return RepositoryStore.of({
        getById: Effect.fn("RepositoryStore.getById")(getById),
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
              Effect.flatMap(
                Option.match({
                  onNone: () => findLegacyByLocalPath(localPath),
                  onSome: (id) => getById(id).pipe(Effect.map(Option.some)),
                }),
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
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeed(Option.none<Repo>()),
                  onSome: (id) => getById(id).pipe(Effect.map(Option.some)),
                }),
              ),
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
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.succeed(Option.none<Repo>()),
                    onSome: (id) => getById(id).pipe(Effect.map(Option.some)),
                  }),
                ),
              )
          },
        ),
        attachResolvedIdentity: Effect.fn("RepositoryStore.attachResolvedIdentity")(
          function (repoId, resolved, checkout) {
            const localPath = Schema.is(LinkedCheckout)(checkout) ? checkout.path : null
            return database
              .transaction(
                Effect.gen(function* () {
                  const stable =
                    resolved.providerRepositoryId === null
                      ? Option.none()
                      : yield* database.get(
                          `SELECT repo_id AS id FROM repository_identities
                         WHERE provider_id = ? AND provider_repository_id = ?`,
                          [resolved.locator.providerId, resolved.providerRepositoryId],
                        )
                  const stableId = yield* decodeOptionalRepositoryId(
                    "attachResolvedIdentity.stableDecode",
                    stable,
                  )
                  const canonicalId = Option.getOrElse(stableId, () => repoId)

                  const locatorRows = yield* database
                    .all(
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
                    )
                    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RepositoryIdRows)))
                  if (canonicalId !== repoId) {
                    yield* mergeRepositoryAlias(database, canonicalId, repoId, "provider")
                  }
                  for (const row of locatorRows) {
                    if (row.id !== canonicalId) {
                      yield* mergeRepositoryAlias(database, canonicalId, row.id, "locator")
                    }
                  }

                  const now = new Date().toISOString()
                  yield* database.run(
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
                  yield* database.run(
                    `UPDATE repos SET remote_url = ?, local_path = COALESCE(?, local_path),
                     updated_at = ? WHERE id = ?`,
                    [resolved.url, localPath, now, canonicalId],
                  )
                  if (localPath !== null) {
                    const previous = yield* database.get(
                      "SELECT repo_id AS id FROM repository_checkouts WHERE local_path = ?",
                      [localPath],
                    )
                    const previousId = yield* decodeOptionalRepositoryId(
                      "attachResolvedIdentity.checkoutDecode",
                      previous,
                    )
                    if (Option.isSome(previousId) && previousId.value !== canonicalId) {
                      yield* mergeRepositoryAlias(
                        database,
                        canonicalId,
                        previousId.value,
                        "checkout",
                      )
                    }
                    yield* database.run(
                      `INSERT INTO repository_checkouts (local_path, repo_id, remote_url, last_seen_at)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(local_path) DO UPDATE SET
                       repo_id = excluded.repo_id,
                       remote_url = excluded.remote_url,
                       last_seen_at = excluded.last_seen_at`,
                      [localPath, canonicalId, checkout.remoteUrl, now],
                    )
                  }
                  return canonicalId
                }),
              )
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
              .transaction(reconcileLocalAliases(database, canonicalProjectId, localPath))
              .pipe(
                Effect.mapError((cause) =>
                  RepositoryStoreError.make({ operation: "reconcileLocalAliases", cause }),
                ),
              )
          },
        ),
        repairLocalAliases: Effect.fn("RepositoryStore.repairLocalAliases")(function () {
          return database
            .transaction(
              Effect.gen(function* () {
                const pairs = yield* database
                  .all(
                    `SELECT local.id AS alias_id, hosted.id AS canonical_id
                   FROM repos AS local
                   INNER JOIN repos AS hosted ON hosted.local_path = local.local_path
                   WHERE local.provider = 'local'
                     AND hosted.provider <> 'local'
                      AND local.local_path IS NOT NULL
                    ORDER BY local.id, hosted.updated_at DESC`,
                  )
                  .pipe(
                    Effect.flatMap(
                      Schema.decodeUnknownEffect(
                        Schema.Array(
                          Schema.Struct({
                            alias_id: ReviewProjectId,
                            canonical_id: ReviewProjectId,
                          }),
                        ),
                      ),
                    ),
                  )
                let removedAliasCount = 0
                for (const pair of pairs) {
                  const removed = yield* mergeRepositoryAlias(
                    database,
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
              }),
            )
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
          const row = encodeRepositoryCompatibilityInput(input)
          const id = repoId(row.provider, row.owner, row.name)
          const now = new Date().toISOString()
          return database
            .transaction(
              Effect.gen(function* () {
                yield* database
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
                      row.provider,
                      row.owner,
                      row.name,
                      row.remoteUrl,
                      row.localPath,
                      input.favorite === "mark" ? 1 : 0,
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
                  )
                yield* recordCompatibilityIdentity(id, row, now).pipe(
                  Effect.mapError((cause) =>
                    RepositoryStoreError.make({ operation: "upsertRepository.identity", cause }),
                  ),
                )
                return yield* getById(id)
              }),
            )
            .pipe(
              Effect.mapError((cause) =>
                Schema.is(RepositoryStoreError)(cause)
                  ? cause
                  : RepositoryStoreError.make({ operation: "upsertRepository", cause }),
              ),
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
        listCheckouts: Effect.fn("RepositoryStore.listCheckouts")(function (id) {
          return database
            .all(
              `SELECT local_path AS path, remote_url AS remoteUrl
               FROM repository_checkouts
               WHERE repo_id = ?
               UNION
               SELECT local_path AS path, remote_url AS remoteUrl
               FROM repos
               WHERE id = ? AND local_path IS NOT NULL`,
              [id, id],
            )
            .pipe(
              Effect.flatMap((rows) =>
                Schema.decodeUnknownEffect(RepositoryCheckoutRows)(rows).pipe(
                  Effect.mapError((cause) =>
                    RepositoryStoreError.make({ operation: "listCheckouts.decode", cause }),
                  ),
                ),
              ),
              Effect.map((rows) => rows.map((row) => RepositoryCheckoutRecord.make(row))),
            )
            .pipe(
              Effect.mapError((cause) =>
                Match.value(cause).pipe(
                  Match.when(Schema.is(RepositoryStoreError), (error) => error),
                  Match.orElse((queryError) =>
                    RepositoryStoreError.make({
                      operation: "listCheckouts.query",
                      cause: queryError,
                    }),
                  ),
                ),
              ),
            )
        }),
        reconcileCheckouts: Effect.fn("RepositoryStore.reconcileCheckouts")(
          function (id, surviving, preferredPath) {
            return database
              .transaction(
                Effect.gen(function* () {
                  yield* database.run("DELETE FROM repository_checkouts WHERE repo_id = ?", [id])
                  const nowMs = Date.now()
                  const now = new Date(nowMs).toISOString()
                  const survivingSeenAt = new Date(nowMs - 1).toISOString()
                  for (const checkout of surviving) {
                    const lastSeenAt = Option.match(
                      Option.filter(preferredPath, (path) => path === checkout.path),
                      {
                        onNone: () => survivingSeenAt,
                        onSome: () => now,
                      },
                    )
                    yield* database.run(
                      `INSERT INTO repository_checkouts (
                         local_path, repo_id, remote_url, last_seen_at
                       ) VALUES (?, ?, ?, ?)
                       ON CONFLICT(local_path) DO UPDATE SET
                         repo_id = excluded.repo_id,
                         remote_url = excluded.remote_url,
                         last_seen_at = excluded.last_seen_at`,
                      [checkout.path, id, checkout.remoteUrl, lastSeenAt],
                    )
                  }
                  yield* database.run(
                    `UPDATE repos
                     SET local_path = ?, updated_at = ?
                     WHERE id = ? AND provider <> 'local'`,
                    [Option.getOrNull(preferredPath), now, id],
                  )
                }),
              )
              .pipe(Effect.andThen(getById(id)))
              .pipe(
                Effect.mapError((cause) =>
                  Match.value(cause).pipe(
                    Match.when(Schema.is(RepositoryStoreError), (error) => error),
                    Match.orElse((transactionError) =>
                      RepositoryStoreError.make({
                        operation: "reconcileCheckouts",
                        cause: transactionError,
                      }),
                    ),
                  ),
                ),
              )
          },
        ),
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
  database: Database,
  canonicalProjectId: ReviewProjectId,
  localPath: RepositoryCheckoutPath,
) =>
  Effect.gen(function* () {
    const canonical = yield* database.get(
      "SELECT id FROM repos WHERE id = ? AND provider <> 'local'",
      [canonicalProjectId],
    )
    if (Option.isNone(canonical)) {
      return yield* RepositoryStoreError.make({
        operation: "reconcileLocalAliases.canonicalNotFound",
        cause: new Error(`Canonical hosted repository not found: ${canonicalProjectId}`),
      })
    }

    const aliases = yield* database
      .all(
        `SELECT id FROM repos
       WHERE provider = 'local' AND local_path = ? AND id <> ?
       ORDER BY id ASC`,
        [localPath, canonicalProjectId],
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(LocalAliasRows)))
    let removedAliasCount = 0

    for (const alias of aliases) {
      if (yield* mergeRepositoryAlias(database, canonicalProjectId, alias.id, "checkout")) {
        removedAliasCount += 1
      }
    }

    return {
      matchedAliasCount: aliases.length,
      removedAliasCount,
      preservedAliasCount: aliases.length - removedAliasCount,
    }
  })

const mergeRepositoryAlias = (
  database: Database,
  canonicalProjectId: ReviewProjectId,
  aliasProjectId: ReviewProjectId,
  reason: "checkout" | "locator" | "provider",
) =>
  Effect.gen(function* () {
    if (canonicalProjectId === aliasProjectId) return false
    const canonical = yield* database.get("SELECT id FROM repos WHERE id = ?", [canonicalProjectId])
    const alias = yield* database.get("SELECT id FROM repos WHERE id = ?", [aliasProjectId])
    if (Option.isNone(canonical) || Option.isNone(alias)) return Option.isNone(alias)

    yield* database.run("DELETE FROM repository_identities WHERE repo_id = ?", [aliasProjectId])
    yield* database.run(
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
    yield* moveAliasRows(database, canonicalProjectId, aliasProjectId)
    yield* database.run("UPDATE repository_checkouts SET repo_id = ? WHERE repo_id = ?", [
      canonicalProjectId,
      aliasProjectId,
    ])
    yield* database.run(
      `DELETE FROM repos
     WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM pull_requests WHERE repo_id = ?)
        AND NOT EXISTS (SELECT 1 FROM walkthroughs WHERE repo_id = ?)
        AND NOT EXISTS (SELECT 1 FROM walkthrough_operations WHERE repo_id = ?)
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
        aliasProjectId,
      ],
    )
    const removed = Option.isNone(
      yield* database.get("SELECT 1 FROM repos WHERE id = ?", [aliasProjectId]),
    )
    if (!removed) {
      yield* database.run(
        `INSERT INTO repository_aliases (alias_repo_id, canonical_repo_id, reason, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(alias_repo_id) DO UPDATE SET
         canonical_repo_id = excluded.canonical_repo_id,
         reason = excluded.reason`,
        [aliasProjectId, canonicalProjectId, reason, new Date().toISOString()],
      )
    }
    return removed
  })

/** Merges collisions by newest durable timestamp, retaining canonical data on exact ties. */
const moveAliasRows = (
  database: Database,
  canonicalProjectId: ReviewProjectId,
  aliasProjectId: ReviewProjectId,
) =>
  Effect.gen(function* () {
    yield* database.run(
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
    yield* database.run("DELETE FROM pull_requests WHERE repo_id = ?", [aliasProjectId])

    yield* database.run(
      `INSERT INTO walkthroughs (
        repo_id, pr_number, review_key, base_sha, head_sha, prompt_version, content_json, created_at
      )
      SELECT ?, pr_number, review_key, base_sha, head_sha, prompt_version, content_json, created_at
      FROM walkthroughs WHERE repo_id = ?
      ON CONFLICT(repo_id, review_key, base_sha, head_sha, prompt_version) DO UPDATE SET
        pr_number = excluded.pr_number,
        content_json = excluded.content_json,
        created_at = excluded.created_at
      WHERE excluded.created_at > walkthroughs.created_at`,
      [canonicalProjectId, aliasProjectId],
    )
    const now = new Date().toISOString()
    yield* database.run(
      `UPDATE walkthrough_operations AS alias_operation
     SET state = 'superseded',
         state_version = state_version + 1,
         superseded_by_operation_id = (
           SELECT canonical_operation.id
           FROM walkthrough_operations AS canonical_operation
           WHERE canonical_operation.repo_id = ?
             AND canonical_operation.review_key = alias_operation.review_key
             AND canonical_operation.base_sha = alias_operation.base_sha
             AND canonical_operation.head_sha = alias_operation.head_sha
             AND canonical_operation.prompt_version = alias_operation.prompt_version
             AND canonical_operation.state IN ('accepted', 'running')
           ORDER BY canonical_operation.accepted_at DESC, canonical_operation.id
           LIMIT 1
         ),
         terminal_at = ?,
         updated_at = ?
     WHERE alias_operation.repo_id = ?
       AND alias_operation.state IN ('accepted', 'running')
       AND EXISTS (
         SELECT 1
         FROM walkthrough_operations AS canonical_operation
         WHERE canonical_operation.repo_id = ?
           AND canonical_operation.review_key = alias_operation.review_key
           AND canonical_operation.base_sha = alias_operation.base_sha
           AND canonical_operation.head_sha = alias_operation.head_sha
           AND canonical_operation.prompt_version = alias_operation.prompt_version
           AND canonical_operation.state IN ('accepted', 'running')
       )`,
      [canonicalProjectId, now, now, aliasProjectId, canonicalProjectId],
    )
    yield* database.run(
      `UPDATE walkthrough_operations
     SET repo_id = ?,
         artifact_repo_id = CASE WHEN artifact_repo_id IS NULL THEN NULL ELSE ? END
     WHERE repo_id = ?`,
      [canonicalProjectId, canonicalProjectId, aliasProjectId],
    )
    yield* database.run("DELETE FROM walkthroughs WHERE repo_id = ?", [aliasProjectId])

    const threadMerges = yield* database
      .all(
        `SELECT alias_thread.id AS alias_thread_id,
              canonical_thread.id AS canonical_thread_id
       FROM review_threads AS alias_thread
       INNER JOIN review_threads AS canonical_thread
         ON canonical_thread.repo_id = ?
        AND canonical_thread.review_key = alias_thread.review_key
        AND canonical_thread.original_anchor_json = alias_thread.original_anchor_json
       WHERE alias_thread.repo_id = ?`,
        [canonicalProjectId, aliasProjectId],
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ThreadMergeRows)))
    if (threadMerges.length > 0) yield* database.run("PRAGMA defer_foreign_keys = ON")
    for (const merge of threadMerges) yield* mergeThreadConversation(database, merge)
    yield* database.run("UPDATE review_threads SET repo_id = ? WHERE repo_id = ?", [
      canonicalProjectId,
      aliasProjectId,
    ])

    yield* database.run(
      `INSERT INTO hosted_viewed_files (
        repo_id, pr_number, base_ref_name, review_key, patch_hash, viewed_at
      )
      SELECT ?, pr_number, base_ref_name, review_key, patch_hash, viewed_at
      FROM hosted_viewed_files WHERE repo_id = ?
      ON CONFLICT(repo_id, pr_number, base_ref_name, review_key, patch_hash) DO UPDATE SET
        viewed_at = excluded.viewed_at
      WHERE excluded.viewed_at > hosted_viewed_files.viewed_at`,
      [canonicalProjectId, aliasProjectId],
    )
    yield* database.run("DELETE FROM hosted_viewed_files WHERE repo_id = ?", [aliasProjectId])

    yield* database.run(
      `INSERT INTO local_viewed_files (
        repo_id, source_identity, comparison_kind, comparison_target,
        review_key, patch_hash, viewed_at
      )
      SELECT ?, source_identity, comparison_kind, comparison_target,
             review_key, patch_hash, viewed_at
      FROM local_viewed_files WHERE repo_id = ?
      ON CONFLICT(
        repo_id, source_identity, comparison_kind, comparison_target, review_key, patch_hash
      ) DO UPDATE SET viewed_at = excluded.viewed_at
      WHERE excluded.viewed_at > local_viewed_files.viewed_at`,
      [canonicalProjectId, aliasProjectId],
    )
    yield* database.run("DELETE FROM local_viewed_files WHERE repo_id = ?", [aliasProjectId])

    yield* database.run(
      `INSERT INTO project_workspace_state (
        repo_id, active_surface, active_activity,
        navigation_contribution_id, navigation_location_json, updated_at
      )
      SELECT ?, active_surface, active_activity,
             navigation_contribution_id, navigation_location_json, updated_at
     FROM project_workspace_state WHERE repo_id = ?
     ON CONFLICT(repo_id) DO UPDATE SET
       active_surface = excluded.active_surface,
       active_activity = excluded.active_activity,
        navigation_contribution_id = excluded.navigation_contribution_id,
        navigation_location_json = excluded.navigation_location_json,
       updated_at = excluded.updated_at
     WHERE excluded.updated_at > project_workspace_state.updated_at`,
      [canonicalProjectId, aliasProjectId],
    )
    yield* database.run("DELETE FROM project_workspace_state WHERE repo_id = ?", [aliasProjectId])
  })

const mergeThreadConversation = (
  database: Database,
  merge: {
    readonly alias_thread_id: ReviewThreadId
    readonly canonical_thread_id: ReviewThreadId
  },
) =>
  Effect.gen(function* () {
    const maxSequenceRow = yield* database.get(
      `SELECT COALESCE(MAX(sequence), 0) AS max_sequence
       FROM review_thread_messages WHERE thread_id = ?`,
      [merge.canonical_thread_id],
    )
    const maxSequence = yield* Option.match(maxSequenceRow, {
      onNone: () =>
        RepositoryStoreError.make({
          operation: "mergeThreadConversation.maxSequenceNotFound",
          cause: new Error(`Thread not found: ${merge.canonical_thread_id}`),
        }),
      onSome: Schema.decodeUnknownEffect(MaxSequenceRow),
    })
    yield* database.run(
      `UPDATE review_thread_messages
     SET sequence = sequence + ?, thread_id = ?
     WHERE thread_id = ?`,
      [maxSequence.max_sequence, merge.canonical_thread_id, merge.alias_thread_id],
    )
    yield* database.run("UPDATE agent_run_artifacts SET thread_id = ? WHERE thread_id = ?", [
      merge.canonical_thread_id,
      merge.alias_thread_id,
    ])
    yield* database.run("UPDATE agent_runs SET thread_id = ? WHERE thread_id = ?", [
      merge.canonical_thread_id,
      merge.alias_thread_id,
    ])
    const canonicalMemory = yield* database.get("SELECT 1 FROM thread_memory WHERE thread_id = ?", [
      merge.canonical_thread_id,
    ])
    if (Option.isNone(canonicalMemory)) {
      yield* database.run("UPDATE thread_memory SET thread_id = ? WHERE thread_id = ?", [
        merge.canonical_thread_id,
        merge.alias_thread_id,
      ])
    } else {
      yield* database.run("DELETE FROM thread_memory WHERE thread_id = ?", [merge.alias_thread_id])
    }
    yield* database.run("DELETE FROM review_threads WHERE id = ?", [merge.alias_thread_id])
  })

const repoId = (provider: RepositoryRowProvider, owner: string, name: string): ReviewProjectId =>
  ReviewProjectId.make(
    provider === "local"
      ? `${provider}:${owner}/${name}`
      : `${provider}:${normalizeIdentityPart(owner)}/${normalizeIdentityPart(name)}`,
  )

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
    source:
      row.provider === "local"
        ? LocalRepositorySource.make()
        : HostedRepositorySource.make({
            locator: makeHostedRepositoryLocator(row.provider, row.owner, row.name),
          }),
    checkout:
      row.local_path === null
        ? RemoteOnly.make({ remoteUrl: row.remote_url })
        : LinkedCheckout.make({ remoteUrl: row.remote_url, path: row.local_path }),
    isFavorite: row.is_favorite === 1,
    lastOpenedAt: row.last_opened_at,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

interface RepositoryCompatibilityInput {
  readonly provider: RepositoryRowProvider
  readonly owner: string
  readonly name: string
  readonly remoteUrl: string
  readonly localPath: RepositoryCheckoutPath | null
}

const encodeRepositoryCompatibilityInput = (
  input: UpsertRepositoryInput,
): RepositoryCompatibilityInput => {
  const localPath = Schema.is(LinkedCheckout)(input.checkout) ? input.checkout.path : null
  if (Schema.is(HostedRepositorySource)(input.source)) {
    return {
      provider: input.source.locator.providerId,
      owner: input.source.locator.namespace,
      name: input.source.locator.name,
      remoteUrl: input.checkout.remoteUrl,
      localPath,
    }
  }

  if (localPath === null) {
    throw new Error("Validated local repository input did not include a linked checkout")
  }
  const path = localPath
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 12)
  return {
    provider: "local",
    owner: "local",
    name: `${basename(path) || "repository"}-${hash}`,
    remoteUrl: input.checkout.remoteUrl,
    localPath: path,
  }
}

const decodeRepo = (operation: RepositoryStoreOperation, input: DatabaseRow) =>
  Schema.decodeUnknownEffect(RepoRow)(input).pipe(
    Effect.map(toRepo),
    Effect.mapError((cause) => RepositoryStoreError.make({ operation, cause })),
  )

const decodeRepos = (operation: RepositoryStoreOperation, input: readonly DatabaseRow[]) =>
  Schema.decodeUnknownEffect(RepoRows)(input).pipe(
    Effect.map((rows) => rows.map(toRepo)),
    Effect.mapError((cause) => RepositoryStoreError.make({ operation, cause })),
  )

const decodeOptionalRepositoryId = (
  operation: RepositoryStoreOperation,
  input: Option.Option<DatabaseRow>,
): Effect.Effect<Option.Option<ReviewProjectId>, RepositoryStoreError> =>
  Option.map(input, (row) =>
    Schema.decodeUnknownEffect(RepositoryIdRow)(row).pipe(Effect.map(({ id }) => id)),
  ).pipe(
    Effect.transposeOption,
    Effect.mapError((cause) => RepositoryStoreError.make({ operation, cause })),
  )
