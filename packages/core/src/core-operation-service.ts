import { ReviewTurnStore } from "@diffdash/persistence/review-turn-store"
import { WalkthroughOperationStore } from "@diffdash/persistence/walkthrough-operation-store"
import {
  WalkthroughStore,
  type WalkthroughStoreError,
} from "@diffdash/persistence/walkthrough-store"
import type { AgentRun } from "@diffdash/domain/agent-run"
import type { AgentRunId } from "@diffdash/domain/agent-run-id"
import type { StartReviewAgentOperationRequest } from "@diffdash/core-rpc/review-agent"
import type { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import { WalkthroughOperationReviewGeneration } from "@diffdash/domain/walkthrough-operation"
import { Context, Effect, Layer, Option } from "effect"

import type { CoreThreadResolutionFailure } from "./core-contract"
import { CoreEventHub } from "./core-event-hub"
import { CoreStartupError } from "./core-startup-error"
import { makeAnalyticsOperationHandlers } from "./operations/analytics-operation-handlers"
import { makeApplicationOperationHandlers } from "./operations/application-operation-handlers"
import {
  assertUniqueOperationHandlers,
  type OperationHandlers,
} from "./operations/operation-handlers"
import { makeRepositoryOperationHandlers } from "./operations/repository-operation-handlers"
import { makeResourceOperationHandlers } from "./operations/resource-operation-handlers"
import { makeReviewAcquisitionOperationHandlers } from "./operations/review-acquisition-operation-handlers"
import {
  ReviewAgentOperationsService,
  type ReviewAgentOperationError,
} from "./operations/review-agent-operations"
import { makeReviewOperationHandlers } from "./operations/review-operation-handlers"
import { makeReviewResolution } from "./operations/review-resolution"
import { makeSettingsOperationHandlers } from "./operations/settings-operation-handlers"
import { makeThreadOperationHandlers } from "./operations/thread-operation-handlers"
import { makeViewedFileOperationHandlers } from "./operations/viewed-file-operation-handlers"
import {
  makeWalkthroughOperations,
  publishWalkthroughTerminalHint,
  recoverInterruptedWalkthroughOperations,
  type WalkthroughOperations,
} from "./operations/walkthrough-operations"

/** Expected failures while resolving and durably accepting one review-agent request. */
export type CoreReviewAgentStartError =
  | ReviewAgentOperationError
  | CoreThreadResolutionFailure
  | WalkthroughStoreError

interface CoreOperationServiceShape {
  readonly start: Effect.Effect<void, CoreStartupError>
  readonly methods: OperationHandlers
  readonly walkthroughs: WalkthroughOperations & {
    readonly resolveGeneration: (
      target: ReviewThreadTarget,
    ) => Effect.Effect<WalkthroughOperationReviewGeneration, CoreThreadResolutionFailure>
  }
  readonly reviewAgents: {
    readonly start: (
      input: StartReviewAgentOperationRequest,
    ) => Effect.Effect<AgentRunId, CoreReviewAgentStartError>
    readonly getOperation: (
      runId: AgentRunId,
    ) => Effect.Effect<Option.Option<AgentRun>, ReviewAgentOperationError>
    readonly cancel: (
      runId: AgentRunId,
    ) => Effect.Effect<Option.Option<AgentRun>, ReviewAgentOperationError>
  }
}

/** Internal authority that exposes only cohesive operations to the external Core RPC handlers. */
export class CoreOperationService extends Context.Service<
  CoreOperationService,
  CoreOperationServiceShape
>()("@diffdash/CoreOperationService") {}

/** Builds the stable Core facade from cohesive internal operation capabilities. */
export const coreOperationLayer = Layer.effect(
  CoreOperationService,
  Effect.gen(function* () {
    const turns = yield* ReviewTurnStore
    const reviewAgentOperations = yield* ReviewAgentOperationsService
    const walkthroughOperationStore = yield* WalkthroughOperationStore
    const walkthroughStore = yield* WalkthroughStore
    const events = yield* CoreEventHub
    const reviews = yield* makeReviewResolution
    const walkthroughs = yield* makeWalkthroughOperations(reviews)
    const resolveWalkthroughGeneration = Effect.fn("Core.Walkthroughs.resolveGeneration")(
      function* (target: ReviewThreadTarget) {
        const { snapshot } = yield* reviews.resolve(target)
        return WalkthroughOperationReviewGeneration.make({
          kind: target.kind,
          projectId: snapshot.projectId,
          snapshotId: snapshot.snapshotId,
          reviewKey: snapshot.reviewKey,
          baseRevision: snapshot.baseRevision,
          headRevision: snapshot.headRevision,
        })
      },
    )
    const analyticsHandlers = yield* makeAnalyticsOperationHandlers
    const applicationHandlers = yield* makeApplicationOperationHandlers
    const repositoryHandlers = yield* makeRepositoryOperationHandlers
    const resourceHandlers = yield* makeResourceOperationHandlers
    const reviewAcquisitionHandlers = yield* makeReviewAcquisitionOperationHandlers
    const reviewHandlers = yield* makeReviewOperationHandlers
    const settingsHandlers = yield* makeSettingsOperationHandlers
    const threadHandlers = yield* makeThreadOperationHandlers(reviews, walkthroughs)
    const viewedFileHandlers = yield* makeViewedFileOperationHandlers
    const startReviewAgent = Effect.fn("Core.ReviewAgents.resolveAndStart")(function* (
      request: StartReviewAgentOperationRequest,
    ) {
      const mapping = yield* turns.validateTarget({
        threadId: request.threadId,
        target: request.target,
        repoId: request.repoId,
        reviewKey: request.reviewKey,
        baseRevision: request.expectedBaseRevision,
        headRevision: request.expectedHeadRevision,
      })
      const { repo, snapshot } = yield* reviews.resolve(request.target)
      const walkthrough = yield* walkthroughs.getCached(repo.id, snapshot)
      return yield* reviewAgentOperations.start({
        threadId: request.threadId,
        repoId: repo.id,
        target: request.target,
        mapping,
        snapshotId: snapshot.snapshotId,
        applicationInstanceId: request.applicationInstanceId,
        processEpoch: request.processEpoch,
        cwd: repo.localPath,
        walkthrough,
      })
    })
    const handlerCapabilities = [
      analyticsHandlers,
      applicationHandlers,
      repositoryHandlers,
      resourceHandlers,
      reviewAcquisitionHandlers,
      reviewHandlers,
      settingsHandlers,
      threadHandlers,
      viewedFileHandlers,
    ] as const

    assertUniqueOperationHandlers(handlerCapabilities)

    const handlers = {
      ...analyticsHandlers,
      ...applicationHandlers,
      ...repositoryHandlers,
      ...resourceHandlers,
      ...reviewAcquisitionHandlers,
      ...reviewHandlers,
      ...settingsHandlers,
      ...threadHandlers,
      ...viewedFileHandlers,
    } satisfies OperationHandlers

    return CoreOperationService.of({
      start: Effect.gen(function* () {
        yield* reviewAgentOperations.recoverInterrupted.pipe(
          Effect.mapError((cause) =>
            CoreStartupError.make({
              operation: "recoverInterruptedReviewTurns",
              message: "DiffDash Core could not recover interrupted review turns.",
              cause,
            }),
          ),
        )
        const activeWalkthroughs = yield* walkthroughOperationStore.listActive.pipe(
          Effect.mapError((cause) =>
            CoreStartupError.make({
              operation: "inspectActiveWalkthroughOperations",
              message: "DiffDash Core could not inspect active walkthrough operations.",
              cause,
            }),
          ),
        )
        for (const operation of activeWalkthroughs) {
          if (operation.state !== "running") continue
          const artifact = yield* walkthroughStore
            .get({
              repoId: operation.identity.repoId,
              reviewKey: operation.identity.reviewKey,
              baseSha: operation.identity.baseRevision,
              headSha: operation.identity.headRevision,
              promptVersion: operation.identity.promptVersion,
            })
            .pipe(
              Effect.mapError((cause) =>
                CoreStartupError.make({
                  operation: "reconcileWalkthroughArtifact",
                  message: "DiffDash Core could not reconcile a saved walkthrough artifact.",
                  cause,
                }),
              ),
            )
          if (Option.isSome(artifact)) {
            const transition = yield* walkthroughOperationStore
              .completeSuccess({
                operationId: operation.id,
                expectedStateVersion: operation.stateVersion,
                artifact: operation.identity,
              })
              .pipe(
                Effect.mapError((cause) =>
                  CoreStartupError.make({
                    operation: "completeRecoveredWalkthroughOperation",
                    message: "DiffDash Core could not finalize a recovered walkthrough operation.",
                    cause,
                  }),
                ),
              )
            if (transition.won && transition.operation.state === "completed") {
              yield* Effect.exit(publishWalkthroughTerminalHint(events, transition.operation))
            }
          }
        }
        yield* recoverInterruptedWalkthroughOperations(walkthroughOperationStore, (operation) =>
          publishWalkthroughTerminalHint(events, operation),
        ).pipe(
          Effect.mapError((cause) =>
            CoreStartupError.make({
              operation: "recoverInterruptedWalkthroughOperations",
              message: "DiffDash Core could not recover interrupted walkthrough operations.",
              cause,
            }),
          ),
        )
      }),
      methods: handlers,
      walkthroughs: { ...walkthroughs, resolveGeneration: resolveWalkthroughGeneration },
      reviewAgents: {
        start: startReviewAgent,
        getOperation: reviewAgentOperations.getOperation,
        cancel: reviewAgentOperations.cancel,
      },
    })
  }),
)
