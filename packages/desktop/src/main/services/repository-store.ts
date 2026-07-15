import { Context, Effect, Layer, Schema } from "effect"

import { Repo, type RepoProvider, type UpsertRepositoryInput } from "@diffdash/domain/repository"
import { DatabaseService } from "./database"

interface RepoRow {
  readonly id: string
  readonly provider: RepoProvider
  readonly owner: string
  readonly name: string
  readonly remote_url: string
  readonly local_path: string | null
  readonly is_favorite: 0 | 1
  readonly last_opened_at: string | null
  readonly last_synced_at: string | null
  readonly created_at: string
  readonly updated_at: string
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
    readonly upsertRepository: (
      input: UpsertRepositoryInput,
    ) => Effect.Effect<Repo, RepositoryStoreError>
    readonly setFavorite: (
      id: string,
      isFavorite: boolean,
    ) => Effect.Effect<Repo, RepositoryStoreError>
    readonly touch: (id: string) => Effect.Effect<Repo, RepositoryStoreError>
  }
>() {
  static readonly layer = Layer.effect(
    RepositoryStore,
    Effect.gen(function* () {
      const database = yield* DatabaseService

      const getById = (id: string) =>
        database.get<RepoRow>("SELECT * FROM repos WHERE id = ?", [id]).pipe(
          Effect.mapError((cause) => RepositoryStoreError.make({ operation: "getById", cause })),
          Effect.flatMap((row) =>
            row === undefined
              ? RepositoryStoreError.make({
                  operation: "getById",
                  cause: new Error(`Repo not found: ${id}`),
                })
              : Effect.succeed(toRepo(row)),
          ),
        )

      return RepositoryStore.of({
        list: Effect.fn("RepositoryStore.list")(function (query?: string) {
          const search = query?.trim()
          const hasSearch = search !== undefined && search.length > 0
          const sql = hasSearch
            ? `SELECT * FROM repos
               WHERE owner LIKE ? OR name LIKE ? OR owner || '/' || name LIKE ?
               ORDER BY is_favorite DESC, last_opened_at DESC NULLS LAST, owner ASC, name ASC`
            : `SELECT * FROM repos
               ORDER BY is_favorite DESC, last_opened_at DESC NULLS LAST, owner ASC, name ASC`
          const params = hasSearch ? [`%${search}%`, `%${search}%`, `%${search}%`] : []
          return database.all<RepoRow>(sql, params).pipe(
            Effect.map((rows) => rows.map(toRepo)),
            Effect.mapError((cause) => RepositoryStoreError.make({ operation: "list", cause })),
          )
        }),
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
      })
    }),
  )
}

const repoId = (provider: RepoProvider, owner: string, name: string) =>
  `${provider}:${owner}/${name}`

const toRepo = (row: RepoRow) =>
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
