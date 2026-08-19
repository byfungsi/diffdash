import type { AgentRun, RunningAgentRun } from "@diffdash/domain/agent-run"
import { isTerminalAgentRun } from "@diffdash/domain/agent-run"
import type { AgentRunId } from "@diffdash/domain/agent-run-id"
import {
  ReviewTurnOwnershipError,
  ReviewTurnRejectedError,
  ReviewTurnStore,
  ReviewTurnStoreError,
  ReviewTurnTargetError,
} from "@diffdash/persistence/review-turn-store"
import {
  Context,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Layer,
  Option,
  Semaphore,
  type Scope,
} from "effect"

import { CoreEventHub } from "../core-event-hub"
import {
  ReviewAgentFinalizeError,
  ReviewAgentProviderFailureError,
  ReviewAgentService,
  ReviewAgentServiceError,
  type RunReviewAgentTurnInput,
} from "../services/review-agent"

/** Expected failures from durable acceptance, provider work, and operation persistence. */
export type ReviewAgentOperationError =
  | ReviewAgentServiceError
  | ReviewAgentFinalizeError
  | ReviewAgentProviderFailureError
  | ReviewTurnTargetError
  | ReviewTurnRejectedError
  | ReviewTurnOwnershipError
  | ReviewTurnStoreError

/** Durable acceptance returned before one review-agent provider worker is launched. */
export interface AcceptedReviewAgentOperation<Failure> {
  readonly operation: RunningAgentRun
  readonly worker: Effect.Effect<void, Failure>
}

/** Persistence capability required by the active review-agent operation coordinator. */
export interface ReviewAgentOperationStore<Failure> {
  readonly getOperation: (runId: AgentRunId) => Effect.Effect<Option.Option<AgentRun>, Failure>
  readonly requestCancellation: (
    runId: AgentRunId,
  ) => Effect.Effect<{ readonly operation: AgentRun; readonly won: boolean }, Failure>
  readonly recoverInterruptedOperations: Effect.Effect<number, Failure>
}

/** Inputs and durable seams used to construct one scoped operation coordinator. */
export interface ReviewAgentOperationsOptions<Input, Failure> {
  readonly accept: (input: Input) => Effect.Effect<AcceptedReviewAgentOperation<Failure>, Failure>
  readonly store: ReviewAgentOperationStore<Failure>
  readonly onTerminalHint?: (operation: AgentRun) => Effect.Effect<void>
}

/** Short Core lifecycle for durable review-agent responses. */
export interface ReviewAgentOperations<Input, Failure> {
  readonly start: (input: Input) => Effect.Effect<AgentRunId, Failure>
  readonly getOperation: (runId: AgentRunId) => Effect.Effect<Option.Option<AgentRun>, Failure>
  readonly cancel: (runId: AgentRunId) => Effect.Effect<Option.Option<AgentRun>, Failure>
  readonly recoverInterrupted: Effect.Effect<number, Failure>
  readonly activeCount: Effect.Effect<number>
}

/** Core authority for durable review-agent acceptance, query, and cancellation. */
export class ReviewAgentOperationsService extends Context.Service<
  ReviewAgentOperationsService,
  ReviewAgentOperations<RunReviewAgentTurnInput, ReviewAgentOperationError>
>()("@diffdash/core/ReviewAgentOperations") {}

/** Scoped active-worker coordinator backed by authoritative review-turn persistence. */
export const reviewAgentOperationsLayer = Layer.effect(
  ReviewAgentOperationsService,
  Effect.gen(function* () {
    const turns = yield* ReviewTurnStore
    const reviewAgents = yield* ReviewAgentService
    const events = yield* CoreEventHub
    const operations = yield* makeReviewAgentOperations<
      RunReviewAgentTurnInput,
      ReviewAgentOperationError
    >({
      store: turns,
      accept: (input) =>
        reviewAgents
          .acceptThreadTurn(input)
          .pipe(
            Effect.map(({ operation, worker }) => ({ operation, worker: Effect.asVoid(worker) })),
          ),
      onTerminalHint: (operation) =>
        events
          .publish({
            topic: "review-agent.operation.terminal",
            schemaVersion: 1,
            scopes: [
              { name: "thread", id: operation.threadId },
              { name: "review", id: operation.reviewKey },
            ],
            source: "review-agent",
            reason: "terminal-state-committed",
            subject: { kind: "operation", operationId: operation.id },
            kind: "operationTerminal",
            stateVersion: 1,
          })
          .pipe(Effect.asVoid),
    })
    return ReviewAgentOperationsService.of(operations)
  }),
)

type WorkerExit<Failure> = Exit.Exit<void, Failure>

/** Creates an active-only `FiberMap` coordinator over a persistence-owned lifecycle. */
export const makeReviewAgentOperations = <Input, Failure>(
  options: ReviewAgentOperationsOptions<Input, Failure>,
): Effect.Effect<ReviewAgentOperations<Input, Failure>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = yield* FiberMap.make<AgentRunId, WorkerExit<Failure>, never>()
    const acceptance = yield* Semaphore.make(1)

    const publishCommittedTerminal = Effect.fn("Core.ReviewAgents.publishCommittedTerminal")(
      function* (runId: AgentRunId) {
        const operation = yield* options.store.getOperation(runId)
        if (Option.isSome(operation) && isTerminalAgentRun(operation.value)) {
          yield* options.onTerminalHint?.(operation.value) ?? Effect.void
        }
        return operation
      },
    )

    const supervise = Effect.fn("Core.ReviewAgents.supervise")(
      (operation: RunningAgentRun, worker: Effect.Effect<void, Failure>) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const workerExit = yield* Effect.exit(restore(worker))
            const hintExit = yield* Effect.exit(publishCommittedTerminal(operation.id))
            return Exit.isFailure(hintExit) ? hintExit : workerExit
          }),
        ),
    )

    const start: ReviewAgentOperations<Input, Failure>["start"] = Effect.fn(
      "Core.ReviewAgents.start",
    )((input) =>
      acceptance.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const accepted = yield* options.accept(input)
            yield* FiberMap.run(
              active,
              accepted.operation.id,
              supervise(accepted.operation, accepted.worker),
              { onlyIfMissing: true },
            )
            return accepted.operation.id
          }),
        ),
      ),
    )

    const getOperation: ReviewAgentOperations<Input, Failure>["getOperation"] = Effect.fn(
      "Core.ReviewAgents.getOperation",
    )((runId) => options.store.getOperation(runId))

    const cancel: ReviewAgentOperations<Input, Failure>["cancel"] = Effect.fn(
      "Core.ReviewAgents.cancel",
    )(function* (runId) {
      const current = yield* options.store.getOperation(runId)
      if (Option.isNone(current) || isTerminalAgentRun(current.value)) return current

      const transition = yield* options.store.requestCancellation(runId)
      if (transition.won) {
        const worker = yield* FiberMap.get(active, runId)
        if (Option.isSome(worker)) yield* Fiber.interrupt(worker.value)
        else yield* publishCommittedTerminal(runId)
      }
      return Option.some(transition.operation)
    })

    return {
      start,
      getOperation,
      cancel,
      recoverInterrupted: options.store.recoverInterruptedOperations,
      activeCount: FiberMap.size(active),
    }
  })
