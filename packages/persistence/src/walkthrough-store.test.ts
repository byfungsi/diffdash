import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Layer, Option } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  Walkthrough,
  WalkthroughChapter,
  WalkthroughChapterId,
  WalkthroughHunkId,
  WalkthroughStop,
  WalkthroughStopId,
  WalkthroughSupportItem,
  WalkthroughSupportItemId,
  WALKTHROUGH_PROMPT_VERSION,
  type WalkthroughCacheKey,
} from "@diffdash/domain/walkthrough"
import { ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import { makeDatabase } from "./database"
import * as DatabaseNode from "./database-node"
import { RepositoryStore } from "./repository-store"
import { hostedTestRepositoryInput } from "./test-support/repository"
import { WalkthroughStore, WalkthroughStoreError } from "./walkthrough-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  Layer.mergeAll(RepositoryStore.layer, WalkthroughStore.layer).pipe(
    Layer.provideMerge(DatabaseNode.layer(databasePath)),
  )

const makeWalkthrough = (summary: string) =>
  Walkthrough.make({
    title: "Review path",
    summary,
    chapters: [
      WalkthroughChapter.make({
        id: WalkthroughChapterId.make("c1"),
        title: "Runtime",
        summary: "Runtime changes.",
        stops: [
          WalkthroughStop.make({
            id: WalkthroughStopId.make("s1"),
            title: "Entry point",
            summary: "Review the entry point first.",
            risk: "critical",
            hunkIds: [
              WalkthroughHunkId.make("src/app.tsx:hosted-review:github:fungsi/diffdash#51:h1"),
            ],
          }),
        ],
      }),
    ],
    support: [
      WalkthroughSupportItem.make({
        id: WalkthroughSupportItemId.make("support-docs"),
        title: "Docs",
        reason: "Documentation support.",
        hunkIds: [
          WalkthroughHunkId.make("docs/readme.md:hosted-review:github:fungsi/diffdash#51:h1"),
        ],
      }),
    ],
  })

const cacheKey = {
  baseSha: ReviewRevision.make("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
  headSha: ReviewRevision.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  promptVersion: WALKTHROUGH_PROMPT_VERSION,
  reviewKey: ReviewKey.make("github:fungsi/diffdash#51"),
} satisfies Omit<WalkthroughCacheKey, "repoId">

describe("WalkthroughStore", () => {
  it.effect("returns a cache miss for an empty database", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const walkthroughStore = yield* WalkthroughStore
        const repo = yield* repositoryStore.upsertRepository(hostedTestRepositoryInput())

        const cached = yield* walkthroughStore.get({ ...cacheKey, repoId: repo.id })

        expect(cached).toEqual(Option.none())
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-47 AC: saves and reads a walkthrough for the same cache key", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const walkthroughStore = yield* WalkthroughStore
        const repo = yield* repositoryStore.upsertRepository(hostedTestRepositoryInput())
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
        expect(Option.map(cached, (stored) => stored.walkthrough.summary)).toEqual(
          Option.some("Review the entry point first."),
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-47 AC: regenerate overwrites an existing walkthrough cache row", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const walkthroughStore = yield* WalkthroughStore
        const repo = yield* repositoryStore.upsertRepository(hostedTestRepositoryInput())

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

        expect(Option.map(cached, (stored) => stored.walkthrough.summary)).toEqual(
          Option.some("Regenerated order."),
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-47 AC: reuses migrated legacy cache rows for the same head SHA", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      return yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const walkthroughStore = yield* WalkthroughStore
        const repo = yield* repositoryStore.upsertRepository(hostedTestRepositoryInput())

        yield* walkthroughStore.save({
          ...cacheKey,
          baseSha: cacheKey.headSha,
          repoId: repo.id,
          prNumber: 51,
          walkthrough: makeWalkthrough("Legacy head-only order."),
        })
        const cached = yield* walkthroughStore.get({ ...cacheKey, repoId: repo.id })

        expect(Option.map(cached, (stored) => stored.walkthrough.summary)).toEqual(
          Option.some("Legacy head-only order."),
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect(
    "FUN-47 AC: cache is isolated by repository, review, revision, and prompt version",
    () =>
      Effect.gen(function* () {
        const databasePath = yield* makeTempDatabasePath

        return yield* Effect.gen(function* () {
          const repositoryStore = yield* RepositoryStore
          const walkthroughStore = yield* WalkthroughStore
          const repo = yield* repositoryStore.upsertRepository(hostedTestRepositoryInput())
          const otherRepo = yield* repositoryStore.upsertRepository(
            hostedTestRepositoryInput({ name: "other" }),
          )

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
            headSha: ReviewRevision.make("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
          })
          const differentBase = yield* walkthroughStore.get({
            ...cacheKey,
            repoId: repo.id,
            baseSha: ReviewRevision.make("cccccccccccccccccccccccccccccccccccccccc"),
          })
          const differentPrompt = yield* walkthroughStore.get({
            ...cacheKey,
            repoId: repo.id,
            promptVersion: "walkthrough-future",
          })
          const differentReview = yield* walkthroughStore.get({
            ...cacheKey,
            repoId: repo.id,
            reviewKey: ReviewKey.make("github:fungsi/diffdash#52"),
          })
          const differentRepository = yield* walkthroughStore.get({
            ...cacheKey,
            repoId: otherRepo.id,
          })

          expect(Option.map(matching, (stored) => stored.walkthrough.summary)).toEqual(
            Option.some("Head A order."),
          )
          expect(differentHead).toEqual(Option.none())
          expect(differentBase).toEqual(Option.none())
          expect(differentPrompt).toEqual(Option.none())
          expect(differentReview).toEqual(Option.none())
          expect(differentRepository).toEqual(Option.none())
        }).pipe(Effect.provide(makeLayer(databasePath)))
      }),
  )

  it.effect("decodes outer walkthrough columns before content JSON", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repositoryStore = yield* RepositoryStore
        const walkthroughStore = yield* WalkthroughStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const repo = yield* repositoryStore.upsertRepository(
          hostedTestRepositoryInput({ name: "corrupt-walkthrough" }),
        )
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

        const corruptOuter = yield* Effect.result(walkthroughStore.get(key))
        expect(Result.isFailure(corruptOuter)).toBe(true)
        if (Result.isFailure(corruptOuter)) {
          expect(corruptOuter.failure).toBeInstanceOf(WalkthroughStoreError)
          expect(corruptOuter.failure.operation).toBe("get.decodeRow")
        }

        yield* database.run("UPDATE walkthroughs SET pr_number = 51 WHERE repo_id = ?", [repo.id])
        const corruptContent = yield* Effect.result(walkthroughStore.get(key))
        expect(Result.isFailure(corruptContent)).toBe(true)
        if (Result.isFailure(corruptContent)) {
          expect(corruptContent.failure).toBeInstanceOf(WalkthroughStoreError)
          expect(corruptContent.failure.operation).toBe("get.decodeContent")
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
