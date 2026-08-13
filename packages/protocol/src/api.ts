import type { AISettings } from "@diffdash/domain/ai-settings"
import type { AppState } from "@diffdash/domain/app-state"
import type {
  GitProviderDescriptor,
  HostedRepository,
  HostedRepositoryLocator,
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
import type { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import type { WebUrl } from "@diffdash/domain/web-url"
import type { AgentProviderCatalog } from "./agent-providers"
import type { AnalyticsEvent } from "./analytics"
import type { AppUpdateState } from "./app-update"
import type { CliNavigationCommand } from "./cli-navigation"
import type { OpenRepositoryComparisonCommand } from "./cli-navigation"
import type {
  GenerateHostedWalkthroughRequest,
  HostedProviderRequest,
  HostedRepositoryRequest,
  HostedRepositorySearchRequest,
  HostedReviewRequest,
  HostedWalkthroughRequest,
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
  ReviewSnapshotPageRequest,
  ReviewSnapshotPageResponse,
  ReviewSnapshotSearchRequest,
  ReviewSnapshotSearchResponse,
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
import type { BridgeResult } from "./ipc"

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
  readonly agentProviders: {
    readonly getCatalog: () => Promise<AgentProviderCatalog>
  }
  readonly installDiffDashCli: () => Promise<DiffDashCliInstallResult>
  readonly openExternalUrl: (url: WebUrl) => Promise<void>
  readonly openRepositoryFile: (request: OpenHostedReviewFileRequest) => Promise<void>
  readonly openLocalRepositoryFile: (
    rootPath: RepositoryCheckoutPath,
    filePath: RepositoryRelativePath,
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
    readonly submitDecision: (request: SubmitHostedReviewDecisionRequest) => Promise<void>
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
    readonly getPage: (request: ReviewSnapshotPageRequest) => Promise<ReviewSnapshotPageResponse>
    readonly search: (request: ReviewSnapshotSearchRequest) => Promise<ReviewSnapshotSearchResponse>
  }
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
  readonly walkthroughs: {
    readonly get: (request: HostedWalkthroughRequest) => Promise<StoredWalkthrough | null>
    readonly generate: (request: GenerateHostedWalkthroughRequest) => Promise<StoredWalkthrough>
  }
  readonly localWalkthroughs: {
    readonly get: (
      target: LocalReviewTarget,
      baseSha: ReviewRevision,
      headSha: ReviewRevision,
    ) => Promise<StoredWalkthrough | null>
    readonly generate: (target: LocalReviewTarget) => Promise<StoredWalkthrough>
    readonly regenerate: (target: LocalReviewTarget) => Promise<StoredWalkthrough>
  }
  readonly repositoryComparisonWalkthroughs: {
    readonly get: (target: RepositoryComparisonTarget) => Promise<StoredWalkthrough | null>
    readonly generate: (target: RepositoryComparisonTarget) => Promise<StoredWalkthrough>
    readonly regenerate: (target: RepositoryComparisonTarget) => Promise<StoredWalkthrough>
  }
}

type BridgeApiMember<Value> = Value extends (
  ...arguments_: infer Arguments
) => Promise<infer Result>
  ? (...arguments_: Arguments) => Promise<BridgeResult<Result>>
  : Value extends EventSubscription<infer Event>
    ? EventSubscription<BridgeResult<Event>>
    : Value extends (...arguments_: infer Arguments) => infer Result
      ? (...arguments_: Arguments) => Result
      : Value extends object
        ? { readonly [Key in keyof Value]: BridgeApiMember<Value[Key]> }
        : Value

/** Electron bridge variant wrapping invoke results and event notifications. */
export type DiffDashBridgeApi = {
  readonly [Key in keyof DiffDashApi]: BridgeApiMember<DiffDashApi[Key]>
}
