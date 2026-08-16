import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"

import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import {
  type GitProviderRegistration,
  GitProviderRegistry,
  HostedReviewCheckoutSpec,
} from "@diffdash/git-provider"
import { GitProvider, ReviewContextError } from "./git-provider"
import {
  GitProviderId,
  GitProviderCapabilities,
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitProviderKind,
  GitProviderTerminology,
  BranchRevision,
  HostedReviewDetail,
  HostedReviewDiff,
  HostedReviewSummary,
  ProviderActor,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewLocator,
  HostedReviewNumber,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import { CoreWebUrl } from "../core-configuration"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"

const patch = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new`

const makeDetail = (headRefOid: string, baseRefOid = "base") =>
  HostedReviewDetail.make({
    summary: HostedReviewSummary.make({
      locator: review,
      title: "Review snapshots",
      body: null,
      author: ProviderActor.make({
        id: null,
        username: "reviewer",
        displayName: null,
        avatarUrl: null,
      }),
      state: "OPEN",
      decision: "none",
      url: CoreWebUrl.make("https://github.com/fungsi/diffdash/pull/51"),
      draft: false,
      base: BranchRevision.make({
        name: BranchRevision.fields.name.make("main"),
        revision: ReviewRevision.make(baseRefOid),
      }),
      head: BranchRevision.make({
        name: BranchRevision.fields.name.make("feature"),
        revision: ReviewRevision.make(headRefOid),
      }),
      createdAt: null,
      updatedAt: null,
    }),
    files: [],
    commits: [],
  })

const makeDiff = (headRefOid: string) =>
  HostedReviewDiff.make({
    locator: review,
    headRevision: ReviewRevision.make(headRefOid),
    diff: patch,
    fetchedAt: "2026-07-12T00:00:00.000Z",
  })

const nextValue = (values: readonly string[], index: number) => values[index] ?? values.at(-1) ?? ""

const unavailable = () => Effect.die(new Error("Unavailable in this test"))

const makeRegistration = (): GitProviderRegistration => ({
  descriptor: GitProviderDescriptor.make({
    id: GitProviderId.make("fixture"),
    kind: GitProviderKind.make("fixture"),
    displayName: "Fixture",
    host: "git.fixture.test",
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
      providerId: GitProviderId.make("fixture"),
      available: true,
      authenticated: true,
      message: null,
    }),
  ),
  parseRemote: unavailable,
  searchRepositories: () => Effect.succeed([]),
  listReviews: () => Effect.succeed([]),
  getReview: unavailable,
  getReviewDiffSource: unavailable,
  getReviewDiff: unavailable,
  getReviewDecision: unavailable,
  submitReviewDecision: unavailable,
  repositoryUrl: () => Effect.succeed(CoreWebUrl.make("https://git.fixture.test/fungsi/diffdash")),
  fileUrl: () => Effect.succeed(CoreWebUrl.make("https://git.fixture.test/fungsi/diffdash/file")),
  bootstrapBareRepository: unavailable,
  checkoutSpec: (_review, revision) =>
    Effect.succeed(
      HostedReviewCheckoutSpec.make({
        repository: review.repository,
        review,
        remoteUrl: "https://git.fixture.test/fungsi/diffdash.git",
        fetchRef: RepositoryComparisonRef.make("refs/reviews/51/head"),
        revision,
      }),
    ),
})

const makeLayer = (input: {
  readonly beforeHeads: readonly string[]
  readonly diffHeads: readonly string[]
  readonly afterHeads: readonly string[]
  readonly parseDiff?: typeof parseUnifiedDiff
}) => {
  let detailCall = 0
  let diffIndex = 0
  const registration = {
    ...makeRegistration(),
    getReview: () => {
      const attempt = Math.floor(detailCall / 2)
      const heads = detailCall % 2 === 0 ? input.beforeHeads : input.afterHeads
      detailCall += 1
      return Effect.succeed(makeDetail(nextValue(heads, attempt)))
    },
    getReviewDiff: () => Effect.sync(() => makeDiff(nextValue(input.diffHeads, diffIndex++))),
  }

  return GitProvider.layerWith(
    input.parseDiff === undefined ? {} : { parseDiff: input.parseDiff },
  ).pipe(Layer.provide(GitProviderRegistry.layer([registration])))
}

describe("GitProvider.acquireHostedReviewSnapshot", () => {
  it.effect("FUN-80 AC: captures one stable pull request snapshot", () => {
    let parseCalls = 0
    return Effect.gen(function* () {
      const service = yield* GitProvider
      const snapshot = yield* service.acquireHostedReviewSnapshot(review)

      expect(snapshot.reviewKey).toBe("fixture:fungsi/diffdash#51")
      expect(snapshot.baseRevision).toBe("base")
      expect(snapshot.headRevision).toBe("head-a")
      expect(snapshot.parsedDiff.files[0]?.hunks).toHaveLength(1)
      expect(parseCalls).toBe(1)
    }).pipe(
      Effect.provide(
        makeLayer({
          beforeHeads: ["head-a"],
          diffHeads: ["head-a"],
          afterHeads: ["head-a"],
          parseDiff: (rawDiff) => {
            parseCalls += 1
            return parseUnifiedDiff(rawDiff)
          },
        }),
      ),
    )
  })

  it.effect("FUN-80 AC: retries when the pull request changes during acquisition", () =>
    Effect.gen(function* () {
      const service = yield* GitProvider
      const snapshot = yield* service.acquireHostedReviewSnapshot(review)

      expect(snapshot.headRevision).toBe("head-b")
    }).pipe(
      Effect.provide(
        makeLayer({
          beforeHeads: ["head-a", "head-b"],
          diffHeads: ["head-a", "head-b"],
          afterHeads: ["head-b", "head-b"],
        }),
      ),
    ),
  )

  it.effect("FUN-80 AC: rejects a snapshot that remains inconsistent", () =>
    Effect.gen(function* () {
      const service = yield* GitProvider
      const result = yield* Effect.result(service.acquireHostedReviewSnapshot(review))

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(ReviewContextError)
    }).pipe(
      Effect.provide(
        makeLayer({
          beforeHeads: ["head-a", "head-b"],
          diffHeads: ["head-a", "head-b"],
          afterHeads: ["head-b", "head-c"],
        }),
      ),
    ),
  )
})

const review = HostedReviewLocator.make({
  repository: HostedRepositoryLocator.make({
    providerId: GitProviderId.make("fixture"),
    namespace: RepositoryNamespace.make("fungsi"),
    name: HostedRepositoryName.make("diffdash"),
  }),
  number: HostedReviewNumber.make(51),
})
