import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  Walkthrough,
  WalkthroughChapter,
  WalkthroughStop,
  WalkthroughSupportItem,
  WALKTHROUGH_PROMPT_VERSION,
} from "@diffdash/domain/walkthrough"
import { DatabaseService } from "./database"
import { RepositoryStore } from "./repository-store"
import { WalkthroughStore, WalkthroughStoreError } from "./walkthrough-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  Layer.mergeAll(RepositoryStore.layer, WalkthroughStore.layer).pipe(
    Layer.provideMerge(DatabaseService.layer(databasePath)),
  )

const makeWalkthrough = (summary: string) =>
  Walkthrough.make({
    title: "Review path",
    summary,
    chapters: [
      WalkthroughChapter.make({
        id: "c1",
        title: "Runtime",
        summary: "Runtime changes.",
        stops: [
          WalkthroughStop.make({
            id: "s1",
            title: "Entry point",
            summary: "Review the entry point first.",
            risk: "critical",
            hunkIds: ["src/app.tsx:hosted-review:github:fungsi/diffdash#51:h1"],
          }),
        ],
      }),
    ],
    support: [
      WalkthroughSupportItem.make({
        id: "support-docs",
        title: "Docs",
        reason: "Documentation support.",
        hunkIds: ["docs/readme.md:hosted-review:github:fungsi/diffdash#51:h1"],
      }),
    ],
  })

const cacheKey = {
  baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  promptVersion: WALKTHROUGH_PROMPT_VERSION,
  reviewKey: "github:fungsi/diffdash#51",
}

describe("WalkthroughStore", () => {
  it.scoped("FUN-47 AC: saves and reads a walkthrough for the same cache key", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const walkthroughStore = yield* WalkthroughStore
        const repo = yield* repositoryStore.upsertRepository({
          localPath: null,
          name: "diffdash",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/diffdash",
        })
        const walkthrough = makeWalkthrough("Review the entry point first.")

        const saved = yield* walkthroughStore.save({
          ...cacheKey,
          repoId: repo.id,
          prNumber: 51,
          walkthrough,
        })
        const cached = yield* walkthroughStore.get({ ...cacheKey, repoId: repo.id })

        expect(saved.repoId).toBe(repo.id)
        expect(saved.prNumber).toBe(51)
        expect(saved.baseSha).toBe(cacheKey.baseSha)
        expect(saved.reviewKey).toBe(cacheKey.reviewKey)
        expect(cached?.walkthrough.summary).toBe("Review the entry point first.")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-47 AC: regenerate overwrites an existing walkthrough cache row", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const walkthroughStore = yield* WalkthroughStore
        const repo = yield* repositoryStore.upsertRepository({
          localPath: null,
          name: "diffdash",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/diffdash",
        })

        yield* walkthroughStore.save({
          ...cacheKey,
          repoId: repo.id,
          prNumber: 51,
          walkthrough: makeWalkthrough("First generated order."),
        })
        yield* walkthroughStore.save({
          ...cacheKey,
          repoId: repo.id,
          prNumber: 51,
          walkthrough: makeWalkthrough("Regenerated order."),
        })

        const cached = yield* walkthroughStore.get({ ...cacheKey, repoId: repo.id })

        expect(cached?.walkthrough.summary).toBe("Regenerated order.")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-47 AC: reuses migrated legacy cache rows for the same head SHA", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const walkthroughStore = yield* WalkthroughStore
        const repo = yield* repositoryStore.upsertRepository({
          localPath: null,
          name: "diffdash",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/diffdash",
        })

        yield* walkthroughStore.save({
          ...cacheKey,
          baseSha: cacheKey.headSha,
          repoId: repo.id,
          prNumber: 51,
          walkthrough: makeWalkthrough("Legacy head-only order."),
        })
        const cached = yield* walkthroughStore.get({ ...cacheKey, repoId: repo.id })

        expect(cached?.walkthrough.summary).toBe("Legacy head-only order.")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped(
    "FUN-47 AC: cache is isolated by repository, review, revision, and prompt version",
    () =>
      Effect.gen(function* () {
        const databasePath = yield* makeTempDatabasePath

        return yield* Effect.gen(function* () {
          const repositoryStore = yield* RepositoryStore
          const walkthroughStore = yield* WalkthroughStore
          const repo = yield* repositoryStore.upsertRepository({
            localPath: null,
            name: "diffdash",
            owner: "fungsi",
            provider: "github",
            remoteUrl: "https://github.com/fungsi/diffdash",
          })
          const otherRepo = yield* repositoryStore.upsertRepository({
            localPath: null,
            name: "other",
            owner: "fungsi",
            provider: "github",
            remoteUrl: "https://github.com/fungsi/other",
          })

          yield* walkthroughStore.save({
            ...cacheKey,
            repoId: repo.id,
            prNumber: 51,
            walkthrough: makeWalkthrough("Head A order."),
          })

          const matching = yield* walkthroughStore.get({ ...cacheKey, repoId: repo.id })
          const differentHead = yield* walkthroughStore.get({
            ...cacheKey,
            repoId: repo.id,
            headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          })
          const differentBase = yield* walkthroughStore.get({
            ...cacheKey,
            repoId: repo.id,
            baseSha: "cccccccccccccccccccccccccccccccccccccccc",
          })
          const differentPrompt = yield* walkthroughStore.get({
            ...cacheKey,
            repoId: repo.id,
            promptVersion: "walkthrough-future",
          })
          const differentReview = yield* walkthroughStore.get({
            ...cacheKey,
            repoId: repo.id,
            reviewKey: "github:fungsi/diffdash#52",
          })
          const differentRepository = yield* walkthroughStore.get({
            ...cacheKey,
            repoId: otherRepo.id,
          })

          expect(matching?.walkthrough.summary).toBe("Head A order.")
          expect(differentHead).toBeNull()
          expect(differentBase).toBeNull()
          expect(differentPrompt).toBeNull()
          expect(differentReview).toBeNull()
          expect(differentRepository).toBeNull()
        }).pipe(Effect.provide(makeLayer(databasePath)))
      }),
  )

  it.scoped("decodes outer walkthrough columns before content JSON", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const walkthroughStore = yield* WalkthroughStore
        const database = yield* DatabaseService
        const repo = yield* repositoryStore.upsertRepository({
          localPath: null,
          name: "corrupt-walkthrough",
          owner: "fungsi",
          provider: "github",
          remoteUrl: "https://github.com/fungsi/corrupt-walkthrough",
        })
        const key = { ...cacheKey, repoId: repo.id }
        yield* walkthroughStore.save({
          ...key,
          prNumber: 51,
          walkthrough: makeWalkthrough("Corrupt after save."),
        })
        yield* database.run(
          "UPDATE walkthroughs SET pr_number = 1.5, content_json = 'not-json' WHERE repo_id = ?",
          [repo.id],
        )

        const corruptOuter = yield* Effect.either(walkthroughStore.get(key))
        expect(Either.isLeft(corruptOuter)).toBe(true)
        if (Either.isLeft(corruptOuter)) {
          expect(corruptOuter.left).toBeInstanceOf(WalkthroughStoreError)
          expect(corruptOuter.left.operation).toBe("get.decodeRow")
        }

        yield* database.run("UPDATE walkthroughs SET pr_number = 51 WHERE repo_id = ?", [repo.id])
        const corruptContent = yield* Effect.either(walkthroughStore.get(key))
        expect(Either.isLeft(corruptContent)).toBe(true)
        if (Either.isLeft(corruptContent)) {
          expect(corruptContent.left).toBeInstanceOf(WalkthroughStoreError)
          expect(corruptContent.left.operation).toBe("get.decodeContent")
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
