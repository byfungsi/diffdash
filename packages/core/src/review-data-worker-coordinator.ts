import type {
  ReviewDiffAcquisition,
  ReviewDiffSource,
  ReviewDiffSourceError,
} from "@diffdash/git-provider"
import {
  consumeReviewDiffSource,
  isBoundedIncrementalDiffBatch,
  ReviewDataWorkerClient,
  ReviewDataWorkerFailure,
  type IncrementalDiffBatch,
  type ReviewDataWorkerRuntime,
} from "@diffdash/review-data-worker"
import { Context, Effect, Exit, Layer, Option, Ref, Schema, Semaphore, type Scope } from "effect"
import { ReviewLifecycleDiagnostics } from "./review-lifecycle-diagnostics"

/** Core-side rejection of an invalid worker batch before snapshot state can observe it. */
export class CoreReviewDataWorkerBatchError extends Schema.TaggedError<CoreReviewDataWorkerBatchError>()(
  "CoreReviewDataWorkerBatchError",
  { safeMessage: Schema.Literal("DiffDash rejected invalid incremental review data.") },
) {}

/** Runtime-specific worker construction supplied once by the selected Core host. */
export interface CoreReviewDataWorkerOptions {
  readonly runtime: ReviewDataWorkerRuntime
  readonly moduleUrl: URL
}

/** Active review worker boundary owned by Core rather than Electron or the renderer. */
export class CoreReviewDataWorker extends Context.Service<
  CoreReviewDataWorker,
  {
    readonly process: (
      source: ReviewDiffSource,
      acquisition: ReviewDiffAcquisition,
      onBatch: (batch: IncrementalDiffBatch) => Effect.Effect<void>,
    ) => Effect.Effect<
      void,
      ReviewDiffSourceError | ReviewDataWorkerFailure | CoreReviewDataWorkerBatchError,
      Scope.Scope
    >
  }
>()("@diffdash/core/CoreReviewDataWorker") {}

/** Provides a latest-session worker coordinator with deterministic switch and scope disposal. */
export const coreReviewDataWorkerLayer = (options: CoreReviewDataWorkerOptions) =>
  Layer.effect(
    CoreReviewDataWorker,
    Effect.gen(function* () {
      const diagnostics = yield* ReviewLifecycleDiagnostics
      const active = yield* Ref.make<
        Option.Option<{ readonly client: ReviewDataWorkerClient; readonly generation: string }>
      >(Option.none())
      const switchLock = yield* Semaphore.make(1)

      const process = Effect.fn("CoreReviewDataWorker.process")(function* (
        source: ReviewDiffSource,
        acquisition: ReviewDiffAcquisition,
        onBatch: (batch: IncrementalDiffBatch) => Effect.Effect<void>,
      ) {
        const client = new ReviewDataWorkerClient(options.runtime, options.moduleUrl)
        const generation = acquisition.generation
        yield* switchLock.withPermits(1)(
          Ref.getAndSet(active, Option.some({ client, generation })).pipe(
            Effect.flatMap((previous) =>
              Option.match(previous, {
                onNone: () => Effect.void,
                onSome: (worker) =>
                  diagnostics
                    .acquisitionSuperseded(worker.generation)
                    .pipe(Effect.andThen(Effect.promise(() => worker.client.dispose()))),
              }),
            ),
          ),
        )
        yield* diagnostics.acquisitionStarted(generation)
        yield* Effect.addFinalizer(() =>
          switchLock.withPermits(1)(
            Ref.modify(active, (current) => [
              Option.exists(current, (worker) => worker.client === client),
              Option.filter(current, (worker) => worker.client !== client),
            ]).pipe(
              Effect.flatMap((ownsActive) =>
                ownsActive ? Effect.promise(() => client.dispose()) : Effect.void,
              ),
            ),
          ),
        )
        const unsubscribe = client.onBatch((batch) =>
          Effect.runPromise(
            isBoundedIncrementalDiffBatch(batch)
              ? onBatch(batch)
              : CoreReviewDataWorkerBatchError.make({
                  safeMessage: "DiffDash rejected invalid incremental review data.",
                }),
          ),
        )
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
        yield* consumeReviewDiffSource(source, acquisition, client).pipe(
          Effect.onExit((exit) =>
            diagnostics.acquisitionFinished(generation, Exit.isSuccess(exit)),
          ),
        )
      })

      return CoreReviewDataWorker.of({ process })
    }),
  )
