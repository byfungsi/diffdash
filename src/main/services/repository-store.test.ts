import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { AppConfig } from "./app-config"
import { DatabaseService } from "./database"
import { RepositoryStore } from "./repository-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  RepositoryStore.layer.pipe(
    Layer.provideMerge(DatabaseService.layer),
    Layer.provide(
      AppConfig.layer({
        databasePath,
        settingsPath: join(dirname(databasePath), "settings.json"),
        tempDir: tmpdir(),
      }),
    ),
  )

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
        const repo = yield* store.upsertRepository({
          localPath: null,
          name: "searchable",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/searchable",
        })

        const updated = yield* store.setFavorite(repo.id, true)
        const matches = yield* store.list("fungsi/search")

        expect(updated.isFavorite).toBe(true)
        expect(matches).toHaveLength(1)
        expect(matches[0]?.id).toBe(repo.id)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
