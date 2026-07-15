import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer } from "effect"

import { Repo } from "../../shared/domain"
import { LinkRepositoryCheckoutRequest } from "../../shared/repository-link"
import { GitService } from "./git"
import { GitProvider, GitProviderRemoteParseError } from "./git-provider"
import { RepositoryLinkError, RepositoryLinker } from "./repository-linker"
import { RepositoryStore } from "./repository-store"

const linkedRepo = Repo.make({
  id: "github:fungsi/diffdash",
  provider: "github",
  owner: "fungsi",
  name: "diffdash",
  remoteUrl: "git@github.com:fungsi/diffdash.git",
  localPath: "/workspace/diffdash",
  isFavorite: true,
  lastOpenedAt: null,
  lastSyncedAt: null,
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
})

const unavailable = <A>() => Effect.die(new Error("Unused test method")) as Effect.Effect<A>

const makeLayer = (remoteUrl = linkedRepo.remoteUrl) => {
  const persisted: Array<{ readonly owner: string; readonly name: string; readonly path: string }> =
    []
  const layer = RepositoryLinker.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          GitService,
          GitService.of({
            detectRepository: () =>
              Effect.succeed({ rootPath: linkedRepo.localPath ?? "", remoteUrl }),
            detectRoot: () => unavailable(),
            currentBranch: () => unavailable(),
            resolveBranchComparison: () => unavailable(),
            getLocalReviewDetail: () => unavailable(),
            getLocalReviewDiff: () => unavailable(),
            getLocalReviewSnapshot: () => unavailable(),
          }),
        ),
        Layer.succeed(
          GitProvider,
          GitProvider.of({
            parseRemoteUrl: (value) =>
              value.includes("github.com")
                ? Effect.succeed({ provider: "github" as const, owner: "fungsi", name: "diffdash" })
                : GitProviderRemoteParseError.make({ remoteUrl: value }),
            repositoryUrl: () => "",
            fileUrl: () => "",
            searchRepositories: () => unavailable(),
            listSearchScopes: () => unavailable(),
            listRepositories: () => unavailable(),
            listPullRequests: () => unavailable(),
            listReviewRequests: () => unavailable(),
            getPullRequestDetail: () => unavailable(),
            refreshPullRequestDetail: () => unavailable(),
            getPullRequestDiff: () => unavailable(),
            hasApprovedPullRequest: () => unavailable(),
            approvePullRequest: () => unavailable(),
            isAvailable: Effect.succeed(true),
          }),
        ),
        Layer.succeed(
          RepositoryStore,
          RepositoryStore.of({
            list: () => unavailable(),
            upsertRepository: (input) =>
              Effect.sync(() => {
                persisted.push({
                  owner: input.owner,
                  name: input.name,
                  path: input.localPath ?? "",
                })
                return Repo.make({ ...linkedRepo, ...input, isFavorite: true })
              }),
            setFavorite: () => unavailable(),
            touch: () => unavailable(),
          }),
        ),
      ),
    ),
  )
  return { layer, persisted }
}

describe("RepositoryLinker", () => {
  it.effect("links a matching checkout and canonical root", () => {
    const { layer, persisted } = makeLayer()
    return Effect.gen(function* () {
      const linker = yield* RepositoryLinker
      const repo = yield* linker.link(
        LinkRepositoryCheckoutRequest.make({
          owner: "FUNGSI",
          name: "DiffDash",
          localPath: "/workspace/diffdash/src",
        }),
      )

      expect(repo.localPath).toBe("/workspace/diffdash")
      expect(persisted).toEqual([
        { owner: "fungsi", name: "diffdash", path: "/workspace/diffdash" },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("rejects a mismatched target without persistence", () => {
    const { layer, persisted } = makeLayer()
    return Effect.gen(function* () {
      const linker = yield* RepositoryLinker
      const result = yield* Effect.either(
        linker.link(
          LinkRepositoryCheckoutRequest.make({
            owner: "other",
            name: "repository",
            localPath: "/workspace/diffdash",
          }),
        ),
      )

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(RepositoryLinkError)
      expect(persisted).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.effect("rejects a checkout without a supported GitHub origin", () => {
    const { layer } = makeLayer("https://gitlab.com/fungsi/diffdash.git")
    return Effect.gen(function* () {
      const linker = yield* RepositoryLinker
      const result = yield* Effect.either(linker.install("/workspace/diffdash"))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left.reason).toContain("supported GitHub remote")
      }
    }).pipe(Effect.provide(layer))
  })
})
