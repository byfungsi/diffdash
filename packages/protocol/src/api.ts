import type { AISettings } from "@diffdash/domain/ai-settings"
import type { AnalyticsEvent } from "./analytics"
import type { AppState } from "@diffdash/domain/app-state"
import type { AppUpdateState } from "./app-update"
import type { CliNavigationCommand } from "./cli-navigation"
import type {
  LocalReviewDetail,
  LocalReviewDiff,
  LocalReviewTarget,
} from "@diffdash/domain/local-review"
import type {
  PullRequestDetail,
  PullRequestDiff,
  PullRequestSummary,
} from "@diffdash/domain/pull-request"
import type {
  Repo,
  RepositorySearchRequest,
  RepositorySearchResult,
  RepositorySearchScope,
} from "@diffdash/domain/repository"
import type { ReviewAgentProgress } from "@diffdash/domain/review-agent"
import type { LocalReviewSnapshot } from "@diffdash/domain/review-context"
import type { AppPrerequisites, DiffDashCliInstallResult } from "./prerequisites"
import type { LinkRepositoryCheckoutRequest } from "./repository-link"
import type {
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import type {
  AddReviewThreadUserMessageRequest,
  CreateReviewThreadRequest,
  RunReviewThreadAgentRequest,
} from "./review-threads"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"

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
  readonly installDiffDashCli: () => Promise<DiffDashCliInstallResult>
  readonly openExternalUrl: (url: string) => Promise<void>
  readonly openRepositoryFile: (
    owner: string,
    name: string,
    filePath: string,
    headRefName: string,
    headRefOid: string | null,
  ) => Promise<void>
  readonly openLocalRepositoryFile: (rootPath: string, filePath: string) => Promise<void>
  readonly repositories: {
    readonly list: (query?: string) => Promise<readonly Repo[]>
    readonly setFavorite: (id: string, isFavorite: boolean) => Promise<Repo>
    readonly favoriteRemote: (repo: RepositorySearchResult) => Promise<Repo>
    readonly addLocal: (localPath: string) => Promise<Repo>
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
  readonly gitProvider: {
    readonly searchRepositories: (
      request: RepositorySearchRequest,
    ) => Promise<readonly RepositorySearchResult[]>
    readonly listSearchScopes: () => Promise<readonly RepositorySearchScope[]>
    readonly listPullRequests: (
      owner: string,
      name: string,
    ) => Promise<readonly PullRequestSummary[]>
    readonly listReviewRequests: () => Promise<readonly PullRequestSummary[]>
    readonly getPullRequestDetail: (
      owner: string,
      name: string,
      number: number,
    ) => Promise<PullRequestDetail>
    readonly refreshPullRequestDetail: (
      owner: string,
      name: string,
      number: number,
    ) => Promise<PullRequestDetail>
    readonly getPullRequestDiff: (
      owner: string,
      name: string,
      number: number,
    ) => Promise<PullRequestDiff>
    readonly hasApprovedPullRequest: (
      owner: string,
      name: string,
      number: number,
    ) => Promise<boolean>
    readonly approvePullRequest: (owner: string, name: string, number: number) => Promise<void>
  }
  readonly localReviews: {
    readonly resolveBranch: (
      localPath: string,
      branchName: string | null,
    ) => Promise<LocalReviewTarget>
    readonly getDetail: (target: LocalReviewTarget) => Promise<LocalReviewDetail>
    readonly getDiff: (target: LocalReviewTarget) => Promise<LocalReviewDiff>
    readonly getSnapshot: (target: LocalReviewTarget) => Promise<LocalReviewSnapshot>
  }
  readonly viewedFiles: {
    readonly list: (
      owner: string,
      name: string,
      number: number,
      headSha: string,
    ) => Promise<readonly string[]>
    readonly set: (
      owner: string,
      name: string,
      number: number,
      headSha: string,
      reviewKey: string,
      filePath: string,
      viewed: boolean,
    ) => Promise<void>
    readonly listLocal: (rootPath: string, headSha: string) => Promise<readonly string[]>
    readonly setLocal: (
      rootPath: string,
      headSha: string,
      reviewKey: string,
      filePath: string,
      viewed: boolean,
    ) => Promise<void>
  }
  readonly walkthroughs: {
    readonly get: (
      owner: string,
      name: string,
      number: number,
      baseSha: string,
      headSha: string,
    ) => Promise<StoredWalkthrough | null>
    readonly generate: (owner: string, name: string, number: number) => Promise<StoredWalkthrough>
    readonly regenerate: (owner: string, name: string, number: number) => Promise<StoredWalkthrough>
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
