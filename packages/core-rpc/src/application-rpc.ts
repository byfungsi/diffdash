import { AgentModelId, AgentProviderId } from "@diffdash/domain/agent-provider"
import { AgentCapability, AgentModelQuality, AISettings } from "@diffdash/domain/ai-settings"
import { ExecutablePath } from "@diffdash/domain/executable-path"
import {
  GitFileRevision,
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitProviderId,
  HostedRepository,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewLocator,
  HostedReviewSummary,
  RepositoryNamespace,
  ReviewDecision,
} from "@diffdash/domain/git-provider"
import { LocalReviewTarget } from "@diffdash/domain/local-review"
import {
  ProjectOpenResult,
  ProjectWorkspaceState,
  ProjectWorkspaceStateInput,
} from "@diffdash/domain/project-workspace"
import {
  RepositoryComparisonRef,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import {
  Repo,
  RepositoryCheckoutPath,
  RepositoryIdentityRepairSummary,
  RepositorySearchScope,
} from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
  RepositoryComparisonSnapshotManifest,
} from "@diffdash/domain/review-context"
import {
  ReviewFilePatchHash,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  ReviewThread,
  ReviewThreadAnchor,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadTarget,
  MarkdownBody,
} from "@diffdash/domain/review-thread"
import { WebUrl } from "@diffdash/domain/web-url"
import { NonNegativeInteger } from "@diffdash/domain/domain-scalar"
import { Schema } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

import { HostRequestContext } from "./identity"
import {
  CoreRpcDeadlineMilliseconds,
  CoreRpcMethodPolicy,
  CoreRpcMethodPolicyAnnotation,
  CoreRpcPayloadBytes,
  type CoreRpcMethodPolicy as CoreRpcMethodPolicyType,
} from "./method-policy"
import { CoreClearDisposableResourcesResult, CoreResourceDiagnostics } from "./resource"

const KIB = 1_024
const MIB = 1_024 * KIB
const RequestIdentity = HostRequestContext.fields
const EmptyRequest = Schema.Struct({ ...RequestIdentity })
const NullableString = Schema.NullOr(Schema.String)
const E2eLifecycleIdentity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
)
/** Core RPC payload for packaged-E2E review lifecycle evidence. */
export const E2eReviewLifecycleDiagnostics = Schema.Struct({
  acquisitions: Schema.Struct({
    activeOperationIds: Schema.Array(E2eLifecycleIdentity),
    started: NonNegativeInteger,
    completed: NonNegativeInteger,
    superseded: NonNegativeInteger,
    drained: NonNegativeInteger,
    failed: NonNegativeInteger,
    lastStartedOperationId: Schema.NullOr(E2eLifecycleIdentity),
    lastSupersededOperationId: Schema.NullOr(E2eLifecycleIdentity),
    lastDrainedOperationId: Schema.NullOr(E2eLifecycleIdentity),
  }),
  sessions: Schema.Struct({
    activeSessionId: Schema.NullOr(E2eLifecycleIdentity),
    opened: NonNegativeInteger,
    disposed: NonNegativeInteger,
    lastDisposedSessionId: Schema.NullOr(E2eLifecycleIdentity),
  }),
})
/** Core RPC payload for packaged-E2E review lifecycle evidence. */
export type E2eReviewLifecycleDiagnostics = typeof E2eReviewLifecycleDiagnostics.Type
/** Core RPC result for arming the next-acquisition supersession hold. */
export const E2eReviewLifecycleHold = Schema.Struct({ armed: Schema.Boolean })
/** Core RPC result for arming the next-acquisition supersession hold. */
export type E2eReviewLifecycleHold = typeof E2eReviewLifecycleHold.Type
const CoreAbsolutePath = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(
    Schema.makeFilter(
      (value) =>
        value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\"),
      { message: "Expected an absolute filesystem path" },
    ),
  ),
  Schema.brand("CoreAbsolutePath"),
)
const CoreFileOpenIntent = Schema.Union([
  Schema.TaggedStruct("local", { rootPath: CoreAbsolutePath, filePath: RepositoryRelativePath }),
  Schema.TaggedStruct("external", { url: WebUrl }),
])

const withContext = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct({ ...RequestIdentity, ...fields })

const AnalyticsEvent = Schema.Union([
  Schema.Struct({ event: Schema.Literal("onboarding_completed") }),
  Schema.Struct({ event: Schema.Literal("repository_bookmarked") }),
  Schema.Struct({ event: Schema.Literal("repository_linked") }),
  Schema.Struct({
    event: Schema.Literal("review_opened"),
    reviewType: Schema.Literals(["local_diff", "pull_request", "repository_comparison"]),
  }),
  Schema.Struct({
    event: Schema.Literal("review_file_viewed"),
    reviewType: Schema.Literals(["local_diff", "pull_request", "repository_comparison"]),
    viewed: Schema.Boolean,
  }),
  Schema.Struct({
    event: Schema.Literal("walkthrough_generated"),
    reviewType: Schema.Literals(["local_diff", "pull_request", "repository_comparison"]),
    regenerated: Schema.Boolean,
    provider: Schema.NonEmptyString,
  }),
  Schema.Struct({
    event: Schema.Literal("review_thread_created"),
    reviewType: Schema.Literals(["local_diff", "pull_request", "repository_comparison"]),
  }),
  Schema.Struct({
    event: Schema.Literal("review_agent_completed"),
    reviewType: Schema.Literals(["local_diff", "pull_request", "repository_comparison"]),
  }),
  Schema.Struct({ event: Schema.Literal("pull_request_approved") }),
  Schema.Struct({ event: Schema.Literal("update_download_started") }),
  Schema.Struct({ event: Schema.Literal("update_install_started") }),
])

const AgentProviderCapabilityStatus = Schema.TaggedUnion({
  Ready: { runtimeVersion: Schema.NullOr(Schema.String) },
  Unavailable: { reason: Schema.String },
  PolicyUnsupported: { reason: Schema.String },
  Unsupported: { reason: Schema.String },
})
const AgentProviderCatalog = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      id: AgentProviderId,
      displayName: Schema.NonEmptyString,
      description: Schema.String,
      homepage: Schema.NullOr(WebUrl),
      capabilities: Schema.Record(AgentCapability, AgentProviderCapabilityStatus),
      models: Schema.Array(
        Schema.Struct({
          id: AgentModelId,
          displayName: Schema.NonEmptyString,
          capabilities: Schema.Array(AgentCapability),
          quality: AgentModelQuality,
        }),
      ),
      defaults: Schema.Struct({
        walkthroughModel: Schema.NullOr(AgentModelId),
        reviewThreadModel: Schema.NullOr(AgentModelId),
      }),
      setup: Schema.Array(
        Schema.Struct({
          name: Schema.NonEmptyString,
          versionRange: Schema.NullOr(Schema.String),
          installHint: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  ),
  autoCandidates: Schema.Struct({
    walkthrough: Schema.Array(AgentProviderId),
    reviewThread: Schema.Array(AgentProviderId),
  }),
})

const AppPrerequisites = Schema.Struct({
  gitInstalled: Schema.Boolean,
  ghInstalled: Schema.Boolean,
  ghVersion: Schema.NullOr(Schema.String),
  ghSearchRepositoriesAvailable: Schema.Boolean,
  ghSupported: Schema.Boolean,
  ghAuthenticated: Schema.Boolean,
  codingAgentInstalled: Schema.Boolean,
  installedCodingAgents: Schema.Array(
    Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.brand("CodingAgentName")),
  ),
  providerDiagnostics: Schema.Array(
    Schema.Struct({ descriptor: GitProviderDescriptor, diagnostic: GitProviderDiagnostic }),
  ),
  setupRequirements: Schema.Array(
    Schema.Struct({
      key: Schema.String.pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.brand("SetupRequirementKey"),
      ),
      providerId: Schema.NullOr(Schema.Union([GitProviderId, AgentProviderId])),
      title: Schema.String,
      description: Schema.String,
      detail: Schema.String,
      ready: Schema.Boolean,
      requiredForLocalUse: Schema.Boolean,
      helpUrl: Schema.NullOr(WebUrl),
    }),
  ),
  diffDashCliInstalled: Schema.Boolean,
  diffDashCliInPath: Schema.Boolean,
  diffDashCliPath: Schema.NullOr(ExecutablePath),
  checkedAt: Schema.String,
})
const DiffDashCliInstallResult = Schema.Struct({
  path: ExecutablePath,
  pathSetupCommand: Schema.NullOr(Schema.String),
})

const CliRepositorySelector = Schema.Struct({
  providerId: Schema.NullOr(GitProviderId),
  namespace: RepositoryNamespace,
  name: HostedRepositoryName,
})
const OpenRepositoryComparisonCommand = Schema.TaggedStruct("openRepositoryComparison", {
  localPath: RepositoryCheckoutPath,
  repository: Schema.NullOr(CliRepositorySelector),
  baseRef: RepositoryComparisonRef,
  headRef: RepositoryComparisonRef,
})
const ResolvedRepositoryComparison = Schema.Struct({
  repo: Repo,
  target: RepositoryComparisonTarget,
})
const ViewedFileRecord = Schema.Struct({ reviewKey: ReviewKey, patchHash: ReviewFilePatchHash })

/** Stable public failure code emitted by an application RPC adapter. */
export const CoreApplicationFailureCode = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(120)),
  Schema.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u)),
)

/** Stable public failure emitted by one exact application RPC method. */
export const coreApplicationFailure = <Method extends string>(method: Method) =>
  Schema.TaggedStruct("CoreApplicationFailure", {
    ...RequestIdentity,
    method: Schema.Literal(method),
    code: CoreApplicationFailureCode,
    retryClass: Schema.Literals(["automatic", "userAction", "notRetryable"]),
    safeMessage: Schema.String.pipe(
      Schema.check(Schema.isMinLength(1)),
      Schema.check(Schema.isMaxLength(240)),
    ),
  })

/** Expected public failure from one native application method. */
export type CoreApplicationFailure<Method extends string = string> = ReturnType<
  typeof coreApplicationFailure<Method>
>["Type"]

const defectValue = Schema.NullishOr(Schema.ObjectKeyword)
const applicationRpc = <
  Method extends string,
  Payload extends Schema.Top,
  Success extends Schema.Top,
>(
  method: Method,
  payload: Payload,
  success: Success,
  policy: CoreRpcMethodPolicyType,
) => {
  const failure = coreApplicationFailure(method)
  return Rpc.make(method, {
    payload,
    success,
    error: failure,
    defect: failure.pipe(Schema.decodeTo(defectValue)),
  }).annotate(CoreRpcMethodPolicyAnnotation, policy)
}

const policy = (options: {
  readonly deadlineMs: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly mutation?: "read" | "idempotentMutation" | "uncertainMutation"
  readonly idempotency?: "idempotent" | "idempotencyKeyRequired" | "nonIdempotent"
  readonly cancellation?: "interruptible" | "detachedAfterAcceptance" | "uninterruptible"
  readonly restart?:
    | "retryInNewEpoch"
    | "retryByIdempotencyKey"
    | "failOnRestart"
    | "resumeByOperationId"
  readonly scope?: "application" | "project" | "review" | "operation"
}): CoreRpcMethodPolicyType =>
  CoreRpcMethodPolicy.make({
    deadlineMs: CoreRpcDeadlineMilliseconds.make(options.deadlineMs),
    maxRequestBytes: CoreRpcPayloadBytes.make(options.maxRequestBytes ?? 256 * KIB),
    maxResponseBytes: CoreRpcPayloadBytes.make(options.maxResponseBytes ?? 2 * MIB),
    cancellation: options.cancellation ?? "interruptible",
    requiredScope: options.scope ?? "application",
    mutationClass: options.mutation ?? "read",
    idempotency: options.idempotency ?? "idempotent",
    restartBehavior:
      options.restart ??
      (options.mutation === undefined || options.mutation === "read"
        ? "retryInNewEpoch"
        : "failOnRestart"),
    requiredHostCapabilities: [],
  })

const read = (deadlineMs = 10_000, maxResponseBytes = 2 * MIB) =>
  policy({ deadlineMs, maxResponseBytes })
const mutation = (deadlineMs = 30_000, maxResponseBytes = 2 * MIB) =>
  policy({
    deadlineMs,
    maxResponseBytes,
    mutation: "uncertainMutation",
    idempotency: "nonIdempotent",
  })
const idempotentMutation = (deadlineMs = 10_000, maxResponseBytes = 2 * MIB) =>
  policy({
    deadlineMs,
    maxResponseBytes,
    mutation: "idempotentMutation",
    idempotency: "idempotent",
    restart: "retryInNewEpoch",
  })

export const AnalyticsCaptureRpc = applicationRpc(
  "Analytics.capture",
  withContext({ event: AnalyticsEvent }),
  Schema.Void,
  mutation(2_000, 1 * KIB),
)
export const AnalyticsStartRpc = applicationRpc(
  "Analytics.start",
  EmptyRequest,
  Schema.Void,
  idempotentMutation(2_000, 1 * KIB),
)
export const AgentProvidersGetCatalogRpc = applicationRpc(
  "AgentProviders.getCatalog",
  EmptyRequest,
  AgentProviderCatalog,
  read(5_000, 256 * KIB),
)
export const PrerequisitesGetRpc = applicationRpc(
  "Prerequisites.get",
  EmptyRequest,
  AppPrerequisites,
  read(10_000, 256 * KIB),
)
export const PrerequisitesInstallDiffDashCliRpc = applicationRpc(
  "Prerequisites.installDiffDashCli",
  EmptyRequest,
  DiffDashCliInstallResult,
  mutation(30_000, 16 * KIB),
)
export const ResolveLocalRepositoryFileRpc = applicationRpc(
  "FileNavigation.resolveLocalRepositoryFile",
  withContext({ rootPath: RepositoryCheckoutPath, filePath: RepositoryRelativePath }),
  CoreFileOpenIntent,
  read(10_000, 16 * KIB),
)
export const ResolveRepositoryComparisonFileRpc = applicationRpc(
  "FileNavigation.resolveRepositoryComparisonFile",
  withContext({ target: RepositoryComparisonTarget, filePath: RepositoryRelativePath }),
  CoreFileOpenIntent,
  read(15_000, 16 * KIB),
)
export const ResolveHostedReviewFileRpc = applicationRpc(
  "FileNavigation.resolveHostedReviewFile",
  withContext({
    review: HostedReviewLocator,
    filePath: RepositoryRelativePath,
    headRefName: GitFileRevision,
    headRevision: Schema.NullOr(ReviewRevision),
  }),
  CoreFileOpenIntent,
  read(15_000, 16 * KIB),
)
export const GitProvidersListRpc = applicationRpc(
  "GitProviders.list",
  EmptyRequest,
  Schema.Array(GitProviderDescriptor),
  read(),
)
export const HostedReviewsSubmitDecisionRpc = applicationRpc(
  "HostedReviews.submitDecision",
  withContext({ review: HostedReviewLocator, decision: ReviewDecision }),
  Schema.Void,
  mutation(),
)
export const HostedReviewsGetDecisionRpc = applicationRpc(
  "HostedReviews.getDecision",
  withContext({ review: HostedReviewLocator }),
  ReviewDecision,
  read(),
)
export const HostedReviewsListRpc = applicationRpc(
  "HostedReviews.list",
  withContext({ repository: HostedRepositoryLocator }),
  Schema.Array(HostedReviewSummary),
  read(),
)
export const HostedReviewsListAssignedRpc = applicationRpc(
  "HostedReviews.listAssigned",
  withContext({ providerId: GitProviderId }),
  Schema.Array(HostedReviewSummary),
  read(),
)
export const GitProvidersListSearchScopesRpc = applicationRpc(
  "GitProviders.listSearchScopes",
  withContext({ providerId: GitProviderId }),
  Schema.Array(RepositorySearchScope),
  read(),
)
export const GitProvidersSearchRepositoriesRpc = applicationRpc(
  "GitProviders.searchRepositories",
  withContext({
    providerId: GitProviderId,
    query: Schema.String,
    namespaces: Schema.Array(Schema.String),
  }),
  Schema.Array(HostedRepository),
  read(),
)
export const LocalReviewsResolveBranchRpc = applicationRpc(
  "LocalReviews.resolveBranch",
  withContext({
    localPath: RepositoryCheckoutPath,
    branchName: Schema.NullOr(RepositoryComparisonRef),
  }),
  LocalReviewTarget,
  read(30_000),
)
export const LocalReviewsResolveLastCommitRpc = applicationRpc(
  "LocalReviews.resolveLastCommit",
  withContext({ localPath: RepositoryCheckoutPath }),
  LocalReviewTarget,
  read(30_000),
)
export const RepositoryComparisonsResolveRpc = applicationRpc(
  "RepositoryComparisons.resolve",
  withContext({ command: OpenRepositoryComparisonCommand }),
  ResolvedRepositoryComparison,
  read(30_000, 64 * KIB),
)
export const ReviewSnapshotsAcquireHostedRpc = applicationRpc(
  "ReviewSnapshots.acquireHosted",
  withContext({ review: HostedReviewLocator }),
  HostedReviewSnapshotManifest,
  read(60_000),
)
export const ReviewSnapshotsAcquireLocalRpc = applicationRpc(
  "ReviewSnapshots.acquireLocal",
  withContext({ target: LocalReviewTarget }),
  LocalReviewSnapshotManifest,
  read(60_000),
)
export const ReviewSnapshotsAcquireRepositoryComparisonRpc = applicationRpc(
  "ReviewSnapshots.acquireRepositoryComparison",
  withContext({ target: RepositoryComparisonTarget }),
  RepositoryComparisonSnapshotManifest,
  read(60_000),
)
export const RepositoriesFavoriteRemoteRpc = applicationRpc(
  "Repositories.favoriteRemote",
  withContext({ repository: HostedRepository }),
  Repo,
  idempotentMutation(),
)
export const RepositoriesForgetRpc = applicationRpc(
  "Repositories.forget",
  withContext({ projectId: ReviewProjectId }),
  Repo,
  idempotentMutation(),
)
export const RepositoriesInstallRpc = applicationRpc(
  "Repositories.install",
  withContext({ localPath: RepositoryCheckoutPath }),
  Repo,
  idempotentMutation(30_000),
)
export const RepositoriesLinkRpc = applicationRpc(
  "Repositories.link",
  withContext({ repository: HostedRepositoryLocator, localPath: RepositoryCheckoutPath }),
  Repo,
  idempotentMutation(30_000),
)
export const RepositoriesListRpc = applicationRpc(
  "Repositories.list",
  withContext({ query: NullableString }),
  Schema.Array(Repo),
  read(),
)
export const RepositoriesOpenProjectRpc = applicationRpc(
  "Repositories.openProject",
  withContext({
    localPath: RepositoryCheckoutPath,
    selectedRepository: Schema.NullOr(HostedRepositoryLocator),
  }),
  ProjectOpenResult,
  idempotentMutation(30_000),
)
export const RepositoriesRepairIdentitiesRpc = applicationRpc(
  "Repositories.repairIdentities",
  EmptyRequest,
  RepositoryIdentityRepairSummary,
  idempotentMutation(60_000),
)
export const RepositoriesSetFavoriteRpc = applicationRpc(
  "Repositories.setFavorite",
  withContext({ id: ReviewProjectId, isFavorite: Schema.Boolean }),
  Repo,
  idempotentMutation(),
)
export const ProjectWorkspaceGetRpc = applicationRpc(
  "ProjectWorkspace.get",
  withContext({ projectId: ReviewProjectId }),
  Schema.NullOr(ProjectWorkspaceState),
  read(),
)
export const ProjectWorkspaceSaveRpc = applicationRpc(
  "ProjectWorkspace.save",
  withContext({ input: ProjectWorkspaceStateInput }),
  ProjectWorkspaceState,
  idempotentMutation(),
)
export const ReviewThreadsAddUserMessageRpc = applicationRpc(
  "ReviewThreads.addUserMessage",
  withContext({ threadId: ReviewThreadId, bodyMarkdown: MarkdownBody }),
  ReviewThreadDetails,
  mutation(),
)
export const ReviewThreadsCreateRpc = applicationRpc(
  "ReviewThreads.create",
  withContext({
    target: ReviewThreadTarget,
    expectedBaseRevision: ReviewRevision,
    expectedHeadRevision: ReviewRevision,
    anchor: ReviewThreadAnchor,
    bodyMarkdown: MarkdownBody,
  }),
  ReviewThreadDetails,
  mutation(),
)
export const ReviewThreadsGetRpc = applicationRpc(
  "ReviewThreads.get",
  withContext({ threadId: ReviewThreadId }),
  ReviewThreadDetails,
  read(),
)
export const ReviewThreadsListRpc = applicationRpc(
  "ReviewThreads.list",
  withContext({ target: ReviewThreadTarget }),
  Schema.Array(ReviewThread),
  read(),
)
export const SettingsGetRpc = applicationRpc("Settings.get", EmptyRequest, AISettings, read())
export const SettingsUpdateRpc = applicationRpc(
  "Settings.update",
  withContext({ settings: AISettings }),
  AISettings,
  idempotentMutation(),
)
export const ResourceDiagnosticsRpc = applicationRpc(
  "Resources.diagnostics",
  EmptyRequest,
  CoreResourceDiagnostics,
  read(5_000, 16 * KIB),
)
export const E2eReviewLifecycleDiagnosticsRpc = applicationRpc(
  "E2E.reviewLifecycleDiagnostics",
  EmptyRequest,
  E2eReviewLifecycleDiagnostics,
  read(5_000, 16 * KIB),
)
export const E2eHoldNextReviewAcquisitionRpc = applicationRpc(
  "E2E.holdNextReviewAcquisition",
  EmptyRequest,
  E2eReviewLifecycleHold,
  idempotentMutation(5_000, 8 * KIB),
)
export const ClearDisposableResourcesRpc = applicationRpc(
  "Resources.clearDisposable",
  EmptyRequest,
  CoreClearDisposableResourcesResult,
  idempotentMutation(30_000, 16 * KIB),
)
export const ViewedFilesListHostedRpc = applicationRpc(
  "ViewedFiles.listHosted",
  withContext({ review: HostedReviewLocator, baseRefName: RepositoryComparisonRef }),
  Schema.Array(ViewedFileRecord),
  read(),
)
export const ViewedFilesListLocalRpc = applicationRpc(
  "ViewedFiles.listLocal",
  withContext({ target: LocalReviewTarget, sourceBranch: Schema.NullOr(RepositoryComparisonRef) }),
  Schema.Array(ViewedFileRecord),
  read(),
)
export const ViewedFilesSetHostedRpc = applicationRpc(
  "ViewedFiles.setHosted",
  withContext({
    review: HostedReviewLocator,
    baseRefName: RepositoryComparisonRef,
    reviewKey: ReviewKey,
    patchHash: ReviewFilePatchHash,
    viewed: Schema.Boolean,
  }),
  Schema.Void,
  idempotentMutation(),
)
export const ViewedFilesSetLocalRpc = applicationRpc(
  "ViewedFiles.setLocal",
  withContext({
    target: LocalReviewTarget,
    sourceBranch: Schema.NullOr(RepositoryComparisonRef),
    reviewKey: ReviewKey,
    patchHash: ReviewFilePatchHash,
    viewed: Schema.Boolean,
  }),
  Schema.Void,
  idempotentMutation(),
)
export const ViewedFilesListRepositoryComparisonRpc = applicationRpc(
  "ViewedFiles.listRepositoryComparison",
  withContext({ target: RepositoryComparisonTarget }),
  Schema.Array(ViewedFileRecord),
  read(),
)
export const ViewedFilesSetRepositoryComparisonRpc = applicationRpc(
  "ViewedFiles.setRepositoryComparison",
  withContext({
    target: RepositoryComparisonTarget,
    reviewKey: ReviewKey,
    patchHash: ReviewFilePatchHash,
    viewed: Schema.Boolean,
  }),
  Schema.Void,
  idempotentMutation(),
)

/** Native application declarations not already owned by AppState or review-agent groups. */
export const CoreApplicationRpcs = RpcGroup.make(
  AnalyticsCaptureRpc,
  AnalyticsStartRpc,
  AgentProvidersGetCatalogRpc,
  PrerequisitesGetRpc,
  PrerequisitesInstallDiffDashCliRpc,
  ResolveLocalRepositoryFileRpc,
  ResolveRepositoryComparisonFileRpc,
  ResolveHostedReviewFileRpc,
  GitProvidersListRpc,
  HostedReviewsSubmitDecisionRpc,
  HostedReviewsGetDecisionRpc,
  HostedReviewsListRpc,
  HostedReviewsListAssignedRpc,
  GitProvidersListSearchScopesRpc,
  GitProvidersSearchRepositoriesRpc,
  LocalReviewsResolveBranchRpc,
  LocalReviewsResolveLastCommitRpc,
  RepositoryComparisonsResolveRpc,
  ReviewSnapshotsAcquireHostedRpc,
  ReviewSnapshotsAcquireLocalRpc,
  ReviewSnapshotsAcquireRepositoryComparisonRpc,
  RepositoriesFavoriteRemoteRpc,
  RepositoriesForgetRpc,
  RepositoriesInstallRpc,
  RepositoriesLinkRpc,
  RepositoriesListRpc,
  RepositoriesOpenProjectRpc,
  RepositoriesRepairIdentitiesRpc,
  RepositoriesSetFavoriteRpc,
  ProjectWorkspaceGetRpc,
  ProjectWorkspaceSaveRpc,
  ReviewThreadsAddUserMessageRpc,
  ReviewThreadsCreateRpc,
  ReviewThreadsGetRpc,
  ReviewThreadsListRpc,
  SettingsGetRpc,
  SettingsUpdateRpc,
  ResourceDiagnosticsRpc,
  E2eReviewLifecycleDiagnosticsRpc,
  E2eHoldNextReviewAcquisitionRpc,
  ClearDisposableResourcesRpc,
  ViewedFilesListHostedRpc,
  ViewedFilesListLocalRpc,
  ViewedFilesSetHostedRpc,
  ViewedFilesSetLocalRpc,
  ViewedFilesListRepositoryComparisonRpc,
  ViewedFilesSetRepositoryComparisonRpc,
)
