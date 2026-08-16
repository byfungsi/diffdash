import {
  GitProviderId,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewLocator,
  HostedReviewNumber,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import { ReviewDiffIdentity, ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import {
  REVIEW_DIFF_MAX_CHUNK_BYTES,
  HostedReviewDiffSourceTarget,
  ReviewDiffAcquisition,
  ReviewDiffByteCompletion,
  ReviewDiffGeneration,
  ReviewDiffSourceFacts,
  ReviewDiffSourceOffer,
  UnifiedBytesMethod,
  type ReviewDiffSource,
} from "@diffdash/git-provider"
import {
  attachReviewDataWorker,
  type ReviewDataWorkerCommand,
  type ReviewDataWorkerEndpoint,
  type ReviewDataWorkerHandle,
  type ReviewDataWorkerResponse,
  type ReviewDataWorkerRuntime,
} from "@diffdash/review-data-worker"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"

import { CoreReviewDataWorker, coreReviewDataWorkerLayer } from "./review-data-worker-coordinator"
import { reviewLifecycleDiagnosticsLayer } from "./review-lifecycle-diagnostics"

const revision = ReviewRevision.make("worker-revision")
const identity = ReviewDiffIdentity.make("diff:v1:worker")
const generation = ReviewDiffGeneration.make("worker-generation")
const acquisition = ReviewDiffAcquisition.make({ generation, expectedRevision: revision })
const replacementGeneration = ReviewDiffGeneration.make("worker-generation-replacement")
const replacementAcquisition = ReviewDiffAcquisition.make({
  generation: replacementGeneration,
  expectedRevision: revision,
})
const bytes = new TextEncoder().encode(
  "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
)
const offer = ReviewDiffSourceOffer.make({
  target: HostedReviewDiffSourceTarget.make({
    reviewKey: ReviewKey.make("fixture:diffdash/worker#1"),
    review: HostedReviewLocator.make({
      repository: HostedRepositoryLocator.make({
        providerId: GitProviderId.make("fixture"),
        namespace: RepositoryNamespace.make("diffdash"),
        name: HostedRepositoryName.make("worker"),
      }),
      number: HostedReviewNumber.make(1),
    }),
  }),
  expectedRevision: revision,
  semanticIdentity: identity,
  methods: [UnifiedBytesMethod.make({ maxChunkBytes: REVIEW_DIFF_MAX_CHUNK_BYTES })],
  facts: ReviewDiffSourceFacts.make({
    origin: "remote",
    revisionKind: "mutable",
    reproducible: false,
    complete: true,
    declaredBytes: bytes.byteLength,
  }),
})

const completeSourceFor = (sourceGeneration: ReviewDiffGeneration): ReviewDiffSource => ({
  offer,
  unifiedBytes: () =>
    Stream.fromIterable([
      { bytes },
      ReviewDiffByteCompletion.make({
        generation: sourceGeneration,
        revision,
        semanticIdentity: identity,
        totalBytes: bytes.byteLength,
      }),
    ]),
  close: Effect.void,
})
const completeSource = completeSourceFor(generation)

describe("CoreReviewDataWorker", () => {
  it.effect("validates and consumes worker batches before acknowledging source chunks", () =>
    Effect.gen(function* () {
      const runtime = new InProcessWorkerRuntime()
      const batches: number[] = []

      yield* Effect.gen(function* () {
        const coordinator = yield* CoreReviewDataWorker
        yield* coordinator.process(completeSource, acquisition, (batch) =>
          Effect.sync(() => batches.push(batch.byteCount)),
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(
          coreReviewDataWorkerLayer({
            runtime,
            moduleUrl: new URL("file:///in-process-worker.mjs"),
          }).pipe(Layer.provide(reviewLifecycleDiagnosticsLayer)),
        ),
      )

      expect(batches.length).toBeGreaterThan(0)
      expect(runtime.terminated).toBe(1)
    }),
  )

  it.effect("terminates the previous disposable worker when a newer review starts", () =>
    Effect.gen(function* () {
      const runtime = new InProcessWorkerRuntime()
      const layer = coreReviewDataWorkerLayer({
        runtime,
        moduleUrl: new URL("file:///in-process-worker.mjs"),
      }).pipe(Layer.provide(reviewLifecycleDiagnosticsLayer))
      yield* Effect.gen(function* () {
        const coordinator = yield* CoreReviewDataWorker
        const first = yield* coordinator
          .process(
            { ...completeSource, unifiedBytes: () => Stream.never },
            acquisition,
            () => Effect.void,
          )
          .pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* coordinator.process(
          completeSourceFor(replacementGeneration),
          replacementAcquisition,
          () => Effect.void,
        )
        yield* Fiber.interrupt(first)

        expect(runtime.started).toBe(2)
        expect(runtime.terminated).toBe(1)
      }).pipe(Effect.provide(layer), Effect.scoped)
      expect(runtime.terminated).toBe(2)
    }),
  )
})

class InProcessWorkerRuntime implements ReviewDataWorkerRuntime {
  started = 0
  terminated = 0

  start(_moduleUrl: URL): ReviewDataWorkerHandle {
    this.started += 1
    const commands = new Set<(command: ReviewDataWorkerCommand) => void>()
    const responses = new Set<(response: ReviewDataWorkerResponse) => void>()
    const endpoint: ReviewDataWorkerEndpoint = {
      onCommand: (listener) => {
        commands.add(listener)
        return () => commands.delete(listener)
      },
      respond: (response) => {
        for (const listener of responses) listener(response)
      },
      close: () => undefined,
    }
    const detach = attachReviewDataWorker(endpoint, {
      append: async () => undefined,
      close: async () => undefined,
    })
    return {
      post: (command) => {
        for (const listener of commands) listener(command)
      },
      onResponse: (listener) => {
        responses.add(listener)
        return () => responses.delete(listener)
      },
      onFailure: () => () => undefined,
      terminate: async () => {
        this.terminated += 1
        detach()
        responses.clear()
      },
    }
  }
}
