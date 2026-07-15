import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DatabaseService } from "./database"
import { RepositoryStore } from "./repository-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  RepositoryStore.layer.pipe(Layer.provideMerge(DatabaseService.layer(databasePath)))

describe("RepositoryStore", () => {
  it.scoped("persists local and remote-only repositories", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const remote = yield* store.upsertRepository({
          isFavorite: true,
          localPath: null,
          name: "remote-repo",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/remote-repo",
        })
        const local = yield* store.upsertRepository({
          isFavorite: false,
          localPath: "/tmp/local-repo",
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
          localPath: null,
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

  it.scoped("upgrades a hosted favorite with its local checkout without duplicating it", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const store = yield* RepositoryStore
        const hosted = yield* store.upsertRepository({
          isFavorite: true,
          localPath: null,
          name: "diffdash",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/diffdash",
        })
        const linked = yield* store.upsertRepository({
          isFavorite: false,
          localPath: "/tmp/diffdash",
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
})
