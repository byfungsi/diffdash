import {
  GitProviderCapabilities,
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitFileRevision,
  GitProviderId,
  GitProviderKind,
  GitProviderTerminology,
  HostedReviewCheck,
  makeHostedRepositoryLocator,
  makeHostedReviewLocator,
} from "@diffdash/domain/git-provider"
import {
  DiagnosticOperation,
  GitProviderOperationError,
  type GitProviderRegistration,
  GitProviderRegistry,
  HostedReviewDiffSourceTarget,
  REVIEW_DIFF_MAX_CHUNK_BYTES,
  ReviewDiffSemanticIdentity,
  ReviewDiffSourceFacts,
  ReviewDiffSourceOffer,
  ReviewKey,
  ReviewRevision,
  UnifiedBytesMethod,
  type ReviewDiffSource,
} from "@diffdash/git-provider"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result, Stream } from "effect"

import { GitProvider } from "./git-provider"

const unexpectedProviderOperation = () => Effect.die(new Error("Unexpected provider operation"))
const providerId = GitProviderId.make("test")

const makeProvider = (
  overrides: Partial<
    Pick<
      GitProviderRegistration,
      "fileUrl" | "getReviewDiffSource" | "mergeReview" | "repositoryUrl"
    >
  > = {},
): GitProviderRegistration => ({
  descriptor: GitProviderDescriptor.make({
    id: providerId,
    kind: GitProviderKind.make("test"),
    displayName: "Test",
    host: "git.example.com",
    capabilities: GitProviderCapabilities.make({
      repositorySearch: false,
      searchScopes: false,
      assignedReviews: false,
      reviewDecisions: false,
      reviewClosure: false,
      reviewMerge: false,
      reviewMergeBypass: false,
      reviewChecks: false,
      reviewBranchUpdates: false,
      fileUrls: false,
      remoteWorkspaceBootstrap: true,
    }),
    terminology: GitProviderTerminology.make({
      repositorySingular: "repository",
      repositoryPlural: "repositories",
      reviewSingular: "review",
      reviewPlural: "reviews",
    }),
  }),
  publishingTools: [],
  diagnose: Effect.succeed(
    GitProviderDiagnostic.make({
      providerId,
      available: true,
      authenticated: false,
      message: "Authenticate the test provider.",
    }),
  ),
  parseRemote: unexpectedProviderOperation,
  searchRepositories: unexpectedProviderOperation,
  listReviews: unexpectedProviderOperation,
  getReview: unexpectedProviderOperation,
  getReviewDiffSource: overrides.getReviewDiffSource ?? unexpectedProviderOperation,
  getReviewDecision: unexpectedProviderOperation,
  closeReview: unexpectedProviderOperation,
  mergeReview: overrides.mergeReview ?? unexpectedProviderOperation,
  submitReviewDecision: unexpectedProviderOperation,
  repositoryUrl: overrides.repositoryUrl ?? unexpectedProviderOperation,
  fileUrl: overrides.fileUrl ?? unexpectedProviderOperation,
  bootstrapBareRepository: unexpectedProviderOperation,
  checkoutSpec: unexpectedProviderOperation,
})

describe("GitProvider", () => {
  it.effect("requires provider support and authentication for remote acquisition", () => {
    const provider = makeProvider()
    const layer = GitProvider.layer.pipe(Layer.provide(GitProviderRegistry.layer([provider])))

    return Effect.gen(function* () {
      const providers = yield* GitProvider
      expect(yield* providers.isAvailable(providerId)).toBe(false)
    }).pipe(Effect.provide(layer))
  })

  it.effect("preserves typed provider URL failures", () => {
    const repository = makeHostedRepositoryLocator("test", "team", "repository")
    const expected = GitProviderOperationError.make({
      providerId,
      operation: DiagnosticOperation.make("repositoryUrl"),
      message: "Provider URL unavailable",
    })
    const layer = GitProvider.layer.pipe(
      Layer.provide(
        GitProviderRegistry.layer([
          makeProvider({
            repositoryUrl: () => expected,
            fileUrl: () => expected,
          }),
        ]),
      ),
    )

    return Effect.gen(function* () {
      const providers = yield* GitProvider
      const repositoryResult = yield* Effect.result(providers.repositoryUrl(repository))
      const fileResult = yield* Effect.result(
        providers.fileUrl(
          repository,
          RepositoryRelativePath.make("src/app.ts"),
          GitFileRevision.make("main"),
        ),
      )

      expect(Result.isFailure(repositoryResult)).toBe(true)
      expect(Result.isFailure(fileResult)).toBe(true)
      if (Result.isFailure(repositoryResult)) {
        expect(repositoryResult.failure).toBe(expected)
      }
      if (Result.isFailure(fileResult)) {
        expect(fileResult.failure).toBe(expected)
      }
    }).pipe(Effect.provide(layer))
  })

  it.effect("exposes bounded review-source acquisition through the Core facade", () => {
    const review = makeHostedReviewLocator("test", "team", "repository", 42)
    const source: ReviewDiffSource = {
      offer: ReviewDiffSourceOffer.make({
        target: HostedReviewDiffSourceTarget.make({
          review,
          reviewKey: ReviewKey.make("test:team/repository#42"),
        }),
        expectedRevision: ReviewRevision.make("head"),
        semanticIdentity: ReviewDiffSemanticIdentity.make("bounded-source"),
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
    const provider = makeProvider({
      getReviewDiffSource: () => Effect.succeed(source),
    })
    const layer = GitProvider.layer.pipe(Layer.provide(GitProviderRegistry.layer([provider])))

    return Effect.gen(function* () {
      const providers = yield* GitProvider
      expect(yield* providers.getReviewDiffSource(review)).toBe(source)
    }).pipe(Effect.provide(layer))
  })

  it.effect("routes hosted review checks by the review provider ID", () => {
    const review = makeHostedReviewLocator("test", "team", "repository", 42)
    const checks = [
      HostedReviewCheck.make({
        status: "passed",
        name: "test",
        workflow: "CI",
        description: null,
        startedAt: null,
        completedAt: null,
        detailsUrl: null,
      }),
    ]
    const provider: GitProviderRegistration = {
      ...makeProvider(),
      listReviewChecks: (requested) => {
        expect(requested).toBe(review)
        return Effect.succeed(checks)
      },
    }
    const layer = GitProvider.layer.pipe(Layer.provide(GitProviderRegistry.layer([provider])))

    return Effect.gen(function* () {
      const providers = yield* GitProvider
      expect(yield* providers.listHostedReviewChecks(review)).toEqual(checks)
    }).pipe(Effect.provide(layer))
  })

  it.effect("fails hosted review checks when the provider does not support them", () => {
    const review = makeHostedReviewLocator("test", "team", "repository", 42)
    const layer = GitProvider.layer.pipe(Layer.provide(GitProviderRegistry.layer([makeProvider()])))

    return Effect.gen(function* () {
      const providers = yield* GitProvider
      const outcome = yield* Effect.result(providers.listHostedReviewChecks(review))
      expect(Result.isFailure(outcome)).toBe(true)
      if (Result.isFailure(outcome)) {
        expect(outcome.failure).toMatchObject({ operation: "listReviewChecks" })
      }
    }).pipe(Effect.provide(layer))
  })

  it.effect("routes branch updates by provider and rejects unsupported providers", () => {
    const review = makeHostedReviewLocator("test", "team", "repository", 42)
    let updated = false
    const supported = {
      ...makeProvider(),
      descriptor: GitProviderDescriptor.make({
        ...makeProvider().descriptor,
        capabilities: GitProviderCapabilities.make({
          ...makeProvider().descriptor.capabilities,
          reviewBranchUpdates: true,
        }),
      }),
      updateReviewBranch: (requested: typeof review) =>
        Effect.sync(() => {
          expect(requested).toBe(review)
          updated = true
        }),
    } satisfies GitProviderRegistration

    return Effect.gen(function* () {
      const providers = yield* GitProvider
      yield* providers.updateHostedReviewBranch(review)
      expect(updated).toBe(true)
    }).pipe(
      Effect.provide(GitProvider.layer.pipe(Layer.provide(GitProviderRegistry.layer([supported])))),
    )
  })

  it.effect("rejects branch updates without the advertised capability", () => {
    const review = makeHostedReviewLocator("test", "team", "repository", 42)
    const provider = { ...makeProvider(), updateReviewBranch: () => Effect.void }
    const layer = GitProvider.layer.pipe(Layer.provide(GitProviderRegistry.layer([provider])))

    return Effect.gen(function* () {
      const providers = yield* GitProvider
      const outcome = yield* Effect.result(providers.updateHostedReviewBranch(review))
      expect(Result.isFailure(outcome)).toBe(true)
      if (Result.isFailure(outcome)) {
        expect(outcome.failure).toMatchObject({ operation: "updateReviewBranch" })
      }
    }).pipe(Effect.provide(layer))
  })

  it.effect("routes merge bypass only when independently advertised", () => {
    const review = makeHostedReviewLocator("test", "team", "repository", 42)
    const expectedHeadRevision = ReviewRevision.make("expected-head")
    const calls: boolean[] = []
    const base = makeProvider({
      mergeReview: (_review, _method, bypassRules) =>
        Effect.sync(() => {
          calls.push(bypassRules)
        }),
    })
    const supported = {
      ...base,
      descriptor: GitProviderDescriptor.make({
        ...base.descriptor,
        capabilities: GitProviderCapabilities.make({
          ...base.descriptor.capabilities,
          reviewMerge: true,
          reviewMergeBypass: true,
        }),
      }),
    } satisfies GitProviderRegistration

    return Effect.gen(function* () {
      const providers = yield* GitProvider
      yield* providers.mergeReview(review, "squash", false, expectedHeadRevision)
      yield* providers.mergeReview(review, "squash", true, expectedHeadRevision)
      expect(calls).toEqual([false, true])
    }).pipe(
      Effect.provide(GitProvider.layer.pipe(Layer.provide(GitProviderRegistry.layer([supported])))),
    )
  })

  it.effect("rejects merge and bypass requests without their advertised capabilities", () => {
    const review = makeHostedReviewLocator("test", "team", "repository", 42)
    const expectedHeadRevision = ReviewRevision.make("expected-head")
    const mergeOnly = makeProvider()
    const mergeSupported = {
      ...mergeOnly,
      descriptor: GitProviderDescriptor.make({
        ...mergeOnly.descriptor,
        capabilities: GitProviderCapabilities.make({
          ...mergeOnly.descriptor.capabilities,
          reviewMerge: true,
        }),
      }),
    } satisfies GitProviderRegistration

    return Effect.gen(function* () {
      const providers = yield* GitProvider
      const unsupportedMerge = yield* Effect.result(
        providers.mergeReview(review, "merge", false, expectedHeadRevision),
      )
      expect(Result.isFailure(unsupportedMerge)).toBe(true)
    }).pipe(
      Effect.provide(
        GitProvider.layer.pipe(Layer.provide(GitProviderRegistry.layer([makeProvider()]))),
      ),
      Effect.andThen(
        Effect.gen(function* () {
          const providers = yield* GitProvider
          const unsupportedBypass = yield* Effect.result(
            providers.mergeReview(review, "merge", true, expectedHeadRevision),
          )
          expect(Result.isFailure(unsupportedBypass)).toBe(true)
          if (Result.isFailure(unsupportedBypass)) {
            expect(unsupportedBypass.failure).toMatchObject({ operation: "mergeReviewBypass" })
          }
        }).pipe(
          Effect.provide(
            GitProvider.layer.pipe(Layer.provide(GitProviderRegistry.layer([mergeSupported]))),
          ),
        ),
      ),
    )
  })
})
