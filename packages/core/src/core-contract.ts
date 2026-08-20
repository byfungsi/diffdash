import {
  AgentCapabilityUnavailableError,
  AgentPolicyEnforcementError,
  AgentProviderOperationError,
  AgentProviderProbeError,
  InvalidAgentProviderRegistrationError,
  InvalidAgentProviderResponseError,
  MissingAgentProviderError,
  UnsupportedAgentCapabilityError,
} from "@diffdash/agent-provider"
import { NoAgentProviderAvailableError } from "@diffdash/agent-provider/registry"
import type { CodeWorkspaceError } from "@diffdash/domain/code-workspace"
import type { ReviewAgentProgressStage } from "@diffdash/domain/review-agent"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewSnapshotId, type ReviewRevision } from "@diffdash/domain/review-identity"
import type {
  ReviewThreadAnchorInvalidError,
  ReviewThreadRevisionChangedError,
  ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import {
  WalkthroughOperationFailure,
  WalkthroughOperationId as DomainWalkthroughOperationId,
  type WalkthroughOperationId as WalkthroughOperationIdType,
} from "@diffdash/domain/walkthrough-operation"
import {
  StoredWalkthrough,
  WalkthroughPromptPreparationError,
  WalkthroughValidationError,
} from "@diffdash/domain/walkthrough"
import type { GitProviderOperationError, UnknownGitProviderError } from "@diffdash/git-provider"
import type { LocalReviewChangedError, LocalReviewTargetError } from "@diffdash/local-git/local-git"
import type { ProjectWorkspaceStoreError } from "@diffdash/persistence/project-workspace-store"
import type { ReviewThreadStoreError } from "@diffdash/persistence/review-thread-store"
import type {
  ReviewTurnRejectedError,
  ReviewTurnStoreError,
  ReviewTurnTargetError,
} from "@diffdash/persistence/review-turn-store"
import type { ViewedFileStoreError } from "@diffdash/persistence/viewed-file-store"
import type { WalkthroughOperationStoreError } from "@diffdash/persistence/walkthrough-operation-store"
import type { ResourceCatalogError } from "@diffdash/persistence/resource-catalog"
import { WalkthroughStoreError } from "@diffdash/persistence/walkthrough-store"
import type { ProcessExecutionError } from "@diffdash/process"
import type { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc/identity"
import { InvokeChannel } from "@diffdash/protocol/channels"
import type { InvokeRequest, InvokeResponse } from "@diffdash/protocol/ipc"
import type {
  ReviewAgentFinalizeError,
  ReviewAgentProviderFailureError,
  ReviewAgentServiceError,
} from "./services/review-agent"
import type { AppSettingsError } from "@diffdash/settings/app-settings"
import type { AppStateError } from "@diffdash/settings/app-state"
import {
  WalkthroughGenerationError,
  WalkthroughModelUnavailableError,
} from "@diffdash/agents/walkthrough"
import { Schema } from "effect"
import { CoreAbsolutePath, CoreWebUrl } from "./core-configuration"
import * as CoreDefectBoundary from "./core-defect-boundary"
import type { PrerequisiteInstallError } from "./services/prerequisites"
import { RepositoryComparisonSourceError } from "./services/repository-comparison-source"
import { RepositoryLinkError } from "./services/repository-linker"
import { ReviewContextError } from "./services/git-provider"

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
  resolveLastCommit: "LocalReviews.resolveLastCommit",
  resolveRepositoryComparison: "RepositoryComparisons.resolve",
  acquireHostedReviewSnapshot: "ReviewSnapshots.acquireHosted",
  acquireLocalReviewSnapshot: "ReviewSnapshots.acquireLocal",
  acquireRepositoryComparisonSnapshot: "ReviewSnapshots.acquireRepositoryComparison",
  favoriteRemoteRepository: "Repositories.favoriteRemote",
  forgetRepository: "Repositories.forget",
  installRepository: "Repositories.install",
  linkRepository: "Repositories.link",
  openCodeWorkspace: "CodeWorkspace.open",
  heartbeatCodeWorkspace: "CodeWorkspace.heartbeat",
  releaseCodeWorkspace: "CodeWorkspace.release",
  listCodeWorkspaceDirectory: "CodeWorkspace.listDirectory",
  searchCodeWorkspace: "CodeWorkspace.search",
  readCodeWorkspaceFile: "CodeWorkspace.readFile",
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
  resourceDiagnostics: "Resources.diagnostics",
  clearDisposableResources: "Resources.clearDisposable",
  listViewedFiles: "ViewedFiles.listHosted",
  listLocalViewedFiles: "ViewedFiles.listLocal",
  setViewedFile: "ViewedFiles.setHosted",
  setLocalViewedFile: "ViewedFiles.setLocal",
  listRepositoryComparisonViewedFiles: "ViewedFiles.listRepositoryComparison",
  setRepositoryComparisonViewedFile: "ViewedFiles.setRepositoryComparison",
} as const

/** One business operation accepted by the Core RPC boundary. */
export type CoreMethod = (typeof CoreMethod)[keyof typeof CoreMethod]

/** Protocol contracts mapped onto the named external Core operation boundary. */
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
  [CoreMethod.resolveLastCommit]: InvokeChannel.resolveLastCommit,
  [CoreMethod.resolveRepositoryComparison]: InvokeChannel.resolveRepositoryComparison,
  [CoreMethod.acquireHostedReviewSnapshot]: InvokeChannel.acquireHostedReviewSnapshot,
  [CoreMethod.acquireLocalReviewSnapshot]: InvokeChannel.acquireLocalReviewSnapshot,
  [CoreMethod.acquireRepositoryComparisonSnapshot]:
    InvokeChannel.acquireRepositoryComparisonSnapshot,
  [CoreMethod.favoriteRemoteRepository]: InvokeChannel.favoriteRemoteRepository,
  [CoreMethod.forgetRepository]: InvokeChannel.forgetRepository,
  [CoreMethod.installRepository]: InvokeChannel.installRepository,
  [CoreMethod.linkRepository]: InvokeChannel.linkRepository,
  [CoreMethod.openCodeWorkspace]: InvokeChannel.openCodeWorkspace,
  [CoreMethod.heartbeatCodeWorkspace]: InvokeChannel.heartbeatCodeWorkspace,
  [CoreMethod.releaseCodeWorkspace]: InvokeChannel.releaseCodeWorkspace,
  [CoreMethod.listCodeWorkspaceDirectory]: InvokeChannel.listCodeWorkspaceDirectory,
  [CoreMethod.searchCodeWorkspace]: InvokeChannel.searchCodeWorkspace,
  [CoreMethod.readCodeWorkspaceFile]: InvokeChannel.readCodeWorkspaceFile,
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
  [CoreMethod.resourceDiagnostics]: InvokeChannel.resourceDiagnostics,
  [CoreMethod.clearDisposableResources]: InvokeChannel.clearDisposableResources,
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
  readonly applicationInstanceId?: ApplicationInstanceId
  readonly processEpoch?: CoreProcessEpoch
  readonly onReviewThreadAgentProgress?: (stage: ReviewAgentProgressStage) => void
}

/** Native file-open intent for a path contained by one local repository. */
export class CoreLocalFileOpenIntent extends Schema.TaggedClass<CoreLocalFileOpenIntent>()(
  "local",
  {
    rootPath: CoreAbsolutePath,
    filePath: RepositoryRelativePath,
  },
) {}

/** Native file-open intent for a provider-owned HTTP or HTTPS URL. */
export class CoreExternalFileOpenIntent extends Schema.TaggedClass<CoreExternalFileOpenIntent>()(
  "external",
  { url: CoreWebUrl },
) {}

/** Intent returned when Electron must perform a native file-open action. */
export const CoreFileOpenIntent = Schema.Union([
  CoreLocalFileOpenIntent,
  CoreExternalFileOpenIntent,
])

/** Intent returned when Electron must perform a native file-open action. */
export type CoreFileOpenIntent = typeof CoreFileOpenIntent.Type

/** Result returned by one named Core operation. */
export type CoreOperationOutput<Method extends CoreMethod> = Method extends
  | typeof CoreMethod.appOpenLocalRepositoryFile
  | typeof CoreMethod.appOpenRepositoryComparisonFile
  | typeof CoreMethod.appOpenRepositoryFile
  ? CoreFileOpenIntent
  : CoreMethodOutput<Method>

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
export const CoreWalkthroughFailure = Schema.Union([
  ReviewContextError,
  RepositoryLinkError,
  RepositoryComparisonSourceError,
  WalkthroughStoreError,
  WalkthroughPromptPreparationError,
  WalkthroughGenerationError,
  WalkthroughValidationError,
  WalkthroughModelUnavailableError,
  MissingAgentProviderError,
  UnsupportedAgentCapabilityError,
  AgentCapabilityUnavailableError,
  AgentPolicyEnforcementError,
  AgentProviderProbeError,
  InvalidAgentProviderRegistrationError,
  NoAgentProviderAvailableError,
  AgentProviderOperationError,
  InvalidAgentProviderResponseError,
])

/** Expected provider, validation, persistence, and review failures from walkthrough generation. */
export type CoreWalkthroughFailure = typeof CoreWalkthroughFailure.Type

/** Exact expected failure channel for every closed Core business operation. */
export interface CoreOperationFailureMap {
  readonly [CoreMethod.analyticsCapture]: never
  readonly [CoreMethod.analyticsStart]: never
  readonly [CoreMethod.agentProvidersGetCatalog]: never
  readonly [CoreMethod.appDiagnostics]: never
  readonly [CoreMethod.appInstallDiffDashCli]: PrerequisiteInstallError
  readonly [CoreMethod.appOpenLocalRepositoryFile]:
    | LocalReviewChangedError
    | LocalReviewTargetError
    | ProcessExecutionError
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
  readonly [CoreMethod.resolveLastCommit]: ProcessExecutionError | LocalReviewTargetError
  readonly [CoreMethod.resolveRepositoryComparison]:
    | LocalReviewTargetError
    | ProcessExecutionError
    | RepositoryComparisonSourceError
    | RepositoryLinkError
  readonly [CoreMethod.acquireHostedReviewSnapshot]: RepositoryLinkError | ReviewContextError
  readonly [CoreMethod.acquireLocalReviewSnapshot]: ReviewContextError | RepositoryLinkError
  readonly [CoreMethod.acquireRepositoryComparisonSnapshot]: RepositoryComparisonSourceError
  readonly [CoreMethod.favoriteRemoteRepository]: RepositoryLinkError
  readonly [CoreMethod.forgetRepository]: RepositoryLinkError
  readonly [CoreMethod.installRepository]: RepositoryLinkError
  readonly [CoreMethod.linkRepository]: RepositoryLinkError
  readonly [CoreMethod.openCodeWorkspace]: CodeWorkspaceError
  readonly [CoreMethod.heartbeatCodeWorkspace]: CodeWorkspaceError
  readonly [CoreMethod.releaseCodeWorkspace]: CodeWorkspaceError
  readonly [CoreMethod.listCodeWorkspaceDirectory]: CodeWorkspaceError
  readonly [CoreMethod.searchCodeWorkspace]: CodeWorkspaceError
  readonly [CoreMethod.readCodeWorkspaceFile]: CodeWorkspaceError
  readonly [CoreMethod.listRepositories]: RepositoryLinkError
  readonly [CoreMethod.openProject]: RepositoryLinkError
  readonly [CoreMethod.repairRepositoryIdentities]: RepositoryLinkError
  readonly [CoreMethod.setRepositoryFavorite]: RepositoryLinkError
  readonly [CoreMethod.projectWorkspaceGet]: ProjectWorkspaceStoreError
  readonly [CoreMethod.projectWorkspaceSave]: ProjectWorkspaceStoreError
  readonly [CoreMethod.addReviewThreadUserMessage]: ReviewThreadStoreError
  readonly [CoreMethod.createReviewThread]:
    | CoreThreadResolutionFailure
    | ReviewThreadAnchorInvalidError
    | ReviewThreadRevisionChangedError
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
  readonly [CoreMethod.resourceDiagnostics]: ResourceCatalogError
  readonly [CoreMethod.clearDisposableResources]: ResourceCatalogError
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

/** Expected failures while loading an already-persisted walkthrough. */
export type CoreGetStoredWalkthroughFailure = CoreThreadResolutionFailure | WalkthroughStoreError

/** Stable identity shared by durable storage and the Core RPC boundary. */
export const WalkthroughOperationId = DomainWalkthroughOperationId

/** Stable identity shared by durable storage and the Core RPC boundary. */
export type WalkthroughOperationId = WalkthroughOperationIdType

/** A requested embedded walkthrough operation is no longer known to this Core epoch. */
export class WalkthroughOperationNotFound extends Schema.TaggedError<WalkthroughOperationNotFound>()(
  "WalkthroughOperationNotFound",
  { operationId: WalkthroughOperationId },
) {}

/** Active durable state could not be reconciled with a worker in this Core epoch. */
export class WalkthroughOperationStateUnavailable extends Schema.TaggedError<WalkthroughOperationStateUnavailable>()(
  "WalkthroughOperationStateUnavailable",
  { operationId: WalkthroughOperationId },
) {}

/** A completed operation references a walkthrough artifact that cannot be loaded. */
export class WalkthroughOperationArtifactUnavailable extends Schema.TaggedError<WalkthroughOperationArtifactUnavailable>()(
  "WalkthroughOperationArtifactUnavailable",
  { operationId: WalkthroughOperationId },
) {}

/** Privacy-safe terminal failure reconstructed from authoritative durable state. */
export class WalkthroughOperationTerminalFailure extends Schema.TaggedError<WalkthroughOperationTerminalFailure>()(
  "WalkthroughOperationTerminalFailure",
  {
    operationId: WalkthroughOperationId,
    failure: WalkthroughOperationFailure,
  },
) {}

/** Request to start provider-neutral walkthrough generation inside Core. */
export interface StartWalkthroughOperation {
  readonly target: ReviewThreadTarget
  readonly regenerate: boolean
}

/** Requested immutable walkthrough generation is unavailable or no longer matches its snapshot. */
export class WalkthroughReviewGenerationChangedError extends Schema.TaggedError<WalkthroughReviewGenerationChangedError>()(
  "WalkthroughReviewGenerationChangedError",
  {
    snapshotId: ReviewSnapshotId,
    reason: Schema.Literals(["unavailable", "mismatched"]),
  },
) {}

/** Hosted review target constructor accepted by the Core walkthrough boundary. */
export const CoreHostedReviewTarget = HostedReviewTarget

/** Promptly returned identity for accepted walkthrough work. */
export interface WalkthroughOperationAccepted {
  readonly operationId: WalkthroughOperationId
}

/** Completed walkthrough operation carrying its stored artifact. */
export class WalkthroughOperationCompleted extends Schema.TaggedClass<WalkthroughOperationCompleted>()(
  "completed",
  { walkthrough: StoredWalkthrough },
) {}

/** Walkthrough operation that ended with one expected typed failure. */
export class WalkthroughOperationFailed extends Schema.TaggedClass<WalkthroughOperationFailed>()(
  "failed",
  { error: Schema.Union([CoreWalkthroughFailure, WalkthroughOperationTerminalFailure]) },
) {}

/** Walkthrough operation cancelled before producing a stored artifact. */
export class WalkthroughOperationCancelled extends Schema.TaggedClass<WalkthroughOperationCancelled>()(
  "cancelled",
  {},
) {}

/** Walkthrough operation replaced by explicit regeneration of the same exact generation. */
export class WalkthroughOperationSuperseded extends Schema.TaggedClass<WalkthroughOperationSuperseded>()(
  "superseded",
  { supersededByOperationId: WalkthroughOperationId },
) {}

/** Walkthrough operation left active by a previous Core epoch and recovered without restart. */
export class WalkthroughOperationInterrupted extends Schema.TaggedClass<WalkthroughOperationInterrupted>()(
  "interrupted",
  {},
) {}

/** Bounded, serializable details retained when a walkthrough reaches a defect terminal state. */
export const CoreDefectSummary = CoreDefectBoundary.CoreDefectSummary
export type CoreDefectSummary = CoreDefectBoundary.CoreDefectSummary

/** Walkthrough operation that ended because of an unexpected defect. */
export class WalkthroughOperationDefect extends Schema.TaggedClass<WalkthroughOperationDefect>()(
  "defect",
  { defect: CoreDefectSummary },
) {}

/** Terminal state observed through the embedded operation boundary. */
export const WalkthroughOperationResult = Schema.Union([
  WalkthroughOperationCompleted,
  WalkthroughOperationFailed,
  WalkthroughOperationCancelled,
  WalkthroughOperationSuperseded,
  WalkthroughOperationInterrupted,
  WalkthroughOperationDefect,
])

/** Terminal state observed through the embedded operation boundary. */
export type WalkthroughOperationResult = typeof WalkthroughOperationResult.Type

/** Request for a stored artifact belonging to one exact review generation. */
export interface GetStoredWalkthrough {
  readonly target: ReviewThreadTarget
  readonly expectedBaseRevision: ReviewRevision | null
  readonly expectedHeadRevision: ReviewRevision | null
}

/** Expected failures while resolving and durably accepting walkthrough work. */
export type CoreWalkthroughStartFailure =
  | CoreThreadResolutionFailure
  | WalkthroughReviewGenerationChangedError
  | WalkthroughOperationStoreError

/** Expected failures while reading, cancelling, or materializing durable walkthrough work. */
export type CoreWalkthroughOperationFailure =
  | WalkthroughOperationNotFound
  | WalkthroughOperationStoreError
  | WalkthroughStoreError
  | WalkthroughOperationStateUnavailable
  | WalkthroughOperationArtifactUnavailable
