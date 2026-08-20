import { expect, it } from "@effect/vitest"
import { LocalRepositorySource } from "@diffdash/domain/git-provider"
import {
  LocalCheckoutFileContent,
  LocalCheckoutFileList,
  LocalCheckoutFileListRejected,
} from "@diffdash/domain/local-checkout-file"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { LocalCheckoutFiles } from "@diffdash/local-git/local-checkout-files"
import { RepositoryStore, RepositoryStoreError } from "@diffdash/persistence/repository-store"
import { Effect, Layer } from "effect"

import { CoreMethod } from "../core-contract"
import { makeLocalCheckoutFileOperationHandlers } from "./local-checkout-file-operation-handlers"

const projectId = ReviewProjectId.make("local:workspace/diffdash")
const rootPath = RepositoryCheckoutPath.make("/workspace/diffdash")
const path = RepositoryRelativePath.make("src/main.ts")
const repo = Repo.make({
  id: projectId,
  source: LocalRepositorySource.make(),
  checkout: LinkedCheckout.make({ path: rootPath, remoteUrl: "file:///workspace/diffdash" }),
  isFavorite: false,
  lastOpenedAt: null,
  lastSyncedAt: null,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
})

it.effect(
  "resolves checkout operations by ReviewProjectId without returning the absolute root",
  () =>
    Effect.gen(function* () {
      const handlers = yield* makeLocalCheckoutFileOperationHandlers
      expect(yield* handlers[CoreMethod.listLocalCheckoutFiles]({ projectId }, {})).toEqual(
        LocalCheckoutFileList.make({ paths: [path] }),
      )
      expect(yield* handlers[CoreMethod.readLocalCheckoutFile]({ projectId, path }, {})).toEqual(
        LocalCheckoutFileContent.make({ path, content: "export const value = 1\n" }),
      )
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(RepositoryStore, {
            getById: (receivedProjectId) =>
              receivedProjectId === projectId
                ? Effect.succeed(repo)
                : Effect.die("unexpected project"),
          }),
          Layer.mock(LocalCheckoutFiles, {
            list: (receivedRootPath) =>
              receivedRootPath === rootPath
                ? Effect.succeed(LocalCheckoutFileList.make({ paths: [path] }))
                : Effect.die("unexpected root"),
            read: (receivedRootPath, receivedPath) =>
              receivedRootPath === rootPath && receivedPath === path
                ? Effect.succeed(
                    LocalCheckoutFileContent.make({
                      path: receivedPath,
                      content: "export const value = 1\n",
                    }),
                  )
                : Effect.die("unexpected file"),
          }),
        ),
      ),
    ),
)

it.effect("returns a stable rejection when repository persistence is unavailable", () =>
  Effect.gen(function* () {
    const handlers = yield* makeLocalCheckoutFileOperationHandlers
    expect(yield* handlers[CoreMethod.listLocalCheckoutFiles]({ projectId }, {})).toEqual(
      LocalCheckoutFileListRejected.make({ reason: "repositoryUnavailable" }),
    )
  }).pipe(
    Effect.provide(
      Layer.merge(
        Layer.mock(RepositoryStore, {
          getById: () =>
            Effect.fail(
              new RepositoryStoreError({
                operation: "getById.query",
                cause: new Error("database unavailable"),
              }),
            ),
        }),
        Layer.mock(LocalCheckoutFiles, {
          list: () => Effect.die("unexpected checkout list"),
          read: () => Effect.die("unexpected checkout read"),
        }),
      ),
    ),
  ),
)
