import { Context, Effect, Layer, Schema } from "effect"

import type { Repo } from "../../shared/domain"
import type { LinkRepositoryCheckoutRequest } from "../../shared/repository-link"
import { GitService } from "./git"
import { GitProvider } from "./git-provider"
import { RepositoryStore } from "./repository-store"

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

      const detect = Effect.fn("RepositoryLinker.detect")(function* (localPath: string) {
        const checkout = yield* git.detectRepository(localPath).pipe(
          Effect.mapError((cause) =>
            RepositoryLinkError.make({
              operation: "detectRepository",
              reason: "Select a Git repository with a GitHub origin.",
              cause,
            }),
          ),
        )
        const identity = yield* gitProvider.parseRemoteUrl(checkout.remoteUrl).pipe(
          Effect.mapError((cause) =>
            RepositoryLinkError.make({
              operation: "parseRemoteUrl",
              reason: "The selected repository origin is not a supported GitHub remote.",
              cause,
            }),
          ),
        )
        return { checkout, identity }
      })

      const persist = Effect.fn("RepositoryLinker.persist")(function* (
        detected: Effect.Effect.Success<ReturnType<typeof detect>>,
      ) {
        return yield* repositories
          .upsertRepository({
            provider: detected.identity.provider,
            owner: detected.identity.owner,
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
          const detected = yield* detect(request.localPath)
          if (
            detected.identity.owner.toLowerCase() !== request.owner.toLowerCase() ||
            detected.identity.name.toLowerCase() !== request.name.toLowerCase()
          ) {
            return yield* RepositoryLinkError.make({
              operation: "validateIdentity",
              reason: `Selected checkout is ${detected.identity.owner}/${detected.identity.name}, not ${request.owner}/${request.name}.`,
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
