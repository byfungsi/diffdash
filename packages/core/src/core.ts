import type {
  AgentProviderOperationError,
  AgentProviderResolutionError,
  InvalidAgentProviderResponseError,
} from "@diffdash/agent-provider"
import type { NoAgentProviderAvailableError } from "@diffdash/agent-provider/registry"
import type { ReviewAgentProgressStage } from "@diffdash/domain/review-agent"
import type { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import type {
  StoredWalkthrough,
  WalkthroughPromptPreparationError,
  WalkthroughValidationError,
} from "@diffdash/domain/walkthrough"
import type { GitProviderOperationError, UnknownGitProviderError } from "@diffdash/git-provider"
import type { LocalReviewTargetError } from "@diffdash/local-git/local-git"
import type { ProjectWorkspaceStoreError } from "@diffdash/persistence/project-workspace-store"
import type { ReviewThreadStoreError } from "@diffdash/persistence/review-thread-store"
import type {
  ReviewTurnRejectedError,
  ReviewTurnStoreError,
  ReviewTurnTargetError,
} from "@diffdash/persistence/review-turn-store"
import type { ViewedFileStoreError } from "@diffdash/persistence/viewed-file-store"
import type { WalkthroughStoreError } from "@diffdash/persistence/walkthrough-store"
import type { ProcessExecutionError } from "@diffdash/process"
import { InvokeChannel } from "@diffdash/protocol/channels"
import type { InvokeRequest, InvokeResponse } from "@diffdash/protocol/ipc"
import type { TransportError } from "@diffdash/protocol/transport-error"
import type {
  ReviewAgentFinalizeError,
  ReviewAgentProviderFailureError,
  ReviewAgentServiceError,
} from "@diffdash/review-agent"
import type { AppSettingsError } from "@diffdash/settings/app-settings"
import type { AppStateError } from "@diffdash/settings/app-state"
import type {
  WalkthroughGenerationError,
  WalkthroughModelUnavailableError,
} from "@diffdash/walkthrough"
import { Schema } from "effect"
import type { CoreAbsolutePath, CoreWebUrl } from "./core-configuration"
import type { CoreStartupFailure } from "./core-startup-error"
import type { PrerequisiteInstallError } from "./services/prerequisites"
import type { RepositoryComparisonSourceError } from "./services/repository-comparison-source"
import type { RepositoryLinkError } from "./services/repository-linker"
import type { ReviewContextError } from "./services/review-context"

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
export { PrerequisiteInstallError } from "./services/prerequisites"
export { RepositoryComparisonSourceError } from "./services/repository-comparison-source"
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

/** Explicit success or expected failure returned across the embedded Core boundary. */
export type CoreResult<Value, Failure> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Failure }

/** Expected failures from selecting or invoking one hosted Git provider. */
export type CoreGitProviderFailure = UnknownGitProviderError | GitProviderOperationError

/** Expected failures while resolving one review target and its repository. */
export type CoreThreadResolutionFailure =
  | ReviewContextError
  | RepositoryLinkError
  | RepositoryComparisonSourceError

/** Expected failures while executing one review-thread agent turn. */
export type CoreReviewAgentFailure =
  | ReviewAgentServiceError
  | ReviewAgentFinalizeError
  | ReviewAgentProviderFailureError
  | ReviewTurnTargetError
  | ReviewTurnRejectedError

/** Expected provider, validation, persistence, and review failures from walkthrough generation. */
export type CoreWalkthroughFailure =
  | ReviewContextError
  | RepositoryLinkError
  | RepositoryComparisonSourceError
  | WalkthroughStoreError
  | WalkthroughPromptPreparationError
  | WalkthroughGenerationError
  | WalkthroughValidationError
  | WalkthroughModelUnavailableError
  | AgentProviderResolutionError
  | NoAgentProviderAvailableError
  | AgentProviderOperationError
  | InvalidAgentProviderResponseError

/** Exact expected failure channel for every closed Core business operation. */
export interface CoreOperationFailureMap {
  readonly [CoreMethod.analyticsCapture]: never
  readonly [CoreMethod.analyticsStart]: never
  readonly [CoreMethod.agentProvidersGetCatalog]: never
  readonly [CoreMethod.appDiagnostics]: never
  readonly [CoreMethod.appInstallDiffDashCli]: PrerequisiteInstallError
  readonly [CoreMethod.appOpenLocalRepositoryFile]: ProcessExecutionError
  readonly [CoreMethod.appOpenRepositoryComparisonFile]: CoreGitProviderFailure
  readonly [CoreMethod.appOpenRepositoryFile]: RepositoryLinkError | CoreGitProviderFailure
  readonly [CoreMethod.appStateGet]: AppStateError
  readonly [CoreMethod.appStateUpdate]: AppStateError
  readonly [CoreMethod.listProviders]: never
  readonly [CoreMethod.submitHostedReviewDecision]: CoreGitProviderFailure
  readonly [CoreMethod.getHostedReviewDecision]: CoreGitProviderFailure
  readonly [CoreMethod.listHostedReviews]: CoreGitProviderFailure
  readonly [CoreMethod.listAssignedHostedReviews]: CoreGitProviderFailure
  readonly [CoreMethod.listHostedRepositorySearchScopes]: CoreGitProviderFailure
  readonly [CoreMethod.searchHostedRepositories]: CoreGitProviderFailure
  readonly [CoreMethod.resolveLocalBranch]: ProcessExecutionError | LocalReviewTargetError
  readonly [CoreMethod.resolveRepositoryComparison]: RepositoryComparisonSourceError
  readonly [CoreMethod.acquireHostedReviewSnapshot]: RepositoryLinkError | ReviewContextError
  readonly [CoreMethod.acquireLocalReviewSnapshot]: ReviewContextError | RepositoryLinkError
  readonly [CoreMethod.acquireRepositoryComparisonSnapshot]: RepositoryComparisonSourceError
  readonly [CoreMethod.getReviewSnapshotPage]: never
  readonly [CoreMethod.searchReviewSnapshot]: never
  readonly [CoreMethod.favoriteRemoteRepository]: RepositoryLinkError
  readonly [CoreMethod.forgetRepository]: RepositoryLinkError
  readonly [CoreMethod.installRepository]: RepositoryLinkError
  readonly [CoreMethod.linkRepository]: RepositoryLinkError
  readonly [CoreMethod.listRepositories]: RepositoryLinkError
  readonly [CoreMethod.openProject]: RepositoryLinkError
  readonly [CoreMethod.repairRepositoryIdentities]: RepositoryLinkError
  readonly [CoreMethod.setRepositoryFavorite]: RepositoryLinkError
  readonly [CoreMethod.projectWorkspaceGet]: ProjectWorkspaceStoreError
  readonly [CoreMethod.projectWorkspaceSave]: ProjectWorkspaceStoreError
  readonly [CoreMethod.addReviewThreadUserMessage]: ReviewThreadStoreError
  readonly [CoreMethod.createReviewThread]:
    | CoreThreadResolutionFailure
    | TransportError
    | ReviewThreadStoreError
  readonly [CoreMethod.getReviewThread]: ReviewThreadStoreError
  readonly [CoreMethod.listReviewThreads]: CoreThreadResolutionFailure | ReviewThreadStoreError
  readonly [CoreMethod.runReviewThreadAgent]:
    | ReviewTurnTargetError
    | ReviewTurnStoreError
    | CoreThreadResolutionFailure
    | WalkthroughStoreError
    | CoreReviewAgentFailure
  readonly [CoreMethod.settingsGet]: AppSettingsError
  readonly [CoreMethod.settingsUpdate]: AppSettingsError
  readonly [CoreMethod.listViewedFiles]: RepositoryLinkError | ViewedFileStoreError
  readonly [CoreMethod.setViewedFile]: RepositoryLinkError | ViewedFileStoreError
  readonly [CoreMethod.listLocalViewedFiles]: RepositoryLinkError | ViewedFileStoreError
  readonly [CoreMethod.setLocalViewedFile]: RepositoryLinkError | ViewedFileStoreError
  readonly [CoreMethod.listRepositoryComparisonViewedFiles]:
    | RepositoryComparisonSourceError
    | ViewedFileStoreError
  readonly [CoreMethod.setRepositoryComparisonViewedFile]:
    | RepositoryComparisonSourceError
    | ViewedFileStoreError
}

/** Expected failure returned by one named Core business operation. */
export type CoreOperationFailure<Method extends CoreMethod> = CoreOperationFailureMap[Method]

/** Startup acquisition can fail before any requested Core operation executes. */
export type CoreBoundaryFailure<Failure> = CoreStartupFailure | Failure

/** Expected failures while starting the Core application lifecycle. */
export type CoreStartFailure = CoreBoundaryFailure<ReviewTurnStoreError>

/** Expected failures while loading an already-persisted walkthrough. */
export type CoreGetStoredWalkthroughFailure = CoreThreadResolutionFailure | WalkthroughStoreError

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
  | { readonly _tag: "failed"; readonly error: CoreWalkthroughFailure }
  | { readonly _tag: "defect"; readonly defect: unknown }
  | { readonly _tag: "cancelled" }

/** Request for a stored artifact belonging to one exact review generation. */
export interface GetStoredWalkthrough {
  readonly target: ReviewThreadTarget
  readonly expectedBaseRevision: string | null
  readonly expectedHeadRevision: string | null
}

/** Durable walkthrough operation seam implemented in-process during the embedded migration. */
export interface CoreWalkthroughs {
  readonly start: (
    request: StartWalkthroughOperation,
  ) => Promise<
    CoreResult<
      WalkthroughOperationAccepted,
      CoreBoundaryFailure<WalkthroughOperationCapacityExceeded>
    >
  >
  readonly getOperation: (
    operationId: WalkthroughOperationId,
  ) => Promise<
    CoreResult<WalkthroughOperationResult, CoreBoundaryFailure<WalkthroughOperationNotFound>>
  >
  readonly cancel: (
    operationId: WalkthroughOperationId,
  ) => Promise<
    CoreResult<WalkthroughOperationResult, CoreBoundaryFailure<WalkthroughOperationNotFound>>
  >
  readonly getStored: (
    request: GetStoredWalkthrough,
  ) => Promise<
    CoreResult<StoredWalkthrough | null, CoreBoundaryFailure<CoreGetStoredWalkthroughFailure>>
  >
}

/** Lifecycle and closed operation surface exposed to a native DiffDash host. */
export interface EmbeddedCore {
  /** Acquires Core resources and completes startup recovery. */
  readonly start: () => Promise<CoreResult<void, CoreStartFailure>>

  /** Executes one named Core operation without exposing internal Effect services. */
  readonly execute: <Method extends CoreMethod>(
    method: Method,
    input: CoreMethodInput<Method>,
    options?: CoreOperationOptions,
  ) => Promise<
    CoreResult<CoreOperationOutput<Method>, CoreBoundaryFailure<CoreOperationFailure<Method>>>
  >

  /** Provider-neutral walkthrough operation boundary owned by Core. */
  readonly walkthroughs: CoreWalkthroughs

  /** Releases every resource owned by Core. */
  readonly dispose: () => Promise<void>
}
