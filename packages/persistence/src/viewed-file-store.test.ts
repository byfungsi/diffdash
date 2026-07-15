import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DatabaseService } from "./database"
import { RepositoryStore } from "./repository-store"
import { ViewedFileStore } from "./viewed-file-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  Layer.mergeAll(RepositoryStore.layer, ViewedFileStore.layer).pipe(
    Layer.provideMerge(DatabaseService.layer(databasePath)),
  )

describe("ViewedFileStore", () => {
  it.scoped("persists and clears viewed file state for a PR head", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const viewedFileStore = yield* ViewedFileStore
        const repo = yield* repositoryStore.upsertRepository({
          localPath: null,
          name: "diffdash",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/diffdash",
        })
        const key = {
          headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          prNumber: 51,
          repoId: repo.id,
        }

        yield* viewedFileStore.set({
          ...key,
          filePath: "src/app.tsx",
          reviewKey: "src/app.tsx",
          viewed: true,
        })
        const viewed = yield* viewedFileStore.list(key)
        const nextRevision = yield* viewedFileStore.list({
          ...key,
          headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        })

        yield* viewedFileStore.set({
          ...key,
          filePath: "src/app.tsx",
          reviewKey: "src/app.tsx",
          viewed: false,
        })
        const cleared = yield* viewedFileStore.list(key)

        expect(viewed).toEqual(["src/app.tsx"])
        expect(nextRevision).toEqual([])
        expect(cleared).toEqual([])
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
