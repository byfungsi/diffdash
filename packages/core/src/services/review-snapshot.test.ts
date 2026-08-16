import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { ChangedFile } from "@diffdash/domain/git-provider"
import {
  LocalReviewDetail,
  LocalReviewDiff,
  workingTreeReviewTarget,
} from "@diffdash/domain/local-review"
import { LocalReviewSnapshot } from "@diffdash/domain/review-context"
import {
  makeReviewSnapshotId,
  ReviewDiffIdentity,
  ReviewKey,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import { TestClock } from "effect/testing"
import { GitService, LocalReviewChangedError } from "@diffdash/local-git/local-git"
import { GitProvider } from "./git-provider"
import { RepositoryComparisonSource } from "./repository-comparison-source"
import { ReviewSnapshotService } from "./review-snapshot"

const target = workingTreeReviewTarget(RepositoryCheckoutPath.make("/repo"))

const snapshot = (name: string) => {
  const rawDiff = `diff --git a/${name}.ts b/${name}.ts
--- a/${name}.ts
+++ b/${name}.ts
@@ -1 +1 @@
-old
+${name}`
  const reviewKey = ReviewKey.make(`local:${name}`)
  const baseRevision = ReviewRevision.make(`base-${name}`)
  const headRevision = ReviewRevision.make(`head-${name}`)
  const parsedDiff = parseUnifiedDiff(rawDiff)
  const diff = LocalReviewDiff.make({
    rootPath: RepositoryCheckoutPath.make(`/repo/${name}`),
    baseSha: baseRevision,
    headSha: headRevision,
    diffHash: ReviewDiffIdentity.make(`diff-${name}`),
    diff: rawDiff,
    fetchedAt: "2026-07-19T00:00:00.000Z",
  })
  return LocalReviewSnapshot.make({
    snapshotId: makeReviewSnapshotId({
      reviewKey,
      baseRevision,
      headRevision,
      diffIdentity: ReviewDiffIdentity.make(diff.diffHash),
    }),
    reviewKey,
    baseRevision,
    headRevision,
    detail: LocalReviewDetail.make({
      rootPath: diff.rootPath,
      repoName: name,
      branchName: RepositoryComparisonRef.make("feature/cache"),
      baseSha: diff.baseSha,
      headSha: diff.headSha,
      diffHash: diff.diffHash,
      title: name,
      files: parsedDiff.files.map((file) =>
        ChangedFile.make({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status,
        }),
      ),
      fetchedAt: diff.fetchedAt,
    }),
    diff,
    parsedDiff,
  })
}

const layerFor = (
  acquireLocal: GitService["Service"]["getLocalReviewSnapshot"],
  config = { capacity: 2, ttlMs: 1_000, tombstoneCapacity: 4 },
) =>
  ReviewSnapshotService.layer(config).pipe(
    Layer.provide(
      Layer.succeed(
        GitService,
        GitService.of({
          detectRepository: () => Effect.die(new Error("Repository detection is unused")),
          detectRoot: () => Effect.die(new Error("Root detection is unused")),
          currentBranch: () => Effect.die(new Error("Branch detection is unused")),
          listRemotes: () => Effect.die(new Error("Remote listing is unused")),
          resolveBranchComparison: () => Effect.die(new Error("Branch comparison is unused")),
          resolveRevisionRangeComparison: () =>
            Effect.die(new Error("Revision range comparison is unused")),
          resolveLastCommit: () => Effect.die(new Error("Last commit resolution is unused")),
          validateLocalReviewTarget: () =>
            Effect.die(new Error("Local review validation is unused")),
          getLocalReviewSnapshot: acquireLocal,
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        GitProvider,
        GitProvider.of({
          listProviders: Effect.succeed([]),
          diagnoseProviders: Effect.succeed([]),
          parseRemoteUrl: () => Effect.die(new Error("Remote parsing is unused")),
          resolveRepository: () => Effect.die(new Error("Repository resolution is unused")),
          repositoryUrl: () => Effect.die(new Error("Repository URL is unused")),
          fileUrl: () => Effect.die(new Error("File URL is unused")),
          searchRepositories: () => Effect.die(new Error("Repository search is unused")),
          listSearchScopes: () => Effect.die(new Error("Search scopes are unused")),
          listHostedReviews: () => Effect.die(new Error("Hosted review listing is unused")),
          listAssignedReviews: () => Effect.die(new Error("Assigned review listing is unused")),
          acquireHostedReviewSnapshot: () => Effect.die(new Error("Hosted acquisition is unused")),
          getReviewDecision: () => Effect.die(new Error("Review decision is unused")),
          submitReviewDecision: () => Effect.die(new Error("Review submission is unused")),
          hostedReviewCheckoutSpec: () => Effect.die(new Error("Checkout spec is unused")),
          bootstrapBareRepository: () => Effect.die(new Error("Bootstrap is unused")),
          isAvailable: () => Effect.die(new Error("Availability is unused")),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        RepositoryComparisonSource,
        RepositoryComparisonSource.of({
          acquire: () => Effect.die(new Error("Comparison acquisition is unused")),
          repository: () => Effect.die(new Error("Comparison repository lookup is unused")),
          resolve: () => Effect.die(new Error("Comparison resolution is unused")),
          useWorkspace: (_target, run) =>
            run(RepositoryCheckoutPath.make("/unused-comparison-workspace")),
        }),
      ),
    ),
  )

describe("ReviewSnapshotService", () => {
  it.effect("evicts the least-recent immutable entry under the explicit capacity", () => {
    const firstValue = snapshot("a")
    const secondValue = snapshot("b")
    const thirdValue = snapshot("c")
    const snapshots = [firstValue, secondValue, thirdValue]
    let index = 0
    return Effect.gen(function* () {
      const service = yield* ReviewSnapshotService
      const first = yield* service.acquireLocal(target)
      const second = yield* service.acquireLocal(target)
      yield* service.get(first.snapshotId)
      const third = yield* service.acquireLocal(target)

      expect((yield* service.stats).snapshotIds).toEqual([first.snapshotId, third.snapshotId])
      expect(Object.isFrozen(first)).toBe(true)
      const stale = yield* Effect.result(service.get(second.snapshotId))
      expect(Result.isFailure(stale)).toBe(true)
      if (Result.isFailure(stale)) expect(stale.failure.reason).toBe("evicted")
    }).pipe(Effect.provide(layerFor(() => Effect.succeed(snapshots[index++] ?? thirdValue))))
  })

  it.effect("expires entries by the test clock and reports a typed stale reason", () => {
    const value = snapshot("ttl")
    return Effect.gen(function* () {
      const service = yield* ReviewSnapshotService
      yield* service.acquireLocal(target)
      yield* TestClock.adjust(1_001)

      const stale = yield* Effect.result(service.get(value.snapshotId))
      expect(Result.isFailure(stale)).toBe(true)
      if (Result.isFailure(stale)) expect(stale.failure.reason).toBe("expired")
      expect((yield* service.stats).size).toBe(0)
    }).pipe(Effect.provide(layerFor(() => Effect.succeed(value))))
  })

  it.effect(
    "refreshes the stored value and TTL when the same snapshot identity is reacquired",
    () => {
      const first = snapshot("refresh")
      const refreshed = LocalReviewSnapshot.make({
        ...first,
        detail: LocalReviewDetail.make({ ...first.detail, title: "refreshed value" }),
      })
      let acquisition = 0
      return Effect.gen(function* () {
        const service = yield* ReviewSnapshotService
        yield* service.acquireLocal(target)
        yield* TestClock.adjust(750)
        yield* service.acquireLocal(target)
        yield* TestClock.adjust(750)

        const stored = yield* service.get(first.snapshotId)
        expect(stored).toBeInstanceOf(LocalReviewSnapshot)
        if (!(stored instanceof LocalReviewSnapshot)) throw new Error("Expected local snapshot")
        expect(stored.detail.title).toBe("refreshed value")
        expect((yield* service.stats).size).toBe(1)
      }).pipe(
        Effect.provide(layerFor(() => Effect.succeed(acquisition++ === 0 ? first : refreshed))),
      )
    },
  )

  it.effect("does not save a snapshot when coherent acquisition fails", () =>
    Effect.gen(function* () {
      const service = yield* ReviewSnapshotService
      const result = yield* Effect.result(service.acquireLocal(target))

      expect(Result.isFailure(result)).toBe(true)
      expect((yield* service.stats).size).toBe(0)
    }).pipe(
      Effect.provide(
        layerFor(() =>
          LocalReviewChangedError.make({ rootPath: RepositoryCheckoutPath.make("/repo") }),
        ),
      ),
    ),
  )
})
