import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer } from "effect"

import type { LocalReviewDetail, LocalReviewDiff } from "@diffdash/domain/local-review"
import { PullRequestDetail, PullRequestDiff, ReviewActor } from "@diffdash/domain/pull-request"
import type { LocalReviewSnapshot } from "@diffdash/domain/review-context"
import { GitService } from "@diffdash/local-git/local-git"
import { GitProvider } from "./git-provider"
import { ReviewContextError, ReviewContextService } from "./review-context"

const patch = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new`

const makeDetail = (headRefOid: string, baseRefOid = "base") =>
  PullRequestDetail.make({
    repoOwner: "fungsi",
    repoName: "diffdash",
    number: 51,
    title: "Review snapshots",
    body: null,
    author: ReviewActor.make({ login: "reviewer" }),
    state: "OPEN",
    url: "https://github.com/fungsi/diffdash/pull/51",
    isDraft: false,
    baseRefName: "main",
    baseRefOid,
    headRefName: "feature",
    headRefOid,
    createdAt: null,
    updatedAt: null,
    files: [],
    commits: [],
  })

const makeDiff = (headRefOid: string) =>
  PullRequestDiff.make({
    repoOwner: "fungsi",
    repoName: "diffdash",
    number: 51,
    headRefOid,
    diff: patch,
    fetchedAt: "2026-07-12T00:00:00.000Z",
  })

const unavailable = <A>() => Effect.die(new Error("Unavailable in this test")) as Effect.Effect<A>

const nextValue = (values: readonly string[], index: number) => values[index] ?? values.at(-1) ?? ""

const makeLayer = (input: {
  readonly beforeHeads: readonly string[]
  readonly diffHeads: readonly string[]
  readonly afterHeads: readonly string[]
}) => {
  let beforeIndex = 0
  let diffIndex = 0
  let afterIndex = 0
  const gitProviderLayer = Layer.succeed(
    GitProvider,
    GitProvider.of({
      parseRemoteUrl: () => unavailable(),
      repositoryUrl: () => "",
      fileUrl: () => "",
      searchRepositories: () => unavailable(),
      listSearchScopes: () => unavailable(),
      listRepositories: () => unavailable(),
      listPullRequests: () => unavailable(),
      listReviewRequests: () => unavailable(),
      getPullRequestDetail: () =>
        Effect.sync(() => makeDetail(nextValue(input.beforeHeads, beforeIndex++))),
      refreshPullRequestDetail: () =>
        Effect.sync(() => makeDetail(nextValue(input.afterHeads, afterIndex++))),
      getPullRequestDiff: () =>
        Effect.sync(() => makeDiff(nextValue(input.diffHeads, diffIndex++))),
      hasApprovedPullRequest: () => unavailable(),
      approvePullRequest: () => unavailable(),
      isAvailable: Effect.succeed(true),
    }),
  )
  const gitLayer = Layer.succeed(
    GitService,
    GitService.of({
      detectRepository: () => unavailable(),
      detectRoot: () => unavailable(),
      currentBranch: () => unavailable(),
      resolveBranchComparison: () => unavailable(),
      getLocalReviewDetail: () => unavailable<LocalReviewDetail>(),
      getLocalReviewDiff: () => unavailable<LocalReviewDiff>(),
      getLocalReviewSnapshot: () => unavailable<LocalReviewSnapshot>(),
    }),
  )

  return ReviewContextService.layer.pipe(Layer.provide(Layer.merge(gitProviderLayer, gitLayer)))
}

describe("ReviewContextService", () => {
  it.effect("FUN-80 AC: captures one stable pull request snapshot", () =>
    Effect.gen(function* () {
      const service = yield* ReviewContextService
      const snapshot = yield* service.getPullRequestSnapshot("fungsi", "diffdash", 51)

      expect(snapshot.reviewKey).toBe("github:fungsi/diffdash#51")
      expect(snapshot.baseRevision).toBe("base")
      expect(snapshot.headRevision).toBe("head-a")
      expect(snapshot.parsedDiff.files[0]?.hunks).toHaveLength(1)
    }).pipe(
      Effect.provide(
        makeLayer({ beforeHeads: ["head-a"], diffHeads: ["head-a"], afterHeads: ["head-a"] }),
      ),
    ),
  )

  it.effect("FUN-80 AC: retries when the pull request changes during acquisition", () =>
    Effect.gen(function* () {
      const service = yield* ReviewContextService
      const snapshot = yield* service.getPullRequestSnapshot("fungsi", "diffdash", 51)

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
      const result = yield* Effect.either(service.getPullRequestSnapshot("fungsi", "diffdash", 51))

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
