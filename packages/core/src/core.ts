import type { ReviewAgentProgressStage } from "@diffdash/domain/review-agent"
import type { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import { InvokeChannel } from "@diffdash/protocol/channels"
import type { InvokeRequest, InvokeResponse } from "@diffdash/protocol/ipc"
import { Schema } from "effect"
import type { CoreAbsolutePath, CoreWebUrl } from "./core-configuration"

export {
  CoreAbsolutePath,
  CoreConfiguration,
  CoreWebUrl,
} from "./core-configuration"
export {
  CoreConfigurationError,
  CoreStartupError,
  type CoreStartupFailure,
} from "./core-startup-error"
export { createEmbeddedCore } from "./embedded-core"
export { RepositoryLinkError } from "./services/repository-linker"
export { ReviewContextError } from "./services/review-context"

/** Closed business-operation catalog implemented by DiffDash Core. */
export const CoreMethod = {
  analyticsCapture: "Analytics.capture",
  analyticsStart: "Analytics.start",
  agentProvidersGetCatalog: "AgentProviders.getCatalog",
  appDiagnostics: "Prerequisites.get",
  appInstallDiffDashCli: "Prerequisites.installDiffDashCli",
  appOpenLocalRepositoryFile: "FileNavigation.resolveLocalRepositoryFile",
  appOpenRepositoryComparisonFile: "FileNavigation.resolveRepositoryComparisonFile",
  appOpenRepositoryFile: "FileNavigation.resolveHostedReviewFile",
  appStateGet: "AppState.get",
  appStateUpdate: "AppState.update",
  listProviders: "GitProviders.list",
  submitHostedReviewDecision: "HostedReviews.submitDecision",
  getHostedReviewDecision: "HostedReviews.getDecision",
  listHostedReviews: "HostedReviews.list",
  listAssignedHostedReviews: "HostedReviews.listAssigned",
  listHostedRepositorySearchScopes: "GitProviders.listSearchScopes",
  searchHostedRepositories: "GitProviders.searchRepositories",
  resolveLocalBranch: "LocalReviews.resolveBranch",
  resolveRepositoryComparison: "RepositoryComparisons.resolve",
  acquireHostedReviewSnapshot: "ReviewSnapshots.acquireHosted",
  acquireLocalReviewSnapshot: "ReviewSnapshots.acquireLocal",
  acquireRepositoryComparisonSnapshot: "ReviewSnapshots.acquireRepositoryComparison",
  getReviewSnapshotPage: "ReviewSnapshots.getPage",
  searchReviewSnapshot: "ReviewSnapshots.search",
  favoriteRemoteRepository: "Repositories.favoriteRemote",
  forgetRepository: "Repositories.forget",
  installRepository: "Repositories.install",
  linkRepository: "Repositories.link",
  listRepositories: "Repositories.list",
  openProject: "Repositories.openProject",
  repairRepositoryIdentities: "Repositories.repairIdentities",
  setRepositoryFavorite: "Repositories.setFavorite",
  projectWorkspaceGet: "ProjectWorkspace.get",
  projectWorkspaceSave: "ProjectWorkspace.save",
  addReviewThreadUserMessage: "ReviewThreads.addUserMessage",
  createReviewThread: "ReviewThreads.create",
  getReviewThread: "ReviewThreads.get",
  listReviewThreads: "ReviewThreads.list",
  runReviewThreadAgent: "ReviewThreads.runAgent",
  settingsGet: "Settings.get",
  settingsUpdate: "Settings.update",
  listViewedFiles: "ViewedFiles.listHosted",
  listLocalViewedFiles: "ViewedFiles.listLocal",
  setViewedFile: "ViewedFiles.setHosted",
  setLocalViewedFile: "ViewedFiles.setLocal",
  listRepositoryComparisonViewedFiles: "ViewedFiles.listRepositoryComparison",
  setRepositoryComparisonViewedFile: "ViewedFiles.setRepositoryComparison",
} as const

/** One business operation accepted by the embedded Core boundary. */
export type CoreMethod = (typeof CoreMethod)[keyof typeof CoreMethod]

/** Protocol contracts reused while Core remains embedded behind Electron. */
export const CoreMethodChannel = {
  [CoreMethod.analyticsCapture]: InvokeChannel.analyticsCapture,
  [CoreMethod.analyticsStart]: InvokeChannel.analyticsStart,
  [CoreMethod.agentProvidersGetCatalog]: InvokeChannel.agentProvidersGetCatalog,
  [CoreMethod.appDiagnostics]: InvokeChannel.appDiagnostics,
  [CoreMethod.appInstallDiffDashCli]: InvokeChannel.appInstallDiffDashCli,
  [CoreMethod.appOpenLocalRepositoryFile]: InvokeChannel.appOpenLocalRepositoryFile,
  [CoreMethod.appOpenRepositoryComparisonFile]: InvokeChannel.appOpenRepositoryComparisonFile,
  [CoreMethod.appOpenRepositoryFile]: InvokeChannel.appOpenRepositoryFile,
  [CoreMethod.appStateGet]: InvokeChannel.appStateGet,
  [CoreMethod.appStateUpdate]: InvokeChannel.appStateUpdate,
  [CoreMethod.listProviders]: InvokeChannel.listProviders,
  [CoreMethod.submitHostedReviewDecision]: InvokeChannel.submitHostedReviewDecision,
  [CoreMethod.getHostedReviewDecision]: InvokeChannel.getHostedReviewDecision,
  [CoreMethod.listHostedReviews]: InvokeChannel.listHostedReviews,
  [CoreMethod.listAssignedHostedReviews]: InvokeChannel.listAssignedHostedReviews,
  [CoreMethod.listHostedRepositorySearchScopes]: InvokeChannel.listHostedRepositorySearchScopes,
  [CoreMethod.searchHostedRepositories]: InvokeChannel.searchHostedRepositories,
  [CoreMethod.resolveLocalBranch]: InvokeChannel.resolveLocalBranch,
  [CoreMethod.resolveRepositoryComparison]: InvokeChannel.resolveRepositoryComparison,
  [CoreMethod.acquireHostedReviewSnapshot]: InvokeChannel.acquireHostedReviewSnapshot,
  [CoreMethod.acquireLocalReviewSnapshot]: InvokeChannel.acquireLocalReviewSnapshot,
  [CoreMethod.acquireRepositoryComparisonSnapshot]:
    InvokeChannel.acquireRepositoryComparisonSnapshot,
  [CoreMethod.getReviewSnapshotPage]: InvokeChannel.getReviewSnapshotPage,
  [CoreMethod.searchReviewSnapshot]: InvokeChannel.searchReviewSnapshot,
  [CoreMethod.favoriteRemoteRepository]: InvokeChannel.favoriteRemoteRepository,
  [CoreMethod.forgetRepository]: InvokeChannel.forgetRepository,
  [CoreMethod.installRepository]: InvokeChannel.installRepository,
  [CoreMethod.linkRepository]: InvokeChannel.linkRepository,
  [CoreMethod.listRepositories]: InvokeChannel.listRepositories,
  [CoreMethod.openProject]: InvokeChannel.openProject,
  [CoreMethod.repairRepositoryIdentities]: InvokeChannel.repairRepositoryIdentities,
  [CoreMethod.setRepositoryFavorite]: InvokeChannel.setRepositoryFavorite,
  [CoreMethod.projectWorkspaceGet]: InvokeChannel.projectWorkspaceGet,
  [CoreMethod.projectWorkspaceSave]: InvokeChannel.projectWorkspaceSave,
  [CoreMethod.addReviewThreadUserMessage]: InvokeChannel.addReviewThreadUserMessage,
  [CoreMethod.createReviewThread]: InvokeChannel.createReviewThread,
  [CoreMethod.getReviewThread]: InvokeChannel.getReviewThread,
  [CoreMethod.listReviewThreads]: InvokeChannel.listReviewThreads,
  [CoreMethod.runReviewThreadAgent]: InvokeChannel.runReviewThreadAgent,
  [CoreMethod.settingsGet]: InvokeChannel.settingsGet,
  [CoreMethod.settingsUpdate]: InvokeChannel.settingsUpdate,
  [CoreMethod.listViewedFiles]: InvokeChannel.listViewedFiles,
  [CoreMethod.listLocalViewedFiles]: InvokeChannel.listLocalViewedFiles,
  [CoreMethod.setViewedFile]: InvokeChannel.setViewedFile,
  [CoreMethod.setLocalViewedFile]: InvokeChannel.setLocalViewedFile,
  [CoreMethod.listRepositoryComparisonViewedFiles]:
    InvokeChannel.listRepositoryComparisonViewedFiles,
  [CoreMethod.setRepositoryComparisonViewedFile]: InvokeChannel.setRepositoryComparisonViewedFile,
} as const satisfies Record<CoreMethod, InvokeChannel>

/** Decoded input for one Core business operation. */
export type CoreMethodInput<Method extends CoreMethod> = InvokeRequest<
  (typeof CoreMethodChannel)[Method]
>

/** Decoded output for one Core business operation. */
export type CoreMethodOutput<Method extends CoreMethod> = InvokeResponse<
  (typeof CoreMethodChannel)[Method]
>

/** Host callbacks required by operations that publish transient progress. */
export interface CoreOperationOptions {
  readonly onReviewThreadAgentProgress?: (stage: ReviewAgentProgressStage) => void
}

/** Intent returned when Electron must perform a native file-open action. */
export type CoreFileOpenIntent =
  | { readonly _tag: "local"; readonly rootPath: CoreAbsolutePath; readonly filePath: string }
  | { readonly _tag: "external"; readonly url: CoreWebUrl }

/** Result returned by one named Core operation. */
export type CoreOperationOutput<Method extends CoreMethod> = Method extends
  | typeof CoreMethod.appOpenLocalRepositoryFile
  | typeof CoreMethod.appOpenRepositoryComparisonFile
  | typeof CoreMethod.appOpenRepositoryFile
  ? CoreFileOpenIntent
  : CoreMethodOutput<Method>

/** Stable identity for one embedded walkthrough operation. */
export const WalkthroughOperationId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("WalkthroughOperationId"),
)

/** Stable identity for one embedded walkthrough operation. */
export type WalkthroughOperationId = typeof WalkthroughOperationId.Type

/** A requested embedded walkthrough operation is no longer known to this Core epoch. */
export class WalkthroughOperationNotFound extends Schema.TaggedError<WalkthroughOperationNotFound>()(
  "WalkthroughOperationNotFound",
  { operationId: WalkthroughOperationId },
) {}

/** The embedded Core already retains the maximum number of walkthrough operation records. */
export class WalkthroughOperationCapacityExceeded extends Schema.TaggedError<WalkthroughOperationCapacityExceeded>()(
  "WalkthroughOperationCapacityExceeded",
  { capacity: Schema.Number, message: Schema.String },
) {}

/** Request to start provider-neutral walkthrough generation inside Core. */
export interface StartWalkthroughOperation {
  readonly target: ReviewThreadTarget
  readonly regenerate: boolean
}

/** Promptly returned identity for accepted walkthrough work. */
export interface WalkthroughOperationAccepted {
  readonly operationId: WalkthroughOperationId
}

/** Terminal state observed through the embedded operation boundary. */
export type WalkthroughOperationResult =
  | { readonly _tag: "completed"; readonly walkthrough: StoredWalkthrough }
  | { readonly _tag: "failed"; readonly error: unknown }
  | { readonly _tag: "cancelled" }

/** Request for a stored artifact belonging to one exact review generation. */
export interface GetStoredWalkthrough {
  readonly target: ReviewThreadTarget
  readonly expectedBaseRevision: string | null
  readonly expectedHeadRevision: string | null
}

/** Durable walkthrough operation seam implemented in-process during the embedded migration. */
export interface CoreWalkthroughs {
  readonly start: (request: StartWalkthroughOperation) => Promise<WalkthroughOperationAccepted>
  readonly getOperation: (
    operationId: WalkthroughOperationId,
  ) => Promise<WalkthroughOperationResult>
  readonly cancel: (operationId: WalkthroughOperationId) => Promise<WalkthroughOperationResult>
  readonly getStored: (request: GetStoredWalkthrough) => Promise<StoredWalkthrough | null>
}

/** Lifecycle and closed operation surface exposed to a native DiffDash host. */
export interface EmbeddedCore {
  /** Acquires Core resources and completes startup recovery. */
  readonly start: () => Promise<void>

  /** Executes one named Core operation without exposing internal Effect services. */
  readonly execute: <Method extends CoreMethod>(
    method: Method,
    input: CoreMethodInput<Method>,
    options?: CoreOperationOptions,
  ) => Promise<CoreOperationOutput<Method>>

  /** Provider-neutral walkthrough operation boundary owned by Core. */
  readonly walkthroughs: CoreWalkthroughs

  /** Releases every resource owned by Core. */
  readonly dispose: () => Promise<void>
}
