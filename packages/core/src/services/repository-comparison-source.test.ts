import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"

import { makeHostedRepositoryLocator } from "@diffdash/domain/git-provider"
import { GitCommitSha, RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { noRepositoryLocalPath, Repo, repositoryLocalPath } from "@diffdash/domain/repository"
import {
  ProjectOpened,
  type ProjectOpenResult,
  ProjectRemoteCandidate,
  ProjectRemoteSelectionRequired,
} from "@diffdash/domain/project-workspace"
import {
  HostedReviewWorkspacePool,
  HostedReviewWorkspacePoolError,
  type HostedRepositoryComparisonInput,
  type PinnedRepositoryComparisonInput,
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
  it.effect("resolves an omitted repository from the invocation checkout", () =>
    Effect.gen(function* () {
      const linked = repository({ localPath: repositoryLocalPath("/repos/linux") })
      const openedPaths: string[] = []
      const pinnedInputs: HostedRepositoryComparisonInput[] = []
      const target = yield* resolve(command(), {
        repositories: [],
        findHosted: Option.none(),
        openProject: ProjectOpened.make({ repo: linked }),
        onOpenProject: (localPath) => openedPaths.push(localPath),
        onPin: (input) => pinnedInputs.push(input),
      })

      expect(openedPaths).toEqual(["/repos/linux"])
      expect(target.repository).toMatchObject({
        providerId: "github",
        namespace: "torvalds",
        name: "linux",
      })
      expect(pinnedInputs[0]).toMatchObject({
        sourcePath: "/repos/linux",
        remoteUrl: "/repos/linux",
      })
    }),
  )

  it.effect("rejects ambiguous or local-only invocation checkouts", () =>
    Effect.gen(function* () {
      const ambiguous = yield* resolve(command(), {
        repositories: [],
        findHosted: Option.none(),
        openProject: ProjectRemoteSelectionRequired.make({
          rootPath: "/repos/linux",
          candidates: [
            ProjectRemoteCandidate.make({
              remoteName: "origin",
              repository: makeHostedRepositoryLocator("github", "torvalds", "linux"),
            }),
            ProjectRemoteCandidate.make({
              remoteName: "upstream",
              repository: makeHostedRepositoryLocator("github", "linux", "linux"),
            }),
          ],
        }),
      }).pipe(Effect.flip)
      expect(ambiguous).toMatchObject({
        code: "repository-ambiguous",
        operation: "resolve.currentRepository",
      })

      const localOnly = yield* resolve(command(), {
        repositories: [],
        findHosted: Option.none(),
        openProject: ProjectOpened.make({ repo: repository({ provider: "local" }) }),
      }).pipe(Effect.flip)
      expect(localOnly).toMatchObject({
        code: "repository-not-found",
        operation: "resolve.currentRepository",
      })
    }),
  )

  it.effect("resolves a provider-qualified linked repository and pins its exact target", () =>
    Effect.gen(function* () {
      const linked = repository({ localPath: repositoryLocalPath("/repos/linux") })
      const pinnedInputs: HostedRepositoryComparisonInput[] = []
      let availabilityChecks = 0
      const target = yield* resolve(command("github"), {
        repositories: [linked],
        findHosted: Option.some(linked),
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
      const github = repository({
        provider: "github",
        localPath: repositoryLocalPath("/repos/linux"),
      })
      const target = yield* resolve(command(null), {
        repositories: [repository({ provider: "local" }), github],
        findHosted: Option.none(),
      })

      expect(target.repository.providerId).toBe("github")

      const error = yield* resolve(command(null), {
        repositories: [github, repository({ provider: "github-enterprise" })],
        findHosted: Option.none(),
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
        findHosted: Option.some(repository({ localPath: noRepositoryLocalPath })),
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
        findHosted: Option.some(repository({ localPath: repositoryLocalPath("/repos/linux") })),
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

  it.effect("acquires snapshot content and workspaces only from pinned revisions", () => {
    const readInputs: PinnedRepositoryComparisonInput[] = []
    const options: TestOptions = {
      repositories: [],
      findHosted: Option.some(repository({ localPath: repositoryLocalPath("/repos/linux") })),
      diff: `diff --git a/kernel.c b/kernel.c
--- a/kernel.c
+++ b/kernel.c
@@ -1 +1 @@
-old
+new`,
      onRead: (input) => readInputs.push(input),
    }
    return Effect.gen(function* () {
      const source = yield* RepositoryComparisonSource
      const target = yield* source.resolve(command("github"))
      const snapshot = yield* source.acquire(target)
      const workspace = yield* source.useWorkspace(target, (localPath) => Effect.succeed(localPath))

      expect(snapshot.baseRevision).toBe(mergeBaseSha)
      expect(snapshot.headRevision).toBe(headSha)
      expect(snapshot.detail.title).toBe("v6.0...v6.1")
      expect(snapshot.parsedDiff.files.map(({ path }) => path)).toEqual(["kernel.c"])
      expect(readInputs).toHaveLength(2)
      expect(readInputs[0]).toMatchObject({ baseSha, headSha, mergeBaseSha })
      expect(workspace).toBe("/comparison-workspace")
    }).pipe(Effect.provide(testLayer(options)))
  })
})

interface TestOptions {
  readonly repositories: readonly Repo[]
  readonly findHosted: Option.Option<Repo>
  readonly openProject?: ProjectOpenResult
  readonly providerAvailable?: boolean
  readonly pinError?: HostedReviewWorkspacePoolError
  readonly onAvailabilityCheck?: () => void
  readonly onOpenProject?: (localPath: string) => void
  readonly onPin?: (input: HostedRepositoryComparisonInput) => void
  readonly onRead?: (input: PinnedRepositoryComparisonInput) => void
  readonly diff?: string
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
            openProject: (localPath) =>
              Effect.sync(() => options.onOpenProject?.(localPath)).pipe(
                Effect.zipRight(
                  options.openProject === undefined
                    ? unavailable()
                    : Effect.succeed(options.openProject),
                ),
              ),
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
            readComparisonDiff: (input) =>
              Effect.sync(() => {
                options.onRead?.(input)
                return options.diff ?? ""
              }),
            useComparison: (input, run) =>
              Effect.sync(() => options.onRead?.(input)).pipe(
                Effect.zipRight(run("/comparison-workspace")),
              ),
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

const command = (providerId?: string | null) =>
  OpenRepositoryComparisonCommand.make({
    localPath: "/repos/linux",
    repository:
      providerId === undefined
        ? null
        : CliRepositorySelector.make({
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
    localPath: overrides.localPath ?? noRepositoryLocalPath,
    isFavorite: false,
    lastOpenedAt: null,
    lastSyncedAt: null,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  })

const unavailable = <A = never>(): Effect.Effect<A> =>
  Effect.dieMessage("Unexpected test service call")
