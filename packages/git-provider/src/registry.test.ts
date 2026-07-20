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
  GitProviderOperationError,
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitProviderRegistry,
  GitProviderTerminology,
  HostedReviewCheckoutSpec,
  UnknownGitProviderError,
  type GitProviderRegistration,
} from "./git-provider"
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
    publishingTools: [`${idValue}-cli`],
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
    repositoryUrl: () => Effect.succeed(`https://${host}/platform/backend/service`),
    fileUrl: (_repository, path, revision) =>
      Effect.succeed(`https://${host}/platform/backend/service/blob/${revision}/${path}`),
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

  it.effect("rejects malformed dynamic provider results with a bounded operation error", () => {
    const registration = makeProvider("fake")
    Object.defineProperty(registration, "searchRepositories", {
      value: () => Effect.succeed([{ locator: { providerId: "fake" } }]),
    })

    return Effect.gen(function* () {
      const registry = yield* GitProviderRegistry
      const provider = yield* registry.get(GitProviderId.make("fake"))
      const result = yield* Effect.either(
        provider.searchRepositories({ query: "", namespaces: [] }),
      )

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(GitProviderOperationError)
        expect(result.left.operation).toBe("searchRepositories")
        expect(result.left.message).toBe("Provider returned malformed data")
        expect(result.left.message.length).toBeLessThanOrEqual(500)
      }
    }).pipe(Effect.provide(GitProviderRegistry.layer([registration])))
  })

  it.effect("rejects a malformed registration descriptor before exposing the provider", () => {
    const registration = makeProvider("fake")
    Object.defineProperty(registration, "descriptor", {
      value: { id: "local", kind: "fake" },
    })

    return Effect.gen(function* () {
      const result = yield* GitProviderRegistry.pipe(
        Effect.provide(GitProviderRegistry.layer([registration])),
        Effect.either,
      )

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(GitProviderOperationError)
        if (result.left instanceof GitProviderOperationError) {
          expect(result.left.providerId).toBe("invalid-provider")
          expect(result.left.operation).toBe("register.descriptor")
        }
      }
    })
  })

  it.effect("rejects same-provider cross-target review and checkout results", () => {
    const registration = makeProvider("fake")
    const requested = HostedReviewLocator.make({
      repository: HostedRepositoryLocator.make({
        providerId: GitProviderId.make("fake"),
        namespace: RepositoryNamespace.make("platform/backend"),
        name: HostedRepositoryName.make("service"),
      }),
      number: HostedReviewNumber.make(42),
    })
    const other = HostedReviewLocator.make({
      repository: requested.repository,
      number: HostedReviewNumber.make(43),
    })
    Object.defineProperty(registration, "getReviewDiff", {
      value: () =>
        Effect.succeed(
          HostedReviewDiff.make({
            locator: other,
            headRevision: "head",
            diff: "",
            fetchedAt: "2026-07-16T00:00:00.000Z",
          }),
        ),
    })
    Object.defineProperty(registration, "checkoutSpec", {
      value: () =>
        Effect.succeed(
          HostedReviewCheckoutSpec.make({
            repository: other.repository,
            review: other,
            remoteUrl: "https://git.example.com/platform/backend/service.git",
            fetchRef: "refs/reviews/43/head",
            revision: "head",
          }),
        ),
    })

    return Effect.gen(function* () {
      const registry = yield* GitProviderRegistry
      const provider = yield* registry.get(GitProviderId.make("fake"))
      const diff = yield* Effect.either(provider.getReviewDiff(requested))
      const checkout = yield* Effect.either(provider.checkoutSpec(requested))

      expect(Either.isLeft(diff)).toBe(true)
      expect(Either.isLeft(checkout)).toBe(true)
      if (Either.isLeft(diff))
        expect(diff.left.message).toBe("Provider returned data for another target")
      if (Either.isLeft(checkout)) {
        expect(checkout.left.message).toBe("Provider returned data for another target")
      }
    }).pipe(Effect.provide(GitProviderRegistry.layer([registration])))
  })

  it.effect("rejects repository and review methods that drift within one provider", () => {
    const registration = makeProvider("fake")
    const requestedRepository = HostedRepositoryLocator.make({
      providerId: GitProviderId.make("fake"),
      namespace: RepositoryNamespace.make("platform/backend"),
      name: HostedRepositoryName.make("service"),
    })
    const otherRepository = HostedRepositoryLocator.make({
      ...requestedRepository,
      name: HostedRepositoryName.make("other-service"),
    })
    const requestedReview = HostedReviewLocator.make({
      repository: requestedRepository,
      number: HostedReviewNumber.make(42),
    })
    const otherReview = HostedReviewLocator.make({
      repository: requestedRepository,
      number: HostedReviewNumber.make(43),
    })
    const otherSummary = HostedReviewSummary.make({
      locator: otherReview,
      title: "Other review",
      body: null,
      author: ProviderActor.make({
        id: null,
        username: "reviewer",
        displayName: null,
        avatarUrl: null,
      }),
      state: "open",
      decision: "none",
      url: "https://git.example.com/platform/backend/service/reviews/43",
      draft: false,
      base: BranchRevision.make({ name: "main", revision: "base" }),
      head: BranchRevision.make({ name: "feature", revision: "head" }),
      createdAt: null,
      updatedAt: null,
    })
    const otherRepositorySummary = HostedReviewSummary.make({
      ...otherSummary,
      locator: HostedReviewLocator.make({
        repository: otherRepository,
        number: HostedReviewNumber.make(42),
      }),
    })
    Object.defineProperty(registration, "listReviews", {
      value: () => Effect.succeed([otherRepositorySummary]),
    })
    Object.defineProperty(registration, "getReview", {
      value: () =>
        Effect.succeed(HostedReviewDetail.make({ summary: otherSummary, files: [], commits: [] })),
    })
    Object.defineProperty(registration, "checkoutSpecAtRevision", {
      value: () =>
        Effect.succeed(
          HostedReviewCheckoutSpec.make({
            repository: otherRepository,
            review: otherReview,
            remoteUrl: "https://git.example.com/platform/backend/other-service.git",
            fetchRef: "refs/reviews/43/head",
            revision: "other-head",
          }),
        ),
    })

    return Effect.gen(function* () {
      const registry = yield* GitProviderRegistry
      const provider = yield* registry.get(GitProviderId.make("fake"))
      const listed = yield* Effect.either(provider.listReviews(requestedRepository))
      const detail = yield* Effect.either(provider.getReview(requestedReview))
      const checkout = yield* Effect.either(
        provider.checkoutSpecAtRevision?.(requestedReview, "head") ?? Effect.void,
      )

      expect(Either.isLeft(listed)).toBe(true)
      expect(Either.isLeft(detail)).toBe(true)
      expect(Either.isLeft(checkout)).toBe(true)
    }).pipe(Effect.provide(GitProviderRegistry.layer([registration])))
  })

  it.effect("preserves typed failures returned by a provider", () => {
    const registration = makeProvider("fake")
    const expected = GitProviderOperationError.make({
      providerId: GitProviderId.make("fake"),
      operation: "listReviews",
      message: "Provider is temporarily unavailable",
    })
    Object.defineProperty(registration, "listReviews", {
      value: () => expected,
    })

    return Effect.gen(function* () {
      const registry = yield* GitProviderRegistry
      const provider = yield* registry.get(GitProviderId.make("fake"))
      const repository = HostedRepositoryLocator.make({
        providerId: GitProviderId.make("fake"),
        namespace: RepositoryNamespace.make("platform/backend"),
        name: HostedRepositoryName.make("service"),
      })
      const result = yield* Effect.either(provider.listReviews(repository))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) expect(result.left).toBe(expected)
    }).pipe(Effect.provide(GitProviderRegistry.layer([registration])))
  })
})
