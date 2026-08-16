import {
  GitProviderCapabilities,
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitFileRevision,
  GitProviderId,
  GitProviderKind,
  GitProviderTerminology,
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
    Pick<GitProviderRegistration, "fileUrl" | "getReviewDiffSource" | "repositoryUrl">
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
})
