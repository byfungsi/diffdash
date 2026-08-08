import { Context, Effect, Layer, Option, Schema } from "effect"
import { createHash } from "node:crypto"
import { basename, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  type HostedRepositoryLocator,
  makeHostedRepositoryLocator,
  ResolvedHostedRepository,
  sameHostedRepository,
} from "@diffdash/domain/git-provider"
import {
  ProjectOpened,
  type ProjectOpenResult,
  ProjectRemoteCandidate,
  ProjectRemoteSelectionRequired,
} from "@diffdash/domain/project-workspace"
import {
  noRepositoryLocalPath,
  type Repo,
  repositoryLocalPath,
  RepositoryIdentityRepairSummary,
  type UpsertRepositoryInput,
} from "@diffdash/domain/repository"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { GitService } from "@diffdash/local-git/local-git"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import type { LinkRepositoryCheckoutRequest } from "@diffdash/protocol/repository-link"
import { GitProvider } from "./git-provider"

/** A local checkout could not be safely linked to a hosted repository. */
export class RepositoryLinkError extends Schema.TaggedError<RepositoryLinkError>()(
  "RepositoryLinkError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Main-process service for resolving and persisting local and hosted repositories. */
/** Main-process service for resolving and persisting local and hosted repositories. */
export class RepositoryLinker extends Context.Service<
  RepositoryLinker,
  {
    readonly list: (query?: string) => Effect.Effect<readonly Repo[], RepositoryLinkError>
    readonly setFavorite: (
      id: string,
      isFavorite: boolean,
    ) => Effect.Effect<Repo, RepositoryLinkError>
    readonly findHosted: (
      repository: HostedRepositoryLocator,
    ) => Effect.Effect<Option.Option<Repo>, RepositoryLinkError>
    readonly ensureHosted: (
      repository: HostedRepositoryLocator,
      isFavorite?: boolean,
    ) => Effect.Effect<Repo, RepositoryLinkError>
    readonly ensureLocal: (localPath: string) => Effect.Effect<Repo, RepositoryLinkError>
    readonly openProject: (
      localPath: string,
      selectedRepository?: HostedRepositoryLocator,
    ) => Effect.Effect<ProjectOpenResult, RepositoryLinkError>
    readonly forget: (projectId: ReviewProjectId) => Effect.Effect<Repo, RepositoryLinkError>
    readonly install: (localPath: string) => Effect.Effect<Repo, RepositoryLinkError>
    readonly link: (
      request: LinkRepositoryCheckoutRequest,
    ) => Effect.Effect<Repo, RepositoryLinkError>
    readonly repairIdentities: () => Effect.Effect<
      RepositoryIdentityRepairSummary,
      RepositoryLinkError
    >
  }
>()("@diffdash/RepositoryLinker") {
  static readonly layer = Layer.effect(
    RepositoryLinker,
    Effect.gen(function* () {
      const git = yield* GitService
      const gitProvider = yield* GitProvider
      const repositories = yield* RepositoryStore

      const listRemotes = Effect.fn("RepositoryLinker.listRemotes")(function* (rootPath: string) {
        return yield* git.listRemotes(rootPath).pipe(
          Effect.mapError((cause) =>
            RepositoryLinkError.make({
              operation: "listRemotes",
              reason: "DiffDash could not enumerate the selected repository remotes.",
              cause,
            }),
          ),
        )
      })

      const detectRoot = Effect.fn("RepositoryLinker.detectRoot")(function* (localPath: string) {
        return yield* git.detectRoot(localPath).pipe(
          Effect.mapError((cause) =>
            RepositoryLinkError.make({
              operation: "detectRepository",
              reason: "Select a Git repository.",
              cause,
            }),
          ),
        )
      })

      const detectHosted = Effect.fn("RepositoryLinker.detectHosted")(function* (
        rootPath: string,
        expected?: HostedRepositoryLocator,
      ) {
        const remotes = yield* listRemotes(rootPath)
        const candidates = remotes.flatMap((remote) => remote.fetchUrls)
        let firstRecognized: {
          readonly checkout: { readonly rootPath: string; readonly remoteUrl: string }
          readonly identity: HostedRepositoryLocator
        } | null = null
        for (const remoteUrl of candidates) {
          const identity = yield* Effect.option(gitProvider.parseRemoteUrl(remoteUrl))
          if (Option.isSome(identity)) {
            const recognized = { checkout: { rootPath, remoteUrl }, identity: identity.value }
            if (expected === undefined || sameHostedRepository(identity.value, expected)) {
              return recognized
            }
            firstRecognized ??= recognized
          }
        }
        if (firstRecognized !== null) return firstRecognized
        return yield* RepositoryLinkError.make({
          operation: "resolveRemote",
          reason: "None of the selected repository remotes belong to a configured provider.",
          cause: new Error("No configured provider recognized any repository remote"),
        })
      })

      const inspectHosted = Effect.fn("RepositoryLinker.inspectHosted")(function* (
        rootPath: string,
      ) {
        const remotes = yield* listRemotes(rootPath)
        const candidates: RecognizedRemote[] = []
        for (const remote of remotes) {
          for (const remoteUrl of remote.fetchUrls) {
            const parsed = yield* Effect.option(gitProvider.parseRemoteUrl(remoteUrl))
            if (Option.isNone(parsed)) continue

            const candidate = {
              remoteName: remote.name,
              repository: parsed.value,
              remoteUrl,
            }
            const duplicateIndex = candidates.findIndex((existing) =>
              sameRepositoryIdentity(existing.repository, candidate.repository),
            )
            if (duplicateIndex < 0) {
              candidates.push(candidate)
            } else if (
              isOriginRemote(candidate.remoteName) &&
              !isOriginRemote(candidates[duplicateIndex]?.remoteName ?? "")
            ) {
              candidates[duplicateIndex] = candidate
            }
          }
        }
        return candidates
      })

      const persist = Effect.fn("RepositoryLinker.persist")(function* (
        input: UpsertRepositoryInput,
        reason: string,
      ) {
        return yield* repositories.upsertRepository(input).pipe(
          Effect.mapError((cause) =>
            RepositoryLinkError.make({
              operation: "persist",
              reason,
              cause,
            }),
          ),
        )
      })

      const persistDetected = Effect.fn("RepositoryLinker.persistDetected")(function* (
        detected: Effect.Success<ReturnType<typeof detectHosted>>,
        isFavorite: boolean,
      ) {
        return yield* persist(
          {
            provider: detected.identity.providerId,
            owner: detected.identity.namespace,
            name: detected.identity.name,
            remoteUrl: detected.checkout.remoteUrl,
            localPath: repositoryLocalPath(detected.checkout.rootPath),
            ...(isFavorite ? { isFavorite: true } : {}),
          },
          "DiffDash could not save the local repository link.",
        )
      })

      const reconcileLocalAliases = Effect.fn("RepositoryLinker.reconcileLocalAliases")(function* (
        repo: Repo,
        rootPath: string,
      ) {
        yield* repositories.reconcileLocalAliases(ReviewProjectId.make(repo.id), rootPath).pipe(
          Effect.mapError((cause) =>
            RepositoryLinkError.make({
              operation: "reconcileLocalAliases",
              reason: "DiffDash could not reconcile the opened project with its local data.",
              cause,
            }),
          ),
        )
        return repo
      })

      const persistRecognized = Effect.fn("RepositoryLinker.persistRecognized")(function* (
        candidate: RecognizedRemote,
        rootPath: string,
        isFavorite = false,
      ) {
        const resolved = yield* gitProvider.resolveRepository(candidate.repository).pipe(
          Effect.catch(() =>
            Effect.succeed(
              ResolvedHostedRepository.make({
                locator: candidate.repository,
                providerRepositoryId: null,
                url: candidate.remoteUrl,
              }),
            ),
          ),
        )
        const stable =
          resolved.providerRepositoryId === null
            ? Option.none<Repo>()
            : yield* repositories
                .findByProviderRepositoryId(
                  resolved.locator.providerId,
                  resolved.providerRepositoryId,
                )
                .pipe(
                  Effect.mapError((cause) =>
                    RepositoryLinkError.make({
                      operation: "findStableIdentity",
                      reason: "DiffDash could not load the resolved repository identity.",
                      cause,
                    }),
                  ),
                )
        const located = Option.isSome(stable)
          ? stable
          : yield* repositories.findHosted(resolved.locator).pipe(
              Effect.mapError((cause) =>
                RepositoryLinkError.make({
                  operation: "findResolvedRepository",
                  reason: "DiffDash could not load the resolved repository.",
                  cause,
                }),
              ),
            )
        const repo = Option.isSome(located)
          ? located.value
          : yield* persist(
              {
                provider: resolved.locator.providerId,
                owner: resolved.locator.namespace,
                name: resolved.locator.name,
                remoteUrl: resolved.url,
                localPath: repositoryLocalPath(rootPath),
                isFavorite,
              },
              "DiffDash could not save the opened project.",
            )
        const attached = yield* repositories
          .attachResolvedIdentity(
            ReviewProjectId.make(repo.id),
            resolved,
            repositoryLocalPath(rootPath),
            candidate.remoteUrl,
          )
          .pipe(
            Effect.mapError((cause) =>
              RepositoryLinkError.make({
                operation: "attachResolvedIdentity",
                reason: "DiffDash could not attach the checkout to its resolved project.",
                cause,
              }),
            ),
          )
        return yield* reconcileLocalAliases(attached, rootPath)
      })

      const findByLocalPath = Effect.fn("RepositoryLinker.findByLocalPath")(function* (
        rootPath: string,
      ) {
        return yield* repositories.findByLocalPath(rootPath).pipe(
          Effect.mapError((cause) =>
            RepositoryLinkError.make({
              operation: "findByLocalPath",
              reason: "DiffDash could not load the previously opened project.",
              cause,
            }),
          ),
        )
      })

      const touch = Effect.fn("RepositoryLinker.touch")(function* (repo: Repo) {
        return yield* repositories.touch(repo.id).pipe(
          Effect.mapError((cause) =>
            RepositoryLinkError.make({
              operation: "touch",
              reason: "DiffDash could not update the opened project.",
              cause,
            }),
          ),
        )
      })

      return RepositoryLinker.of({
        list: Effect.fn("RepositoryLinker.list")(function (query) {
          return repositories.list(query).pipe(
            Effect.mapError((cause) =>
              RepositoryLinkError.make({
                operation: "list",
                reason: "DiffDash could not load saved repositories.",
                cause,
              }),
            ),
          )
        }),
        setFavorite: Effect.fn("RepositoryLinker.setFavorite")(function (id, isFavorite) {
          return repositories.setFavorite(id, isFavorite).pipe(
            Effect.mapError((cause) =>
              RepositoryLinkError.make({
                operation: "setFavorite",
                reason: "DiffDash could not update the repository favorite.",
                cause,
              }),
            ),
          )
        }),
        findHosted: Effect.fn("RepositoryLinker.findHosted")(function* (repository) {
          return yield* repositories.findHosted(repository).pipe(
            Effect.mapError((cause) =>
              RepositoryLinkError.make({
                operation: "findHosted",
                reason: "DiffDash could not load the linked repository.",
                cause,
              }),
            ),
          )
        }),
        ensureHosted: Effect.fn("RepositoryLinker.ensureHosted")(function* (
          repository,
          isFavorite = false,
        ) {
          const resolved = yield* gitProvider.resolveRepository(repository).pipe(
            Effect.catch(() =>
              gitProvider.repositoryUrl(repository).pipe(
                Effect.map((url) =>
                  ResolvedHostedRepository.make({
                    locator: repository,
                    providerRepositoryId: null,
                    url,
                  }),
                ),
                Effect.mapError((cause) =>
                  RepositoryLinkError.make({
                    operation: "resolveHostedUrl",
                    reason: "DiffDash could not resolve the repository URL.",
                    cause,
                  }),
                ),
              ),
            ),
          )
          const stable =
            resolved.providerRepositoryId === null
              ? Option.none<Repo>()
              : yield* repositories
                  .findByProviderRepositoryId(
                    resolved.locator.providerId,
                    resolved.providerRepositoryId,
                  )
                  .pipe(
                    Effect.mapError((cause) =>
                      RepositoryLinkError.make({
                        operation: "findHostedIdentity",
                        reason: "DiffDash could not load the resolved hosted repository.",
                        cause,
                      }),
                    ),
                  )
          const located = Option.isSome(stable)
            ? stable
            : yield* repositories.findHosted(resolved.locator).pipe(
                Effect.mapError((cause) =>
                  RepositoryLinkError.make({
                    operation: "findHosted",
                    reason: "DiffDash could not load the hosted repository.",
                    cause,
                  }),
                ),
              )
          const repo = Option.isSome(located)
            ? located.value
            : yield* persist(
                {
                  provider: resolved.locator.providerId,
                  owner: resolved.locator.namespace,
                  name: resolved.locator.name,
                  remoteUrl: resolved.url,
                  localPath: noRepositoryLocalPath,
                  ...(isFavorite ? { isFavorite: true } : {}),
                },
                "DiffDash could not save the hosted repository.",
              )
          if (isFavorite && !repo.isFavorite) {
            yield* repositories.setFavorite(repo.id, true).pipe(
              Effect.mapError((cause) =>
                RepositoryLinkError.make({
                  operation: "favoriteHosted",
                  reason: "DiffDash could not pin the hosted repository.",
                  cause,
                }),
              ),
            )
          }
          return yield* repositories
            .attachResolvedIdentity(
              ReviewProjectId.make(repo.id),
              resolved,
              noRepositoryLocalPath,
              resolved.url,
            )
            .pipe(
              Effect.mapError((cause) =>
                RepositoryLinkError.make({
                  operation: "attachHostedIdentity",
                  reason: "DiffDash could not save the resolved hosted repository identity.",
                  cause,
                }),
              ),
            )
        }),
        ensureLocal: Effect.fn("RepositoryLinker.ensureLocal")(function* (localPath) {
          const rootPath = yield* detectRoot(localPath)
          const existing = yield* findByLocalPath(rootPath)
          if (Option.isSome(existing)) return yield* touch(existing.value)
          const candidates = yield* inspectHosted(rootPath)
          const originCandidates = candidates.filter((candidate) =>
            isOriginRemote(candidate.remoteName),
          )
          const automatic =
            originCandidates.length === 1
              ? originCandidates[0]
              : candidates.length === 1
                ? candidates[0]
                : undefined
          if (automatic !== undefined) return yield* persistRecognized(automatic, rootPath)
          return yield* persist(
            localRepositoryInput(rootPath),
            "DiffDash could not save the local repository.",
          )
        }),
        openProject: Effect.fn("RepositoryLinker.openProject")(
          function* (localPath, selectedRepository) {
            const rootPath = yield* detectRoot(localPath)
            const [existing, candidates] = yield* Effect.all([
              findByLocalPath(rootPath),
              inspectHosted(rootPath),
            ])

            if (selectedRepository !== undefined) {
              const selected = candidates.find((candidate) =>
                sameRepositoryIdentity(candidate.repository, selectedRepository),
              )
              if (selected === undefined) {
                return yield* RepositoryLinkError.make({
                  operation: "validateSelection",
                  reason: "The selected remote is not available for this repository.",
                  cause: new Error("Selected hosted repository did not match a recognized remote"),
                })
              }
              return ProjectOpened.make({ repo: yield* persistRecognized(selected, rootPath) })
            }

            if (Option.isSome(existing) && existing.value.provider !== "local") {
              const remembered = candidates.find((candidate) =>
                samePersistedRepository(existing.value, candidate.repository),
              )
              if (remembered !== undefined) {
                return ProjectOpened.make({
                  repo: yield* persistRecognized(remembered, rootPath, existing.value.isFavorite),
                })
              }
            }

            const originCandidates = candidates.filter((candidate) =>
              isOriginRemote(candidate.remoteName),
            )
            const automatic =
              originCandidates.length === 1
                ? originCandidates[0]
                : candidates.length === 1
                  ? candidates[0]
                  : undefined
            if (automatic !== undefined) {
              return ProjectOpened.make({ repo: yield* persistRecognized(automatic, rootPath) })
            }

            const [first, second, ...remaining] = candidates
            if (first !== undefined && second !== undefined) {
              return ProjectRemoteSelectionRequired.make({
                rootPath,
                candidates: [
                  ProjectRemoteCandidate.make({
                    remoteName: first.remoteName,
                    repository: first.repository,
                  }),
                  ProjectRemoteCandidate.make({
                    remoteName: second.remoteName,
                    repository: second.repository,
                  }),
                  ...remaining.map((candidate) =>
                    ProjectRemoteCandidate.make({
                      remoteName: candidate.remoteName,
                      repository: candidate.repository,
                    }),
                  ),
                ],
              })
            }

            if (Option.isSome(existing) && existing.value.provider !== "local") {
              const repo = yield* touch(existing.value)
              return ProjectOpened.make({ repo: yield* reconcileLocalAliases(repo, rootPath) })
            }
            return ProjectOpened.make({
              repo: yield* persist(
                localRepositoryInput(rootPath),
                "DiffDash could not save the local project.",
              ),
            })
          },
        ),
        forget: Effect.fn("RepositoryLinker.forget")(function (projectId) {
          return repositories.forget(projectId).pipe(
            Effect.mapError((cause) =>
              RepositoryLinkError.make({
                operation: "forget",
                reason: "DiffDash could not forget the project.",
                cause,
              }),
            ),
          )
        }),
        install: Effect.fn("RepositoryLinker.install")(function* (localPath) {
          const rootPath = yield* detectRoot(localPath)
          const candidates = yield* inspectHosted(rootPath)
          const origin = candidates.filter((candidate) => isOriginRemote(candidate.remoteName))
          const candidate =
            origin.length === 1 ? origin[0] : candidates.length === 1 ? candidates[0] : undefined
          if (candidate === undefined) {
            const detected = yield* detectHosted(rootPath)
            const repo = yield* persistDetected(detected, true)
            return yield* reconcileLocalAliases(repo, rootPath)
          }
          return yield* persistRecognized(candidate, rootPath, true)
        }),
        link: Effect.fn("RepositoryLinker.link")(function* (request) {
          const rootPath = yield* detectRoot(request.localPath)
          const detected = yield* detectHosted(rootPath, request.repository)
          if (!sameHostedRepository(detected.identity, request.repository)) {
            return yield* RepositoryLinkError.make({
              operation: "validateIdentity",
              reason: `Selected checkout is ${detected.identity.providerId}:${detected.identity.namespace}/${detected.identity.name}, not ${request.repository.providerId}:${request.repository.namespace}/${request.repository.name}.`,
              cause: new Error(
                "The selected checkout origin does not match the requested repository",
              ),
            })
          }
          const candidate: RecognizedRemote = {
            remoteName: "selected",
            repository: detected.identity,
            remoteUrl: detected.checkout.remoteUrl,
          }
          return yield* persistRecognized(candidate, rootPath, true)
        }),
        repairIdentities: Effect.fn("RepositoryLinker.repairIdentities")(function* () {
          yield* repositories.setIdentityRepairStatus("running").pipe(
            Effect.mapError((cause) =>
              RepositoryLinkError.make({
                operation: "startIdentityRepair",
                reason: "DiffDash could not start project identity repair.",
                cause,
              }),
            ),
          )
          const local = yield* repositories.repairLocalAliases().pipe(
            Effect.mapError((cause) =>
              RepositoryLinkError.make({
                operation: "repairLocalAliases",
                reason: "DiffDash could not repair local project aliases.",
                cause,
              }),
            ),
          )
          const repos = yield* repositories.list().pipe(
            Effect.mapError((cause) =>
              RepositoryLinkError.make({
                operation: "listForIdentityRepair",
                reason: "DiffDash could not load projects for identity repair.",
                cause,
              }),
            ),
          )
          const localRepositories = repos.flatMap((repo) =>
            repo.provider === "local" && repo.localPath !== null
              ? [{ repo, localPath: repo.localPath }]
              : [],
          )
          const localResults = yield* Effect.forEach(
            localRepositories,
            ({ repo, localPath }) =>
              Effect.gen(function* () {
                const candidates = yield* inspectHosted(localPath)
                const origin = candidates.filter((candidate) =>
                  isOriginRemote(candidate.remoteName),
                )
                const candidate =
                  origin.length === 1
                    ? origin[0]
                    : candidates.length === 1
                      ? candidates[0]
                      : undefined
                if (candidate === undefined) {
                  return yield* RepositoryLinkError.make({
                    operation: "repairLocalIdentity",
                    reason: "DiffDash could not identify one unambiguous hosted project.",
                    cause: new Error("No unambiguous hosted origin"),
                  })
                }
                return yield* persistRecognized(candidate, localPath, repo.isFavorite)
              }).pipe(Effect.result),
            { concurrency: 2 },
          )
          const hostedResults = yield* Effect.forEach(
            repos.filter((repo) => repo.provider !== "local"),
            (repo) =>
              gitProvider
                .resolveRepository(
                  makeHostedRepositoryLocator(repo.provider, repo.owner, repo.name),
                )
                .pipe(
                  Effect.flatMap((resolved) =>
                    repositories.attachResolvedIdentity(
                      ReviewProjectId.make(repo.id),
                      resolved,
                      repo.localPath,
                      repo.remoteUrl,
                    ),
                  ),
                  Effect.result,
                ),
            { concurrency: 2 },
          )
          yield* repositories.setIdentityRepairStatus("completed").pipe(
            Effect.mapError((cause) =>
              RepositoryLinkError.make({
                operation: "completeIdentityRepair",
                reason: "DiffDash repaired projects but could not save the repair status.",
                cause,
              }),
            ),
          )
          return RepositoryIdentityRepairSummary.make({
            resolvedCount: [...localResults, ...hostedResults].filter(
              (result) => result._tag === "Success",
            ).length,
            unresolvedCount: [...localResults, ...hostedResults].filter(
              (result) => result._tag === "Failure",
            ).length,
            localAliasCount: local.matchedAliasCount,
          })
        }),
      })
    }),
  )
}

interface RecognizedRemote {
  readonly remoteName: string
  readonly repository: HostedRepositoryLocator
  readonly remoteUrl: string
}

const normalizedIdentityPart = (value: string) => value.toLocaleLowerCase("en-US")

const sameRepositoryIdentity = (left: HostedRepositoryLocator, right: HostedRepositoryLocator) =>
  normalizedIdentityPart(left.providerId) === normalizedIdentityPart(right.providerId) &&
  normalizedIdentityPart(left.namespace) === normalizedIdentityPart(right.namespace) &&
  normalizedIdentityPart(left.name) === normalizedIdentityPart(right.name)

const samePersistedRepository = (repo: Repo, repository: HostedRepositoryLocator) =>
  normalizedIdentityPart(repo.provider) === normalizedIdentityPart(repository.providerId) &&
  normalizedIdentityPart(repo.owner) === normalizedIdentityPart(repository.namespace) &&
  normalizedIdentityPart(repo.name) === normalizedIdentityPart(repository.name)

const isOriginRemote = (remoteName: string) => normalizedIdentityPart(remoteName) === "origin"

const localRepositoryInput = (rootPath: string) => {
  const resolvedRootPath = resolve(rootPath)
  const hash = createHash("sha256").update(resolvedRootPath).digest("hex").slice(0, 12)
  const repoName = basename(resolvedRootPath) || "repository"
  return {
    provider: "local",
    owner: "local",
    name: `${repoName}-${hash}`,
    remoteUrl: pathToFileURL(resolvedRootPath).toString(),
    localPath: repositoryLocalPath(resolvedRootPath),
    isFavorite: false,
  } as const
}
