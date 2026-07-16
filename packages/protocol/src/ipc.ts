import { AISettings } from "@diffdash/domain/ai-settings"
import { AppState } from "@diffdash/domain/app-state"
import { GitProviderDescriptor, ReviewDecision } from "@diffdash/domain/git-provider"
import {
  LocalReviewDetail,
  LocalReviewDiff,
  LocalReviewTarget,
} from "@diffdash/domain/local-review"
import {
  PullRequestDetail,
  PullRequestDiff,
  PullRequestSummary,
} from "@diffdash/domain/pull-request"
import { Repo, RepositorySearchResult, RepositorySearchScope } from "@diffdash/domain/repository"
import { ReviewAgentProgress } from "@diffdash/domain/review-agent"
import { LocalReviewSnapshot } from "@diffdash/domain/review-context"
import {
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import { Schema } from "effect"
import { AgentProviderCatalog } from "./agent-providers"
import { AnalyticsEvent } from "./analytics"
import { AppUpdateState } from "./app-update"
import { EventChannel, InvokeChannel } from "./channels"
import { CliNavigationCommand } from "./cli-navigation"
import {
  GenerateHostedWalkthroughRequest,
  HostedProviderRequest,
  HostedRepositoryRequest,
  HostedRepositorySearchRequest,
  HostedReviewRequest,
  HostedViewedFilesRequest,
  HostedWalkthroughRequest,
  OpenHostedReviewFileRequest,
  SetHostedViewedFileRequest,
  SubmitHostedReviewDecisionRequest,
} from "./hosted-git"
import { AppPrerequisites, DiffDashCliInstallResult } from "./prerequisites"
import { LinkRepositoryCheckoutRequest } from "./repository-link"
import {
  AddReviewThreadUserMessageRequest,
  CreateReviewThreadRequest,
  ReviewThreadIdRequest,
  RunReviewThreadAgentRequest,
} from "./review-threads"
import { TransportError, transportError } from "./transport-error"

const EmptyRequest = Schema.Struct({})
const EmptyResponse = Schema.Void
const NullableString = Schema.NullOr(Schema.String)

const defineInvoke = <
  Channel extends InvokeChannel,
  Request extends Schema.Schema.Any,
  Response extends Schema.Schema.Any,
>(
  channel: Channel,
  request: Request,
  response: Response,
) => ({ channel, request, response })

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
  [InvokeChannel.appOpenExternalUrl]: defineInvoke(
    InvokeChannel.appOpenExternalUrl,
    Schema.Struct({ url: Schema.String }),
    EmptyResponse,
  ),
  [InvokeChannel.appOpenLocalRepositoryFile]: defineInvoke(
    InvokeChannel.appOpenLocalRepositoryFile,
    Schema.Struct({ rootPath: Schema.String, filePath: Schema.String }),
    EmptyResponse,
  ),
  [InvokeChannel.appOpenRepositoryFile]: defineInvoke(
    InvokeChannel.appOpenRepositoryFile,
    OpenHostedReviewFileRequest,
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
  [InvokeChannel.getHostedReview]: defineInvoke(
    InvokeChannel.getHostedReview,
    HostedReviewRequest,
    PullRequestDetail,
  ),
  [InvokeChannel.getHostedReviewDiff]: defineInvoke(
    InvokeChannel.getHostedReviewDiff,
    HostedReviewRequest,
    PullRequestDiff,
  ),
  [InvokeChannel.getHostedReviewDecision]: defineInvoke(
    InvokeChannel.getHostedReviewDecision,
    HostedReviewRequest,
    ReviewDecision,
  ),
  [InvokeChannel.listHostedReviews]: defineInvoke(
    InvokeChannel.listHostedReviews,
    HostedRepositoryRequest,
    Schema.Array(PullRequestSummary),
  ),
  [InvokeChannel.listAssignedHostedReviews]: defineInvoke(
    InvokeChannel.listAssignedHostedReviews,
    HostedProviderRequest,
    Schema.Array(PullRequestSummary),
  ),
  [InvokeChannel.listHostedRepositorySearchScopes]: defineInvoke(
    InvokeChannel.listHostedRepositorySearchScopes,
    HostedProviderRequest,
    Schema.Array(RepositorySearchScope),
  ),
  [InvokeChannel.refreshHostedReview]: defineInvoke(
    InvokeChannel.refreshHostedReview,
    HostedReviewRequest,
    PullRequestDetail,
  ),
  [InvokeChannel.searchHostedRepositories]: defineInvoke(
    InvokeChannel.searchHostedRepositories,
    HostedRepositorySearchRequest,
    Schema.Array(RepositorySearchResult),
  ),
  [InvokeChannel.localReviewDetail]: defineInvoke(
    InvokeChannel.localReviewDetail,
    Schema.Struct({ target: LocalReviewTarget }),
    LocalReviewDetail,
  ),
  [InvokeChannel.localReviewDiff]: defineInvoke(
    InvokeChannel.localReviewDiff,
    Schema.Struct({ target: LocalReviewTarget }),
    LocalReviewDiff,
  ),
  [InvokeChannel.localReviewSnapshot]: defineInvoke(
    InvokeChannel.localReviewSnapshot,
    Schema.Struct({ target: LocalReviewTarget }),
    LocalReviewSnapshot,
  ),
  [InvokeChannel.resolveLocalBranch]: defineInvoke(
    InvokeChannel.resolveLocalBranch,
    Schema.Struct({ localPath: Schema.String, branchName: NullableString }),
    LocalReviewTarget,
  ),
  [InvokeChannel.generateLocalWalkthrough]: defineInvoke(
    InvokeChannel.generateLocalWalkthrough,
    Schema.Struct({ target: LocalReviewTarget, regenerate: Schema.Boolean }),
    StoredWalkthrough,
  ),
  [InvokeChannel.getLocalWalkthrough]: defineInvoke(
    InvokeChannel.getLocalWalkthrough,
    Schema.Struct({ target: LocalReviewTarget, baseSha: Schema.String, headSha: Schema.String }),
    Schema.NullOr(StoredWalkthrough),
  ),
  [InvokeChannel.drainNavigationCommands]: defineInvoke(
    InvokeChannel.drainNavigationCommands,
    EmptyRequest,
    Schema.Array(CliNavigationCommand),
  ),
  [InvokeChannel.addLocalRepository]: defineInvoke(
    InvokeChannel.addLocalRepository,
    Schema.Struct({ localPath: Schema.String }),
    Repo,
  ),
  [InvokeChannel.favoriteRemoteRepository]: defineInvoke(
    InvokeChannel.favoriteRemoteRepository,
    Schema.Struct({ repository: RepositorySearchResult }),
    Repo,
  ),
  [InvokeChannel.installRepository]: defineInvoke(
    InvokeChannel.installRepository,
    Schema.Struct({ localPath: Schema.String }),
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
  [InvokeChannel.selectLocalFolder]: defineInvoke(
    InvokeChannel.selectLocalFolder,
    EmptyRequest,
    NullableString,
  ),
  [InvokeChannel.setRepositoryFavorite]: defineInvoke(
    InvokeChannel.setRepositoryFavorite,
    Schema.Struct({ id: Schema.String, isFavorite: Schema.Boolean }),
    Repo,
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
    Schema.Array(Schema.String),
  ),
  [InvokeChannel.listLocalViewedFiles]: defineInvoke(
    InvokeChannel.listLocalViewedFiles,
    Schema.Struct({ rootPath: Schema.String, headSha: Schema.String }),
    Schema.Array(Schema.String),
  ),
  [InvokeChannel.setViewedFile]: defineInvoke(
    InvokeChannel.setViewedFile,
    SetHostedViewedFileRequest,
    EmptyResponse,
  ),
  [InvokeChannel.setLocalViewedFile]: defineInvoke(
    InvokeChannel.setLocalViewedFile,
    Schema.Struct({
      rootPath: Schema.String,
      headSha: Schema.String,
      reviewKey: Schema.String,
      filePath: Schema.String,
      viewed: Schema.Boolean,
    }),
    EmptyResponse,
  ),
  [InvokeChannel.generateWalkthrough]: defineInvoke(
    InvokeChannel.generateWalkthrough,
    GenerateHostedWalkthroughRequest,
    StoredWalkthrough,
  ),
  [InvokeChannel.getWalkthrough]: defineInvoke(
    InvokeChannel.getWalkthrough,
    HostedWalkthroughRequest,
    Schema.NullOr(StoredWalkthrough),
  ),
} as const

const defineEvent = <Channel extends EventChannel, Payload extends Schema.Schema.Any>(
  channel: Channel,
  payload: Payload,
) => ({ channel, payload })

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

/** Returns the request schema associated with one channel. */
export const invokeRequestSchema = <Channel extends InvokeChannel>(channel: Channel) => {
  // SAFETY: InvokeContract is keyed by each channel and defineInvoke retains its request schema.
  return InvokeContract[channel].request as Schema.Schema<InvokeRequest<Channel>, unknown>
}

/** Returns the response schema associated with one channel. */
export const invokeResponseSchema = <Channel extends InvokeChannel>(channel: Channel) => {
  // SAFETY: InvokeContract is keyed by each channel and defineInvoke retains its response schema.
  return InvokeContract[channel].response as Schema.Schema<InvokeResponse<Channel>, unknown>
}

/** Returns the payload schema associated with one event channel. */
export const eventPayloadSchema = <Channel extends EventChannel>(channel: Channel) => {
  // SAFETY: EventContract is keyed by each channel and defineEvent retains its payload schema.
  return EventContract[channel].payload as Schema.Schema<EventPayload<Channel>, unknown>
}

/** Serializable success envelope returned for every invoke operation. */
export const successEnvelope = <Value extends Schema.Schema.Any>(value: Value) =>
  Schema.TaggedStruct("Success", { value })

/** Serializable failure envelope returned for every invoke operation. */
export const FailureEnvelope = Schema.TaggedStruct("Failure", {
  error: TransportError,
})

/** Looks up a known invoke contract while rejecting unknown channels deterministically. */
export const getInvokeContract = (channel: unknown) => {
  if (typeof channel === "string" && channel in InvokeContract) {
    return InvokeContract[channel as keyof typeof InvokeContract]
  }
  throw transportError("UNKNOWN_CHANNEL", `Unknown IPC invoke channel: ${String(channel)}`)
}

/** Looks up a known event contract while rejecting unknown channels deterministically. */
export const getEventContract = (channel: unknown) => {
  if (typeof channel === "string" && channel in EventContract) {
    return EventContract[channel as keyof typeof EventContract]
  }
  throw transportError("UNKNOWN_CHANNEL", `Unknown IPC event channel: ${String(channel)}`)
}
