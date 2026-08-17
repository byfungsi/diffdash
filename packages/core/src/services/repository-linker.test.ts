import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Layer, Option } from "effect"

import type { HostedRepositoryLocator as HostedRepositoryLocatorType } from "@diffdash/domain/git-provider"
import {
  LinkedCheckout,
  Repo,
  RepositoryCheckoutPath,
  type UpsertRepositoryInput,
} from "@diffdash/domain/repository"
import {
  GitProviderId,
  HostedRepositorySource,
  HostedRepositoryLocator,
  HostedRepositoryName,
  RepositoryNamespace,
  ResolvedHostedRepository,
  LocalRepositorySource,
} from "@diffdash/domain/git-provider"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { RepositoryStore, RepositoryStoreError } from "@diffdash/persistence/repository-store"
import { LinkRepositoryCheckoutRequest } from "@diffdash/protocol/repository-link"
import { GitService } from "@diffdash/local-git/local-git"
import { GitProvider, GitProviderRemoteParseError } from "./git-provider"
import {
  RepositoryLinkError,
  RepositoryLinker,
  RepositorySelectionIntent,
} from "./repository-linker"
import { CoreWebUrl } from "../core-configuration"

const linkedRepo = Repo.make({
  id: ReviewProjectId.make("github:fungsi/diffdash"),
  source: HostedRepositorySource.make({
    locator: HostedRepositoryLocator.make({
      providerId: GitProviderId.make("github"),
      namespace: RepositoryNamespace.make("fungsi"),
      name: HostedRepositoryName.make("diffdash"),
    }),
  }),
  checkout: LinkedCheckout.make({
    remoteUrl: "git@github.com:fungsi/diffdash.git",
    path: RepositoryCheckoutPath.make("/workspace/diffdash"),
  }),
  isFavorite: true,
  lastOpenedAt: null,
  lastSyncedAt: null,
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
})
const linkedRepoLocalPath = RepositoryCheckoutPath.make("/workspace/diffdash")

const unavailable = <A>() => Effect.die(new Error("Unused test method")) as Effect.Effect<A>

const makeLayer = (
  remoteUrl = linkedRepo.remoteUrl,
  remoteUrls: readonly string[] = [remoteUrl],
  existingByPath: Option.Option<Repo> = Option.none(),
) => {
  const persisted: Array<{
    readonly favorite: "preserve" | "mark"
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
            detectRepository: () => Effect.succeed({ rootPath: linkedRepoLocalPath, remoteUrl }),
            detectRoot: () => Effect.succeed(linkedRepoLocalPath),
            currentBranch: () => unavailable(),
            resolveBranchComparison: () => unavailable(),
            resolveRevisionRangeComparison: () => unavailable(),
            resolveLastCommit: () => unavailable(),
            validateLocalReviewTarget: () => unavailable(),
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
            resolveRepository: (locator) =>
              Effect.succeed(
                ResolvedHostedRepository.make({
                  locator,
                  providerRepositoryId: null,
                  url: CoreWebUrl.make(`https://github.com/${locator.namespace}/${locator.name}`),
                }),
              ),
            repositoryUrl: (locator) =>
              Effect.succeed(
                CoreWebUrl.make(
                  `https://${locator.providerId}.example/${locator.namespace}/${locator.name}`,
                ),
              ),
            fileUrl: () => Effect.succeed(CoreWebUrl.make("https://example.com/file")),
            searchRepositories: () => unavailable(),
            listSearchScopes: () => unavailable(),
            listHostedReviews: () => unavailable(),
            listAssignedReviews: () => unavailable(),
            getReviewDiffSource: () => unavailable(),
            getHostedReviewDetail: () => unavailable(),
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
            getById: () => Effect.succeed(linkedRepo),
            list: () => Effect.succeed([linkedRepo]),
            findByLocalPath: () => Effect.succeed(existingByPath),
            findHosted: () => Effect.succeed(Option.none()),
            findByProviderRepositoryId: () => Effect.succeed(Option.none()),
            attachResolvedIdentity: () =>
              Effect.succeed(Option.getOrElse(existingByPath, () => linkedRepo)),
            reconcileLocalAliases: () =>
              Effect.succeed({
                matchedAliasCount: 0,
                removedAliasCount: 0,
                preservedAliasCount: 0,
              }),
            repairLocalAliases: () =>
              Effect.succeed({
                matchedAliasCount: 0,
                removedAliasCount: 0,
                preservedAliasCount: 0,
              }),
            setIdentityRepairStatus: () => Effect.void,
            upsertRepository: (input) =>
              Effect.sync(() => {
                const capture = upsertCapture(input)
                persisted.push({
                  favorite: input.favorite,
                  owner: capture.owner,
                  name: capture.name,
                  path: capture.localPath,
                  remoteUrl: capture.remoteUrl,
                })
                return Repo.make({
                  ...linkedRepo,
                  source: input.source,
                  checkout: input.checkout,
                  isFavorite: input.favorite === "mark" || linkedRepo.isFavorite,
                })
              }),
            setFavorite: (_id, isFavorite) =>
              Effect.succeed(Repo.make({ ...linkedRepo, isFavorite })),
            touch: () => Effect.succeed(Option.getOrElse(existingByPath, () => linkedRepo)),
            forget: () => unavailable(),
          }),
        ),
      ),
    ),
  )
  return { layer, persisted }
}

describe("RepositoryLinker", () => {
  it.effect("returns None when no hosted repository is linked", () => {
    const { layer } = makeLayer()
    return Effect.gen(function* () {
      const result = yield* (yield* RepositoryLinker).findHosted(repository("fungsi", "missing"))

      expect(Option.isNone(result)).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  it.effect("links a matching checkout and canonical root", () => {
    const { layer, persisted } = makeLayer()
    return Effect.gen(function* () {
      const linker = yield* RepositoryLinker
      const repo = yield* linker.link(
        LinkRepositoryCheckoutRequest.make({
          repository: repository("FUNGSI", "DiffDash"),
          localPath: RepositoryCheckoutPath.make("/workspace/diffdash/src"),
        }),
      )

      expect(repo.localPath).toBe("/workspace/diffdash")
      expect(persisted).toEqual([
        {
          favorite: "mark",
          owner: "fungsi",
          name: "diffdash",
          path: "/workspace/diffdash",
          remoteUrl: "https://github.com/fungsi/diffdash",
        },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("rejects a mismatched target without persistence", () => {
    const { layer, persisted } = makeLayer()
    return Effect.gen(function* () {
      const linker = yield* RepositoryLinker
      const result = yield* Effect.result(
        linker.link(
          LinkRepositoryCheckoutRequest.make({
            repository: repository("other", "repository"),
            localPath: RepositoryCheckoutPath.make("/workspace/diffdash"),
          }),
        ),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(RepositoryLinkError)
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
          localPath: RepositoryCheckoutPath.make("/workspace/diffdash"),
        }),
      )
      expect(persisted).toHaveLength(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("rejects a checkout without a supported GitHub origin", () => {
    const { layer } = makeLayer("https://gitlab.com/fungsi/diffdash.git")
    return Effect.gen(function* () {
      const linker = yield* RepositoryLinker
      const result = yield* Effect.result(
        linker.install(RepositoryCheckoutPath.make("/workspace/diffdash")),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure.reason).toContain("configured provider")
      }
    }).pipe(Effect.provide(layer))
  })

  it.effect("falls back to the first recognized remote when install is ambiguous", () => {
    const { layer, persisted } = makeOpenProjectLayer({
      remotes: [
        { name: "upstream", fetchUrls: [linkedRepo.remoteUrl] },
        { name: "fork", fetchUrls: ["https://github.com/other/repository.git"] },
      ],
    })
    return Effect.gen(function* () {
      yield* (yield* RepositoryLinker).install(linkedRepoLocalPath)

      expect(persisted).toEqual([
        expect.objectContaining({ owner: "fungsi", name: "diffdash", favorite: "mark" }),
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "resolves hosted URLs while preserving an existing favorite and linked checkout",
    () => {
      const { layer, persisted } = makeLayer()
      return Effect.gen(function* () {
        const linker = yield* RepositoryLinker
        const repo = yield* linker.ensureHosted(repository("fungsi", "diffdash"), "preserve")

        expect(repo.localPath).toBe(linkedRepo.localPath)
        expect(repo.isFavorite).toBe(true)
        expect(persisted).toEqual([
          {
            favorite: "preserve",
            owner: "fungsi",
            name: "diffdash",
            path: null,
            remoteUrl: "https://github.com/fungsi/diffdash",
          },
        ])
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect("resolves a local review checkout to its hosted origin before persistence", () => {
    const { layer, persisted } = makeLayer()
    return Effect.gen(function* () {
      const linker = yield* RepositoryLinker
      const repo = yield* linker.ensureLocal(RepositoryCheckoutPath.make("/workspace/diffdash/src"))

      expect(repo.localPath).toBe(linkedRepo.localPath)
      expect(persisted[0]).toMatchObject({
        favorite: "preserve",
        owner: "fungsi",
        path: "/workspace/diffdash",
        remoteUrl: "https://github.com/fungsi/diffdash",
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect("reuses a hosted project identity for local review state", () => {
    const { layer, persisted } = makeLayer(
      linkedRepo.remoteUrl,
      [linkedRepo.remoteUrl],
      Option.some(linkedRepo),
    )
    return Effect.gen(function* () {
      const repo = yield* (yield* RepositoryLinker).ensureLocal(
        RepositoryCheckoutPath.make("/workspace/diffdash/src"),
      )

      expect(repo.id).toBe(linkedRepo.id)
      expect(repo.hostedLocator?.providerId).toBe("github")
      expect(persisted).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.effect("opens an unrecognized checkout as a canonical local project", () => {
    const { layer, persisted } = makeOpenProjectLayer({
      remotes: [{ name: "origin", fetchUrls: ["https://gitlab.example/fungsi/diffdash.git"] }],
    })
    return Effect.gen(function* () {
      const result = yield* (yield* RepositoryLinker).openProject(
        RepositoryCheckoutPath.make("/workspace/diffdash/src"),
        RepositorySelectionIntent.Automatic(),
      )

      expect(result["_tag"]).toBe("opened")
      if (result["_tag"] !== "opened") return
      expect(result.repo.source).toBeInstanceOf(LocalRepositorySource)
      expect(result.repo.localPath).toBe("/workspace/diffdash")
      expect(persisted).toEqual([
        expect.objectContaining({ provider: "local", localPath: "/workspace/diffdash" }),
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("prefers a remembered hosted project over a different origin", () => {
    const { layer, persisted, touched, reconciled } = makeOpenProjectLayer({
      existing: linkedRepo,
      remotes: [
        { name: "origin", fetchUrls: ["https://github.com/other/repository.git"] },
        { name: "upstream", fetchUrls: [linkedRepo.remoteUrl] },
      ],
    })
    return Effect.gen(function* () {
      const result = yield* (yield* RepositoryLinker).openProject(
        linkedRepoLocalPath,
        RepositorySelectionIntent.Automatic(),
      )

      expect(result["_tag"]).toBe("opened")
      if (result["_tag"] !== "opened") return
      expect(result.repo.id).toBe(linkedRepo.id)
      expect(touched).toEqual([])
      expect(persisted).toEqual([])
      expect(reconciled).toEqual([
        {
          canonicalProjectId: ReviewProjectId.make(linkedRepo.id),
          localPath: "/workspace/diffdash",
        },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("prefers one recognized origin when several hosted remotes remain", () => {
    const { layer, persisted } = makeOpenProjectLayer({
      remotes: [
        { name: "upstream", fetchUrls: [linkedRepo.remoteUrl] },
        { name: "origin", fetchUrls: ["https://github.com/other/repository.git"] },
      ],
    })
    return Effect.gen(function* () {
      const result = yield* (yield* RepositoryLinker).openProject(
        linkedRepoLocalPath,
        RepositorySelectionIntent.Automatic(),
      )

      expect(result["_tag"]).toBe("opened")
      expect(persisted).toEqual([
        expect.objectContaining({ owner: "other", name: "repository", favorite: "preserve" }),
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("reconciles local aliases after opening a recognized hosted project", () => {
    const { layer, reconciled } = makeOpenProjectLayer({
      remotes: [{ name: "origin", fetchUrls: [linkedRepo.remoteUrl] }],
    })
    return Effect.gen(function* () {
      const result = yield* (yield* RepositoryLinker).openProject(
        RepositoryCheckoutPath.make("/workspace/diffdash/src"),
        RepositorySelectionIntent.Automatic(),
      )

      expect(result["_tag"]).toBe("opened")
      expect(reconciled).toEqual([
        {
          canonicalProjectId: ReviewProjectId.make(linkedRepo.id),
          localPath: "/workspace/diffdash",
        },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("returns safe candidates when recognized remotes are ambiguous", () => {
    const { layer, persisted } = makeOpenProjectLayer({
      remotes: [
        { name: "upstream", fetchUrls: [linkedRepo.remoteUrl] },
        { name: "fork", fetchUrls: ["https://github.com/other/repository.git"] },
      ],
    })
    return Effect.gen(function* () {
      const result = yield* (yield* RepositoryLinker).openProject(
        RepositoryCheckoutPath.make("/workspace/diffdash/src"),
        RepositorySelectionIntent.Automatic(),
      )

      expect(result["_tag"]).toBe("remoteSelectionRequired")
      if (result["_tag"] !== "remoteSelectionRequired") return
      expect(result.rootPath).toBe("/workspace/diffdash")
      expect(result.candidates).toEqual([
        { remoteName: "upstream", repository: repository("fungsi", "diffdash") },
        { remoteName: "fork", repository: repository("other", "repository") },
      ])
      expect(result.candidates.every((candidate) => !("remoteUrl" in candidate))).toBe(true)
      expect(persisted).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.effect("validates and persists an explicit remote choice", () => {
    const { layer, persisted } = makeOpenProjectLayer({
      remotes: [
        { name: "upstream", fetchUrls: [linkedRepo.remoteUrl] },
        { name: "fork", fetchUrls: ["https://github.com/other/repository.git"] },
      ],
    })
    return Effect.gen(function* () {
      const rejected = yield* Effect.result(
        (yield* RepositoryLinker).openProject(
          RepositoryCheckoutPath.make("/workspace/diffdash/src"),
          RepositorySelectionIntent.Selected({
            repository: repository("missing", "repository"),
          }),
        ),
      )
      expect(Result.isFailure(rejected)).toBe(true)
      expect(persisted).toEqual([])

      const result = yield* (yield* RepositoryLinker).openProject(
        RepositoryCheckoutPath.make("/workspace/diffdash/src"),
        RepositorySelectionIntent.Selected({
          repository: repository("OTHER", "REPOSITORY"),
        }),
      )

      expect(result["_tag"]).toBe("opened")
      expect(persisted).toEqual([
        expect.objectContaining({
          owner: "other",
          name: "repository",
          localPath: "/workspace/diffdash",
          favorite: "preserve",
        }),
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("deduplicates hosted repository identities case-insensitively", () => {
    const { layer, persisted } = makeOpenProjectLayer({
      remotes: [
        { name: "upstream", fetchUrls: ["https://github.com/Fungsi/DiffDash.git"] },
        { name: "mirror", fetchUrls: ["git@github.com:fungsi/diffdash.git"] },
      ],
    })
    return Effect.gen(function* () {
      const result = yield* (yield* RepositoryLinker).openProject(
        linkedRepoLocalPath,
        RepositorySelectionIntent.Automatic(),
      )

      expect(result["_tag"]).toBe("opened")
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toEqual(expect.objectContaining({ owner: "Fungsi", name: "DiffDash" }))
    }).pipe(Effect.provide(layer))
  })

  it.effect("repairs a legacy local project through its resolved origin", () => {
    const local = Repo.make({
      ...linkedRepo,
      id: ReviewProjectId.make("local:local/xenith-operator-dashboard-fe"),
      source: LocalRepositorySource.make(),
      checkout: LinkedCheckout.make({
        remoteUrl: "file:///workspace/diffdash",
        path: linkedRepoLocalPath,
      }),
      isFavorite: false,
    })
    const { layer, persisted } = makeOpenProjectLayer({
      listed: [local],
      remotes: [{ name: "origin", fetchUrls: [linkedRepo.remoteUrl] }],
    })
    return Effect.gen(function* () {
      const result = yield* (yield* RepositoryLinker).repairIdentities()

      expect(result).toEqual({ resolvedCount: 1, unresolvedCount: 0, localAliasCount: 0 })
      expect(persisted).toEqual([
        expect.objectContaining({
          provider: "github",
          owner: "fungsi",
          name: "diffdash",
          localPath: "/workspace/diffdash",
        }),
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("delegates forget and wraps repository-store failures", () => {
    const { layer, forgotten } = makeOpenProjectLayer({ forgetFails: true })
    return Effect.gen(function* () {
      const projectId = ReviewProjectId.make(linkedRepo.id)
      const result = yield* Effect.result((yield* RepositoryLinker).forget(projectId))

      expect(forgotten).toEqual([projectId])
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(RepositoryLinkError)
        expect(result.failure.operation).toBe("forget")
      }
    }).pipe(Effect.provide(layer))
  })
})

interface OpenProjectLayerOptions {
  readonly existing?: Repo
  readonly forgetFails?: boolean
  readonly listed?: readonly Repo[]
  readonly remotes?: readonly {
    readonly name: string
    readonly fetchUrls: readonly string[]
  }[]
}

interface UpsertCapture {
  readonly provider: string
  readonly owner: string
  readonly name: string
  readonly remoteUrl: string
  readonly localPath: string | null
  readonly favorite: "preserve" | "mark"
}

const upsertCapture = (input: UpsertRepositoryInput): Omit<UpsertCapture, "favorite"> => {
  const identity =
    input.source instanceof HostedRepositorySource
      ? {
          provider: input.source.locator.providerId,
          owner: input.source.locator.namespace,
          name: input.source.locator.name,
        }
      : { provider: "local", owner: "local", name: "diffdash" }
  return {
    ...identity,
    remoteUrl: input.checkout.remoteUrl,
    localPath: input.checkout instanceof LinkedCheckout ? input.checkout.path : null,
  }
}

interface ReconciliationCapture {
  readonly canonicalProjectId: ReviewProjectId
  readonly localPath: RepositoryCheckoutPath
}

const makeOpenProjectLayer = (options: OpenProjectLayerOptions = {}) => {
  const persisted: UpsertCapture[] = []
  const touched: string[] = []
  const forgotten: ReviewProjectId[] = []
  const reconciled: ReconciliationCapture[] = []
  const layer = RepositoryLinker.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          GitService,
          GitService.of({
            listRemotes: () =>
              Effect.succeed(
                (options.remotes ?? []).map((remote) => ({
                  name: remote.name,
                  fetchUrls: [...remote.fetchUrls],
                })),
              ),
            detectRepository: () => unavailable(),
            detectRoot: () => Effect.succeed(RepositoryCheckoutPath.make("/workspace/diffdash")),
            currentBranch: () => unavailable(),
            resolveBranchComparison: () => unavailable(),
            resolveRevisionRangeComparison: () => unavailable(),
            resolveLastCommit: () => unavailable(),
            validateLocalReviewTarget: () => unavailable(),
          }),
        ),
        Layer.succeed(
          GitProvider,
          GitProvider.of({
            listProviders: Effect.succeed([]),
            diagnoseProviders: Effect.succeed([]),
            parseRemoteUrl: (value) => {
              const parsed = parseTestRemote(value)
              return parsed === null
                ? GitProviderRemoteParseError.make({ remoteUrl: value })
                : Effect.succeed(parsed)
            },
            resolveRepository: (locator) =>
              Effect.succeed(
                ResolvedHostedRepository.make({
                  locator,
                  providerRepositoryId: null,
                  url: CoreWebUrl.make(`https://github.com/${locator.namespace}/${locator.name}`),
                }),
              ),
            repositoryUrl: () => unavailable(),
            fileUrl: () => unavailable(),
            searchRepositories: () => unavailable(),
            listSearchScopes: () => unavailable(),
            listHostedReviews: () => unavailable(),
            listAssignedReviews: () => unavailable(),
            getReviewDiffSource: () => unavailable(),
            getHostedReviewDetail: () => unavailable(),
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
            getById: () => Effect.succeed(options.existing ?? linkedRepo),
            list: () => Effect.succeed(options.listed ?? []),
            findByLocalPath: () => Effect.succeed(Option.fromNullishOr(options.existing)),
            findHosted: () => Effect.succeed(Option.fromNullishOr(options.existing)),
            findByProviderRepositoryId: () => Effect.succeed(Option.none()),
            attachResolvedIdentity: (_repoId, resolved, checkout) =>
              Effect.succeed(
                Repo.make({
                  ...linkedRepo,
                  source: HostedRepositorySource.make({ locator: resolved.locator }),
                  checkout,
                }),
              ),
            reconcileLocalAliases: (canonicalProjectId, localPath) =>
              Effect.sync(() => {
                reconciled.push({ canonicalProjectId, localPath })
                return {
                  matchedAliasCount: 1,
                  removedAliasCount: 1,
                  preservedAliasCount: 0,
                }
              }),
            repairLocalAliases: () =>
              Effect.succeed({
                matchedAliasCount: 0,
                removedAliasCount: 0,
                preservedAliasCount: 0,
              }),
            setIdentityRepairStatus: () => Effect.void,
            upsertRepository: (input) =>
              Effect.sync(() => {
                const capture = {
                  ...upsertCapture(input),
                  favorite: input.favorite,
                }
                persisted.push(capture)
                return Repo.make({
                  id: ReviewProjectId.make(`${capture.provider}:${capture.owner}/${capture.name}`),
                  source: input.source,
                  checkout: input.checkout,
                  isFavorite: input.favorite === "mark",
                  lastOpenedAt: "2026-08-02T00:00:00.000Z",
                  lastSyncedAt: "2026-08-02T00:00:00.000Z",
                  createdAt: "2026-08-02T00:00:00.000Z",
                  updatedAt: "2026-08-02T00:00:00.000Z",
                })
              }),
            setFavorite: () => unavailable(),
            touch: (id) =>
              Effect.sync(() => {
                touched.push(id)
                return Repo.make({ ...linkedRepo, id: ReviewProjectId.make(id) })
              }),
            forget: (id) =>
              Effect.suspend(() => {
                forgotten.push(id)
                return options.forgetFails === true
                  ? RepositoryStoreError.make({
                      operation: "forget",
                      cause: new Error("test forget failure"),
                    })
                  : Effect.succeed(
                      Repo.make({ ...linkedRepo, isFavorite: false, lastOpenedAt: null }),
                    )
              }),
          }),
        ),
      ),
    ),
  )
  return { layer, persisted, touched, forgotten, reconciled }
}

const parseTestRemote = (remoteUrl: string): HostedRepositoryLocatorType | null => {
  const match = /github\.com(?::|\/)([^/]+)\/([^/]+?)(?:\.git)?$/iu.exec(remoteUrl)
  return match?.[1] === undefined || match[2] === undefined ? null : repository(match[1], match[2])
}

const repository = (owner: string, name: string) =>
  HostedRepositoryLocator.make({
    providerId: GitProviderId.make("github"),
    namespace: RepositoryNamespace.make(owner),
    name: HostedRepositoryName.make(name),
  })
