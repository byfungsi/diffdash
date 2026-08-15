import { Context, Effect, Layer, Option, Schema } from "effect"

import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import {
  ChangedFile,
  HostedRepositorySource,
  makeHostedRepositoryLocator,
} from "@diffdash/domain/git-provider"
import { ProjectRemoteSelectionRequired } from "@diffdash/domain/project-workspace"
import {
  makeRepositoryComparisonReviewKey,
  RepositoryComparisonDetail,
  RepositoryComparisonDiff,
  repositoryComparisonBaseRevision,
  repositoryComparisonHeadRevision,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import { RepositoryCheckoutPath, type Repo } from "@diffdash/domain/repository"
import { RepositoryComparisonSnapshot } from "@diffdash/domain/review-context"
import { makeReviewDiffIdentity, makeReviewSnapshotId } from "@diffdash/domain/review-identity"
import {
  HostedReviewWorkspacePool,
  HostedReviewWorkspacePoolError,
} from "@diffdash/local-git/hosted-review-workspace-pool"
import type { OpenRepositoryComparisonCommand } from "@diffdash/protocol/cli-navigation"
import { CoreAbsolutePath } from "../core-configuration"
import { GitProvider } from "./git-provider"
import { RepositoryLinker, RepositorySelectionIntent } from "./repository-linker"
import { CoreExpectedCause, toCoreExpectedCause } from "../core-error-cause"

const RepositoryComparisonOperation = Schema.String.pipe(
  Schema.brand("RepositoryComparisonOperation"),
)

/** A recoverable failure while resolving an immutable repository comparison. */
export class RepositoryComparisonSourceError extends Schema.TaggedError<RepositoryComparisonSourceError>()(
  "RepositoryComparisonSourceError",
  {
    code: Schema.Literals([
      "repository-not-found",
      "repository-ambiguous",
      "provider-unavailable",
      "revision-not-found",
      "revision-ambiguous",
      "no-common-ancestor",
      "revision-changed",
      "acquisition-failed",
    ]),
    operation: RepositoryComparisonOperation,
    reason: Schema.String,
    cause: CoreExpectedCause,
  },
) {}

/** Resolves saved repository selectors and pins immutable Git comparison coordinates. */
export class RepositoryComparisonSource extends Context.Service<
  RepositoryComparisonSource,
  {
    readonly resolve: (
      command: OpenRepositoryComparisonCommand,
    ) => Effect.Effect<RepositoryComparisonTarget, RepositoryComparisonSourceError>
    readonly repository: (
      target: RepositoryComparisonTarget,
    ) => Effect.Effect<Repo, RepositoryComparisonSourceError>
    readonly acquire: (
      target: RepositoryComparisonTarget,
    ) => Effect.Effect<RepositoryComparisonSnapshot, RepositoryComparisonSourceError>
    readonly useWorkspace: <A, E>(
      target: RepositoryComparisonTarget,
      run: (localPath: RepositoryCheckoutPath) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | RepositoryComparisonSourceError>
  }
>()("@diffdash/RepositoryComparisonSource") {
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
        const repository = saved.hostedLocator
        if (repository === null) {
          return yield* sourceError(
            "repository-not-found",
            "resolve.repositoryIdentity",
            "The saved repository does not have a hosted identity.",
            new Error("Saved repository is local-only"),
          )
        }
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
            remoteUrl:
              command.repository === null && saved.localPath !== null
                ? saved.localPath
                : saved.remoteUrl,
            baseRef: command.baseRef,
            headRef: command.headRef,
            bootstrapBareRepository: (destination) =>
              providers.bootstrapBareRepository(repository, CoreAbsolutePath.make(destination)),
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

      const repository = Effect.fn("RepositoryComparisonSource.repository")(function* (
        target: RepositoryComparisonTarget,
      ) {
        const saved = yield* repositories
          .findHosted(target.repository)
          .pipe(
            Effect.mapError((cause) =>
              sourceError(
                "acquisition-failed",
                "acquire.repository",
                "DiffDash could not load the saved comparison repository.",
                cause,
              ),
            ),
          )
        if (Option.isSome(saved)) return saved.value
        return yield* sourceError(
          "repository-not-found",
          "acquire.repository",
          "The comparison repository is no longer saved or linked in DiffDash.",
          new Error("Saved comparison repository was not found"),
        )
      })

      const comparisonInput = Effect.fn("RepositoryComparisonSource.comparisonInput")(function* (
        target: RepositoryComparisonTarget,
      ) {
        const saved = yield* repository(target)
        return {
          saved,
          input: {
            repository: target.repository,
            sourcePath: saved.localPath,
            remoteUrl: saved.remoteUrl,
            baseSha: target.baseSha,
            headSha: target.headSha,
            mergeBaseSha: target.mergeBaseSha,
            bootstrapBareRepository: (destination: string) =>
              providers.bootstrapBareRepository(
                target.repository,
                CoreAbsolutePath.make(destination),
              ),
          },
        } as const
      })

      const acquire = Effect.fn("RepositoryComparisonSource.acquire")(function* (
        target: RepositoryComparisonTarget,
      ) {
        const { input } = yield* comparisonInput(target)
        const diff = yield* workspaces
          .readComparisonDiff(input)
          .pipe(Effect.mapError(mapWorkspaceError))
        const parsedDiff = parseUnifiedDiff(diff)
        const fetchedAt = new Date().toISOString()
        const reviewKey = makeRepositoryComparisonReviewKey(target)
        const baseRevision = repositoryComparisonBaseRevision(target)
        const headRevision = repositoryComparisonHeadRevision(target)
        const diffIdentity = makeReviewDiffIdentity(diff)
        return RepositoryComparisonSnapshot.make({
          snapshotId: makeReviewSnapshotId({
            reviewKey,
            baseRevision,
            headRevision,
            diffIdentity,
          }),
          reviewKey,
          baseRevision,
          headRevision,
          detail: RepositoryComparisonDetail.make({
            target,
            title: `${target.baseRef}...${target.headRef}`,
            files: parsedDiff.files.map((file) =>
              ChangedFile.make({
                path: file.path,
                additions: file.additions,
                deletions: file.deletions,
                changeType: file.status,
              }),
            ),
            fetchedAt,
          }),
          diff: RepositoryComparisonDiff.make({ target, diff, fetchedAt }),
          parsedDiff,
        })
      })

      const useWorkspace = <A, E>(
        target: RepositoryComparisonTarget,
        run: (localPath: RepositoryCheckoutPath) => Effect.Effect<A, E>,
      ): Effect.Effect<A, E | RepositoryComparisonSourceError> =>
        comparisonInput(target).pipe(
          Effect.flatMap(({ input }) => workspaces.useComparison(input, run)),
          Effect.mapError((cause) =>
            Schema.is(HostedReviewWorkspacePoolError)(cause) ? mapWorkspaceError(cause) : cause,
          ),
        )

      return RepositoryComparisonSource.of({ acquire, repository, resolve, useWorkspace })
    }),
  )
}

const resolveSavedRepository = (
  repositories: RepositoryLinker["Service"],
  command: OpenRepositoryComparisonCommand,
) => {
  const selector = command.repository
  if (selector === null) {
    return repositories
      .openProject(
        RepositoryCheckoutPath.make(command.localPath),
        RepositorySelectionIntent.Automatic(),
      )
      .pipe(
        Effect.mapError((cause) =>
          sourceError("acquisition-failed", "resolve.currentRepository", cause.reason, cause),
        ),
        Effect.flatMap((result) => {
          if (Schema.is(ProjectRemoteSelectionRequired)(result)) {
            return sourceError(
              "repository-ambiguous",
              "resolve.currentRepository",
              "The current repository has multiple recognized remotes. Pass --repository=provider:namespace/name.",
              new Error(
                `Ambiguous current repository remotes: ${result.candidates
                  .map(({ remoteName }) => remoteName)
                  .join(", ")}`,
              ),
            )
          }
          if (!Schema.is(HostedRepositorySource)(result.repo.source)) {
            return sourceError(
              "repository-not-found",
              "resolve.currentRepository",
              "The current repository has no recognized hosted remote. Save a hosted repository and pass --repository=provider:namespace/name.",
              new Error("Current repository has no hosted identity"),
            )
          }
          return Effect.succeed(result.repo)
        }),
      )
  }
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
        Option.isNone(repository)
          ? sourceError(
              "repository-not-found",
              "resolve.repository",
              "The requested repository is not saved or linked in DiffDash.",
              new Error(`Saved repository not found: ${selector.providerId}`),
            )
          : Effect.succeed(repository.value),
      ),
    )
  }

  return repositories.list(`${selector.namespace}/${selector.name}`).pipe(
    Effect.mapError((cause) =>
      sourceError(
        "acquisition-failed",
        "resolve.repository",
        "DiffDash could not load saved repositories.",
        toCoreExpectedCause(cause),
      ),
    ),
    Effect.flatMap((saved) => {
      const namespace = selector.namespace.toLocaleLowerCase("en-US")
      const name = selector.name.toLocaleLowerCase("en-US")
      const matches = saved.filter(
        (repository) =>
          Schema.is(HostedRepositorySource)(repository.source) &&
          repository.source.locator.namespace.toLocaleLowerCase("en-US") === namespace &&
          repository.source.locator.name.toLocaleLowerCase("en-US") === name,
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
          `Ambiguous repository providers: ${matches
            .flatMap((repository) =>
              Schema.is(HostedRepositorySource)(repository.source)
                ? [repository.source.locator.providerId]
                : [],
            )
            .join(", ")}`,
        ),
      )
    }),
  )
}

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
  cause: CoreExpectedCause,
) =>
  RepositoryComparisonSourceError.make({
    code,
    operation: RepositoryComparisonOperation.make(operation),
    reason,
    cause,
  })
