import { Context, Effect, Layer, Schema } from "effect"

import { makeHostedRepositoryLocator } from "@diffdash/domain/git-provider"
import { RepositoryComparisonTarget } from "@diffdash/domain/repository-comparison"
import type { Repo } from "@diffdash/domain/repository"
import {
  HostedReviewWorkspacePool,
  type HostedReviewWorkspacePoolError,
} from "@diffdash/local-git/hosted-review-workspace-pool"
import type { OpenRepositoryComparisonCommand } from "@diffdash/protocol/cli-navigation"
import { GitProvider } from "./git-provider"
import { RepositoryLinker } from "./repository-linker"

/** A recoverable failure while resolving an immutable repository comparison. */
export class RepositoryComparisonSourceError extends Schema.TaggedError<RepositoryComparisonSourceError>()(
  "RepositoryComparisonSourceError",
  {
    code: Schema.Literal(
      "repository-not-found",
      "repository-ambiguous",
      "provider-unavailable",
      "revision-not-found",
      "revision-ambiguous",
      "no-common-ancestor",
      "revision-changed",
      "acquisition-failed",
    ),
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Resolves saved repository selectors and pins immutable Git comparison coordinates. */
export class RepositoryComparisonSource extends Context.Tag("@diffdash/RepositoryComparisonSource")<
  RepositoryComparisonSource,
  {
    readonly resolve: (
      command: OpenRepositoryComparisonCommand,
    ) => Effect.Effect<RepositoryComparisonTarget, RepositoryComparisonSourceError>
  }
>() {
  static readonly layer = Layer.effect(
    RepositoryComparisonSource,
    Effect.gen(function* () {
      const repositories = yield* RepositoryLinker
      const providers = yield* GitProvider
      const workspaces = yield* HostedReviewWorkspacePool

      const resolve = Effect.fn("RepositoryComparisonSource.resolve")(function* (
        command: OpenRepositoryComparisonCommand,
      ) {
        const saved = yield* resolveSavedRepository(repositories, command)
        const repository = yield* locatorFromRepo(saved)
        if (saved.localPath === null) {
          const available = yield* providers.isAvailable(repository.providerId)
          if (!available) {
            return yield* sourceError(
              "provider-unavailable",
              "resolve.provider",
              `The ${repository.providerId} provider is unavailable. Configure or authenticate it, then retry.`,
              new Error(`Provider unavailable: ${repository.providerId}`),
            )
          }
        }

        const pinned = yield* workspaces
          .pinComparison({
            repository,
            sourcePath: saved.localPath,
            remoteUrl: saved.remoteUrl,
            baseRef: command.baseRef,
            headRef: command.headRef,
            bootstrapBareRepository: (destination) =>
              providers.bootstrapBareRepository(repository, destination),
          })
          .pipe(Effect.mapError(mapWorkspaceError))

        return RepositoryComparisonTarget.make({
          kind: "repositoryComparison",
          repository,
          baseRef: command.baseRef,
          headRef: command.headRef,
          ...pinned,
        })
      })

      return RepositoryComparisonSource.of({ resolve })
    }),
  )
}

const resolveSavedRepository = (
  repositories: RepositoryLinker["Type"],
  command: OpenRepositoryComparisonCommand,
) => {
  const selector = command.repository
  if (selector.providerId !== null) {
    const requested = makeHostedRepositoryLocator(
      selector.providerId,
      selector.namespace,
      selector.name,
    )
    return repositories.findHosted(requested).pipe(
      Effect.mapError((cause) =>
        sourceError(
          "acquisition-failed",
          "resolve.repository",
          "DiffDash could not load the requested saved repository.",
          cause,
        ),
      ),
      Effect.flatMap((repository) =>
        repository === null
          ? sourceError(
              "repository-not-found",
              "resolve.repository",
              "The requested repository is not saved or linked in DiffDash.",
              new Error(`Saved repository not found: ${selector.providerId}`),
            )
          : Effect.succeed(repository),
      ),
    )
  }

  return repositories.list(`${selector.namespace}/${selector.name}`).pipe(
    Effect.mapError((cause) =>
      sourceError(
        "acquisition-failed",
        "resolve.repository",
        "DiffDash could not load saved repositories.",
        cause,
      ),
    ),
    Effect.flatMap((saved) => {
      const namespace = selector.namespace.toLocaleLowerCase("en-US")
      const name = selector.name.toLocaleLowerCase("en-US")
      const matches = saved.filter(
        (repository) =>
          repository.provider !== "local" &&
          repository.owner.toLocaleLowerCase("en-US") === namespace &&
          repository.name.toLocaleLowerCase("en-US") === name,
      )
      const match = matches[0]
      if (matches.length === 1 && match !== undefined) return Effect.succeed(match)
      if (matches.length === 0) {
        return sourceError(
          "repository-not-found",
          "resolve.repository",
          "The requested repository is not saved or linked in DiffDash.",
          new Error("No saved repository matched the unqualified selector"),
        )
      }
      return sourceError(
        "repository-ambiguous",
        "resolve.repository",
        "The repository exists on multiple providers. Qualify it as provider:namespace/name.",
        new Error(
          `Ambiguous repository providers: ${matches.map(({ provider }) => provider).join(", ")}`,
        ),
      )
    }),
  )
}

const locatorFromRepo = (repository: Repo) =>
  Effect.try({
    try: () => makeHostedRepositoryLocator(repository.provider, repository.owner, repository.name),
    catch: (cause) =>
      sourceError(
        "acquisition-failed",
        "resolve.repositoryIdentity",
        "The saved repository has an invalid hosted identity.",
        cause,
      ),
  })

const mapWorkspaceError = (
  cause: HostedReviewWorkspacePoolError,
): RepositoryComparisonSourceError => {
  switch (cause.code) {
    case "revision-not-found":
    case "revision-ambiguous":
    case "no-common-ancestor":
    case "revision-changed":
      return sourceError(cause.code, cause.operation, cause.reason, cause)
    default:
      return sourceError("acquisition-failed", cause.operation, cause.reason, cause)
  }
}

const sourceError = (
  code: RepositoryComparisonSourceError["code"],
  operation: string,
  reason: string,
  cause: unknown,
) => RepositoryComparisonSourceError.make({ code, operation, reason, cause })
