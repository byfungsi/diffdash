import type { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import {
  makeRepositoryWatcher,
  nodeRepositoryWatchSource,
  type RepositoryForceReason,
} from "@diffdash/local-git/repository-watcher"
import { RepositoryReconciler } from "@diffdash/local-git/repository-reconciliation"
import { Context, Effect, Layer, Ref } from "effect"

import { CoreEventHub } from "./core-event-hub"

/** Core-owned lifecycle for the one repository selected by the active project session. */
export class CoreRepositoryWatcher extends Context.Service<
  CoreRepositoryWatcher,
  {
    readonly activate: (
      projectId: ReviewProjectId,
      checkoutPath: RepositoryCheckoutPath,
    ) => Effect.Effect<number>
    readonly deactivate: (projectId: ReviewProjectId) => Effect.Effect<void>
    readonly hint: (projectId: ReviewProjectId) => Effect.Effect<void>
    readonly force: (
      projectId: ReviewProjectId,
      reason: RepositoryForceReason,
    ) => Effect.Effect<void>
  }
>()("@diffdash/core/CoreRepositoryWatcher") {}

/** Scoped production watcher backed by local-only Git reconciliation and Core event hints. */
export const coreRepositoryWatcherLayer = Layer.effect(
  CoreRepositoryWatcher,
  Effect.gen(function* () {
    const events = yield* CoreEventHub
    const stateVersion = yield* Ref.make(0)
    return yield* makeRepositoryWatcher({
      watchSource: nodeRepositoryWatchSource,
      publish: (invalidation) =>
        Effect.gen(function* () {
          const version = yield* Ref.updateAndGet(stateVersion, (current) => current + 1)
          yield* events.publish({
            topic: "repository.state.changed",
            schemaVersion: 1,
            scopes: [{ name: "project", id: invalidation.projectId }],
            source: "repository-watcher",
            reason: "authoritative-git-state-changed",
            subject: {
              kind: "generation",
              generationId: String(invalidation.generation),
            },
            kind: "stateChanged",
            stateVersion: version,
          })
        }),
    })
  }),
).pipe(Layer.provide(RepositoryReconciler.layer))
