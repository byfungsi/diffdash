import { AISettings } from "@diffdash/domain/ai-settings"
import { AppState } from "@diffdash/domain/app-state"
import {
  GitProviderDescriptor,
  HostedRepository,
  HostedRepositoryLocator,
  HostedReviewSummary,
  ReviewDecision,
} from "@diffdash/domain/git-provider"
import { LocalReviewTarget } from "@diffdash/domain/local-review"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import {
  ProjectOpenResult,
  ProjectWorkspaceState,
  ProjectWorkspaceStateInput,
} from "@diffdash/domain/project-workspace"
import {
  Repo,
  RepositoryCheckoutPath,
  RepositoryIdentityRepairSummary,
  RepositorySearchScope,
} from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewAgentProgress } from "@diffdash/domain/review-agent"
import {
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
  RepositoryComparisonSnapshotManifest,
} from "@diffdash/domain/review-context"
import {
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { WebUrl } from "@diffdash/domain/web-url"
import { Schema, SchemaTransformation } from "effect"
import { AgentProviderCatalog } from "./agent-providers"
import { AnalyticsEvent } from "./analytics"
import { AppUpdateState } from "./app-update"
import { EventChannel, InvokeChannel } from "./channels"
import { E2eReviewLifecycleDiagnostics, E2eReviewLifecycleHold } from "./e2e-review-lifecycle"
import { CliNavigationCommand, NAVIGATION_COMMAND_DRAIN_LIMIT } from "./cli-navigation"
import {
  HostedProviderRequest,
  HostedRepositoryRequest,
  HostedRepositorySearchRequest,
  HostedReviewRequest,
  OpenHostedReviewFileRequest,
  SubmitHostedReviewDecisionRequest,
} from "./hosted-git"
import { assertJsonPayloadWithinBudget, jsonSafeUtf8ByteLength } from "./payload-budget"
import { AppPrerequisites, DiffDashCliInstallResult } from "./prerequisites"
import { LinkRepositoryCheckoutRequest } from "./repository-link"
import { ClearDisposableResourcesResult, ResourceDiagnostics } from "./resource-diagnostics"
import {
  AcquireHostedReviewSnapshotRequest,
  AcquireLocalReviewSnapshotRequest,
  AcquireRepositoryComparisonSnapshotRequest,
  OpenRepositoryComparisonFileRequest,
  ResolvedRepositoryComparison,
  ResolveRepositoryComparisonRequest,
} from "./review-snapshot"
import {
  CloseReviewSessionRequest,
  CurrentReviewSessionRequest,
  OpenReviewSessionRequest,
  ResolvedReviewSessionTarget,
  ReviewSessionInventoryPage,
  ReviewSessionInventoryRequest,
  ReviewSessionRange,
  ReviewSessionRangeRequest,
  ReviewSessionSearchPublication,
  ReviewSessionSearchRequest,
  ReviewSessionState,
  ReviewSessionTargetRequest,
} from "./review-session"
import {
  AddReviewThreadUserMessageRequest,
  CreateReviewThreadRequest,
  ReviewThreadIdRequest,
  RunReviewThreadAgentRequest,
} from "./review-threads"
import { TransportErrorPayload, transportError, type TransportError } from "./transport-error"
import {
  WalkthroughBridgeStartRequest,
  WalkthroughStartBridgeResult,
} from "./walkthrough-operation"
import {
  WalkthroughBridgeGetStoredRequest,
  WalkthroughBridgeOperationRequest,
  WalkthroughCancelBridgeResult,
  WalkthroughGetOperationBridgeResult,
  WalkthroughGetStoredBridgeResult,
  WalkthroughOperationBridgeHint,
} from "./walkthrough-operation-state"
import {
  HostedViewedFilesRequest,
  LocalViewedFilesRequest,
  RepositoryComparisonViewedFilesRequest,
  SetHostedViewedFileRequest,
  SetLocalViewedFileRequest,
  SetRepositoryComparisonViewedFileRequest,
  ViewedFileRecord,
} from "./viewed-files"

const EmptyRequest = Schema.Struct({})
const EmptyResponse = Schema.Null.pipe(
  Schema.decodeTo(
    Schema.Void,
    SchemaTransformation.transform({
      decode: (): void => undefined,
      encode: (_value: void) => null,
    }),
  ),
)
/** Serializable failure envelope returned for every invoke operation. */
export const FailureEnvelope = Schema.TaggedStruct("Failure", {
  error: TransportErrorPayload,
})
/** Successful value envelope returned for every invoke operation. */
export type SuccessEnvelope<Value> = {
  readonly _tag: "Success"
  readonly value: Value
}

/** Typed success or failure value crossing the Electron bridge. */
export type BridgeResult<Value> = SuccessEnvelope<Value> | typeof FailureEnvelope.Type

const BOUNDED_FAILURE_ENVELOPE = Schema.encodeSync(FailureEnvelope)({
  _tag: "Failure",
  error: transportError("PAYLOAD_TOO_LARGE", "IPC response exceeded its byte limit."),
})
/** Smallest response budget accepted by a protocol invoke contract. */
export const MINIMUM_FAILURE_ENVELOPE_BYTES = jsonSafeUtf8ByteLength(BOUNDED_FAILURE_ENVELOPE)
const NullableString = Schema.NullOr(Schema.String)
const KIB = 1_024
const DEFAULT_MAX_REQUEST_BYTES = 256 * KIB
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1_024 * KIB
const DEFAULT_MAX_EVENT_PAYLOAD_BYTES = 256 * KIB
type BoundaryValue = Schema.Json | object | undefined | void
type BoundarySchema = Schema.ConstraintCodec<BoundaryValue, BoundaryValue>

const defineInvoke = <
  Channel extends InvokeChannel,
  Request extends BoundarySchema,
  Response extends BoundarySchema,
>(
  channel: Channel,
  request: Request,
  response: Response,
  limits: {
    readonly maxRequestBytes?: number
    readonly maxResponseBytes?: number
  } = {},
) => {
  const maxRequestBytes = positiveSafeInteger(
    limits.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    `${channel}.maxRequestBytes`,
  )
  const maxResponseBytes = positiveSafeInteger(
    limits.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    `${channel}.maxResponseBytes`,
  )
  if (maxResponseBytes < MINIMUM_FAILURE_ENVELOPE_BYTES) {
    throw new Error(
      `${channel}.maxResponseBytes must fit the bounded failure envelope (${MINIMUM_FAILURE_ENVELOPE_BYTES} bytes)`,
    )
  }
  return { channel, request, response, maxRequestBytes, maxResponseBytes }
}

/** Complete schema registry for renderer-to-host request/response operations. */
export const InvokeContract = {
  [InvokeChannel.analyticsCapture]: defineInvoke(
    InvokeChannel.analyticsCapture,
    Schema.Struct({ event: AnalyticsEvent }),
    EmptyResponse,
  ),
  [InvokeChannel.analyticsStart]: defineInvoke(
    InvokeChannel.analyticsStart,
    EmptyRequest,
    EmptyResponse,
  ),
  [InvokeChannel.e2eReviewLifecycleDiagnostics]: defineInvoke(
    InvokeChannel.e2eReviewLifecycleDiagnostics,
    EmptyRequest,
    E2eReviewLifecycleDiagnostics,
    { maxResponseBytes: 16 * KIB },
  ),
  [InvokeChannel.e2eHoldNextReviewAcquisition]: defineInvoke(
    InvokeChannel.e2eHoldNextReviewAcquisition,
    EmptyRequest,
    E2eReviewLifecycleHold,
  ),
  [InvokeChannel.agentProvidersGetCatalog]: defineInvoke(
    InvokeChannel.agentProvidersGetCatalog,
    EmptyRequest,
    AgentProviderCatalog,
  ),
  [InvokeChannel.appDiagnostics]: defineInvoke(
    InvokeChannel.appDiagnostics,
    EmptyRequest,
    AppPrerequisites,
  ),
  [InvokeChannel.appInstallDiffDashCli]: defineInvoke(
    InvokeChannel.appInstallDiffDashCli,
    EmptyRequest,
    DiffDashCliInstallResult,
  ),
  [InvokeChannel.appActivateWindow]: defineInvoke(
    InvokeChannel.appActivateWindow,
    EmptyRequest,
    EmptyResponse,
  ),
  [InvokeChannel.appOpenExternalUrl]: defineInvoke(
    InvokeChannel.appOpenExternalUrl,
    Schema.Struct({ url: WebUrl }),
    EmptyResponse,
  ),
  [InvokeChannel.appOpenLocalRepositoryFile]: defineInvoke(
    InvokeChannel.appOpenLocalRepositoryFile,
    Schema.Struct({ rootPath: RepositoryCheckoutPath, filePath: RepositoryRelativePath }),
    EmptyResponse,
  ),
  [InvokeChannel.appOpenRepositoryFile]: defineInvoke(
    InvokeChannel.appOpenRepositoryFile,
    OpenHostedReviewFileRequest,
    EmptyResponse,
  ),
  [InvokeChannel.appOpenRepositoryComparisonFile]: defineInvoke(
    InvokeChannel.appOpenRepositoryComparisonFile,
    OpenRepositoryComparisonFileRequest,
    EmptyResponse,
  ),
  [InvokeChannel.appStateGet]: defineInvoke(InvokeChannel.appStateGet, EmptyRequest, AppState),
  [InvokeChannel.appStateUpdate]: defineInvoke(
    InvokeChannel.appStateUpdate,
    Schema.Struct({ state: AppState }),
    AppState,
  ),
  [InvokeChannel.listProviders]: defineInvoke(
    InvokeChannel.listProviders,
    EmptyRequest,
    Schema.Array(GitProviderDescriptor),
  ),
  [InvokeChannel.submitHostedReviewDecision]: defineInvoke(
    InvokeChannel.submitHostedReviewDecision,
    SubmitHostedReviewDecisionRequest,
    EmptyResponse,
  ),
  [InvokeChannel.getHostedReviewDecision]: defineInvoke(
    InvokeChannel.getHostedReviewDecision,
    HostedReviewRequest,
    ReviewDecision,
  ),
  [InvokeChannel.listHostedReviews]: defineInvoke(
    InvokeChannel.listHostedReviews,
    HostedRepositoryRequest,
    Schema.Array(HostedReviewSummary),
  ),
  [InvokeChannel.listAssignedHostedReviews]: defineInvoke(
    InvokeChannel.listAssignedHostedReviews,
    HostedProviderRequest,
    Schema.Array(HostedReviewSummary),
  ),
  [InvokeChannel.listHostedRepositorySearchScopes]: defineInvoke(
    InvokeChannel.listHostedRepositorySearchScopes,
    HostedProviderRequest,
    Schema.Array(RepositorySearchScope),
  ),
  [InvokeChannel.searchHostedRepositories]: defineInvoke(
    InvokeChannel.searchHostedRepositories,
    HostedRepositorySearchRequest,
    Schema.Array(HostedRepository),
  ),
  [InvokeChannel.resolveLocalBranch]: defineInvoke(
    InvokeChannel.resolveLocalBranch,
    Schema.Struct({
      localPath: RepositoryCheckoutPath,
      branchName: Schema.NullOr(RepositoryComparisonRef),
    }),
    LocalReviewTarget,
  ),
  [InvokeChannel.resolveLastCommit]: defineInvoke(
    InvokeChannel.resolveLastCommit,
    Schema.Struct({ localPath: RepositoryCheckoutPath }),
    LocalReviewTarget,
  ),
  [InvokeChannel.resolveRepositoryComparison]: defineInvoke(
    InvokeChannel.resolveRepositoryComparison,
    ResolveRepositoryComparisonRequest,
    ResolvedRepositoryComparison,
    { maxRequestBytes: 64 * KIB, maxResponseBytes: 64 * KIB },
  ),
  [InvokeChannel.acquireHostedReviewSnapshot]: defineInvoke(
    InvokeChannel.acquireHostedReviewSnapshot,
    AcquireHostedReviewSnapshotRequest,
    HostedReviewSnapshotManifest,
    { maxRequestBytes: 64 * KIB, maxResponseBytes: 8 * 1_024 * KIB },
  ),
  [InvokeChannel.acquireLocalReviewSnapshot]: defineInvoke(
    InvokeChannel.acquireLocalReviewSnapshot,
    AcquireLocalReviewSnapshotRequest,
    LocalReviewSnapshotManifest,
    { maxRequestBytes: 64 * KIB, maxResponseBytes: 8 * 1_024 * KIB },
  ),
  [InvokeChannel.acquireRepositoryComparisonSnapshot]: defineInvoke(
    InvokeChannel.acquireRepositoryComparisonSnapshot,
    AcquireRepositoryComparisonSnapshotRequest,
    RepositoryComparisonSnapshotManifest,
    { maxRequestBytes: 64 * KIB, maxResponseBytes: 8 * 1_024 * KIB },
  ),
  [InvokeChannel.openProgressiveReviewSession]: defineInvoke(
    InvokeChannel.openProgressiveReviewSession,
    OpenReviewSessionRequest,
    ReviewSessionState,
    { maxRequestBytes: 8 * KIB, maxResponseBytes: 8 * KIB },
  ),
  [InvokeChannel.getProgressiveReviewSession]: defineInvoke(
    InvokeChannel.getProgressiveReviewSession,
    CurrentReviewSessionRequest,
    ReviewSessionState,
    { maxRequestBytes: 8 * KIB, maxResponseBytes: 8 * KIB },
  ),
  [InvokeChannel.closeProgressiveReviewSession]: defineInvoke(
    InvokeChannel.closeProgressiveReviewSession,
    CloseReviewSessionRequest,
    ReviewSessionState,
    { maxRequestBytes: 8 * KIB, maxResponseBytes: 8 * KIB },
  ),
  [InvokeChannel.getProgressiveReviewInventory]: defineInvoke(
    InvokeChannel.getProgressiveReviewInventory,
    ReviewSessionInventoryRequest,
    ReviewSessionInventoryPage,
    { maxRequestBytes: 8 * KIB, maxResponseBytes: 128 * KIB },
  ),
  [InvokeChannel.readProgressiveReviewRange]: defineInvoke(
    InvokeChannel.readProgressiveReviewRange,
    ReviewSessionRangeRequest,
    ReviewSessionRange,
    { maxRequestBytes: 8 * KIB, maxResponseBytes: 384 * KIB },
  ),
  [InvokeChannel.waitForProgressiveReviewRange]: defineInvoke(
    InvokeChannel.waitForProgressiveReviewRange,
    ReviewSessionRangeRequest,
    ReviewSessionRange,
    { maxRequestBytes: 8 * KIB, maxResponseBytes: 384 * KIB },
  ),
  [InvokeChannel.resolveProgressiveReviewTarget]: defineInvoke(
    InvokeChannel.resolveProgressiveReviewTarget,
    ReviewSessionTargetRequest,
    ResolvedReviewSessionTarget,
    { maxRequestBytes: 8 * KIB, maxResponseBytes: 16 * KIB },
  ),
  [InvokeChannel.searchProgressiveReview]: defineInvoke(
    InvokeChannel.searchProgressiveReview,
    ReviewSessionSearchRequest,
    Schema.Array(ReviewSessionSearchPublication).pipe(Schema.check(Schema.isMaxLength(256))),
    { maxRequestBytes: 16 * KIB, maxResponseBytes: 384 * KIB },
  ),
  [InvokeChannel.startWalkthroughOperation]: defineInvoke(
    InvokeChannel.startWalkthroughOperation,
    WalkthroughBridgeStartRequest,
    WalkthroughStartBridgeResult,
    { maxRequestBytes: 8 * KIB, maxResponseBytes: 64 * KIB },
  ),
  [InvokeChannel.getWalkthroughOperation]: defineInvoke(
    InvokeChannel.getWalkthroughOperation,
    WalkthroughBridgeOperationRequest,
    WalkthroughGetOperationBridgeResult,
    { maxRequestBytes: 2 * KIB, maxResponseBytes: 384 * KIB },
  ),
  [InvokeChannel.cancelWalkthroughOperation]: defineInvoke(
    InvokeChannel.cancelWalkthroughOperation,
    WalkthroughBridgeOperationRequest,
    WalkthroughCancelBridgeResult,
    { maxRequestBytes: 2 * KIB, maxResponseBytes: 384 * KIB },
  ),
  [InvokeChannel.getStoredWalkthrough]: defineInvoke(
    InvokeChannel.getStoredWalkthrough,
    WalkthroughBridgeGetStoredRequest,
    WalkthroughGetStoredBridgeResult,
    { maxRequestBytes: 8 * KIB, maxResponseBytes: 384 * KIB },
  ),
  [InvokeChannel.drainNavigationCommands]: defineInvoke(
    InvokeChannel.drainNavigationCommands,
    EmptyRequest,
    Schema.Array(CliNavigationCommand).pipe(
      Schema.check(Schema.isMaxLength(NAVIGATION_COMMAND_DRAIN_LIMIT)),
    ),
  ),
  [InvokeChannel.favoriteRemoteRepository]: defineInvoke(
    InvokeChannel.favoriteRemoteRepository,
    Schema.Struct({ repository: HostedRepository }),
    Repo,
  ),
  [InvokeChannel.forgetRepository]: defineInvoke(
    InvokeChannel.forgetRepository,
    Schema.Struct({ projectId: ReviewProjectId }),
    Repo,
  ),
  [InvokeChannel.installRepository]: defineInvoke(
    InvokeChannel.installRepository,
    Schema.Struct({ localPath: RepositoryCheckoutPath }),
    Repo,
  ),
  [InvokeChannel.linkRepository]: defineInvoke(
    InvokeChannel.linkRepository,
    LinkRepositoryCheckoutRequest,
    Repo,
  ),
  [InvokeChannel.listRepositories]: defineInvoke(
    InvokeChannel.listRepositories,
    Schema.Struct({ query: NullableString }),
    Schema.Array(Repo),
  ),
  [InvokeChannel.openProject]: defineInvoke(
    InvokeChannel.openProject,
    Schema.Struct({
      localPath: RepositoryCheckoutPath,
      selectedRepository: Schema.NullOr(HostedRepositoryLocator),
    }),
    ProjectOpenResult,
  ),
  [InvokeChannel.repairRepositoryIdentities]: defineInvoke(
    InvokeChannel.repairRepositoryIdentities,
    EmptyRequest,
    RepositoryIdentityRepairSummary,
  ),
  [InvokeChannel.resourceDiagnostics]: defineInvoke(
    InvokeChannel.resourceDiagnostics,
    EmptyRequest,
    ResourceDiagnostics,
    { maxRequestBytes: 1 * KIB, maxResponseBytes: 16 * KIB },
  ),
  [InvokeChannel.clearDisposableResources]: defineInvoke(
    InvokeChannel.clearDisposableResources,
    EmptyRequest,
    ClearDisposableResourcesResult,
    { maxRequestBytes: 1 * KIB, maxResponseBytes: 16 * KIB },
  ),
  [InvokeChannel.selectLocalFolder]: defineInvoke(
    InvokeChannel.selectLocalFolder,
    EmptyRequest,
    Schema.NullOr(RepositoryCheckoutPath),
  ),
  [InvokeChannel.setRepositoryFavorite]: defineInvoke(
    InvokeChannel.setRepositoryFavorite,
    Schema.Struct({ id: ReviewProjectId, isFavorite: Schema.Boolean }),
    Repo,
  ),
  [InvokeChannel.projectWorkspaceGet]: defineInvoke(
    InvokeChannel.projectWorkspaceGet,
    Schema.Struct({ projectId: ReviewProjectId }),
    Schema.NullOr(ProjectWorkspaceState),
  ),
  [InvokeChannel.projectWorkspaceSave]: defineInvoke(
    InvokeChannel.projectWorkspaceSave,
    Schema.Struct({ input: ProjectWorkspaceStateInput }),
    ProjectWorkspaceState,
  ),
  [InvokeChannel.addReviewThreadUserMessage]: defineInvoke(
    InvokeChannel.addReviewThreadUserMessage,
    AddReviewThreadUserMessageRequest,
    ReviewThreadDetails,
  ),
  [InvokeChannel.createReviewThread]: defineInvoke(
    InvokeChannel.createReviewThread,
    CreateReviewThreadRequest,
    ReviewThreadDetails,
  ),
  [InvokeChannel.getReviewThread]: defineInvoke(
    InvokeChannel.getReviewThread,
    ReviewThreadIdRequest,
    ReviewThreadDetails,
  ),
  [InvokeChannel.listReviewThreads]: defineInvoke(
    InvokeChannel.listReviewThreads,
    Schema.Struct({ target: ReviewThreadTarget }),
    Schema.Array(ReviewThread),
  ),
  [InvokeChannel.runReviewThreadAgent]: defineInvoke(
    InvokeChannel.runReviewThreadAgent,
    RunReviewThreadAgentRequest,
    ReviewThreadDetails,
  ),
  [InvokeChannel.settingsGet]: defineInvoke(InvokeChannel.settingsGet, EmptyRequest, AISettings),
  [InvokeChannel.settingsUpdate]: defineInvoke(
    InvokeChannel.settingsUpdate,
    Schema.Struct({ settings: AISettings }),
    AISettings,
  ),
  [InvokeChannel.updatesCheck]: defineInvoke(
    InvokeChannel.updatesCheck,
    EmptyRequest,
    EmptyResponse,
  ),
  [InvokeChannel.updatesDownload]: defineInvoke(
    InvokeChannel.updatesDownload,
    EmptyRequest,
    EmptyResponse,
  ),
  [InvokeChannel.updatesGetState]: defineInvoke(
    InvokeChannel.updatesGetState,
    EmptyRequest,
    AppUpdateState,
  ),
  [InvokeChannel.updatesRestartAndInstall]: defineInvoke(
    InvokeChannel.updatesRestartAndInstall,
    EmptyRequest,
    EmptyResponse,
  ),
  [InvokeChannel.listViewedFiles]: defineInvoke(
    InvokeChannel.listViewedFiles,
    HostedViewedFilesRequest,
    Schema.Array(ViewedFileRecord),
  ),
  [InvokeChannel.listLocalViewedFiles]: defineInvoke(
    InvokeChannel.listLocalViewedFiles,
    LocalViewedFilesRequest,
    Schema.Array(ViewedFileRecord),
  ),
  [InvokeChannel.setViewedFile]: defineInvoke(
    InvokeChannel.setViewedFile,
    SetHostedViewedFileRequest,
    EmptyResponse,
  ),
  [InvokeChannel.setLocalViewedFile]: defineInvoke(
    InvokeChannel.setLocalViewedFile,
    SetLocalViewedFileRequest,
    EmptyResponse,
  ),
  [InvokeChannel.listRepositoryComparisonViewedFiles]: defineInvoke(
    InvokeChannel.listRepositoryComparisonViewedFiles,
    RepositoryComparisonViewedFilesRequest,
    Schema.Array(ViewedFileRecord),
  ),
  [InvokeChannel.setRepositoryComparisonViewedFile]: defineInvoke(
    InvokeChannel.setRepositoryComparisonViewedFile,
    SetRepositoryComparisonViewedFileRequest,
    EmptyResponse,
  ),
} as const

const defineEvent = <Channel extends EventChannel, Payload extends BoundarySchema>(
  channel: Channel,
  payload: Payload,
  maxPayloadBytes = DEFAULT_MAX_EVENT_PAYLOAD_BYTES,
) => ({
  channel,
  payload,
  maxPayloadBytes: positiveSafeInteger(maxPayloadBytes, `${channel}.maxPayloadBytes`),
})

/** Complete schema registry for host-to-renderer events. */
export const EventContract = {
  [EventChannel.navigationCommandsAvailable]: defineEvent(
    EventChannel.navigationCommandsAvailable,
    EmptyRequest,
  ),
  [EventChannel.reviewThreadAgentProgress]: defineEvent(
    EventChannel.reviewThreadAgentProgress,
    ReviewAgentProgress,
  ),
  [EventChannel.walkthroughOperationHint]: defineEvent(
    EventChannel.walkthroughOperationHint,
    WalkthroughOperationBridgeHint,
    8 * KIB,
  ),
  [EventChannel.updateStateChanged]: defineEvent(EventChannel.updateStateChanged, AppUpdateState),
} as const

/** Decoded request type for one invoke channel. */
export type InvokeRequest<Channel extends InvokeChannel> =
  (typeof InvokeContract)[Channel]["request"]["Type"]

/** Decoded response type for one invoke channel. */
export type InvokeResponse<Channel extends InvokeChannel> =
  (typeof InvokeContract)[Channel]["response"]["Type"]

/** Decoded event payload type for one event channel. */
export type EventPayload<Channel extends EventChannel> =
  (typeof EventContract)[Channel]["payload"]["Type"]

/** Returns the response schema associated with one channel. */
export const invokeResponseSchema = <Channel extends InvokeChannel>(
  channel: Channel,
): (typeof InvokeContract)[Channel]["response"] => InvokeContract[channel].response

/** Returns the payload schema associated with one event channel. */
export const eventPayloadSchema = <Channel extends EventChannel>(
  channel: Channel,
): (typeof EventContract)[Channel]["payload"] => EventContract[channel].payload

/** Serializable success envelope returned for every invoke operation. */
export const successEnvelope = <Value extends BoundarySchema>(value: Value) =>
  Schema.TaggedStruct("Success", { value })

/** Returns the schema for one typed bridge result. */
export const bridgeResult = <Value extends BoundarySchema>(value: Value) =>
  Schema.Union([successEnvelope(value), FailureEnvelope])

/** Encodes one failure under a contract response budget, falling back to a fixed bounded error. */
export const encodeFailureEnvelopeWithinBudget = (
  error: TransportError,
  maxResponseBytes: number,
) => {
  try {
    const encoded = Schema.encodeSync(FailureEnvelope)({ _tag: "Failure", error })
    assertJsonPayloadWithinBudget(encoded, maxResponseBytes)
    return encoded
  } catch {
    assertJsonPayloadWithinBudget(BOUNDED_FAILURE_ENVELOPE, maxResponseBytes)
    return BOUNDED_FAILURE_ENVELOPE
  }
}

function positiveSafeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}
