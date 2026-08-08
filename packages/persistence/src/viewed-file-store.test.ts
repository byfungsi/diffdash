import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ReviewFilePatchHash } from "@diffdash/domain/review-identity"
import { noRepositoryLocalPath, repositoryLocalPath } from "@diffdash/domain/repository"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Layer } from "effect"

import { DatabaseService } from "./database"
import { RepositoryStore } from "./repository-store"
import { LocalViewedFileScope, ViewedFileStore, ViewedFileStoreError } from "./viewed-file-store"

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
  it.effect("retains hosted viewed state only for the same base target and file patch", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const viewedFiles = yield* ViewedFileStore
        const repo = yield* repositoryStore.upsertRepository({
          localPath: noRepositoryLocalPath,
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

  it.effect("isolates local viewed state by source branch and comparison target", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const viewedFiles = yield* ViewedFileStore
        const repo = yield* repositoryStore.upsertRepository({
          localPath: repositoryLocalPath("/repo"),
          name: "local-repo",
          owner: "local",
          provider: "local",
          remoteUrl: "file:///repo",
        })
        const scope = LocalViewedFileScope.make({
          comparisonKind: "branch",
          comparisonTarget: "main",
          repoId: repo.id,
          sourceIdentity: "branch:feature/auth",
        })

        yield* viewedFiles.setLocal(scope, {
          patchHash: patchA,
          reviewKey: "src/auth.ts",
          viewed: true,
        })

        expect(yield* viewedFiles.listLocal(scope)).toEqual([
          { patchHash: patchA, reviewKey: "src/auth.ts" },
        ])
        expect(
          yield* viewedFiles.listLocal(
            LocalViewedFileScope.make({
              ...scope,
              sourceIdentity: "branch:feature/payments",
            }),
          ),
        ).toEqual([])
        expect(
          yield* viewedFiles.listLocal(
            LocalViewedFileScope.make({ ...scope, comparisonTarget: "release/next" }),
          ),
        ).toEqual([])
        expect(
          yield* viewedFiles.listLocal(
            LocalViewedFileScope.make({
              ...scope,
              comparisonKind: "workingTree",
              comparisonTarget: "",
            }),
          ),
        ).toEqual([])
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("isolates repository-comparison viewed state by immutable head identity", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const viewedFiles = yield* ViewedFileStore
        const repo = yield* repositoryStore.upsertRepository({
          localPath: repositoryLocalPath("/repo"),
          name: "diffdash",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/diffdash",
        })
        const scope = LocalViewedFileScope.make({
          comparisonKind: "repositoryComparison",
          comparisonTarget: "b".repeat(40),
          repoId: repo.id,
          sourceIdentity: `comparison:repository-comparison:v1:${repo.id}:${"a".repeat(40)}:${"b".repeat(40)}:${"c".repeat(40)}`,
        })

        yield* viewedFiles.setLocal(scope, {
          patchHash: patchA,
          reviewKey: "src/app.tsx",
          viewed: true,
        })

        expect(yield* viewedFiles.listLocal(scope)).toEqual([
          { patchHash: patchA, reviewKey: "src/app.tsx" },
        ])
        expect(
          yield* viewedFiles.listLocal(
            LocalViewedFileScope.make({ ...scope, comparisonTarget: "d".repeat(40) }),
          ),
        ).toEqual([])
        expect(
          yield* viewedFiles.listLocal(
            LocalViewedFileScope.make({
              ...scope,
              sourceIdentity: scope.sourceIdentity.replace(
                `:${"c".repeat(40)}`,
                `:${"d".repeat(40)}`,
              ),
            }),
          ),
        ).toEqual([])
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("fully decodes hosted and local viewed-file rows", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const viewedFiles = yield* ViewedFileStore
        const database = yield* DatabaseService
        const repo = yield* repositoryStore.upsertRepository({
          localPath: repositoryLocalPath("/repo"),
          name: "decoded-repo",
          owner: "local",
          provider: "local",
          remoteUrl: "file:///repo",
        })
        const hostedScope = { baseRefName: "main", prNumber: 51, repoId: repo.id }
        const localScope = LocalViewedFileScope.make({
          comparisonKind: "branch",
          comparisonTarget: "main",
          repoId: repo.id,
          sourceIdentity: "branch:feature/schema",
        })
        yield* viewedFiles.setHosted({
          ...hostedScope,
          patchHash: patchA,
          reviewKey: "src/hosted.ts",
          viewed: true,
        })
        yield* viewedFiles.setLocal(localScope, {
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

        const hosted = yield* Effect.result(viewedFiles.listHosted(hostedScope))
        const local = yield* Effect.result(viewedFiles.listLocal(localScope))
        expect(Result.isFailure(hosted)).toBe(true)
        if (Result.isFailure(hosted)) {
          expect(hosted.failure).toBeInstanceOf(ViewedFileStoreError)
          expect(hosted.failure.operation).toBe("listHosted.decode")
        }
        expect(Result.isFailure(local)).toBe(true)
        if (Result.isFailure(local)) {
          expect(local.failure).toBeInstanceOf(ViewedFileStoreError)
          expect(local.failure.operation).toBe("listLocal.decode")
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
