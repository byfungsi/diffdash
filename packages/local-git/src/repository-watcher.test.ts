import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"

import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import {
  CanonicalGitDirectories,
  CanonicalGitState,
  RepositoryReconciler,
} from "./repository-reconciliation"
import {
  makeRepositoryWatcher,
  type RepositoryInvalidation,
  type RepositoryWatchSource,
} from "./repository-watcher"

const checkoutPath = RepositoryCheckoutPath.make("/workspace/repo")
const directories = CanonicalGitDirectories.make({
  checkoutRoot: checkoutPath,
  worktreeGitDirectory: RepositoryCheckoutPath.make("/workspace/repo/.git"),
  commonGitDirectory: RepositoryCheckoutPath.make("/workspace/repo/.git"),
})
const projectA = ReviewProjectId.make("project:a")
const projectB = ReviewProjectId.make("project:b")

describe("RepositoryWatcher", () => {
  it.effect("coalesces lock and rename storms and invalidates only semantic changes", () =>
    Effect.gen(function* () {
      const nativeHints: Array<() => void> = []
      const reads = yield* Ref.make(0)
      const publications: RepositoryInvalidation[] = []
      const watcher = yield* makeRepositoryWatcher({
        watchSource: {
          start: (_directories, onSignal) =>
            Effect.sync(() => {
              nativeHints.push(() => onSignal("hint"))
              return Effect.void
            }),
        },
        publish: (invalidation) => Effect.sync(() => void publications.push(invalidation)),
        limits: { debounce: 50, maxWait: 200, pollingInterval: 10_000 },
      }).pipe(Effect.provide(reconcilerLayer(reads, () => state("same"))))

      yield* watcher.activate(projectA, checkoutPath)
      yield* waitUntil(() => publications.length === 1)
      const nativeHint = nativeHints[0]
      if (nativeHint === undefined) throw new Error("Native watcher did not start")
      for (let index = 0; index < 100; index += 1) nativeHint()
      yield* Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, {
        discard: true,
      })
      yield* TestClock.adjust(50)
      yield* waitUntilEffect(Ref.get(reads).pipe(Effect.map((count) => count === 2)))

      expect(publications).toHaveLength(1)
      expect(yield* Ref.get(reads)).toBe(2)
    }),
  )

  it.effect("runs one reconciliation with at most one follow-up when hints arrive in flight", () =>
    Effect.gen(function* () {
      const firstRun = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const reads = yield* Ref.make(0)
      const publications: RepositoryInvalidation[] = []
      const layer = Layer.succeed(
        RepositoryReconciler,
        RepositoryReconciler.of({
          resolveDirectories: () => Effect.succeed(directories),
          readState: () =>
            Ref.updateAndGet(reads, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Deferred.succeed(firstRun, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseFirst)),
                      Effect.as(state("first")),
                    )
                  : Effect.succeed(state("second")),
              ),
            ),
        }),
      )
      const watcher = yield* makeRepositoryWatcher({
        watchSource: inertWatchSource,
        publish: (invalidation) => Effect.sync(() => void publications.push(invalidation)),
        limits: { pollingInterval: 10_000 },
      }).pipe(Effect.provide(layer))

      yield* watcher.activate(projectA, checkoutPath)
      yield* Deferred.await(firstRun)
      yield* Effect.forEach(Array.from({ length: 100 }), () => watcher.hint(projectA), {
        discard: true,
      })
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* waitUntilEffect(Ref.get(reads).pipe(Effect.map((count) => count === 2)))
      yield* Effect.yieldNow

      expect(yield* Ref.get(reads)).toBe(2)
      expect(publications.map((item) => item.state.fingerprint)).toEqual(["first", "second"])
    }),
  )

  it.effect("bounds a continuous hint stream by the maximum wait", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0)
      const watcher = yield* makeRepositoryWatcher({
        watchSource: inertWatchSource,
        publish: () => Effect.void,
        limits: { debounce: 50, maxWait: 200, pollingInterval: 10_000 },
      }).pipe(Effect.provide(reconcilerLayer(reads, () => state("unchanged"))))
      yield* watcher.activate(projectA, checkoutPath)
      yield* waitUntilEffect(Ref.get(reads).pipe(Effect.map((count) => count === 1)))

      for (let index = 0; index < 5; index += 1) {
        yield* watcher.hint(projectA)
        yield* Effect.yieldNow
        yield* TestClock.adjust(40)
      }
      yield* waitUntilEffect(Ref.get(reads).pipe(Effect.map((count) => count === 2)))

      expect(yield* Ref.get(reads)).toBe(2)
    }),
  )

  it.effect("forces focus, resume, overflow, and periodic polling reconciliation", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0)
      const watcher = yield* makeRepositoryWatcher({
        watchSource: inertWatchSource,
        publish: () => Effect.void,
        limits: { pollingInterval: 100 },
      }).pipe(Effect.provide(reconcilerLayer(reads, () => state("unchanged"))))
      yield* watcher.activate(projectA, checkoutPath)
      yield* waitUntilEffect(Ref.get(reads).pipe(Effect.map((count) => count === 1)))

      for (const reason of ["focus", "resume", "overflow"] as const) {
        const before = yield* Ref.get(reads)
        yield* watcher.force(projectA, reason)
        yield* waitUntilEffect(Ref.get(reads).pipe(Effect.map((count) => count === before + 1)))
      }
      yield* TestClock.adjust(100)
      yield* waitUntilEffect(Ref.get(reads).pipe(Effect.map((count) => count === 5)))

      expect(yield* Ref.get(reads)).toBe(5)
    }),
  )

  it.effect("falls back to immediate reconciliation and polling when native watching fails", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0)
      const failedWatchSource: RepositoryWatchSource = {
        start: (_directories, onSignal) =>
          Effect.sync(() => {
            onSignal("overflow")
            return Effect.void
          }),
      }
      const watcher = yield* makeRepositoryWatcher({
        watchSource: failedWatchSource,
        publish: () => Effect.void,
        limits: { pollingInterval: 100 },
      }).pipe(Effect.provide(reconcilerLayer(reads, () => state("unchanged"))))

      yield* watcher.activate(projectA, checkoutPath)
      yield* waitUntilEffect(Ref.get(reads).pipe(Effect.map((count) => count === 2)))
      yield* TestClock.adjust(100)
      yield* waitUntilEffect(Ref.get(reads).pipe(Effect.map((count) => count === 3)))

      expect(yield* Ref.get(reads)).toBe(3)
    }),
  )

  it.effect("cancels inactive work and never publishes a stale project generation", () =>
    Effect.gen(function* () {
      const projectAStarted = yield* Deferred.make<void>()
      const projectACancelled = yield* Deferred.make<void>()
      const publications: RepositoryInvalidation[] = []
      const layer = Layer.succeed(
        RepositoryReconciler,
        RepositoryReconciler.of({
          resolveDirectories: () => Effect.succeed(directories),
          readState: (path) =>
            path === checkoutPath
              ? Deferred.succeed(projectAStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(projectACancelled, undefined)),
                )
              : Effect.succeed(state("project-b")),
        }),
      )
      const watcher = yield* makeRepositoryWatcher({
        watchSource: inertWatchSource,
        publish: (invalidation) => Effect.sync(() => void publications.push(invalidation)),
      }).pipe(Effect.provide(layer))
      const projectBPath = RepositoryCheckoutPath.make("/workspace/other")

      yield* watcher.activate(projectA, checkoutPath)
      yield* Deferred.await(projectAStarted)
      const generationB = yield* watcher.activate(projectB, projectBPath)
      yield* Deferred.await(projectACancelled)
      yield* waitUntil(() => publications.length === 1)

      expect(publications).toMatchObject([
        { projectId: projectB, generation: generationB, checkoutPath: projectBPath },
      ])
      yield* watcher.deactivate(projectB)
      const reactivatedGeneration = yield* watcher.activate(projectB, projectBPath)
      expect(reactivatedGeneration).toBeGreaterThan(generationB)
    }),
  )

  it.effect("continues reconciliation when an invalidation subscriber defects", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0)
      let publishAttempts = 0
      const watcher = yield* makeRepositoryWatcher({
        watchSource: inertWatchSource,
        publish: () =>
          Effect.sync(() => {
            publishAttempts += 1
            if (publishAttempts === 1) throw new Error("subscriber unavailable")
          }),
      }).pipe(Effect.provide(reconcilerLayer(reads, () => state(`state-${publishAttempts + 1}`))))
      yield* watcher.activate(projectA, checkoutPath)
      yield* waitUntilEffect(Ref.get(reads).pipe(Effect.map((count) => count === 1)))
      yield* watcher.force(projectA, "focus")
      yield* waitUntilEffect(Ref.get(reads).pipe(Effect.map((count) => count === 2)))

      expect(publishAttempts).toBe(2)
    }),
  )
})

const inertWatchSource: RepositoryWatchSource = {
  start: () => Effect.succeed(Effect.void),
}

const state = (fingerprint: string): CanonicalGitState =>
  CanonicalGitState.make({
    branchIntent: "main",
    resolvedHeadSha: "a".repeat(40),
    status: "",
    fingerprint,
  })

const reconcilerLayer = (reads: Ref.Ref<number>, makeState: () => CanonicalGitState) =>
  Layer.succeed(
    RepositoryReconciler,
    RepositoryReconciler.of({
      resolveDirectories: () => Effect.succeed(directories),
      readState: () => Ref.update(reads, (count) => count + 1).pipe(Effect.as(makeState())),
    }),
  )

const waitUntil = (predicate: () => boolean): Effect.Effect<void> =>
  waitUntilEffect(Effect.sync(predicate))

const waitUntilEffect = (predicate: Effect.Effect<boolean>): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (yield* predicate) return
      yield* Effect.yieldNow
    }
    yield* Effect.die(new Error("Condition was not reached"))
  })
