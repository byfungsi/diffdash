import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Stream } from "effect"

import {
  BranchRevision,
  GitFileRevision,
  GitProviderCapabilities,
  GitProviderId,
  GitProviderKind,
  HostedRepository,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewDetail,
  HostedReviewLocator,
  HostedReviewNumber,
  HostedReviewSummary,
  ProviderActor,
  RepositoryNamespace,
  RepositoryRelativePath,
  makeHostedRepositoryKey,
} from "@diffdash/domain/git-provider"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import { WebUrl } from "@diffdash/domain/web-url"
import {
  AmbiguousGitRemoteError,
  DuplicateGitProviderError,
  DiagnosticOperation,
  GitProviderOperationError,
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitProviderRegistry,
  GitProviderTerminology,
  HostedReviewCheckoutSpec,
  HostedReviewDiffSourceTarget,
  ReviewDiffSemanticIdentity,
  ReviewDiffSourceFacts,
  ReviewDiffSourceOffer,
  ReviewKey,
  UnifiedBytesMethod,
  REVIEW_DIFF_MAX_CHUNK_BYTES,
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
    url: WebUrl.make(`https://${host}/platform/backend/service/reviews/42`),
    draft: false,
    base: BranchRevision.make({
      name: RepositoryComparisonRef.make("main"),
      revision: ReviewRevision.make("base"),
    }),
    head: BranchRevision.make({
      name: RepositoryComparisonRef.make("feature"),
      revision: ReviewRevision.make("head"),
    }),
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
          url: WebUrl.make(`https://${host}/platform/backend/service`),
          description: null,
          isPrivate: false,
          updatedAt: null,
        }),
      ]),
    listReviews: () => Effect.succeed([summary]),
    getReview: () => Effect.succeed(HostedReviewDetail.make({ summary, files: [], commits: [] })),
    getReviewDiffSource: () =>
      Effect.succeed({
        offer: ReviewDiffSourceOffer.make({
          target: HostedReviewDiffSourceTarget.make({
            review,
            reviewKey: ReviewKey.make(`${id}:platform/backend/service#42`),
          }),
          expectedRevision: ReviewRevision.make("head"),
          semanticIdentity: ReviewDiffSemanticIdentity.make("conformance-source"),
          methods: [UnifiedBytesMethod.make({ maxChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES })],
          facts: ReviewDiffSourceFacts.make({
            origin: "remote",
            revisionKind: "mutable",
            reproducible: false,
            complete: true,
            declaredBytes: 0,
          }),
        }),
        unifiedBytes: () => Stream.empty,
        close: Effect.void,
      }),
    getReviewDecision: () => Effect.succeed("none" as const),
    submitReviewDecision: () => Effect.void,
    repositoryUrl: () => Effect.succeed(WebUrl.make(`https://${host}/platform/backend/service`)),
    fileUrl: (_repository, path, revision) =>
      Effect.succeed(
        WebUrl.make(`https://${host}/platform/backend/service/blob/${revision}/${path}`),
      ),
    bootstrapBareRepository: () => Effect.void,
    checkoutSpec: (_review, revision) =>
      Effect.succeed(
        HostedReviewCheckoutSpec.make({
          repository,
          review,
          remoteUrl: `https://${host}/platform/backend/service.git`,
          fetchRef: RepositoryComparisonRef.make("refs/reviews/42/head"),
          revision,
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
      const unknown = yield* Effect.result(registry.get(GitProviderId.make("missing")))
      const ambiguous = yield* Effect.result(registry.resolveRemote("https://shared.example/repo"))
      expect(Result.isFailure(unknown)).toBe(true)
      expect(Result.isFailure(ambiguous)).toBe(true)
      if (Result.isFailure(unknown)) expect(unknown.failure).toBeInstanceOf(UnknownGitProviderError)
      if (Result.isFailure(ambiguous)) {
        expect(ambiguous.failure).toBeInstanceOf(AmbiguousGitRemoteError)
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
        Effect.result,
      )
      expect(Result.isFailure(exit)).toBe(true)
      if (Result.isFailure(exit)) expect(exit.failure).toBeInstanceOf(DuplicateGitProviderError)
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
      const result = yield* Effect.result(
        provider.searchRepositories({ query: "", namespaces: [] }),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(GitProviderOperationError)
        expect(result.failure.operation).toBe("searchRepositories")
        expect(result.failure.message).toBe("Provider returned malformed data")
        expect(result.failure.message.length).toBeLessThanOrEqual(500)
      }
    }).pipe(Effect.provide(GitProviderRegistry.layer([registration])))
  })

  it.effect("preserves a validated bounded review source through registry wrapping", () => {
    const registration = makeProvider("fake")
    const review = HostedReviewLocator.make({
      repository: HostedRepositoryLocator.make({
        providerId: GitProviderId.make("fake"),
        namespace: RepositoryNamespace.make("platform/backend"),
        name: HostedRepositoryName.make("service"),
      }),
      number: HostedReviewNumber.make(42),
    })
    const source = {
      offer: ReviewDiffSourceOffer.make({
        target: HostedReviewDiffSourceTarget.make({
          review,
          reviewKey: ReviewKey.make("fake:platform/backend/service#42"),
        }),
        expectedRevision: ReviewRevision.make("head"),
        semanticIdentity: ReviewDiffSemanticIdentity.make("fixture-source"),
        methods: [UnifiedBytesMethod.make({ maxChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES })],
        facts: ReviewDiffSourceFacts.make({
          origin: "remote",
          revisionKind: "mutable",
          reproducible: false,
          complete: true,
          declaredBytes: null,
        }),
      }),
      unifiedBytes: () => Stream.die(new Error("Unused source method")),
      close: Effect.void,
    }
    Object.defineProperty(registration, "getReviewDiffSource", {
      value: () => Effect.succeed(source),
    })

    return Effect.gen(function* () {
      const registry = yield* GitProviderRegistry
      const provider = yield* registry.get(GitProviderId.make("fake"))
      expect(yield* provider.getReviewDiffSource(review)).toBe(source)
    }).pipe(Effect.provide(GitProviderRegistry.layer([registration])))
  })

  it.effect("rejects malformed provider URL outputs with typed operation errors", () => {
    const registration = makeProvider("fake")
    Object.defineProperty(registration, "repositoryUrl", {
      value: () => Effect.succeed("not-a-url"),
    })
    Object.defineProperty(registration, "fileUrl", {
      value: () => Effect.succeed("file:///private/path"),
    })

    return Effect.gen(function* () {
      const registry = yield* GitProviderRegistry
      const provider = yield* registry.get(GitProviderId.make("fake"))
      const repository = HostedRepositoryLocator.make({
        providerId: GitProviderId.make("fake"),
        namespace: RepositoryNamespace.make("platform/backend"),
        name: HostedRepositoryName.make("service"),
      })
      const repositoryResult = yield* Effect.result(provider.repositoryUrl(repository))
      const fileResult = yield* Effect.result(
        provider.fileUrl(
          repository,
          RepositoryRelativePath.make("src/app.ts"),
          GitFileRevision.make("main"),
        ),
      )

      expect(Result.isFailure(repositoryResult)).toBe(true)
      expect(Result.isFailure(fileResult)).toBe(true)
      if (Result.isFailure(repositoryResult)) {
        expect(repositoryResult.failure).toMatchObject({
          _tag: "GitProviderOperationError",
          operation: "repositoryUrl",
          message: "Provider returned malformed data",
        })
      }
      if (Result.isFailure(fileResult)) {
        expect(fileResult.failure).toMatchObject({
          _tag: "GitProviderOperationError",
          operation: "fileUrl",
          message: "Provider returned malformed data",
        })
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
        Effect.result,
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(GitProviderOperationError)
        if (result.failure instanceof GitProviderOperationError) {
          expect(result.failure.providerId).toBe("invalid-provider")
          expect(result.failure.operation).toBe("register.descriptor")
        }
      }
    })
  })

  it.effect("rejects same-provider cross-target checkout results", () => {
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
    Object.defineProperty(registration, "checkoutSpec", {
      value: () =>
        Effect.succeed(
          HostedReviewCheckoutSpec.make({
            repository: other.repository,
            review: other,
            remoteUrl: "https://git.example.com/platform/backend/service.git",
            fetchRef: RepositoryComparisonRef.make("refs/reviews/43/head"),
            revision: ReviewRevision.make("head"),
          }),
        ),
    })

    return Effect.gen(function* () {
      const registry = yield* GitProviderRegistry
      const provider = yield* registry.get(GitProviderId.make("fake"))
      const checkout = yield* Effect.result(
        provider.checkoutSpec(requested, ReviewRevision.make("head")),
      )

      expect(Result.isFailure(checkout)).toBe(true)
      if (Result.isFailure(checkout)) {
        expect(checkout.failure.message).toBe("Provider returned data for another target")
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
      url: WebUrl.make("https://git.example.com/platform/backend/service/reviews/43"),
      draft: false,
      base: BranchRevision.make({
        name: RepositoryComparisonRef.make("main"),
        revision: ReviewRevision.make("base"),
      }),
      head: BranchRevision.make({
        name: RepositoryComparisonRef.make("feature"),
        revision: ReviewRevision.make("head"),
      }),
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
    Object.defineProperty(registration, "checkoutSpec", {
      value: () =>
        Effect.succeed(
          HostedReviewCheckoutSpec.make({
            repository: otherRepository,
            review: otherReview,
            remoteUrl: "https://git.example.com/platform/backend/other-service.git",
            fetchRef: RepositoryComparisonRef.make("refs/reviews/43/head"),
            revision: ReviewRevision.make("other-head"),
          }),
        ),
    })

    return Effect.gen(function* () {
      const registry = yield* GitProviderRegistry
      const provider = yield* registry.get(GitProviderId.make("fake"))
      const listed = yield* Effect.result(provider.listReviews(requestedRepository))
      const detail = yield* Effect.result(provider.getReview(requestedReview))
      const checkout = yield* Effect.result(
        provider.checkoutSpec(requestedReview, ReviewRevision.make("head")),
      )

      expect(Result.isFailure(listed)).toBe(true)
      expect(Result.isFailure(detail)).toBe(true)
      expect(Result.isFailure(checkout)).toBe(true)
    }).pipe(Effect.provide(GitProviderRegistry.layer([registration])))
  })

  it.effect("preserves typed failures returned by a provider", () => {
    const registration = makeProvider("fake")
    const expected = GitProviderOperationError.make({
      providerId: GitProviderId.make("fake"),
      operation: DiagnosticOperation.make("listReviews"),
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
      const result = yield* Effect.result(provider.listReviews(repository))

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBe(expected)
    }).pipe(Effect.provide(GitProviderRegistry.layer([registration])))
  })
})
