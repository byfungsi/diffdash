import { Context, Data, Effect, Layer, Match, Option, Result, Schema } from "effect"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  HostedRepositorySource,
  type HostedRepositoryLocator,
  LocalRepositorySource,
  RepositorySource,
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
  LinkedCheckout,
  RemoteOnly,
  type Repo,
  RepositoryCheckout,
  RepositoryCheckoutPath,
  type RepositoryFavoriteIntent,
  RepositoryIdentityRepairSummary,
  UpsertRepositoryInput,
} from "@diffdash/domain/repository"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { GitService, type LocalGitWorktree } from "@diffdash/local-git/local-git"
import { RepositoryCheckoutRecord, RepositoryStore } from "@diffdash/persistence/repository-store"
import { ProcessFileSystem } from "@diffdash/process/file-system"
import type { LinkRepositoryCheckoutRequest } from "@diffdash/protocol/repository-link"
import { GitProvider } from "./git-provider"
import { CoreExpectedCause } from "../core-error-cause"

const RepositoryLinkOperation = Schema.Literals([
  "listRemotes",
  "detectRepository",
  "resolveRemote",
  "persist",
  "reconcileLocalAliases",
  "findStableIdentity",
  "findResolvedRepository",
  "attachResolvedIdentity",
  "findByLocalPath",
  "touch",
  "list",
  "setFavorite",
  "findHosted",
  "resolveHostedUrl",
  "findHostedIdentity",
  "favoriteHosted",
  "attachHostedIdentity",
  "validateSelection",
  "forget",
  "validateIdentity",
  "startIdentityRepair",
  "repairLocalAliases",
  "listForIdentityRepair",
  "repairLocalIdentity",
  "completeIdentityRepair",
  "inspectCheckout",
  "listCheckouts",
  "listWorktrees",
  "reconcileCheckouts",
])

/** A local checkout could not be safely linked to a hosted repository. */
export class RepositoryLinkError extends Schema.TaggedError<RepositoryLinkError>()(
  "RepositoryLinkError",
  {
    operation: RepositoryLinkOperation,
    reason: Schema.String,
    cause: CoreExpectedCause,
  },
) {}

/** Whether repository opening should select a hosted remote automatically or use an explicit choice. */
export type RepositorySelectionIntent = Data.TaggedEnum<{
  Automatic: {}
  Selected: { readonly repository: HostedRepositoryLocator }
}>

/** Constructors for repository remote selection intents. */
export const RepositorySelectionIntent = Data.taggedEnum<RepositorySelectionIntent>()

/** Main-process service for resolving and persisting local and hosted repositories. */
export class RepositoryLinker extends Context.Service<
  RepositoryLinker,
  {
    readonly list: (query?: string) => Effect.Effect<readonly Repo[], RepositoryLinkError>
    readonly setFavorite: (
      id: ReviewProjectId,
      isFavorite: boolean,
    ) => Effect.Effect<Repo, RepositoryLinkError>
    readonly findHosted: (
      repository: HostedRepositoryLocator,
    ) => Effect.Effect<Option.Option<Repo>, RepositoryLinkError>
    readonly ensureHosted: (
      repository: HostedRepositoryLocator,
      favorite: RepositoryFavoriteIntent,
    ) => Effect.Effect<Repo, RepositoryLinkError>
    readonly ensureLocal: (
      localPath: RepositoryCheckoutPath,
    ) => Effect.Effect<Repo, RepositoryLinkError>
    readonly openProject: (
      localPath: RepositoryCheckoutPath,
      selection: RepositorySelectionIntent,
    ) => Effect.Effect<ProjectOpenResult, RepositoryLinkError>
    readonly forget: (projectId: ReviewProjectId) => Effect.Effect<Repo, RepositoryLinkError>
    readonly install: (
      localPath: RepositoryCheckoutPath,
    ) => Effect.Effect<Repo, RepositoryLinkError>
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
      const fileSystem = yield* ProcessFileSystem

      const listRemotes = Effect.fn("RepositoryLinker.listRemotes")(function* (
        rootPath: RepositoryCheckoutPath,
      ) {
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

      const detectRoot = Effect.fn("RepositoryLinker.detectRoot")(function* (
        localPath: RepositoryCheckoutPath,
      ) {
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
        rootPath: RepositoryCheckoutPath,
        selection: RepositorySelectionIntent,
      ) {
        const remotes = yield* listRemotes(rootPath)
        const candidates = remotes.flatMap((remote) => remote.fetchUrls)
        let firstRecognized: Option.Option<{
          readonly checkout: {
            readonly rootPath: RepositoryCheckoutPath
            readonly remoteUrl: string
          }
          readonly identity: HostedRepositoryLocator
        }> = Option.none()
        for (const remoteUrl of candidates) {
          const identity = yield* Effect.option(gitProvider.parseRemoteUrl(remoteUrl))
          if (Option.isSome(identity)) {
            const recognized = { checkout: { rootPath, remoteUrl }, identity: identity.value }
            const matchesSelection = Match.valueTags(selection, {
              Automatic: () => true,
              Selected: ({ repository }) => sameHostedRepository(identity.value, repository),
            })
            if (matchesSelection) {
              return recognized
            }
            if (Option.isNone(firstRecognized)) firstRecognized = Option.some(recognized)
          }
        }
        if (Option.isSome(firstRecognized)) return firstRecognized.value
        return yield* RepositoryLinkError.make({
          operation: "resolveRemote",
          reason: "None of the selected repository remotes belong to a configured provider.",
          cause: new Error("No configured provider recognized any repository remote"),
        })
      })

      const inspectHosted = Effect.fn("RepositoryLinker.inspectHosted")(function* (
        rootPath: RepositoryCheckoutPath,
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
              sameHostedRepository(existing.repository, candidate.repository),
            )
            if (duplicateIndex < 0) {
              candidates.push(candidate)
            } else {
              const existing = Option.fromNullishOr(candidates[duplicateIndex])
              if (
                isOriginRemote(candidate.remoteName) &&
                Option.exists(existing, (value) => !isOriginRemote(value.remoteName))
              ) {
                candidates[duplicateIndex] = candidate
              }
            }
          }
        }
        return candidates
      })

      const persistCheckoutReconciliation = Effect.fn(
        "RepositoryLinker.persistCheckoutReconciliation",
      )(function (
        repo: Repo,
        surviving: readonly RepositoryCheckoutRecord[],
        preferredPath: Option.Option<RepositoryCheckoutPath>,
      ) {
        return repositories.reconcileCheckouts(repo.id, surviving, preferredPath).pipe(
          Effect.mapError((cause) =>
            RepositoryLinkError.make({
              operation: "reconcileCheckouts",
              reason: "DiffDash could not reconcile the repository checkout.",
              cause,
            }),
          ),
        )
      })

      const inspectCheckoutPath = Effect.fn("RepositoryLinker.inspectCheckoutPath")(
        (path: RepositoryCheckoutPath) =>
          fileSystem
            .inspect(path)
            .pipe(Effect.map(Option.fromNullishOr))
            .pipe(
              Effect.mapError((cause) =>
                RepositoryLinkError.make({
                  operation: "inspectCheckout",
                  reason: "DiffDash could not inspect a saved repository checkout.",
                  cause,
                }),
              ),
            ),
      )

      const reconcileCheckout = Effect.fn("RepositoryLinker.reconcileCheckout")((repo: Repo) =>
        RepositoryCheckout.match(repo.checkout, {
          RemoteOnly: () => Effect.succeed(repo),
          LinkedCheckout: (linkedCheckout) =>
            RepositorySource.match(repo.source, {
              local: () => Effect.succeed(repo),
              hosted: ({ locator }) =>
                Effect.gen(function* () {
                  const candidates = yield* repositories.listCheckouts(repo.id).pipe(
                    Effect.mapError((cause) =>
                      RepositoryLinkError.make({
                        operation: "listCheckouts",
                        reason: "DiffDash could not load saved repository checkouts.",
                        cause,
                      }),
                    ),
                  )
                  const orderedCandidates = [
                    RepositoryCheckoutRecord.make({
                      path: linkedCheckout.path,
                      remoteUrl: linkedCheckout.remoteUrl,
                    }),
                    ...candidates.filter((candidate) => candidate.path !== linkedCheckout.path),
                  ]
                  let registeredWorktrees = Option.none<readonly LocalGitWorktree[]>()
                  let firstInspectionFailure = Option.none<RepositoryLinkError>()
                  for (const candidate of orderedCandidates) {
                    const entry = yield* inspectCheckoutPath(candidate.path)
                    if (Option.isNone(entry)) continue

                    const remoteInspection = yield* Effect.result(inspectHosted(candidate.path))
                    const remotes = Result.match(remoteInspection, {
                      onFailure: (failure) => {
                        firstInspectionFailure = Option.orElse(firstInspectionFailure, () =>
                          Option.some(failure),
                        )
                        return Option.none<readonly RecognizedRemote[]>()
                      },
                      onSuccess: Option.some,
                    })
                    if (
                      !Option.exists(remotes, (recognized) =>
                        recognized.some((remote) =>
                          sameHostedRepository(remote.repository, locator),
                        ),
                      )
                    ) {
                      continue
                    }

                    const worktreeInspection = yield* Effect.result(
                      git.listWorktrees(candidate.path).pipe(
                        Effect.mapError((cause) =>
                          RepositoryLinkError.make({
                            operation: "listWorktrees",
                            reason: "DiffDash could not inspect registered Git worktrees.",
                            cause,
                          }),
                        ),
                      ),
                    )
                    registeredWorktrees = Result.match(worktreeInspection, {
                      onFailure: (failure) => {
                        firstInspectionFailure = Option.orElse(firstInspectionFailure, () =>
                          Option.some(failure),
                        )
                        return Option.none<readonly LocalGitWorktree[]>()
                      },
                      onSuccess: Option.some,
                    })
                    if (Option.isSome(registeredWorktrees)) break
                  }

                  if (Option.isNone(registeredWorktrees)) {
                    return yield* Option.match(firstInspectionFailure, {
                      onNone: () => persistCheckoutReconciliation(repo, [], Option.none()),
                      onSome: Effect.fail,
                    })
                  }

                  const inspectedWorktrees = yield* Effect.forEach(
                    registeredWorktrees.value,
                    (worktree) =>
                      inspectCheckoutPath(worktree.path).pipe(
                        Effect.map(Option.map(() => worktree)),
                      ),
                  )
                  const surviving = inspectedWorktrees
                    .flatMap((worktree) => Option.toArray(worktree))
                    .filter((worktree) => !worktree.isBare && !worktree.isPrunable)
                  const preferred = Option.firstSomeOf([
                    Option.fromIterable(
                      surviving.filter((worktree) => worktree.path === linkedCheckout.path),
                    ),
                    Option.fromIterable(surviving.filter((worktree) => worktree.isMain)),
                    Option.fromIterable(surviving),
                  ])
                  return yield* Option.match(preferred, {
                    onNone: () => persistCheckoutReconciliation(repo, [], Option.none()),
                    onSome: (selected) => {
                      if (
                        selected.path === linkedCheckout.path &&
                        surviving.length === candidates.length &&
                        surviving.every((worktree) =>
                          candidates.some((candidate) => candidate.path === worktree.path),
                        )
                      ) {
                        return Effect.succeed(repo)
                      }
                      return persistCheckoutReconciliation(
                        repo,
                        surviving.map((worktree) =>
                          RepositoryCheckoutRecord.make({
                            path: worktree.path,
                            remoteUrl: linkedCheckout.remoteUrl,
                          }),
                        ),
                        Option.some(selected.path),
                      )
                    },
                  })
                }),
            }),
        }),
      )

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
      ) {
        const input = UpsertRepositoryInput.make({
          source: HostedRepositorySource.make({ locator: detected.identity }),
          checkout: LinkedCheckout.make({
            remoteUrl: detected.checkout.remoteUrl,
            path: detected.checkout.rootPath,
          }),
          favorite: "mark",
        })
        return yield* persist(input, "DiffDash could not save the local repository link.")
      })

      const reconcileLocalAliases = Effect.fn("RepositoryLinker.reconcileLocalAliases")(function* (
        repo: Repo,
        rootPath: RepositoryCheckoutPath,
      ) {
        yield* repositories.reconcileLocalAliases(repo.id, rootPath).pipe(
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
        rootPath: RepositoryCheckoutPath,
        favorite: RepositoryFavoriteIntent,
      ) {
        const resolved = yield* gitProvider.resolveRepository(candidate.repository).pipe(
          Effect.catch(() =>
            gitProvider.repositoryUrl(candidate.repository).pipe(
              Effect.map((url) =>
                ResolvedHostedRepository.make({
                  locator: candidate.repository,
                  providerRepositoryId: null,
                  url,
                }),
              ),
              Effect.mapError((cause) =>
                RepositoryLinkError.make({
                  operation: "findResolvedRepository",
                  reason: "DiffDash could not resolve the repository's provider URL.",
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
              UpsertRepositoryInput.make({
                source: HostedRepositorySource.make({ locator: resolved.locator }),
                checkout: LinkedCheckout.make({ remoteUrl: resolved.url, path: rootPath }),
                favorite,
              }),
              "DiffDash could not save the opened project.",
            )
        const attached = yield* repositories
          .attachResolvedIdentity(
            repo.id,
            resolved,
            LinkedCheckout.make({ remoteUrl: candidate.remoteUrl, path: rootPath }),
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
        rootPath: RepositoryCheckoutPath,
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
          return repositories
            .list(query)
            .pipe(
              Effect.flatMap((repos) =>
                Effect.forEach(repos, reconcileCheckout, { concurrency: 4 }),
              ),
            )
            .pipe(
              Effect.mapError((cause) =>
                Match.value(cause).pipe(
                  Match.when(Schema.is(RepositoryLinkError), (error) => error),
                  Match.orElse((storeError) =>
                    RepositoryLinkError.make({
                      operation: "list",
                      reason: "DiffDash could not load saved repositories.",
                      cause: storeError,
                    }),
                  ),
                ),
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
        ensureHosted: Effect.fn("RepositoryLinker.ensureHosted")(function* (repository, favorite) {
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
                UpsertRepositoryInput.make({
                  source: HostedRepositorySource.make({ locator: resolved.locator }),
                  checkout: RemoteOnly.make({ remoteUrl: resolved.url }),
                  favorite,
                }),
                "DiffDash could not save the hosted repository.",
              )
          if (favorite === "mark" && !repo.isFavorite) {
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
            .attachResolvedIdentity(repo.id, resolved, RemoteOnly.make({ remoteUrl: resolved.url }))
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
          const automatic = selectAutomaticCandidate(candidates)
          if (Option.isSome(automatic)) {
            return yield* persistRecognized(automatic.value, rootPath, "preserve")
          }
          return yield* persist(
            localRepositoryInput(rootPath),
            "DiffDash could not save the local repository.",
          )
        }),
        openProject: Effect.fn("RepositoryLinker.openProject")(function* (localPath, selection) {
          const rootPath = yield* detectRoot(localPath)
          const [existing, candidates] = yield* Effect.all([
            findByLocalPath(rootPath),
            inspectHosted(rootPath),
          ])

          const selectedRepository = Match.valueTags(selection, {
            Automatic: () => Option.none<HostedRepositoryLocator>(),
            Selected: ({ repository }) => Option.some(repository),
          })
          if (Option.isSome(selectedRepository)) {
            const selected = candidates.find((candidate) =>
              sameHostedRepository(candidate.repository, selectedRepository.value),
            )
            if (selected === undefined) {
              return yield* RepositoryLinkError.make({
                operation: "validateSelection",
                reason: "The selected remote is not available for this repository.",
                cause: new Error("Selected hosted repository did not match a recognized remote"),
              })
            }
            return ProjectOpened.make({
              repo: yield* persistRecognized(selected, rootPath, "preserve"),
            })
          }

          if (Option.isSome(existing) && Schema.is(HostedRepositorySource)(existing.value.source)) {
            const remembered = candidates.find((candidate) =>
              existing.value.matchesHosted(candidate.repository),
            )
            if (remembered !== undefined) {
              return ProjectOpened.make({
                repo: yield* persistRecognized(
                  remembered,
                  rootPath,
                  existing.value.isFavorite ? "mark" : "preserve",
                ),
              })
            }
          }

          const automatic = selectAutomaticCandidate(candidates)
          if (Option.isSome(automatic)) {
            return ProjectOpened.make({
              repo: yield* persistRecognized(automatic.value, rootPath, "preserve"),
            })
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

          if (Option.isSome(existing) && Schema.is(HostedRepositorySource)(existing.value.source)) {
            const repo = yield* touch(existing.value)
            return ProjectOpened.make({ repo: yield* reconcileLocalAliases(repo, rootPath) })
          }
          return ProjectOpened.make({
            repo: yield* persist(
              localRepositoryInput(rootPath),
              "DiffDash could not save the local project.",
            ),
          })
        }),
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
          const candidate = selectAutomaticCandidate(candidates)
          if (Option.isNone(candidate)) {
            const detected = yield* detectHosted(rootPath, RepositorySelectionIntent.Automatic())
            const repo = yield* persistDetected(detected)
            return yield* reconcileLocalAliases(repo, rootPath)
          }
          return yield* persistRecognized(candidate.value, rootPath, "mark")
        }),
        link: Effect.fn("RepositoryLinker.link")(function* (request) {
          const rootPath = yield* detectRoot(request.localPath)
          const detected = yield* detectHosted(
            rootPath,
            RepositorySelectionIntent.Selected({ repository: request.repository }),
          )
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
          return yield* persistRecognized(candidate, rootPath, "mark")
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
            Schema.is(LocalRepositorySource)(repo.source) &&
            Schema.is(LinkedCheckout)(repo.checkout)
              ? [{ repo, localPath: repo.checkout.path }]
              : [],
          )
          const localResults = yield* Effect.forEach(
            localRepositories,
            ({ repo, localPath }) =>
              Effect.gen(function* () {
                const candidates = yield* inspectHosted(localPath)
                const candidate = selectAutomaticCandidate(candidates)
                if (Option.isNone(candidate)) {
                  return yield* RepositoryLinkError.make({
                    operation: "repairLocalIdentity",
                    reason: "DiffDash could not identify one unambiguous hosted project.",
                    cause: new Error("No unambiguous hosted origin"),
                  })
                }
                return yield* persistRecognized(
                  candidate.value,
                  localPath,
                  repo.isFavorite ? "mark" : "preserve",
                )
              }).pipe(Effect.result),
            { concurrency: 2 },
          )
          const hostedRepositories = repos.flatMap((repo) =>
            Schema.is(HostedRepositorySource)(repo.source)
              ? [{ repo, locator: repo.source.locator }]
              : [],
          )
          const hostedResults = yield* Effect.forEach(
            hostedRepositories,
            ({ repo, locator }) =>
              gitProvider.resolveRepository(locator).pipe(
                Effect.flatMap((resolved) =>
                  repositories.attachResolvedIdentity(repo.id, resolved, repo.checkout),
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
            resolvedCount: [...localResults, ...hostedResults].filter((result) =>
              Match.valueTags(result, { Success: () => true, Failure: () => false }),
            ).length,
            unresolvedCount: [...localResults, ...hostedResults].filter((result) =>
              Match.valueTags(result, { Success: () => false, Failure: () => true }),
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

const isOriginRemote = (remoteName: string) => remoteName.toLocaleLowerCase("en-US") === "origin"

const selectAutomaticCandidate = (
  candidates: readonly RecognizedRemote[],
): Option.Option<RecognizedRemote> => {
  const originCandidates = candidates.filter((candidate) => isOriginRemote(candidate.remoteName))
  if (originCandidates.length === 1) return Option.fromIterable(originCandidates)
  if (candidates.length === 1) return Option.fromIterable(candidates)
  return Option.none()
}

const localRepositoryInput = (rootPath: RepositoryCheckoutPath): UpsertRepositoryInput => {
  const resolvedRootPath = RepositoryCheckoutPath.make(resolve(rootPath))
  return UpsertRepositoryInput.make({
    source: LocalRepositorySource.make(),
    checkout: LinkedCheckout.make({
      remoteUrl: pathToFileURL(resolvedRootPath).toString(),
      path: resolvedRootPath,
    }),
    favorite: "preserve",
  })
}
