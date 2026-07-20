import type { GitService } from "@diffdash/local-git/local-git"
import type { RepositoryStore } from "@diffdash/persistence/repository-store"
import type { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import type { ReviewTurnStore } from "@diffdash/persistence/review-turn-store"
import type { ViewedFileStore } from "@diffdash/persistence/viewed-file-store"
import type { WalkthroughStore } from "@diffdash/persistence/walkthrough-store"
import type { ProcessService } from "@diffdash/process"
import type { ReviewAgentService } from "@diffdash/review-agent"
import type { ReviewThreadAnchorMapper } from "@diffdash/review-agent/anchor-mapper"
import type { AppSettings } from "@diffdash/settings/app-settings"
import type { AppState } from "@diffdash/settings/app-state"
import type { WalkthroughService } from "@diffdash/walkthrough"
import { Cause, type Effect, Exit, ManagedRuntime, Option } from "effect"
import type { AgentProviders } from "../../src/main/services/agent-providers"
import type { Analytics } from "../../src/main/services/analytics"
import type { AppUpdater } from "../../src/main/services/app-updater"
import type { GitProvider } from "../../src/main/services/git-provider"
import type { Prerequisites } from "../../src/main/services/prerequisites"
import type { RepositoryLinker } from "../../src/main/services/repository-linker"
import type { ReviewContextService } from "../../src/main/services/review-context"
import type { ReviewSnapshotService } from "../../src/main/services/review-snapshot"
import { createAppLayer } from "./composition"

/** Services provided once to all desktop application programs. */
type ApplicationServices =
  | RepositoryStore
  | Analytics
  | RepositoryLinker
  | GitService
  | ProcessService
  | GitProvider
  | AppState
  | AppUpdater
  | AppSettings
  | Prerequisites
  | AgentProviders
  | ReviewContextService
  | ReviewSnapshotService
  | ReviewAgentService
  | ReviewThreadAnchorMapper
  | ReviewThreadStore
  | ReviewTurnStore
  | ViewedFileStore
  | WalkthroughStore
  | WalkthroughService

/** Typed boundary around the desktop application's managed Effect runtime. */
export interface ApplicationRuntime {
  readonly dispose: () => Promise<void>
  readonly runPromise: <A, E>(program: Effect.Effect<A, E, ApplicationServices>) => Promise<A>
}

/** Creates the single managed runtime owned by the Electron application lifecycle. */
export const createApplicationRuntime = (): ApplicationRuntime => {
  const runtime = ManagedRuntime.make(createAppLayer())
  return {
    dispose: () => runtime.dispose(),
    runPromise: async (program) => {
      const exit = await runtime.runPromiseExit(program)
      if (Exit.isSuccess(exit)) return exit.value
      const failure = Cause.failureOption(exit.cause)
      if (Option.isSome(failure)) throw failure.value
      throw Cause.squash(exit.cause)
    },
  }
}
