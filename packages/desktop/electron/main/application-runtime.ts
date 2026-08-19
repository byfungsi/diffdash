import {
  CoreMethod,
  type CoreMethod as CoreMethodType,
  type CoreMethodInput,
  type CoreOperationOptions,
  type CoreOperationOutput,
} from "@diffdash/core"
import type { DiffDashApi } from "@diffdash/protocol/api"
import type { ProgressiveReviewApi } from "@diffdash/protocol/review-session"
import type { WalkthroughOperationBridgeHint } from "@diffdash/protocol/walkthrough-operation-state"

type ApplicationCoreOperation<Method extends CoreMethodType> = (
  input: CoreMethodInput<Method>,
  options?: CoreOperationOptions,
) => Promise<CoreOperationOutput<Method>>

interface ApplicationCoreRuntime {
  readonly analyticsCapture: ApplicationCoreOperation<typeof CoreMethod.analyticsCapture>
  readonly analyticsStart: ApplicationCoreOperation<typeof CoreMethod.analyticsStart>
  readonly agentProvidersGetCatalog: ApplicationCoreOperation<
    typeof CoreMethod.agentProvidersGetCatalog
  >
  readonly appDiagnostics: ApplicationCoreOperation<typeof CoreMethod.appDiagnostics>
  readonly appInstallDiffDashCli: ApplicationCoreOperation<typeof CoreMethod.appInstallDiffDashCli>
  readonly appOpenLocalRepositoryFile: ApplicationCoreOperation<
    typeof CoreMethod.appOpenLocalRepositoryFile
  >
  readonly appOpenRepositoryComparisonFile: ApplicationCoreOperation<
    typeof CoreMethod.appOpenRepositoryComparisonFile
  >
  readonly appOpenRepositoryFile: ApplicationCoreOperation<typeof CoreMethod.appOpenRepositoryFile>
  readonly appStateGet: ApplicationCoreOperation<typeof CoreMethod.appStateGet>
  readonly appStateUpdate: ApplicationCoreOperation<typeof CoreMethod.appStateUpdate>
  readonly listProviders: ApplicationCoreOperation<typeof CoreMethod.listProviders>
  readonly submitHostedReviewDecision: ApplicationCoreOperation<
    typeof CoreMethod.submitHostedReviewDecision
  >
  readonly getHostedReviewDecision: ApplicationCoreOperation<
    typeof CoreMethod.getHostedReviewDecision
  >
  readonly listHostedReviews: ApplicationCoreOperation<typeof CoreMethod.listHostedReviews>
  readonly listAssignedHostedReviews: ApplicationCoreOperation<
    typeof CoreMethod.listAssignedHostedReviews
  >
  readonly listHostedRepositorySearchScopes: ApplicationCoreOperation<
    typeof CoreMethod.listHostedRepositorySearchScopes
  >
  readonly searchHostedRepositories: ApplicationCoreOperation<
    typeof CoreMethod.searchHostedRepositories
  >
  readonly resolveLocalBranch: ApplicationCoreOperation<typeof CoreMethod.resolveLocalBranch>
  readonly resolveLastCommit: ApplicationCoreOperation<typeof CoreMethod.resolveLastCommit>
  readonly resolveRepositoryComparison: ApplicationCoreOperation<
    typeof CoreMethod.resolveRepositoryComparison
  >
  readonly acquireHostedReviewSnapshot: ApplicationCoreOperation<
    typeof CoreMethod.acquireHostedReviewSnapshot
  >
  readonly acquireLocalReviewSnapshot: ApplicationCoreOperation<
    typeof CoreMethod.acquireLocalReviewSnapshot
  >
  readonly acquireRepositoryComparisonSnapshot: ApplicationCoreOperation<
    typeof CoreMethod.acquireRepositoryComparisonSnapshot
  >
  readonly favoriteRemoteRepository: ApplicationCoreOperation<
    typeof CoreMethod.favoriteRemoteRepository
  >
  readonly forgetRepository: ApplicationCoreOperation<typeof CoreMethod.forgetRepository>
  readonly installRepository: ApplicationCoreOperation<typeof CoreMethod.installRepository>
  readonly linkRepository: ApplicationCoreOperation<typeof CoreMethod.linkRepository>
  readonly listRepositories: ApplicationCoreOperation<typeof CoreMethod.listRepositories>
  readonly openProject: ApplicationCoreOperation<typeof CoreMethod.openProject>
  readonly repairRepositoryIdentities: ApplicationCoreOperation<
    typeof CoreMethod.repairRepositoryIdentities
  >
  readonly resourceDiagnostics: ApplicationCoreOperation<typeof CoreMethod.resourceDiagnostics>
  readonly clearDisposableResources: ApplicationCoreOperation<
    typeof CoreMethod.clearDisposableResources
  >
  readonly e2eReviewLifecycleDiagnostics: () => Promise<
    import("@diffdash/protocol/e2e-review-lifecycle").E2eReviewLifecycleDiagnostics
  >
  readonly e2eHoldNextReviewAcquisition: () => Promise<
    import("@diffdash/protocol/e2e-review-lifecycle").E2eReviewLifecycleHold
  >
  readonly setRepositoryFavorite: ApplicationCoreOperation<typeof CoreMethod.setRepositoryFavorite>
  readonly projectWorkspaceGet: ApplicationCoreOperation<typeof CoreMethod.projectWorkspaceGet>
  readonly projectWorkspaceSave: ApplicationCoreOperation<typeof CoreMethod.projectWorkspaceSave>
  readonly addReviewThreadUserMessage: ApplicationCoreOperation<
    typeof CoreMethod.addReviewThreadUserMessage
  >
  readonly createReviewThread: ApplicationCoreOperation<typeof CoreMethod.createReviewThread>
  readonly getReviewThread: ApplicationCoreOperation<typeof CoreMethod.getReviewThread>
  readonly listReviewThreads: ApplicationCoreOperation<typeof CoreMethod.listReviewThreads>
  readonly runReviewThreadAgent: ApplicationCoreOperation<typeof CoreMethod.runReviewThreadAgent>
  readonly settingsGet: ApplicationCoreOperation<typeof CoreMethod.settingsGet>
  readonly settingsUpdate: ApplicationCoreOperation<typeof CoreMethod.settingsUpdate>
  readonly listViewedFiles: ApplicationCoreOperation<typeof CoreMethod.listViewedFiles>
  readonly listLocalViewedFiles: ApplicationCoreOperation<typeof CoreMethod.listLocalViewedFiles>
  readonly setViewedFile: ApplicationCoreOperation<typeof CoreMethod.setViewedFile>
  readonly setLocalViewedFile: ApplicationCoreOperation<typeof CoreMethod.setLocalViewedFile>
  readonly listRepositoryComparisonViewedFiles: ApplicationCoreOperation<
    typeof CoreMethod.listRepositoryComparisonViewedFiles
  >
  readonly setRepositoryComparisonViewedFile: ApplicationCoreOperation<
    typeof CoreMethod.setRepositoryComparisonViewedFile
  >
}

/** Electron adapter that projects Core operations into schema-encoded IPC values. */
export interface ApplicationRuntime {
  readonly start: () => Promise<void>
  readonly core: ApplicationCoreRuntime
  readonly walkthroughOperations: Pick<
    DiffDashApi["walkthroughOperations"],
    "start" | "getOperation" | "cancel" | "getStored"
  > & {
    readonly replayHints: () => Promise<readonly WalkthroughOperationBridgeHint[]>
  }
  readonly progressiveReviews: ProgressiveReviewApi
  readonly dispose: () => Promise<void>
}
