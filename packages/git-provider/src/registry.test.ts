import { describe, expect, it } from "@effect/vitest"
import { Effect, Either } from "effect"

import {
  BranchRevision,
  GitProviderCapabilities,
  GitProviderId,
  GitProviderKind,
  HostedRepository,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewDetail,
  HostedReviewDiff,
  HostedReviewLocator,
  HostedReviewNumber,
  HostedReviewSummary,
  ProviderActor,
  RepositoryNamespace,
  makeHostedRepositoryKey,
} from "@diffdash/domain/git-provider"
import {
  AmbiguousGitRemoteError,
  DuplicateGitProviderError,
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitProviderTerminology,
  HostedReviewCheckoutSpec,
  UnknownGitProviderError,
  type GitProviderRegistration,
} from "./git-provider"
import { GitProviderRegistry } from "./registry"
import { gitProviderConformance } from "./testing"

const makeProvider = (idValue: string, host = "git.example.com"): GitProviderRegistration => {
  const id = GitProviderId.make(idValue)
  const repository = HostedRepositoryLocator.make({
    providerId: id,
    namespace: RepositoryNamespace.make("platform/backend"),
    name: HostedRepositoryName.make("service"),
  })
  const review = HostedReviewLocator.make({
    repository,
    number: HostedReviewNumber.make(42),
  })
  const summary = HostedReviewSummary.make({
    locator: review,
    title: "Review",
    body: null,
    author: ProviderActor.make({
      id: null,
      username: "reviewer",
      displayName: null,
      avatarUrl: null,
    }),
    state: "open",
    decision: "none",
    url: `https://${host}/platform/backend/service/reviews/42`,
    draft: false,
    base: BranchRevision.make({ name: "main", revision: "base" }),
    head: BranchRevision.make({ name: "feature", revision: "head" }),
    createdAt: null,
    updatedAt: null,
  })
  return {
    descriptor: GitProviderDescriptor.make({
      id,
      kind: GitProviderKind.make("fake"),
      displayName: idValue,
      host,
      capabilities: GitProviderCapabilities.make({
        repositorySearch: true,
        searchScopes: true,
        assignedReviews: true,
        reviewDecisions: true,
        fileUrls: true,
        remoteWorkspaceBootstrap: true,
      }),
      terminology: GitProviderTerminology.make({
        repositorySingular: "repository",
        repositoryPlural: "repositories",
        reviewSingular: "review",
        reviewPlural: "reviews",
      }),
    }),
    diagnose: Effect.succeed(
      GitProviderDiagnostic.make({
        providerId: id,
        available: true,
        authenticated: true,
        message: null,
      }),
    ),
    parseRemote: (remoteUrl) => Effect.succeed(remoteUrl.includes(host) ? repository : null),
    searchRepositories: () =>
      Effect.succeed([
        HostedRepository.make({
          locator: repository,
          url: `https://${host}/platform/backend/service`,
          description: null,
          isPrivate: false,
          updatedAt: null,
        }),
      ]),
    listReviews: () => Effect.succeed([summary]),
    getReview: () => Effect.succeed(HostedReviewDetail.make({ summary, files: [], commits: [] })),
    getReviewDiff: () =>
      Effect.succeed(
        HostedReviewDiff.make({
          locator: review,
          headRevision: "head",
          diff: "",
          fetchedAt: "2026-07-16T00:00:00.000Z",
        }),
      ),
    getReviewDecision: () => Effect.succeed("none" as const),
    submitReviewDecision: () => Effect.void,
    repositoryUrl: () => `https://${host}/platform/backend/service`,
    fileUrl: (_repository, path, revision) =>
      `https://${host}/platform/backend/service/blob/${revision}/${path}`,
    bootstrapBareRepository: () => Effect.void,
    checkoutSpec: () =>
      Effect.succeed(
        HostedReviewCheckoutSpec.make({
          repository,
          review,
          remoteUrl: `https://${host}/platform/backend/service.git`,
          fetchRef: "refs/reviews/42/head",
          revision: "head",
        }),
      ),
  }
}

gitProviderConformance("fake", {
  create: () => makeProvider("fake"),
  configuredRemote: "git@git.example.com:platform/backend/service.git",
  nestedNamespace: "platform/backend",
  repositoryName: "service",
  reviewNumber: 42,
})

describe("GitProviderRegistry", () => {
  it.effect("FUN-130 AC: allows multiple instances of one provider kind", () =>
    Effect.gen(function* () {
      const registry = yield* GitProviderRegistry
      expect(yield* registry.list).toHaveLength(2)
      expect((yield* registry.list).map(({ descriptor }) => descriptor.kind)).toEqual([
        "fake",
        "fake",
      ])
      expect((yield* registry.get(GitProviderId.make("first"))).descriptor.id).toBe("first")
      const resolved = yield* registry.resolveRemote("https://second.example/service")
      expect(resolved).not.toBeNull()
      if (resolved !== null) expect(resolved.providerId).toBe("second")
    }).pipe(
      Effect.provide(
        GitProviderRegistry.layer([
          makeProvider("first", "first.example"),
          makeProvider("second", "second.example"),
        ]),
      ),
    ),
  )

  it.effect("FUN-130 AC: keeps the same namespace and name distinct across providers", () =>
    Effect.gen(function* () {
      const registry = yield* GitProviderRegistry
      const first = yield* registry.get(GitProviderId.make("first"))
      const second = yield* registry.get(GitProviderId.make("second"))
      const firstRepository = (yield* first.searchRepositories({ query: "", namespaces: [] }))[0]
      const secondRepository = (yield* second.searchRepositories({ query: "", namespaces: [] }))[0]

      expect(firstRepository).toBeDefined()
      expect(secondRepository).toBeDefined()
      if (firstRepository === undefined || secondRepository === undefined) return
      expect(firstRepository.locator.namespace).toBe(secondRepository.locator.namespace)
      expect(firstRepository.locator.name).toBe(secondRepository.locator.name)
      expect(makeHostedRepositoryKey(firstRepository.locator)).not.toBe(
        makeHostedRepositoryKey(secondRepository.locator),
      )
    }).pipe(
      Effect.provide(
        GitProviderRegistry.layer([
          makeProvider("first", "first.example"),
          makeProvider("second", "second.example"),
        ]),
      ),
    ),
  )

  it.effect("fails closed for unknown IDs and ambiguous remotes", () =>
    Effect.gen(function* () {
      const registry = yield* GitProviderRegistry
      const unknown = yield* Effect.either(registry.get(GitProviderId.make("missing")))
      const ambiguous = yield* Effect.either(registry.resolveRemote("https://shared.example/repo"))
      expect(Either.isLeft(unknown)).toBe(true)
      expect(Either.isLeft(ambiguous)).toBe(true)
      if (Either.isLeft(unknown)) expect(unknown.left).toBeInstanceOf(UnknownGitProviderError)
      if (Either.isLeft(ambiguous)) {
        expect(ambiguous.left).toBeInstanceOf(AmbiguousGitRemoteError)
      }
    }).pipe(
      Effect.provide(
        GitProviderRegistry.layer([
          makeProvider("first", "shared.example"),
          makeProvider("second", "shared.example"),
        ]),
      ),
    ),
  )

  it.effect("FUN-130 AC: rejects colliding provider instance IDs", () =>
    Effect.gen(function* () {
      const exit = yield* GitProviderRegistry.pipe(
        Effect.provide(GitProviderRegistry.layer([makeProvider("same"), makeProvider("same")])),
        Effect.either,
      )
      expect(Either.isLeft(exit)).toBe(true)
      if (Either.isLeft(exit)) expect(exit.left).toBeInstanceOf(DuplicateGitProviderError)
    }),
  )
})
