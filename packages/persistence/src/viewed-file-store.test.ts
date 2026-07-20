import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ReviewFilePatchHash } from "@diffdash/domain/review-identity"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer } from "effect"

import { DatabaseService } from "./database"
import { RepositoryStore } from "./repository-store"
import {
  type LocalViewedFileScope,
  ViewedFileStore,
  ViewedFileStoreError,
} from "./viewed-file-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  Layer.mergeAll(RepositoryStore.layer, ViewedFileStore.layer).pipe(
    Layer.provideMerge(DatabaseService.layer(databasePath)),
  )

const patchA = ReviewFilePatchHash.make("file-patch:v1:aaaaaaaaaaaaaaaa")
const patchB = ReviewFilePatchHash.make("file-patch:v1:bbbbbbbbbbbbbbbb")

describe("ViewedFileStore", () => {
  it.scoped("retains hosted viewed state only for the same base target and file patch", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const viewedFiles = yield* ViewedFileStore
        const repo = yield* repositoryStore.upsertRepository({
          localPath: null,
          name: "diffdash",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/diffdash",
        })
        const scope = { baseRefName: "main", prNumber: 51, repoId: repo.id }

        yield* viewedFiles.setHosted({
          ...scope,
          patchHash: patchA,
          reviewKey: "src/app.tsx",
          viewed: true,
        })

        expect(yield* viewedFiles.listHosted(scope)).toEqual([
          { patchHash: patchA, reviewKey: "src/app.tsx" },
        ])
        expect(yield* viewedFiles.listHosted({ ...scope, baseRefName: "release/next" })).toEqual([])

        yield* viewedFiles.setHosted({
          ...scope,
          patchHash: patchB,
          reviewKey: "src/app.tsx",
          viewed: true,
        })
        expect(yield* viewedFiles.listHosted(scope)).toEqual([
          { patchHash: patchA, reviewKey: "src/app.tsx" },
          { patchHash: patchB, reviewKey: "src/app.tsx" },
        ])

        yield* viewedFiles.setHosted({
          ...scope,
          patchHash: patchB,
          reviewKey: "src/app.tsx",
          viewed: false,
        })
        expect(yield* viewedFiles.listHosted(scope)).toEqual([
          { patchHash: patchA, reviewKey: "src/app.tsx" },
        ])
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("isolates local viewed state by source branch and comparison target", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const viewedFiles = yield* ViewedFileStore
        const repo = yield* repositoryStore.upsertRepository({
          localPath: "/repo",
          name: "local-repo",
          owner: "local",
          provider: "local",
          remoteUrl: "file:///repo",
        })
        const scope: LocalViewedFileScope = {
          comparisonKind: "branch",
          comparisonTarget: "main",
          repoId: repo.id,
          sourceIdentity: "branch:feature/auth",
        }

        yield* viewedFiles.setLocal({
          ...scope,
          patchHash: patchA,
          reviewKey: "src/auth.ts",
          viewed: true,
        })

        expect(yield* viewedFiles.listLocal(scope)).toEqual([
          { patchHash: patchA, reviewKey: "src/auth.ts" },
        ])
        expect(
          yield* viewedFiles.listLocal({ ...scope, sourceIdentity: "branch:feature/payments" }),
        ).toEqual([])
        expect(
          yield* viewedFiles.listLocal({ ...scope, comparisonTarget: "release/next" }),
        ).toEqual([])
        expect(
          yield* viewedFiles.listLocal({
            ...scope,
            comparisonKind: "workingTree",
            comparisonTarget: "",
          }),
        ).toEqual([])
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("fully decodes hosted and local viewed-file rows", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const viewedFiles = yield* ViewedFileStore
        const database = yield* DatabaseService
        const repo = yield* repositoryStore.upsertRepository({
          localPath: "/repo",
          name: "decoded-repo",
          owner: "local",
          provider: "local",
          remoteUrl: "file:///repo",
        })
        const hostedScope = { baseRefName: "main", prNumber: 51, repoId: repo.id }
        const localScope: LocalViewedFileScope = {
          comparisonKind: "branch",
          comparisonTarget: "main",
          repoId: repo.id,
          sourceIdentity: "branch:feature/schema",
        }
        yield* viewedFiles.setHosted({
          ...hostedScope,
          patchHash: patchA,
          reviewKey: "src/hosted.ts",
          viewed: true,
        })
        yield* viewedFiles.setLocal({
          ...localScope,
          patchHash: patchB,
          reviewKey: "src/local.ts",
          viewed: true,
        })

        yield* database.run("UPDATE hosted_viewed_files SET review_key = '' WHERE repo_id = ?", [
          repo.id,
        ])
        yield* database.run("UPDATE local_viewed_files SET patch_hash = '' WHERE repo_id = ?", [
          repo.id,
        ])

        const hosted = yield* Effect.either(viewedFiles.listHosted(hostedScope))
        const local = yield* Effect.either(viewedFiles.listLocal(localScope))
        expect(Either.isLeft(hosted)).toBe(true)
        if (Either.isLeft(hosted)) {
          expect(hosted.left).toBeInstanceOf(ViewedFileStoreError)
          expect(hosted.left.operation).toBe("listHosted.decode")
        }
        expect(Either.isLeft(local)).toBe(true)
        if (Either.isLeft(local)) {
          expect(local.left).toBeInstanceOf(ViewedFileStoreError)
          expect(local.left.operation).toBe("listLocal.decode")
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
