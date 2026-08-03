import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { makeHostedRepositoryLocator } from "@diffdash/domain/git-provider"
import { GitCommitSha, RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { Repo } from "@diffdash/domain/repository"
import {
  HostedReviewWorkspacePool,
  HostedReviewWorkspacePoolError,
  type HostedRepositoryComparisonInput,
} from "@diffdash/local-git/hosted-review-workspace-pool"
import {
  CliRepositorySelector,
  OpenRepositoryComparisonCommand,
} from "@diffdash/protocol/cli-navigation"
import { GitProvider } from "./git-provider"
import {
  RepositoryComparisonSource,
  RepositoryComparisonSourceError,
} from "./repository-comparison-source"
import { RepositoryLinker } from "./repository-linker"

const baseSha = GitCommitSha.make("a".repeat(40))
const headSha = GitCommitSha.make("b".repeat(40))
const mergeBaseSha = GitCommitSha.make("c".repeat(40))

describe("RepositoryComparisonSource", () => {
  it.effect("resolves a provider-qualified linked repository and pins its exact target", () =>
    Effect.gen(function* () {
      const linked = repository({ localPath: "/repos/linux" })
      const pinnedInputs: HostedRepositoryComparisonInput[] = []
      let availabilityChecks = 0
      const target = yield* resolve(command("github"), {
        repositories: [linked],
        findHosted: linked,
        onAvailabilityCheck: () => availabilityChecks++,
        onPin: (input) => pinnedInputs.push(input),
      })

      expect(target).toMatchObject({
        kind: "repositoryComparison",
        repository: {
          providerId: "github",
          namespace: "torvalds",
          name: "linux",
        },
        baseRef: "v6.0",
        headRef: "v6.1",
        baseSha,
        headSha,
        mergeBaseSha,
      })
      expect(pinnedInputs).toHaveLength(1)
      expect(pinnedInputs[0]?.sourcePath).toBe("/repos/linux")
      expect(pinnedInputs[0]?.remoteUrl).toBe("https://github.com/torvalds/linux.git")
      expect(availabilityChecks).toBe(0)
    }),
  )

  it.effect("uses an unqualified selector only when exactly one provider matches", () =>
    Effect.gen(function* () {
      const github = repository({ provider: "github", localPath: "/repos/linux" })
      const target = yield* resolve(command(null), {
        repositories: [repository({ provider: "local" }), github],
        findHosted: null,
      })

      expect(target.repository.providerId).toBe("github")

      const error = yield* resolve(command(null), {
        repositories: [github, repository({ provider: "github-enterprise" })],
        findHosted: null,
      }).pipe(Effect.flip)
      expect(error).toMatchObject({
        code: "repository-ambiguous",
        operation: "resolve.repository",
      })
    }),
  )

  it.effect("rejects an unavailable provider before remote-only acquisition", () =>
    Effect.gen(function* () {
      let pinned = false
      const error = yield* resolve(command("github"), {
        repositories: [],
        findHosted: repository({ localPath: null }),
        providerAvailable: false,
        onPin: () => {
          pinned = true
        },
      }).pipe(Effect.flip)

      expect(error).toMatchObject({
        code: "provider-unavailable",
        operation: "resolve.provider",
      })
      expect(pinned).toBe(false)
    }),
  )

  it.effect("preserves actionable ref acquisition errors", () =>
    Effect.gen(function* () {
      const error = yield* resolve(command("github"), {
        repositories: [],
        findHosted: repository({ localPath: "/repos/linux" }),
        pinError: HostedReviewWorkspacePoolError.make({
          code: "revision-ambiguous",
          operation: "comparison.resolve.base",
          reason: "Use an explicit ref namespace.",
          cause: new Error("ambiguous"),
        }),
      }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(RepositoryComparisonSourceError)
      expect(error).toMatchObject({
        code: "revision-ambiguous",
        operation: "comparison.resolve.base",
        reason: "Use an explicit ref namespace.",
      })
    }),
  )
})

interface TestOptions {
  readonly repositories: readonly Repo[]
  readonly findHosted: Repo | null
  readonly providerAvailable?: boolean
  readonly pinError?: HostedReviewWorkspacePoolError
  readonly onAvailabilityCheck?: () => void
  readonly onPin?: (input: HostedRepositoryComparisonInput) => void
}

const resolve = (input: OpenRepositoryComparisonCommand, options: TestOptions) =>
  Effect.gen(function* () {
    const source = yield* RepositoryComparisonSource
    return yield* source.resolve(input)
  }).pipe(Effect.provide(testLayer(options)))

const testLayer = (options: TestOptions) =>
  RepositoryComparisonSource.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          RepositoryLinker,
          RepositoryLinker.of({
            list: () => Effect.succeed(options.repositories),
            findHosted: () => Effect.succeed(options.findHosted),
            setFavorite: () => unavailable(),
            ensureHosted: () => unavailable(),
            ensureLocal: () => unavailable(),
            openProject: () => unavailable(),
            forget: () => unavailable(),
            install: () => unavailable(),
            link: () => unavailable(),
            repairIdentities: () => unavailable(),
          }),
        ),
        Layer.succeed(
          GitProvider,
          GitProvider.of({
            listProviders: unavailable(),
            diagnoseProviders: unavailable(),
            parseRemoteUrl: () => unavailable(),
            resolveRepository: () => unavailable(),
            repositoryUrl: () => unavailable(),
            fileUrl: () => unavailable(),
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
            isAvailable: () =>
              Effect.sync(() => {
                options.onAvailabilityCheck?.()
                return options.providerAvailable ?? true
              }),
          }),
        ),
        Layer.succeed(
          HostedReviewWorkspacePool,
          HostedReviewWorkspacePool.of({
            use: () => unavailable(),
            pinComparison: (comparison) =>
              Effect.sync(() => options.onPin?.(comparison)).pipe(
                Effect.zipRight(
                  options.pinError === undefined
                    ? Effect.succeed({ baseSha, headSha, mergeBaseSha })
                    : Effect.fail(options.pinError),
                ),
              ),
          }),
        ),
      ),
    ),
  )

const command = (providerId: string | null) =>
  OpenRepositoryComparisonCommand.make({
    repository: CliRepositorySelector.make({
      providerId:
        providerId === null
          ? null
          : makeHostedRepositoryLocator(providerId, "torvalds", "linux").providerId,
      namespace: makeHostedRepositoryLocator("github", "torvalds", "linux").namespace,
      name: makeHostedRepositoryLocator("github", "torvalds", "linux").name,
    }),
    baseRef: RepositoryComparisonRef.make("v6.0"),
    headRef: RepositoryComparisonRef.make("v6.1"),
  })

const repository = (
  overrides: Partial<Pick<Repo, "provider" | "owner" | "name" | "localPath">> = {},
) =>
  Repo.make({
    id: `${overrides.provider ?? "github"}:torvalds/linux`,
    provider: overrides.provider ?? "github",
    owner: overrides.owner ?? "torvalds",
    name: overrides.name ?? "linux",
    remoteUrl: "https://github.com/torvalds/linux.git",
    localPath: overrides.localPath ?? null,
    isFavorite: false,
    lastOpenedAt: null,
    lastSyncedAt: null,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  })

const unavailable = <A = never>(): Effect.Effect<A> =>
  Effect.dieMessage("Unexpected test service call")
