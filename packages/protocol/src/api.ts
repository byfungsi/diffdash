import type { AISettings } from "@diffdash/domain/ai-settings"
import type { AppState } from "@diffdash/domain/app-state"
import type {
  GitProviderDescriptor,
  HostedRepository,
  HostedReviewSummary,
  ReviewDecision,
} from "@diffdash/domain/git-provider"
import type { LocalReviewTarget } from "@diffdash/domain/local-review"
import type { Repo, RepositorySearchScope } from "@diffdash/domain/repository"
import type { ReviewAgentProgress } from "@diffdash/domain/review-agent"
import type {
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
} from "@diffdash/domain/review-context"
import type {
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import type { AgentProviderCatalog } from "./agent-providers"
import type { AnalyticsEvent } from "./analytics"
import type { AppUpdateState } from "./app-update"
import type { CliNavigationCommand } from "./cli-navigation"
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
} from "./review-snapshot"
import type {
  HostedViewedFilesRequest,
  LocalViewedFilesRequest,
  SetHostedViewedFileRequest,
  SetLocalViewedFileRequest,
  ViewedFileRecord,
} from "./viewed-files"

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
    readonly onStateChanged: (listener: (state: AppUpdateState) => void) => () => void
  }
  readonly navigation: {
    readonly drainCommands: () => Promise<readonly CliNavigationCommand[]>
    readonly onCommandsAvailable: (listener: () => void) => () => void
  }
  readonly diagnostics: () => Promise<AppPrerequisites>
  readonly agentProviders: {
    readonly getCatalog: () => Promise<AgentProviderCatalog>
  }
  readonly installDiffDashCli: () => Promise<DiffDashCliInstallResult>
  readonly openExternalUrl: (url: string) => Promise<void>
  readonly openRepositoryFile: (request: OpenHostedReviewFileRequest) => Promise<void>
  readonly openLocalRepositoryFile: (rootPath: string, filePath: string) => Promise<void>
  readonly repositories: {
    readonly list: (query?: string) => Promise<readonly Repo[]>
    readonly setFavorite: (id: string, isFavorite: boolean) => Promise<Repo>
    readonly favoriteRemote: (repo: HostedRepository) => Promise<Repo>
    readonly install: (localPath: string) => Promise<Repo>
    readonly link: (input: LinkRepositoryCheckoutRequest) => Promise<Repo>
    readonly selectLocalFolder: () => Promise<string | null>
  }
  readonly reviewThreads: {
    readonly list: (target: ReviewThreadTarget) => Promise<readonly ReviewThread[]>
    readonly create: (input: CreateReviewThreadRequest) => Promise<ReviewThreadDetails>
    readonly addUserMessage: (
      input: AddReviewThreadUserMessageRequest,
    ) => Promise<ReviewThreadDetails>
    readonly get: (threadId: ReviewThreadId) => Promise<ReviewThreadDetails>
    readonly runAgent: (input: RunReviewThreadAgentRequest) => Promise<ReviewThreadDetails>
    readonly onAgentProgress: (listener: (progress: ReviewAgentProgress) => void) => () => void
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
      localPath: string,
      branchName: string | null,
    ) => Promise<LocalReviewTarget>
  }
  readonly reviewSnapshots: {
    readonly acquireHosted: (request: HostedReviewRequest) => Promise<HostedReviewSnapshotManifest>
    readonly acquireLocal: (target: LocalReviewTarget) => Promise<LocalReviewSnapshotManifest>
    readonly getPage: (request: ReviewSnapshotPageRequest) => Promise<ReviewSnapshotPageResponse>
    readonly search: (request: ReviewSnapshotSearchRequest) => Promise<ReviewSnapshotSearchResponse>
  }
  readonly viewedFiles: {
    readonly list: (request: HostedViewedFilesRequest) => Promise<readonly ViewedFileRecord[]>
    readonly set: (request: SetHostedViewedFileRequest) => Promise<void>
    readonly listLocal: (request: LocalViewedFilesRequest) => Promise<readonly ViewedFileRecord[]>
    readonly setLocal: (request: SetLocalViewedFileRequest) => Promise<void>
  }
  readonly walkthroughs: {
    readonly get: (request: HostedWalkthroughRequest) => Promise<StoredWalkthrough | null>
    readonly generate: (request: GenerateHostedWalkthroughRequest) => Promise<StoredWalkthrough>
  }
  readonly localWalkthroughs: {
    readonly get: (
      target: LocalReviewTarget,
      baseSha: string,
      headSha: string,
    ) => Promise<StoredWalkthrough | null>
    readonly generate: (target: LocalReviewTarget) => Promise<StoredWalkthrough>
    readonly regenerate: (target: LocalReviewTarget) => Promise<StoredWalkthrough>
  }
}
