import type { AISettings } from "@diffdash/domain/ai-settings"
import type { AppState } from "@diffdash/domain/app-state"
import type {
  GitProviderDescriptor,
  HostedRepository,
  HostedRepositoryLocator,
  HostedReviewDetail,
  HostedReviewCheck,
  HostedReviewSummary,
  ReviewDecision,
} from "@diffdash/domain/git-provider"
import type { LocalReviewTarget } from "@diffdash/domain/local-review"
import type { RepositoryComparisonTarget } from "@diffdash/domain/repository-comparison"
import type { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import type {
  ProjectOpenResult,
  ProjectWorkspaceState,
  ProjectWorkspaceStateInput,
} from "@diffdash/domain/project-workspace"
import type {
  Repo,
  RepositoryCheckoutPath,
  RepositoryIdentityRepairSummary,
  RepositorySearchScope,
} from "@diffdash/domain/repository"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import type { ReviewAgentProgress } from "@diffdash/domain/review-agent"
import type {
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
  RepositoryComparisonSnapshotManifest,
} from "@diffdash/domain/review-context"
import type {
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import type { WebUrl } from "@diffdash/domain/web-url"
import type { AgentProviderCatalog } from "./agent-providers"
import type {
  ConnectOpenCodeSessionRequest,
  ListOpenCodeSessionsRequest,
  OpenCodeConnection,
  OpenCodeSessionSummary,
  SubmitCommentReceipt,
  SubmitCommentRequest,
} from "./ai-connection"
import type { AnalyticsEvent } from "./analytics"
import type { AppUpdateState } from "./app-update"
import type { CodeWorkspaceFileStreamCancellationRegistrar } from "./code-workspace-stream"
import type { CliNavigationCommand } from "./cli-navigation"
import type {
  CodeWorkspaceDirectoryPage,
  CodeWorkspaceChangesResult,
  CodeWorkspaceDefinitionsRequest,
  CodeWorkspaceReferencesRequest,
  CodeWorkspaceFileReadResult,
  CodeWorkspaceLease,
  CodeWorkspaceLeaseRequest,
  CodeWorkspaceLineChangesRequest,
  CodeWorkspaceLineChangesResult,
  ListCodeWorkspaceDirectoryRequest,
  OpenCodeWorkspaceRequest,
  ReadCodeWorkspaceFileRequest,
  SearchCodeWorkspaceRequest,
  CodeWorkspaceSearchResult,
  RepositoryLanguageLocationResult,
} from "./code-workspace"
import type { OpenRepositoryComparisonCommand } from "./cli-navigation"
import type {
  HostedProviderRequest,
  CloseHostedReviewRequest,
  HostedRepositoryRequest,
  HostedRepositorySearchRequest,
  HostedReviewRequest,
  MergeHostedReviewRequest,
  OpenHostedReviewFileRequest,
  SubmitHostedReviewDecisionRequest,
} from "./hosted-git"
import type { AppPrerequisites, DiffDashCliInstallResult } from "./prerequisites"
import type { LinkRepositoryCheckoutRequest } from "./repository-link"
import type {
  AddReviewThreadUserMessageRequest,
  CreateReviewThreadRequest,
  RunReviewThreadAgentRequest,
} from "./review-threads"
import type {
  ResolvedRepositoryComparison,
  OpenRepositoryComparisonFileRequest,
} from "./review-snapshot"
import type {
  HostedViewedFilesRequest,
  LocalViewedFilesRequest,
  RepositoryComparisonViewedFilesRequest,
  SetHostedViewedFileRequest,
  SetLocalViewedFileRequest,
  SetRepositoryComparisonViewedFileRequest,
  ViewedFileRecord,
} from "./viewed-files"
import type { RendererBridgeResult } from "./ipc"
import type { ProgressiveReviewApi } from "./review-session"
import type { ClearDisposableResourcesResult, ResourceDiagnostics } from "./resource-diagnostics"
import type {
  WalkthroughBridgeStartRequest,
  WalkthroughStartBridgeResult,
} from "./walkthrough-operation"
import type {
  WalkthroughBridgeGetStoredRequest,
  WalkthroughBridgeOperationRequest,
  WalkthroughCancelBridgeResult,
  WalkthroughGetOperationBridgeResult,
  WalkthroughGetStoredBridgeResult,
  WalkthroughOperationBridgeHint,
} from "./walkthrough-operation-state"
type EventSubscription<Value> = (listener: (value: Value) => void) => () => void

/** Complete renderer-facing platform contract implemented by preload and demo runtimes. */
export interface DiffDashApi {
  readonly analytics: {
    readonly start: () => Promise<void>
    readonly capture: (event: AnalyticsEvent) => Promise<void>
  }
  readonly updates: {
    readonly getState: () => Promise<AppUpdateState>
    readonly check: () => Promise<void>
    readonly download: () => Promise<void>
    readonly restartAndInstall: () => Promise<void>
    readonly onStateChanged: EventSubscription<AppUpdateState>
  }
  readonly navigation: {
    readonly activateWindow: () => Promise<void>
    readonly drainCommands: () => Promise<readonly CliNavigationCommand[]>
    readonly onCommandsAvailable: EventSubscription<void>
  }
  readonly diagnostics: () => Promise<AppPrerequisites>
  readonly resources?: {
    readonly diagnostics: () => Promise<ResourceDiagnostics>
    readonly clearDisposable: () => Promise<ClearDisposableResourcesResult>
  }
  readonly agentProviders: {
    readonly getCatalog: () => Promise<AgentProviderCatalog>
  }
  readonly ai: {
    readonly listOpenCodeSessions: (
      request: ListOpenCodeSessionsRequest,
    ) => Promise<readonly OpenCodeSessionSummary[]>
    readonly connectOpenCodeSession: (
      request: ConnectOpenCodeSessionRequest,
    ) => Promise<OpenCodeConnection>
    readonly submitComment: (
      request: SubmitCommentRequest,
    ) => Promise<typeof SubmitCommentReceipt.Type>
  }
  readonly installDiffDashCli: () => Promise<DiffDashCliInstallResult>
  readonly openExternalUrl: (url: WebUrl) => Promise<void>
  readonly openRepositoryFile: (request: OpenHostedReviewFileRequest) => Promise<void>
  readonly openLocalRepositoryFile: (
    rootPath: RepositoryCheckoutPath,
    filePath: RepositoryRelativePath,
    target: LocalReviewTarget | null,
  ) => Promise<void>
  readonly repositories: {
    readonly list: (query?: string) => Promise<readonly Repo[]>
    readonly setFavorite: (id: ReviewProjectId, isFavorite: boolean) => Promise<Repo>
    readonly favoriteRemote: (repo: HostedRepository) => Promise<Repo>
    readonly install: (localPath: RepositoryCheckoutPath) => Promise<Repo>
    readonly link: (input: LinkRepositoryCheckoutRequest) => Promise<Repo>
    readonly openProject: (
      localPath: RepositoryCheckoutPath,
      selectedRepository?: HostedRepositoryLocator,
    ) => Promise<ProjectOpenResult>
    readonly repairIdentities: () => Promise<RepositoryIdentityRepairSummary>
    readonly forget: (projectId: ReviewProjectId) => Promise<Repo>
    readonly selectLocalFolder: () => Promise<RepositoryCheckoutPath | null>
  }
  readonly codeWorkspace: {
    readonly open: (request: OpenCodeWorkspaceRequest) => Promise<CodeWorkspaceLease>
    readonly heartbeat: (request: CodeWorkspaceLeaseRequest) => Promise<CodeWorkspaceLease>
    readonly release: (request: CodeWorkspaceLeaseRequest) => Promise<void>
    readonly listDirectory: (
      request: ListCodeWorkspaceDirectoryRequest,
    ) => Promise<CodeWorkspaceDirectoryPage>
    readonly search: (request: SearchCodeWorkspaceRequest) => Promise<CodeWorkspaceSearchResult>
    readonly readFile: (
      request: ReadCodeWorkspaceFileRequest,
    ) => Promise<CodeWorkspaceFileReadResult>
    readonly definitions: (
      request: CodeWorkspaceDefinitionsRequest,
    ) => Promise<RepositoryLanguageLocationResult>
    readonly references: (
      request: CodeWorkspaceReferencesRequest,
    ) => Promise<RepositoryLanguageLocationResult>
    readonly changes: (request: CodeWorkspaceLeaseRequest) => Promise<CodeWorkspaceChangesResult>
    readonly lineChanges: (
      request: CodeWorkspaceLineChangesRequest,
    ) => Promise<CodeWorkspaceLineChangesResult>
  }
  readonly projectWorkspace: {
    readonly get: (projectId: ReviewProjectId) => Promise<ProjectWorkspaceState | null>
    readonly save: (input: ProjectWorkspaceStateInput) => Promise<ProjectWorkspaceState>
  }
  readonly reviewThreads: {
    readonly list: (target: ReviewThreadTarget) => Promise<readonly ReviewThread[]>
    readonly create: (input: CreateReviewThreadRequest) => Promise<ReviewThreadDetails>
    readonly addUserMessage: (
      input: AddReviewThreadUserMessageRequest,
    ) => Promise<ReviewThreadDetails>
    readonly get: (threadId: ReviewThreadId) => Promise<ReviewThreadDetails>
    readonly runAgent: (input: RunReviewThreadAgentRequest) => Promise<ReviewThreadDetails>
    readonly onAgentProgress: EventSubscription<ReviewAgentProgress>
  }
  readonly settings: {
    readonly get: () => Promise<AISettings>
    readonly update: (settings: AISettings) => Promise<AISettings>
  }
  readonly appState: {
    readonly get: () => Promise<AppState>
    readonly update: (state: AppState) => Promise<AppState>
  }
  readonly providers: {
    readonly list: () => Promise<readonly GitProviderDescriptor[]>
  }
  readonly hostedRepositories: {
    readonly searchRepositories: (
      request: HostedRepositorySearchRequest,
    ) => Promise<readonly HostedRepository[]>
    readonly listSearchScopes: (
      request: HostedProviderRequest,
    ) => Promise<readonly RepositorySearchScope[]>
  }
  readonly hostedReviews: {
    readonly list: (request: HostedRepositoryRequest) => Promise<readonly HostedReviewSummary[]>
    readonly listAssigned: (
      request: HostedProviderRequest,
    ) => Promise<readonly HostedReviewSummary[]>
    readonly getDecision: (request: HostedReviewRequest) => Promise<ReviewDecision>
    readonly getDetail: (request: HostedReviewRequest) => Promise<HostedReviewDetail>
    readonly getChecks: (request: HostedReviewRequest) => Promise<readonly HostedReviewCheck[]>
    readonly submitDecision: (request: SubmitHostedReviewDecisionRequest) => Promise<void>
    readonly close: (request: CloseHostedReviewRequest) => Promise<void>
    readonly merge: (request: MergeHostedReviewRequest) => Promise<void>
    readonly updateBranch: (request: HostedReviewRequest) => Promise<void>
  }
  readonly localReviews: {
    readonly resolveBranch: (
      localPath: RepositoryCheckoutPath,
      branchName: RepositoryComparisonRef | null,
    ) => Promise<LocalReviewTarget>
    readonly resolveLastCommit: (localPath: RepositoryCheckoutPath) => Promise<LocalReviewTarget>
  }
  readonly repositoryComparisons: {
    readonly resolve: (
      command: OpenRepositoryComparisonCommand,
    ) => Promise<ResolvedRepositoryComparison>
    readonly openFile: (request: OpenRepositoryComparisonFileRequest) => Promise<void>
  }
  readonly reviewSnapshots: {
    readonly acquireHosted: (request: HostedReviewRequest) => Promise<HostedReviewSnapshotManifest>
    readonly acquireLocal: (target: LocalReviewTarget) => Promise<LocalReviewSnapshotManifest>
    readonly acquireRepositoryComparison: (
      target: RepositoryComparisonTarget,
    ) => Promise<RepositoryComparisonSnapshotManifest>
  }
  readonly progressiveReviews: ProgressiveReviewApi
  readonly viewedFiles: {
    readonly list: (request: HostedViewedFilesRequest) => Promise<readonly ViewedFileRecord[]>
    readonly set: (request: SetHostedViewedFileRequest) => Promise<void>
    readonly listLocal: (request: LocalViewedFilesRequest) => Promise<readonly ViewedFileRecord[]>
    readonly setLocal: (request: SetLocalViewedFileRequest) => Promise<void>
    readonly listRepositoryComparison: (
      request: RepositoryComparisonViewedFilesRequest,
    ) => Promise<readonly ViewedFileRecord[]>
    readonly setRepositoryComparison: (
      request: SetRepositoryComparisonViewedFileRequest,
    ) => Promise<void>
  }
  readonly walkthroughOperations: {
    readonly start: (
      request: WalkthroughBridgeStartRequest,
    ) => Promise<WalkthroughStartBridgeResult>
    readonly getOperation: (
      request: WalkthroughBridgeOperationRequest,
    ) => Promise<WalkthroughGetOperationBridgeResult>
    readonly cancel: (
      request: WalkthroughBridgeOperationRequest,
    ) => Promise<WalkthroughCancelBridgeResult>
    readonly getStored: (
      request: WalkthroughBridgeGetStoredRequest,
    ) => Promise<WalkthroughGetStoredBridgeResult>
    readonly onHint: EventSubscription<WalkthroughOperationBridgeHint>
  }
}

type BridgeApiMember<Value> = Value extends (
  ...arguments_: infer Arguments
) => Promise<infer Result>
  ? (...arguments_: Arguments) => Promise<RendererBridgeResult<Result>>
  : Value extends EventSubscription<infer Event>
    ? EventSubscription<RendererBridgeResult<Event>>
    : Value extends (...arguments_: infer Arguments) => infer Result
      ? (...arguments_: Arguments) => Result
      : Value extends object
        ? { readonly [Key in keyof Value]: BridgeApiMember<Value[Key]> }
        : Value

type MappedDiffDashBridgeApi = {
  readonly [Key in keyof DiffDashApi]: BridgeApiMember<DiffDashApi[Key]>
}

/** Electron bridge variant wrapping invoke results and exposing stream cancellation. */
export type DiffDashBridgeApi = Omit<MappedDiffDashBridgeApi, "codeWorkspace"> & {
  readonly codeWorkspace: Omit<MappedDiffDashBridgeApi["codeWorkspace"], "readFile"> & {
    readonly readFile: (
      request: ReadCodeWorkspaceFileRequest,
      registerCancellation?: CodeWorkspaceFileStreamCancellationRegistrar,
    ) => Promise<RendererBridgeResult<CodeWorkspaceFileReadResult>>
  }
}
