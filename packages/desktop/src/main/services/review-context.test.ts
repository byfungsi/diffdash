import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer } from "effect"

import { GitService } from "@diffdash/local-git/local-git"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { GitProvider } from "./git-provider"
import { ReviewContextError, ReviewContextService } from "./review-context"
import {
  GitProviderId,
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
      url: "https://github.com/fungsi/diffdash/pull/51",
      draft: false,
      base: BranchRevision.make({ name: "main", revision: baseRefOid }),
      head: BranchRevision.make({ name: "feature", revision: headRefOid }),
      createdAt: null,
      updatedAt: null,
    }),
    files: [],
    commits: [],
  })

const makeDiff = (headRefOid: string) =>
  HostedReviewDiff.make({
    locator: review,
    headRevision: headRefOid,
    diff: patch,
    fetchedAt: "2026-07-12T00:00:00.000Z",
  })

const unavailable = () => Effect.die(new Error("Unavailable in this test"))

const nextValue = (values: readonly string[], index: number) => values[index] ?? values.at(-1) ?? ""

const makeLayer = (input: {
  readonly beforeHeads: readonly string[]
  readonly diffHeads: readonly string[]
  readonly afterHeads: readonly string[]
  readonly parseDiff?: typeof parseUnifiedDiff
}) => {
  let beforeIndex = 0
  let diffIndex = 0
  let afterIndex = 0
  const gitProviderLayer = Layer.succeed(
    GitProvider,
    GitProvider.of({
      listProviders: Effect.succeed([]),
      diagnoseProviders: Effect.succeed([]),
      parseRemoteUrl: () => unavailable(),
      repositoryUrl: () => Effect.succeed(""),
      fileUrl: () => Effect.succeed(""),
      searchRepositories: () => unavailable(),
      listSearchScopes: () => unavailable(),
      listHostedReviews: () => unavailable(),
      listAssignedReviews: () => unavailable(),
      getHostedReview: () =>
        Effect.sync(() => makeDetail(nextValue(input.beforeHeads, beforeIndex++))),
      refreshHostedReview: () =>
        Effect.sync(() => makeDetail(nextValue(input.afterHeads, afterIndex++))),
      getHostedReviewDiff: () =>
        Effect.sync(() => makeDiff(nextValue(input.diffHeads, diffIndex++))),
      getReviewDecision: () => unavailable(),
      submitReviewDecision: () => unavailable(),
      hostedReviewCheckoutSpec: () => unavailable(),
      bootstrapBareRepository: () => unavailable(),
      isAvailable: () => Effect.succeed(true),
    }),
  )
  const gitLayer = Layer.succeed(
    GitService,
    GitService.of({
      listRemotes: () => Effect.succeed([]),
      detectRepository: () => unavailable(),
      detectRoot: () => unavailable(),
      currentBranch: () => unavailable(),
      resolveBranchComparison: () => unavailable(),
      getLocalReviewDetail: () => unavailable(),
      getLocalReviewDiff: () => unavailable(),
      getLocalReviewSnapshot: () => unavailable(),
    }),
  )

  return ReviewContextService.layerWith(
    input.parseDiff === undefined ? {} : { parseDiff: input.parseDiff },
  ).pipe(Layer.provide(Layer.merge(gitProviderLayer, gitLayer)))
}

describe("ReviewContextService", () => {
  it.effect("FUN-80 AC: captures one stable pull request snapshot", () => {
    let parseCalls = 0
    return Effect.gen(function* () {
      const service = yield* ReviewContextService
      const snapshot = yield* service.getHostedReviewSnapshot(review)

      expect(snapshot.reviewKey).toBe("github:fungsi/diffdash#51")
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
      const service = yield* ReviewContextService
      const snapshot = yield* service.getHostedReviewSnapshot(review)

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
      const service = yield* ReviewContextService
      const result = yield* Effect.either(service.getHostedReviewSnapshot(review))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(ReviewContextError)
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
    providerId: GitProviderId.make("github"),
    namespace: RepositoryNamespace.make("fungsi"),
    name: HostedRepositoryName.make("diffdash"),
  }),
  number: HostedReviewNumber.make(51),
})
