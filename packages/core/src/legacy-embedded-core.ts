import { ReviewTurnStore } from "@diffdash/persistence/review-turn-store"
import { Cause, Effect, Exit, ManagedRuntime, Option } from "effect"
import type { EmbeddedCore } from "./core"
import type { CoreConfiguration } from "./core-configuration"
import { createCoreLayer } from "./core-layer"
import type { CoreServices } from "./core-services"
import { AgentProviders } from "./services/agent-providers"
import { Analytics } from "./services/analytics"
import { GitProvider } from "./services/git-provider"
import { Prerequisites } from "./services/prerequisites"
import { RepositoryComparisonSource } from "./services/repository-comparison-source"
import { RepositoryLinker, RepositoryLinkError } from "./services/repository-linker"
import { ReviewContextError } from "./services/review-context"
import { ReviewSnapshotService, ReviewSnapshotUnavailableError } from "./services/review-snapshot"
import { paginateReviewSnapshot, searchReviewSnapshot } from "./services/review-snapshot-pagination"

export {
  AgentProviders,
  Analytics,
  GitProvider,
  Prerequisites,
  RepositoryComparisonSource,
  RepositoryLinker,
  RepositoryLinkError,
  ReviewContextError,
  ReviewSnapshotService,
  ReviewSnapshotUnavailableError,
  paginateReviewSnapshot,
  searchReviewSnapshot,
}

/** Services temporarily available to Electron controllers during the Core migration. */
export type LegacyCoreServices = CoreServices

/** Embedded Core compatibility surface removed after controller operation migration. */
export interface LegacyEmbeddedCore extends EmbeddedCore {
  /** Executes an existing controller program against the closed migration service set. */
  readonly runLegacy: <A, E>(program: Effect.Effect<A, E, LegacyCoreServices>) => Promise<A>
}

/** Creates the single embedded Core runtime used during the external-Core migration. */
export const createEmbeddedCore = (configuration: CoreConfiguration): LegacyEmbeddedCore => {
  const runtime = ManagedRuntime.make(createCoreLayer(configuration))
  const runLegacy: LegacyEmbeddedCore["runLegacy"] = async (program) => {
    const exit = await runtime.runPromiseExit(program)
    if (Exit.isSuccess(exit)) return exit.value
    const failure = Cause.failureOption(exit.cause)
    if (Option.isSome(failure)) throw failure.value
    throw Cause.squash(exit.cause)
  }

  return {
    start: () =>
      runLegacy(
        Effect.flatMap(ReviewTurnStore, (turns) => turns.recoverInterruptedTurns).pipe(
          Effect.asVoid,
        ),
      ),
    dispose: () => runtime.dispose(),
    runLegacy,
  }
}
