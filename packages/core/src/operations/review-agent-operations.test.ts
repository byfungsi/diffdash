import {
  AgentPromptVersion,
  type AgentRun,
  CancelledAgentRun,
  CompletedAgentRun,
  InterruptedAgentRun,
  RunningAgentRun,
} from "@diffdash/domain/agent-run"
import { AgentRunId } from "@diffdash/domain/agent-run-id"
import { ReviewAgentProviderId } from "@diffdash/domain/review-agent-provider-id"
import { ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import { ReviewThreadId } from "@diffdash/domain/review-thread"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Option, Ref, Schema } from "effect"

import {
  makeReviewAgentOperations,
  type ReviewAgentOperationStore,
} from "./review-agent-operations"

const makeRunning = (id: string, threadId = "thread-256") =>
  RunningAgentRun.make({
    id: AgentRunId.make(id),
    threadId: ReviewThreadId.make(threadId),
    reviewKey: ReviewKey.make("github:fungsi/diffdash#256"),
    baseRevision: ReviewRevision.make("base-256"),
    headRevision: ReviewRevision.make("head-256"),
    provider: ReviewAgentProviderId.make("opencode"),
    model: "openai/gpt-5",
    promptVersion: AgentPromptVersion.make("review-thread-v3"),
    startedAt: "2026-08-16T00:00:00.000Z",
  })

const makeHarness = Effect.fn("ReviewAgentOperationsTest.makeHarness")(function* () {
  const runs = yield* Ref.make(new Map<AgentRunId, AgentRun>())
  const workers = yield* Ref.make(new Map<AgentRunId, Effect.Effect<void>>())
  const hints = yield* Ref.make<readonly AgentRun[]>([])
  const executions = yield* Ref.make(0)

  const store: ReviewAgentOperationStore<never> = {
    getOperation: (runId) =>
      Ref.get(runs).pipe(Effect.map((all) => Option.fromNullishOr(all.get(runId)))),
    requestCancellation: (runId) =>
      Ref.modify(
        runs,
        (
          all,
        ): readonly [
          { readonly operation: AgentRun; readonly won: boolean },
          Map<AgentRunId, AgentRun>,
        ] => {
          const current = all.get(runId)
          if (current === undefined || !Schema.is(RunningAgentRun)(current)) {
            if (current === undefined) throw new Error("Test operation was not found")
            return [{ operation: current, won: false }, all]
          }
          const cancelled = CancelledAgentRun.make({
            id: current.id,
            threadId: current.threadId,
            reviewKey: current.reviewKey,
            baseRevision: current.baseRevision,
            headRevision: current.headRevision,
            provider: current.provider,
            model: current.model,
            promptVersion: current.promptVersion,
            startedAt: current.startedAt,
            completedAt: "2026-08-16T00:00:01.000Z",
          })
          const updated = new Map(all)
          updated.set(runId, cancelled)
          return [{ operation: cancelled, won: true }, updated]
        },
      ),
    recoverInterruptedOperations: Ref.modify(runs, (all) => {
      let count = 0
      const updated = new Map(all)
      for (const [runId, run] of all) {
        if (!Schema.is(RunningAgentRun)(run)) continue
        count += 1
        updated.set(
          runId,
          InterruptedAgentRun.make({
            id: run.id,
            threadId: run.threadId,
            reviewKey: run.reviewKey,
            baseRevision: run.baseRevision,
            headRevision: run.headRevision,
            provider: run.provider,
            model: run.model,
            promptVersion: run.promptVersion,
            startedAt: run.startedAt,
            completedAt: "2026-08-16T00:00:02.000Z",
          }),
        )
      }
      return [count, updated]
    }),
  }

  const operations = yield* makeReviewAgentOperations<string, never>({
    store,
    accept: (id) =>
      Effect.gen(function* () {
        const operation = makeRunning(id)
        const worker = yield* Ref.get(workers).pipe(
          Effect.map((all) => all.get(operation.id) ?? Effect.void),
        )
        yield* Ref.update(runs, (all) => {
          if (
            [...all.values()].some(
              (run) => run.threadId === operation.threadId && Schema.is(RunningAgentRun)(run),
            )
          ) {
            throw new Error("single-flight violation")
          }
          const updated = new Map(all)
          updated.set(operation.id, operation)
          return updated
        })
        return {
          operation,
          worker: Ref.update(executions, (count) => count + 1).pipe(Effect.andThen(worker)),
        }
      }),
    onTerminalHint: (operation) => Ref.update(hints, (all) => [...all, operation]),
  })

  return { operations, runs, workers, hints, executions }
})

describe("ReviewAgentOperations", () => {
  it.effect("reconnects navigation and reload reads through authoritative state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const runId = yield* harness.operations.start("run-reload")
      const firstRead = yield* harness.operations.getOperation(runId)
      const secondRead = yield* harness.operations.getOperation(runId)

      expect(firstRead).toEqual(secondRead)
      expect(Option.getOrThrow(firstRead)).toMatchObject({ _tag: "Running" })
      expect(yield* harness.operations.activeCount).toBe(0)
    }),
  )

  it.effect("persists terminal completion before publishing its hint", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const run = makeRunning("run-complete")
      const release = yield* Deferred.make<void>()
      yield* Ref.update(harness.workers, (all) =>
        new Map(all).set(
          run.id,
          Deferred.await(release).pipe(
            Effect.andThen(
              Ref.update(harness.runs, (stored) =>
                new Map(stored).set(
                  run.id,
                  CompletedAgentRun.make({
                    id: run.id,
                    threadId: run.threadId,
                    reviewKey: run.reviewKey,
                    baseRevision: run.baseRevision,
                    headRevision: run.headRevision,
                    provider: run.provider,
                    model: run.model,
                    promptVersion: run.promptVersion,
                    startedAt: run.startedAt,
                    completedAt: "2026-08-16T00:00:01.000Z",
                  }),
                ),
              ),
            ),
          ),
        ),
      )

      yield* harness.operations.start(run.id)
      yield* Deferred.succeed(release, undefined)
      yield* Effect.yieldNow

      const hinted = (yield* Ref.get(harness.hints))[0]
      expect(hinted).toMatchObject({ _tag: "Completed" })
      expect(Option.getOrThrow(yield* harness.operations.getOperation(run.id))).toEqual(hinted)
    }),
  )

  it.effect("cancels provider resources after the durable cancellation wins", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const run = makeRunning("run-cancel")
      const started = yield* Deferred.make<void>()
      const finalized = yield* Ref.make(false)
      yield* Ref.update(harness.workers, (all) =>
        new Map(all).set(
          run.id,
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Ref.set(finalized, true)),
          ),
        ),
      )

      yield* harness.operations.start(run.id)
      yield* Deferred.await(started)
      const cancelled = yield* harness.operations.cancel(run.id)

      expect(Option.getOrThrow(cancelled)).toMatchObject({ _tag: "Cancelled" })
      expect(yield* Ref.get(finalized)).toBe(true)
      expect((yield* Ref.get(harness.hints)).at(-1)).toMatchObject({ _tag: "Cancelled" })
      expect(yield* harness.operations.activeCount).toBe(0)
    }),
  )

  it.effect("preserves one active operation per thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const blocker = yield* Deferred.make<void>()
      const first = makeRunning("run-first")
      yield* Ref.update(harness.workers, (all) =>
        new Map(all).set(first.id, Deferred.await(blocker)),
      )
      yield* harness.operations.start(first.id)

      const duplicate = yield* Effect.exit(harness.operations.start("run-duplicate"))
      expect(Exit.isFailure(duplicate)).toBe(true)
      expect(yield* Ref.get(harness.executions)).toBe(1)
      yield* harness.operations.cancel(first.id)
    }),
  )

  it.effect("marks abandoned runs interrupted on restart without executing them again", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const abandoned = makeRunning("run-abandoned")
      yield* Ref.set(harness.runs, new Map([[abandoned.id, abandoned]]))

      expect(yield* harness.operations.recoverInterrupted).toBe(1)
      expect(Option.getOrThrow(yield* harness.operations.getOperation(abandoned.id))).toMatchObject(
        { _tag: "Interrupted" },
      )
      expect(yield* Ref.get(harness.executions)).toBe(0)
    }),
  )

  it.effect("leaves one committed terminal state when completion races cancellation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const run = makeRunning("run-race")
      const complete = yield* Deferred.make<void>()
      yield* Ref.update(harness.workers, (all) =>
        new Map(all).set(
          run.id,
          Deferred.await(complete).pipe(
            Effect.andThen(
              Ref.update(harness.runs, (stored) => {
                const current = stored.get(run.id)
                if (current === undefined || !Schema.is(RunningAgentRun)(current)) return stored
                return new Map(stored).set(
                  run.id,
                  CompletedAgentRun.make({
                    id: current.id,
                    threadId: current.threadId,
                    reviewKey: current.reviewKey,
                    baseRevision: current.baseRevision,
                    headRevision: current.headRevision,
                    provider: current.provider,
                    model: current.model,
                    promptVersion: current.promptVersion,
                    startedAt: current.startedAt,
                    completedAt: "2026-08-16T00:00:01.000Z",
                  }),
                )
              }),
            ),
          ),
        ),
      )
      yield* harness.operations.start(run.id)

      yield* Effect.all(
        [harness.operations.cancel(run.id), Deferred.succeed(complete, undefined)],
        { concurrency: "unbounded" },
      )
      yield* Effect.yieldNow

      const terminal = Option.getOrThrow(yield* harness.operations.getOperation(run.id))
      expect(terminal).toEqual(
        expect.objectContaining({ _tag: expect.stringMatching(/^(Cancelled|Completed)$/u) }),
      )
      expect(yield* harness.operations.activeCount).toBe(0)
    }),
  )
})
