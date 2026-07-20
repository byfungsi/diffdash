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
import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer, TestClock } from "effect"
import { ReviewContextError, ReviewContextService } from "./review-context"
import { ReviewSnapshotService } from "./review-snapshot"

const target = workingTreeReviewTarget("/repo")

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
    rootPath: `/repo/${name}`,
    baseSha: baseRevision,
    headSha: headRevision,
    diffHash: `diff-${name}`,
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
      branchName: "feature/cache",
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
  acquireLocal: ReviewContextService["Type"]["getLocalReviewSnapshot"],
  config = { capacity: 2, ttlMs: 1_000, tombstoneCapacity: 4 },
) =>
  ReviewSnapshotService.layer(config).pipe(
    Layer.provide(
      Layer.succeed(
        ReviewContextService,
        ReviewContextService.of({
          getHostedReviewSnapshot: () => Effect.die(new Error("Hosted acquisition is unused")),
          getLocalReviewSnapshot: acquireLocal,
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
      const stale = yield* Effect.either(service.get(second.snapshotId))
      expect(Either.isLeft(stale)).toBe(true)
      if (Either.isLeft(stale)) expect(stale.left.reason).toBe("evicted")
    }).pipe(Effect.provide(layerFor(() => Effect.succeed(snapshots[index++] ?? thirdValue))))
  })

  it.effect("expires entries by the test clock and reports a typed stale reason", () => {
    const value = snapshot("ttl")
    return Effect.gen(function* () {
      const service = yield* ReviewSnapshotService
      yield* service.acquireLocal(target)
      yield* TestClock.adjust(1_001)

      const stale = yield* Effect.either(service.get(value.snapshotId))
      expect(Either.isLeft(stale)).toBe(true)
      if (Either.isLeft(stale)) expect(stale.left.reason).toBe("expired")
      expect((yield* service.stats).size).toBe(0)
    }).pipe(Effect.provide(layerFor(() => Effect.succeed(value))))
  })

  it.effect("does not save a snapshot when coherent acquisition fails", () =>
    Effect.gen(function* () {
      const service = yield* ReviewSnapshotService
      const result = yield* Effect.either(service.acquireLocal(target))

      expect(Either.isLeft(result)).toBe(true)
      expect((yield* service.stats).size).toBe(0)
    }).pipe(
      Effect.provide(
        layerFor(() =>
          ReviewContextError.make({
            operation: "local.snapshot",
            reason: "Review changed during acquisition",
            cause: new Error("incoherent revisions"),
          }),
        ),
      ),
    ),
  )
})
