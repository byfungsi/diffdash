import type { GitService } from "@diffdash/local-git/local-git"
import type { RepositoryStore } from "@diffdash/persistence/repository-store"
import type { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import type { ViewedFileStore } from "@diffdash/persistence/viewed-file-store"
import type { WalkthroughStore } from "@diffdash/persistence/walkthrough-store"
import type { CliService } from "@diffdash/process/cli"
import type { AppSettings } from "@diffdash/settings/app-settings"
import type { AppState } from "@diffdash/settings/app-state"
import type { WalkthroughService } from "@diffdash/walkthrough"
import { type Effect, ManagedRuntime } from "effect"
import type { AgentProviders } from "../../src/main/services/agent-providers"
import type { Analytics } from "../../src/main/services/analytics"
import type { AppUpdater } from "../../src/main/services/app-updater"
import type { GitProvider } from "../../src/main/services/git-provider"
import type { Prerequisites } from "../../src/main/services/prerequisites"
import type { RepositoryLinker } from "../../src/main/services/repository-linker"
import type { ReviewAgentService } from "../../src/main/services/review-agent"
import type { ReviewContextService } from "../../src/main/services/review-context"
import type { ReviewThreadAnchorMapper } from "../../src/main/services/review-thread-anchor-mapper"
import { createAppLayer } from "./composition"

/** Services provided once to all desktop application programs. */
export type ApplicationServices =
  | RepositoryStore
  | Analytics
  | RepositoryLinker
  | GitService
  | CliService
  | GitProvider
  | AppState
  | AppUpdater
  | AppSettings
  | Prerequisites
  | AgentProviders
  | ReviewContextService
  | ReviewAgentService
  | ReviewThreadAnchorMapper
  | ReviewThreadStore
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
    runPromise: (program) => runtime.runPromise(program),
  }
}
