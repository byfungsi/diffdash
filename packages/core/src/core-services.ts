import type { GitService } from "@diffdash/local-git/local-git"
import type { ProjectWorkspaceStore } from "@diffdash/persistence/project-workspace-store"
import type { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import type { ReviewTurnStore } from "@diffdash/persistence/review-turn-store"
import type { ViewedFileStore } from "@diffdash/persistence/viewed-file-store"
import type { WalkthroughStore } from "@diffdash/persistence/walkthrough-store"
import type { ReviewAgentService } from "@diffdash/review-agent"
import type { ReviewThreadAnchorMapper } from "@diffdash/review-agent/anchor-mapper"
import type { AppSettings } from "@diffdash/settings/app-settings"
import type { AppState } from "@diffdash/settings/app-state"
import type { WalkthroughService } from "@diffdash/walkthrough"
import type { AgentProviders } from "./services/agent-providers"
import type { Analytics } from "./services/analytics"
import type { GitProvider } from "./services/git-provider"
import type { Prerequisites } from "./services/prerequisites"
import type { RepositoryComparisonSource } from "./services/repository-comparison-source"
import type { RepositoryLinker } from "./services/repository-linker"
import type { ReviewSnapshotService } from "./services/review-snapshot"

/** Complete service context temporarily exposed to legacy desktop controllers. */
export type CoreServices =
  | AgentProviders
  | Analytics
  | AppSettings
  | AppState
  | GitProvider
  | GitService
  | Prerequisites
  | ProjectWorkspaceStore
  | RepositoryComparisonSource
  | RepositoryLinker
  | ReviewAgentService
  | ReviewSnapshotService
  | ReviewThreadAnchorMapper
  | ReviewThreadStore
  | ReviewTurnStore
  | ViewedFileStore
  | WalkthroughService
  | WalkthroughStore
