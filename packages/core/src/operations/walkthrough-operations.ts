import type { ReviewSnapshot } from "@diffdash/domain/review-context"
import {
  prepareWalkthroughPromptInput,
  type StoredWalkthrough,
  type WalkthroughCacheKey,
  WALKTHROUGH_PROMPT_VERSION,
  walkthroughHostedReviewScope,
  walkthroughLocalDiffScope,
  walkthroughRepositoryComparisonScope,
} from "@diffdash/domain/walkthrough"
import {
  WalkthroughStore,
  type WalkthroughStoreError,
} from "@diffdash/persistence/walkthrough-store"
import { WalkthroughService } from "@diffdash/walkthrough"
import { Cause, Deferred, Effect, Exit, FiberMap, Match, Option, type Scope } from "effect"
import { randomUUID } from "node:crypto"

import {
  type CoreGetStoredWalkthroughFailure,
  type CoreWalkthroughFailure,
  type GetStoredWalkthrough,
  type StartWalkthroughOperation,
  type WalkthroughOperationAccepted,
  WalkthroughOperationCancelled,
  WalkthroughOperationCapacityExceeded,
  WalkthroughOperationCompleted,
  WalkthroughOperationDefect,
  WalkthroughOperationFailed,
  WalkthroughOperationId,
  type WalkthroughOperationId as WalkthroughOperationIdType,
  WalkthroughOperationNotFound,
  type WalkthroughOperationResult,
} from "../core-contract"
import { RepositoryComparisonSource } from "../services/repository-comparison-source"
import type { ReviewResolution } from "./review-resolution"

interface WalkthroughEntry {
  readonly result: Deferred.Deferred<WalkthroughOperationResult>
}

interface WalkthroughRegistration {
  readonly operationId: WalkthroughOperationIdType
}

const MAX_RETAINED_WALKTHROUGH_OPERATIONS = 64

/** Scoped admission, observation, cancellation, and retention for walkthrough operations. */
export interface WalkthroughLifecycle {
  readonly start: (
    request: StartWalkthroughOperation,
  ) => Effect.Effect<WalkthroughOperationAccepted, WalkthroughOperationCapacityExceeded>
  readonly getOperation: (
    operationId: WalkthroughOperationIdType,
  ) => Effect.Effect<WalkthroughOperationResult, WalkthroughOperationNotFound>
  readonly cancel: (
    operationId: WalkthroughOperationIdType,
  ) => Effect.Effect<WalkthroughOperationResult, WalkthroughOperationNotFound>
}

/** Scoped walkthrough capability including generation and persistent cache access. */
export interface WalkthroughOperations extends WalkthroughLifecycle {
  readonly getStored: (
    request: GetStoredWalkthrough,
  ) => Effect.Effect<Option.Option<StoredWalkthrough>, CoreGetStoredWalkthroughFailure>
  readonly getCached: (
    repoId: string,
    snapshot: ReviewSnapshot,
  ) => Effect.Effect<Option.Option<StoredWalkthrough>, WalkthroughStoreError>
}

/** Builds scoped walkthrough lifecycle state around one generation operation. */
export const makeWalkthroughLifecycle = (
  generate: (
    request: StartWalkthroughOperation,
  ) => Effect.Effect<StoredWalkthrough, CoreWalkthroughFailure>,
): Effect.Effect<WalkthroughLifecycle, never, Scope.Scope> =>
  Effect.gen(function* () {
    const walkthroughFibers = yield* FiberMap.make<WalkthroughOperationIdType>()
    const walkthroughOperations = new Map<WalkthroughOperationIdType, WalkthroughEntry>()
    const walkthroughStartSemaphore = yield* Effect.makeSemaphore(1)

    const reserveWalkthroughSlot = Effect.fn("Core.Walkthroughs.reserveSlot")(function* () {
      if (walkthroughOperations.size < MAX_RETAINED_WALKTHROUGH_OPERATIONS) return

      const oldestTerminalOperationId = yield* Effect.findFirst(
        walkthroughOperations,
        ([, operation]) => Deferred.isDone(operation.result),
      ).pipe(Effect.map(Option.map(([operationId]) => operationId)))

      return yield* Option.match(oldestTerminalOperationId, {
        onNone: () =>
          Effect.fail(
            WalkthroughOperationCapacityExceeded.make({
              capacity: MAX_RETAINED_WALKTHROUGH_OPERATIONS,
              message: `DiffDash already retains ${MAX_RETAINED_WALKTHROUGH_OPERATIONS} active walkthrough operations.`,
            }),
          ),
        onSome: (operationId) =>
          Effect.sync(() => {
            walkthroughOperations.delete(operationId)
          }),
      })
    })

    const registerWalkthrough = Effect.fn("Core.Walkthroughs.register")(function* (
      request: StartWalkthroughOperation,
    ) {
      yield* reserveWalkthroughSlot()
      const operationId = WalkthroughOperationId.make(randomUUID())
      const result = yield* Deferred.make<WalkthroughOperationResult>()
      const complete = (terminal: WalkthroughOperationResult) =>
        Deferred.succeed(result, terminal).pipe(Effect.asVoid)
      yield* FiberMap.run(
        walkthroughFibers,
        operationId,
        Effect.exit(generate(request)).pipe(
          Effect.flatMap((exit) => complete(walkthroughTerminalFromExit(exit))),
          Effect.onInterrupt(() => complete(WalkthroughOperationCancelled.make({}))),
          Effect.asVoid,
        ),
      )
      walkthroughOperations.set(operationId, { result })
      return { operationId } satisfies WalkthroughRegistration
    })

    const rollbackRegistration = (operationId: WalkthroughOperationIdType) =>
      FiberMap.remove(walkthroughFibers, operationId).pipe(
        Effect.andThen(
          Effect.sync(() => {
            walkthroughOperations.delete(operationId)
          }),
        ),
      )

    const start: WalkthroughLifecycle["start"] = Effect.fn("Core.Walkthroughs.start")((request) =>
      walkthroughStartSemaphore.withPermits(1)(
        Effect.acquireUseRelease(
          registerWalkthrough(request),
          ({ operationId }) => Effect.succeed({ operationId }),
          ({ operationId }, exit) =>
            Exit.isFailure(exit) ? rollbackRegistration(operationId) : Effect.void,
        ),
      ),
    )

    const getOperation: WalkthroughLifecycle["getOperation"] = Effect.fn(
      "Core.Walkthroughs.getOperation",
    )(function* (operationId) {
      return yield* Option.match(Option.fromNullable(walkthroughOperations.get(operationId)), {
        onNone: () => Effect.fail(WalkthroughOperationNotFound.make({ operationId })),
        onSome: ({ result }) => Deferred.await(result),
      })
    })

    const cancel: WalkthroughLifecycle["cancel"] = Effect.fn("Core.Walkthroughs.cancel")(
      function* (operationId) {
        return yield* Option.match(Option.fromNullable(walkthroughOperations.get(operationId)), {
          onNone: () => Effect.fail(WalkthroughOperationNotFound.make({ operationId })),
          onSome: ({ result }) =>
            FiberMap.remove(walkthroughFibers, operationId).pipe(
              Effect.andThen(Deferred.await(result)),
            ),
        })
      },
    )

    return { start, getOperation, cancel }
  })

/** Acquires the complete scoped walkthrough capability. */
export const makeWalkthroughOperations = (
  reviews: ReviewResolution,
): Effect.Effect<
  WalkthroughOperations,
  never,
  RepositoryComparisonSource | Scope.Scope | WalkthroughService | WalkthroughStore
> =>
  Effect.gen(function* () {
    const comparisons = yield* RepositoryComparisonSource
    const walkthroughService = yield* WalkthroughService
    const walkthroughStore = yield* WalkthroughStore

    const getCached: WalkthroughOperations["getCached"] = Effect.fn("Core.Walkthroughs.getCached")(
      (repoId, snapshot) => walkthroughStore.get(walkthroughCacheKey(repoId, snapshot)),
    )

    const getStoredWalkthrough: WalkthroughOperations["getStored"] = Effect.fn(
      "Core.Walkthroughs.getStored",
    )(function* (request) {
      const { repo, snapshot } = yield* reviews.resolve(request.target)
      if (
        (request.expectedBaseRevision !== null &&
          snapshot.baseRevision !== request.expectedBaseRevision) ||
        (request.expectedHeadRevision !== null &&
          snapshot.headRevision !== request.expectedHeadRevision)
      ) {
        return Option.none()
      }
      return yield* getCached(repo.id, snapshot)
    })

    const loadOrGenerate = Effect.fn("Core.Walkthroughs.loadOrGenerate")(function* (
      regenerate: boolean,
      cacheKey: WalkthroughCacheKey,
      generate: Effect.Effect<StoredWalkthrough, CoreWalkthroughFailure>,
    ) {
      if (regenerate) return yield* generate
      const cached = yield* walkthroughStore.get(cacheKey)
      return yield* Option.match(cached, {
        onNone: () => generate,
        onSome: Effect.succeed,
      })
    })

    const generate: (
      request: StartWalkthroughOperation,
    ) => Effect.Effect<StoredWalkthrough, CoreWalkthroughFailure> = Effect.fn(
      "Core.Walkthroughs.generate",
    )((request) =>
      Match.value(request.target).pipe(
        Match.when({ kind: "hosted" }, (target) =>
          Effect.gen(function* () {
            const { repo, snapshot, prNumber } = yield* reviews.resolveHosted(target)
            const cacheKey = walkthroughCacheKey(repo.id, snapshot)
            return yield* loadOrGenerate(
              request.regenerate,
              cacheKey,
              Effect.gen(function* () {
                const promptInput = yield* prepareWalkthroughPromptInput(
                  snapshot.parsedDiff.files,
                  walkthroughHostedReviewScope(target.review),
                )
                const walkthrough = yield* walkthroughService.generate({
                  review: { kind: "hosted", hostedReview: snapshot.detail },
                  diff: promptInput.diff,
                  hunkDigest: promptInput.hunkDigest,
                  changedFileTree: promptInput.changedFileTree,
                  generation: promptInput.generation,
                  promptStats: promptInput.stats,
                })
                return yield* walkthroughStore.save({ ...cacheKey, prNumber, walkthrough })
              }),
            )
          }),
        ),
        Match.when({ kind: "repositoryComparison" }, (target) =>
          Effect.gen(function* () {
            const { repo, snapshot } = yield* reviews.resolveRepositoryComparison(target)
            const cacheKey = walkthroughCacheKey(repo.id, snapshot)
            return yield* loadOrGenerate(
              request.regenerate,
              cacheKey,
              Effect.gen(function* () {
                const promptInput = yield* prepareWalkthroughPromptInput(
                  snapshot.parsedDiff.files,
                  walkthroughRepositoryComparisonScope(snapshot.reviewKey),
                )
                const walkthrough = yield* comparisons.useWorkspace(target, (workingDirectory) =>
                  walkthroughService.generate({
                    review: { kind: "repositoryComparison", comparison: snapshot.detail },
                    diff: promptInput.diff,
                    hunkDigest: promptInput.hunkDigest,
                    changedFileTree: promptInput.changedFileTree,
                    generation: promptInput.generation,
                    promptStats: promptInput.stats,
                    workingDirectory,
                  }),
                )
                return yield* walkthroughStore.save({ ...cacheKey, prNumber: null, walkthrough })
              }),
            )
          }),
        ),
        Match.when({ kind: "local" }, (target) =>
          Effect.gen(function* () {
            const { repo, snapshot } = yield* reviews.resolveLocal(target)
            const cacheKey = walkthroughCacheKey(repo.id, snapshot)
            return yield* loadOrGenerate(
              request.regenerate,
              cacheKey,
              Effect.gen(function* () {
                const promptInput = yield* prepareWalkthroughPromptInput(
                  snapshot.parsedDiff.files,
                  walkthroughLocalDiffScope(snapshot.headRevision),
                )
                const walkthrough = yield* walkthroughService.generate({
                  review: { kind: "localDiff", localReview: snapshot.detail },
                  diff: promptInput.diff,
                  hunkDigest: promptInput.hunkDigest,
                  changedFileTree: promptInput.changedFileTree,
                  generation: promptInput.generation,
                  promptStats: promptInput.stats,
                })
                return yield* walkthroughStore.save({ ...cacheKey, prNumber: null, walkthrough })
              }),
            )
          }),
        ),
        Match.exhaustive,
      ),
    )

    const lifecycle = yield* makeWalkthroughLifecycle(generate)
    return { ...lifecycle, getStored: getStoredWalkthrough, getCached }
  })

/** Converts one walkthrough fiber exit without allowing defects to masquerade as expected failures. */
export const walkthroughTerminalFromExit = (
  exit: Exit.Exit<StoredWalkthrough, CoreWalkthroughFailure>,
): WalkthroughOperationResult =>
  Exit.match(exit, {
    onSuccess: (walkthrough) => WalkthroughOperationCompleted.make({ walkthrough }),
    onFailure: (cause) =>
      Option.match(Cause.dieOption(cause), {
        onSome: (defect) => WalkthroughOperationDefect.make({ defect }),
        onNone: () =>
          Option.match(Cause.failureOption(cause), {
            onSome: (error) => WalkthroughOperationFailed.make({ error }),
            onNone: () =>
              Option.match(Cause.interruptOption(cause), {
                onSome: () => WalkthroughOperationCancelled.make({}),
                onNone: () => WalkthroughOperationDefect.make({ defect: Cause.squash(cause) }),
              }),
          }),
      }),
  })

const walkthroughCacheKey = (repoId: string, snapshot: ReviewSnapshot): WalkthroughCacheKey => ({
  repoId,
  reviewKey: snapshot.reviewKey,
  baseSha: snapshot.baseRevision,
  headSha: snapshot.headRevision,
  promptVersion: WALKTHROUGH_PROMPT_VERSION,
})
