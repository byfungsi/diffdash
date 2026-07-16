import { Context, Effect, Layer, Schema } from "effect"

import type { Repo } from "@diffdash/domain/repository"
import type { HostedRepositoryLocator } from "@diffdash/domain/git-provider"
import type { LinkRepositoryCheckoutRequest } from "@diffdash/protocol/repository-link"
import { GitService } from "@diffdash/local-git/local-git"
import { GitProvider } from "./git-provider"
import { RepositoryStore } from "@diffdash/persistence/repository-store"

/** A local checkout could not be safely linked to a GitHub repository. */
export class RepositoryLinkError extends Schema.TaggedError<RepositoryLinkError>()(
  "RepositoryLinkError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Main-process service for validating and persisting GitHub checkout links. */
export class RepositoryLinker extends Context.Tag("@diffdash/RepositoryLinker")<
  RepositoryLinker,
  {
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

      const detect = Effect.fn("RepositoryLinker.detect")(function* (
        localPath: string,
        expected?: HostedRepositoryLocator,
      ) {
        const rootPath = yield* git.detectRoot(localPath).pipe(
          Effect.mapError((cause) =>
            RepositoryLinkError.make({
              operation: "detectRepository",
              reason: "Select a Git repository.",
              cause,
            }),
          ),
        )
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
        detected: Effect.Effect.Success<ReturnType<typeof detect>>,
      ) {
        return yield* repositories
          .upsertRepository({
            provider: detected.identity.providerId,
            owner: detected.identity.namespace,
            name: detected.identity.name,
            remoteUrl: detected.checkout.remoteUrl,
            localPath: detected.checkout.rootPath,
            isFavorite: true,
          })
          .pipe(
            Effect.mapError((cause) =>
              RepositoryLinkError.make({
                operation: "persist",
                reason: "DiffDash could not save the local repository link.",
                cause,
              }),
            ),
          )
      })

      return RepositoryLinker.of({
        install: Effect.fn("RepositoryLinker.install")(function* (localPath) {
          const detected = yield* detect(localPath)
          return yield* persist(detected)
        }),
        link: Effect.fn("RepositoryLinker.link")(function* (request) {
          const detected = yield* detect(request.localPath, request.repository)
          if (!sameHostedRepository(detected.identity, request.repository)) {
            return yield* RepositoryLinkError.make({
              operation: "validateIdentity",
              reason: `Selected checkout is ${detected.identity.providerId}:${detected.identity.namespace}/${detected.identity.name}, not ${request.repository.providerId}:${request.repository.namespace}/${request.repository.name}.`,
              cause: new Error(
                "The selected checkout origin does not match the requested repository",
              ),
            })
          }
          return yield* persist(detected)
        }),
      })
    }),
  )
}

const sameHostedRepository = (left: HostedRepositoryLocator, right: HostedRepositoryLocator) =>
  left.providerId === right.providerId &&
  left.namespace.toLowerCase() === right.namespace.toLowerCase() &&
  left.name.toLowerCase() === right.name.toLowerCase()
