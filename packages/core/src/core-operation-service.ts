import { ReviewTurnStore } from "@diffdash/persistence/review-turn-store"
import { WalkthroughOperationStore } from "@diffdash/persistence/walkthrough-operation-store"
import { WalkthroughStore } from "@diffdash/persistence/walkthrough-store"
import { Context, Effect, Layer, Option } from "effect"

import {
  type CoreMethod as CoreMethodType,
  type CoreMethodInput,
  type CoreOperationFailure,
  type CoreOperationOptions,
  type CoreOperationOutput,
} from "./core-contract"
import { CoreStartupError } from "./core-startup-error"
import { makeAnalyticsOperationHandlers } from "./operations/analytics-operation-handlers"
import { makeApplicationOperationHandlers } from "./operations/application-operation-handlers"
import {
  assertUniqueOperationHandlers,
  type OperationHandlers,
} from "./operations/operation-handlers"
import { makeRepositoryOperationHandlers } from "./operations/repository-operation-handlers"
import { makeReviewOperationHandlers } from "./operations/review-operation-handlers"
import { makeReviewResolution } from "./operations/review-resolution"
import { makeSettingsOperationHandlers } from "./operations/settings-operation-handlers"
import { makeThreadOperationHandlers } from "./operations/thread-operation-handlers"
import { makeViewedFileOperationHandlers } from "./operations/viewed-file-operation-handlers"
import {
  makeWalkthroughOperations,
  type WalkthroughOperations,
} from "./operations/walkthrough-operations"

interface CoreOperationServiceShape {
  readonly start: Effect.Effect<void, CoreStartupError>
  readonly execute: <Method extends CoreMethodType>(
    method: Method,
    input: CoreMethodInput<Method>,
    options?: CoreOperationOptions,
  ) => Effect.Effect<CoreOperationOutput<Method>, CoreOperationFailure<Method>>
  readonly walkthroughs: WalkthroughOperations
}

/** Internal authority that exposes only cohesive Core operations to the embedded runtime. */
export class CoreOperationService extends Context.Service<
  CoreOperationService,
  CoreOperationServiceShape
>()("@diffdash/CoreOperationService") {}

/** Builds the stable Core facade from cohesive internal operation capabilities. */
export const coreOperationLayer = Layer.effect(
  CoreOperationService,
  Effect.gen(function* () {
    const turns = yield* ReviewTurnStore
    const walkthroughOperationStore = yield* WalkthroughOperationStore
    const walkthroughStore = yield* WalkthroughStore
    const reviews = yield* makeReviewResolution
    const walkthroughs = yield* makeWalkthroughOperations(reviews)
    const analyticsHandlers = yield* makeAnalyticsOperationHandlers
    const applicationHandlers = yield* makeApplicationOperationHandlers
    const repositoryHandlers = yield* makeRepositoryOperationHandlers
    const reviewHandlers = yield* makeReviewOperationHandlers
    const settingsHandlers = yield* makeSettingsOperationHandlers
    const threadHandlers = yield* makeThreadOperationHandlers(reviews, walkthroughs)
    const viewedFileHandlers = yield* makeViewedFileOperationHandlers
    const handlerCapabilities = [
      analyticsHandlers,
      applicationHandlers,
      repositoryHandlers,
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
      ...reviewHandlers,
      ...settingsHandlers,
      ...threadHandlers,
      ...viewedFileHandlers,
    } satisfies OperationHandlers

    const execute: CoreOperationServiceShape["execute"] = (method, input, options = {}) => {
      const handler = handlers[method]
      // SAFETY: OperationHandlers preserves the method/input/output correlation; indexed access
      // widens that relationship before TypeScript can invoke the selected generic member.
      // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- SAFETY: The indexed handler retains the method correlation that TypeScript loses during generic lookup.
      return handler(input as never, options) as Effect.Effect<
        CoreOperationOutput<typeof method>,
        CoreOperationFailure<typeof method>
      >
    }

    return CoreOperationService.of({
      start: Effect.gen(function* () {
        yield* turns.recoverInterruptedTurns.pipe(
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
            yield* walkthroughOperationStore
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
          }
        }
        yield* walkthroughOperationStore.recoverActiveAsInterrupted.pipe(
          Effect.mapError((cause) =>
            CoreStartupError.make({
              operation: "recoverInterruptedWalkthroughOperations",
              message: "DiffDash Core could not recover interrupted walkthrough operations.",
              cause,
            }),
          ),
        )
      }),
      execute,
      walkthroughs,
    })
  }),
)
