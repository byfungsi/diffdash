import { Context, Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { basename, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  type HostedRepositoryLocator,
  makeHostedRepositoryLocator,
  sameHostedRepository,
} from "@diffdash/domain/git-provider"
import type { Repo, UpsertRepositoryInput } from "@diffdash/domain/repository"
import { GitService } from "@diffdash/local-git/local-git"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import type { LinkRepositoryCheckoutRequest } from "@diffdash/protocol/repository-link"
import { GitProvider } from "./git-provider"

/** A local checkout could not be safely linked to a GitHub repository. */
export class RepositoryLinkError extends Schema.TaggedError<RepositoryLinkError>()(
  "RepositoryLinkError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Main-process service for resolving and persisting local and hosted repositories. */
export class RepositoryLinker extends Context.Tag("@diffdash/RepositoryLinker")<
  RepositoryLinker,
  {
    readonly list: (query?: string) => Effect.Effect<readonly Repo[], RepositoryLinkError>
    readonly setFavorite: (
      id: string,
      isFavorite: boolean,
    ) => Effect.Effect<Repo, RepositoryLinkError>
    readonly findHosted: (
      repository: HostedRepositoryLocator,
    ) => Effect.Effect<Repo | null, RepositoryLinkError>
    readonly ensureHosted: (
      repository: HostedRepositoryLocator,
      isFavorite?: boolean,
    ) => Effect.Effect<Repo, RepositoryLinkError>
    readonly ensureLocal: (localPath: string) => Effect.Effect<Repo, RepositoryLinkError>
    readonly install: (localPath: string) => Effect.Effect<Repo, RepositoryLinkError>
    readonly link: (
      request: LinkRepositoryCheckoutRequest,
    ) => Effect.Effect<Repo, RepositoryLinkError>
  }
>() {
  static readonly layer = Layer.effect(
    RepositoryLinker,
    Effect.gen(function* () {
      const git = yield* GitService
      const gitProvider = yield* GitProvider
      const repositories = yield* RepositoryStore

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
        const remotes = yield* git.listRemotes(rootPath).pipe(
          Effect.mapError((cause) =>
            RepositoryLinkError.make({
              operation: "listRemotes",
              reason: "DiffDash could not enumerate the selected repository remotes.",
              cause,
            }),
          ),
        )
        const candidates = remotes.flatMap((remote) => remote.fetchUrls)
        let firstRecognized: {
          readonly checkout: { readonly rootPath: string; readonly remoteUrl: string }
          readonly identity: HostedRepositoryLocator
        } | null = null
        for (const remoteUrl of candidates) {
          const identity = yield* Effect.option(gitProvider.parseRemoteUrl(remoteUrl))
          if (identity["_tag"] === "Some") {
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
        detected: Effect.Effect.Success<ReturnType<typeof detectHosted>>,
        isFavorite: boolean,
      ) {
        return yield* persist(
          {
            provider: detected.identity.providerId,
            owner: detected.identity.namespace,
            name: detected.identity.name,
            remoteUrl: detected.checkout.remoteUrl,
            localPath: detected.checkout.rootPath,
            ...(isFavorite ? { isFavorite: true } : {}),
          },
          "DiffDash could not save the local repository link.",
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
          const matches = yield* repositories
            .list(`${repository.namespace}/${repository.name}`)
            .pipe(
              Effect.mapError((cause) =>
                RepositoryLinkError.make({
                  operation: "findHosted",
                  reason: "DiffDash could not load the linked repository.",
                  cause,
                }),
              ),
            )
          return (
            matches.find(
              (candidate) =>
                candidate.provider !== "local" &&
                sameHostedRepository(
                  makeHostedRepositoryLocator(candidate.provider, candidate.owner, candidate.name),
                  repository,
                ),
            ) ?? null
          )
        }),
        ensureHosted: Effect.fn("RepositoryLinker.ensureHosted")(function* (
          repository,
          isFavorite = false,
        ) {
          const remoteUrl = yield* gitProvider.repositoryUrl(repository).pipe(
            Effect.mapError((cause) =>
              RepositoryLinkError.make({
                operation: "resolveHostedUrl",
                reason: "DiffDash could not resolve the repository URL.",
                cause,
              }),
            ),
          )
          return yield* persist(
            {
              provider: repository.providerId,
              owner: repository.namespace,
              name: repository.name,
              remoteUrl,
              localPath: null,
              ...(isFavorite ? { isFavorite: true } : {}),
            },
            "DiffDash could not save the hosted repository.",
          )
        }),
        ensureLocal: Effect.fn("RepositoryLinker.ensureLocal")(function* (localPath) {
          const rootPath = yield* detectRoot(localPath)
          return yield* persist(
            localRepositoryInput(rootPath),
            "DiffDash could not save the local repository.",
          )
        }),
        install: Effect.fn("RepositoryLinker.install")(function* (localPath) {
          const rootPath = yield* detectRoot(localPath)
          const detected = yield* detectHosted(rootPath)
          return yield* persistDetected(detected, true)
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
          return yield* persistDetected(detected, true)
        }),
      })
    }),
  )
}

const localRepositoryInput = (rootPath: string) => {
  const resolvedRootPath = resolve(rootPath)
  const hash = createHash("sha256").update(resolvedRootPath).digest("hex").slice(0, 12)
  const repoName = basename(resolvedRootPath) || "repository"
  return {
    provider: "local",
    owner: "local",
    name: `${repoName}-${hash}`,
    remoteUrl: pathToFileURL(resolvedRootPath).toString(),
    localPath: resolvedRootPath,
    isFavorite: false,
  } as const
}
