import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer } from "effect"

import { Repo } from "@diffdash/domain/repository"
import {
  GitProviderId,
  HostedRepositoryLocator,
  HostedRepositoryName,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import { LinkRepositoryCheckoutRequest } from "@diffdash/protocol/repository-link"
import { GitService } from "@diffdash/local-git/local-git"
import { GitProvider, GitProviderRemoteParseError } from "./git-provider"
import { RepositoryLinkError, RepositoryLinker } from "./repository-linker"
import { RepositoryStore } from "@diffdash/persistence/repository-store"

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

const makeLayer = (
  remoteUrl = linkedRepo.remoteUrl,
  remoteUrls: readonly string[] = [remoteUrl],
) => {
  const persisted: Array<{
    readonly favorite: boolean | undefined
    readonly owner: string
    readonly name: string
    readonly path: string | null
    readonly remoteUrl: string
  }> = []
  const layer = RepositoryLinker.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          GitService,
          GitService.of({
            listRemotes: () => Effect.succeed([{ name: "origin", fetchUrls: [...remoteUrls] }]),
            detectRepository: () =>
              Effect.succeed({ rootPath: linkedRepo.localPath ?? "", remoteUrl }),
            detectRoot: () => Effect.succeed(linkedRepo.localPath ?? ""),
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
            listProviders: Effect.succeed([]),
            diagnoseProviders: Effect.succeed([]),
            parseRemoteUrl: (value) =>
              value.includes("github.com")
                ? Effect.succeed(
                    value.includes("other/repository")
                      ? repository("other", "repository")
                      : repository("fungsi", "diffdash"),
                  )
                : GitProviderRemoteParseError.make({ remoteUrl: value }),
            repositoryUrl: (locator) =>
              Effect.succeed(
                `https://${locator.providerId}.example/${locator.namespace}/${locator.name}`,
              ),
            fileUrl: () => Effect.succeed(""),
            searchRepositories: () => unavailable(),
            listSearchScopes: () => unavailable(),
            listHostedReviews: () => unavailable(),
            listAssignedReviews: () => unavailable(),
            getHostedReview: () => unavailable(),
            refreshHostedReview: () => unavailable(),
            getHostedReviewDiff: () => unavailable(),
            getReviewDecision: () => unavailable(),
            submitReviewDecision: () => unavailable(),
            hostedReviewCheckoutSpec: () => unavailable(),
            bootstrapBareRepository: () => unavailable(),
            isAvailable: () => Effect.succeed(true),
          }),
        ),
        Layer.succeed(
          RepositoryStore,
          RepositoryStore.of({
            list: () => Effect.succeed([linkedRepo]),
            upsertRepository: (input) =>
              Effect.sync(() => {
                persisted.push({
                  favorite: input.isFavorite,
                  owner: input.owner,
                  name: input.name,
                  path: input.localPath,
                  remoteUrl: input.remoteUrl,
                })
                return Repo.make({
                  ...linkedRepo,
                  ...input,
                  localPath: input.localPath ?? linkedRepo.localPath,
                  isFavorite: input.isFavorite === true || linkedRepo.isFavorite,
                })
              }),
            setFavorite: (_id, isFavorite) =>
              Effect.succeed(Repo.make({ ...linkedRepo, isFavorite })),
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
          repository: repository("FUNGSI", "DiffDash"),
          localPath: "/workspace/diffdash/src",
        }),
      )

      expect(repo.localPath).toBe("/workspace/diffdash")
      expect(persisted).toEqual([
        {
          favorite: true,
          owner: "fungsi",
          name: "diffdash",
          path: "/workspace/diffdash",
          remoteUrl: linkedRepo.remoteUrl,
        },
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
            repository: repository("other", "repository"),
            localPath: "/workspace/diffdash",
          }),
        ),
      )

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(RepositoryLinkError)
      expect(persisted).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.effect("FUN-126 AC: links the expected provider identity from any configured remote", () => {
    const { layer, persisted } = makeLayer(linkedRepo.remoteUrl, [
      "https://github.com/other/repository.git",
      linkedRepo.remoteUrl,
    ])
    return Effect.gen(function* () {
      const linker = yield* RepositoryLinker
      yield* linker.link(
        LinkRepositoryCheckoutRequest.make({
          repository: repository("fungsi", "diffdash"),
          localPath: "/workspace/diffdash",
        }),
      )
      expect(persisted).toHaveLength(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("rejects a checkout without a supported GitHub origin", () => {
    const { layer } = makeLayer("https://gitlab.com/fungsi/diffdash.git")
    return Effect.gen(function* () {
      const linker = yield* RepositoryLinker
      const result = yield* Effect.either(linker.install("/workspace/diffdash"))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left.reason).toContain("configured provider")
      }
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "resolves hosted URLs while preserving an existing favorite and linked checkout",
    () => {
      const { layer, persisted } = makeLayer()
      return Effect.gen(function* () {
        const linker = yield* RepositoryLinker
        const repo = yield* linker.ensureHosted(repository("fungsi", "diffdash"))

        expect(repo.localPath).toBe(linkedRepo.localPath)
        expect(repo.isFavorite).toBe(true)
        expect(persisted).toEqual([
          {
            favorite: undefined,
            owner: "fungsi",
            name: "diffdash",
            path: null,
            remoteUrl: "https://github.example/fungsi/diffdash",
          },
        ])
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect("canonicalizes local repositories before persistence", () => {
    const { layer, persisted } = makeLayer()
    return Effect.gen(function* () {
      const linker = yield* RepositoryLinker
      const repo = yield* linker.ensureLocal("/workspace/diffdash/src")

      expect(repo.localPath).toBe(linkedRepo.localPath)
      expect(persisted[0]).toMatchObject({
        favorite: false,
        owner: "local",
        path: "/workspace/diffdash",
        remoteUrl: "file:///workspace/diffdash",
      })
    }).pipe(Effect.provide(layer))
  })
})

const repository = (owner: string, name: string) =>
  HostedRepositoryLocator.make({
    providerId: GitProviderId.make("github"),
    namespace: RepositoryNamespace.make(owner),
    name: HostedRepositoryName.make(name),
  })
