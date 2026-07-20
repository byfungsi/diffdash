import { AISettings } from "@diffdash/domain/ai-settings"
import { AppState } from "@diffdash/domain/app-state"
import {
  GitProviderDescriptor,
  HostedRepository,
  HostedReviewSummary,
  ReviewDecision,
} from "@diffdash/domain/git-provider"
import { LocalReviewTarget } from "@diffdash/domain/local-review"
import { Repo, RepositorySearchScope } from "@diffdash/domain/repository"
import { ReviewAgentProgress } from "@diffdash/domain/review-agent"
import {
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
} from "@diffdash/domain/review-context"
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
import { CliNavigationCommand, NAVIGATION_COMMAND_DRAIN_LIMIT } from "./cli-navigation"
import {
  GenerateHostedWalkthroughRequest,
  HostedProviderRequest,
  HostedRepositoryRequest,
  HostedRepositorySearchRequest,
  HostedReviewRequest,
  HostedWalkthroughRequest,
  OpenHostedReviewFileRequest,
  SubmitHostedReviewDecisionRequest,
} from "./hosted-git"
import { assertJsonPayloadWithinBudget, jsonSafeUtf8ByteLength } from "./payload-budget"
import { AppPrerequisites, DiffDashCliInstallResult } from "./prerequisites"
import { LinkRepositoryCheckoutRequest } from "./repository-link"
import {
  AcquireHostedReviewSnapshotRequest,
  AcquireLocalReviewSnapshotRequest,
  REVIEW_SNAPSHOT_PAGE_MAX_BYTES,
  REVIEW_SNAPSHOT_SEARCH_MAX_BYTES,
  ReviewSnapshotPageRequest,
  ReviewSnapshotPageResponse,
  ReviewSnapshotSearchRequest,
  ReviewSnapshotSearchResponse,
} from "./review-snapshot"
import {
  AddReviewThreadUserMessageRequest,
  CreateReviewThreadRequest,
  ReviewThreadIdRequest,
  RunReviewThreadAgentRequest,
} from "./review-threads"
import { TransportError, transportError } from "./transport-error"
import {
  HostedViewedFilesRequest,
  LocalViewedFilesRequest,
  SetHostedViewedFileRequest,
  SetLocalViewedFileRequest,
  ViewedFileRecord,
} from "./viewed-files"

const EmptyRequest = Schema.Struct({})
const EmptyResponse = Schema.transform(Schema.Null, Schema.Void, {
  decode: () => undefined,
  encode: () => null,
})
/** Serializable failure envelope returned for every invoke operation. */
export const FailureEnvelope = Schema.TaggedStruct("Failure", {
  error: TransportError,
})
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

const defineInvoke = <
  Channel extends InvokeChannel,
  Request extends Schema.Schema.AnyNoContext,
  Response extends Schema.Schema.AnyNoContext,
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
    Schema.Struct({ localPath: Schema.String, branchName: NullableString }),
    LocalReviewTarget,
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
  [InvokeChannel.getReviewSnapshotPage]: defineInvoke(
    InvokeChannel.getReviewSnapshotPage,
    ReviewSnapshotPageRequest,
    ReviewSnapshotPageResponse,
    {
      maxRequestBytes: 64 * KIB,
      maxResponseBytes: REVIEW_SNAPSHOT_PAGE_MAX_BYTES + KIB,
    },
  ),
  [InvokeChannel.searchReviewSnapshot]: defineInvoke(
    InvokeChannel.searchReviewSnapshot,
    ReviewSnapshotSearchRequest,
    ReviewSnapshotSearchResponse,
    {
      maxRequestBytes: 64 * KIB,
      maxResponseBytes: REVIEW_SNAPSHOT_SEARCH_MAX_BYTES + KIB,
    },
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
    Schema.Array(CliNavigationCommand).pipe(Schema.maxItems(NAVIGATION_COMMAND_DRAIN_LIMIT)),
  ),
  [InvokeChannel.favoriteRemoteRepository]: defineInvoke(
    InvokeChannel.favoriteRemoteRepository,
    Schema.Struct({ repository: HostedRepository }),
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

const defineEvent = <Channel extends EventChannel, Payload extends Schema.Schema.AnyNoContext>(
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

const createInvokeRegistry = <
  const Registry extends Record<InvokeChannel, ReturnType<typeof defineInvoke>>,
>(
  contracts: Registry,
) => ({
  contracts,
  request: <Channel extends InvokeChannel>(channel: Channel) => contracts[channel].request,
  response: <Channel extends InvokeChannel>(channel: Channel) => contracts[channel].response,
})

const createEventRegistry = <
  const Registry extends Record<EventChannel, ReturnType<typeof defineEvent>>,
>(
  contracts: Registry,
) => ({
  contracts,
  payload: <Channel extends EventChannel>(channel: Channel) => contracts[channel].payload,
})

const invokeRegistry = createInvokeRegistry(InvokeContract)
const eventRegistry = createEventRegistry(EventContract)

/** Returns the request schema associated with one channel. */
export const invokeRequestSchema = <Channel extends InvokeChannel>(channel: Channel) => {
  return invokeRegistry.request(channel)
}

/** Returns the response schema associated with one channel. */
export const invokeResponseSchema = <Channel extends InvokeChannel>(channel: Channel) => {
  return invokeRegistry.response(channel)
}

/** Returns the payload schema associated with one event channel. */
export const eventPayloadSchema = <Channel extends EventChannel>(channel: Channel) => {
  return eventRegistry.payload(channel)
}

/** Serializable success envelope returned for every invoke operation. */
export const successEnvelope = <Value extends Schema.Schema.AnyNoContext>(value: Value) =>
  Schema.TaggedStruct("Success", { value })

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

const hasOwn = <Value extends object>(value: Value, key: PropertyKey): key is keyof Value =>
  Object.hasOwn(value, key)

function positiveSafeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}

/** Looks up a known invoke contract while rejecting unknown channels deterministically. */
export const getInvokeContract = (channel: unknown) => {
  if (typeof channel === "string" && hasOwn(InvokeContract, channel)) {
    return InvokeContract[channel]
  }
  throw transportError("UNKNOWN_CHANNEL", `Unknown IPC invoke channel: ${String(channel)}`)
}

/** Looks up a known event contract while rejecting unknown channels deterministically. */
export const getEventContract = (channel: unknown) => {
  if (typeof channel === "string" && hasOwn(EventContract, channel)) {
    return EventContract[channel]
  }
  throw transportError("UNKNOWN_CHANNEL", `Unknown IPC event channel: ${String(channel)}`)
}
