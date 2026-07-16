import { contextBridge, ipcRenderer } from "electron"
import type { IpcRendererEvent } from "electron"

import type { AppState } from "@diffdash/domain/app-state"
import type { AppUpdateState } from "@diffdash/protocol/app-update"
import type { AnalyticsEvent } from "@diffdash/protocol/analytics"
import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import type { LocalReviewDetail, LocalReviewDiff } from "@diffdash/domain/local-review"
import type {
  PullRequestDetail,
  PullRequestDiff,
  PullRequestSummary,
} from "@diffdash/domain/pull-request"
import type {
  RepositorySearchResult,
  RepositorySearchScope,
  Repo,
} from "@diffdash/domain/repository"
import type { AISettings } from "@diffdash/domain/ai-settings"
import type { DiffDashApi } from "@diffdash/protocol/api"
import type { AppPrerequisites, DiffDashCliInstallResult } from "@diffdash/protocol/prerequisites"
import type { LinkRepositoryCheckoutRequest } from "@diffdash/protocol/repository-link"
import type { LocalReviewTarget } from "@diffdash/domain/local-review"
import type { LocalReviewSnapshot } from "@diffdash/domain/review-context"
import type { ReviewAgentProgress } from "@diffdash/domain/review-agent"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
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
} from "@diffdash/protocol/review-threads"
import type { GitProviderDescriptor, ReviewDecision } from "@diffdash/domain/git-provider"
import type {
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
} from "@diffdash/protocol/hosted-git"

const invoke = async <A>(channel: InvokeChannel, ...args: readonly unknown[]): Promise<A> => {
  try {
    // SAFETY: Each channel is registered in `electron/main/index.ts` with the matching return type.
    return (await ipcRenderer.invoke(channel, ...args)) as A
  } catch (cause) {
    throw new Error(`${channel} failed: ${ipcErrorMessage(cause)}`, { cause })
  }
}

const ipcErrorMessage = (cause: unknown) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause)

const api: DiffDashApi = {
  analytics: {
    start: () => invoke<void>(InvokeChannel.analyticsStart),
    capture: (event: AnalyticsEvent) => invoke<void>(InvokeChannel.analyticsCapture, event),
  },
  updates: {
    getState: () => invoke<AppUpdateState>(InvokeChannel.updatesGetState),
    check: () => invoke<void>(InvokeChannel.updatesCheck),
    download: () => invoke<void>(InvokeChannel.updatesDownload),
    restartAndInstall: () => invoke<void>(InvokeChannel.updatesRestartAndInstall),
    onStateChanged: (listener: (state: AppUpdateState) => void) => {
      const wrapped = (_event: IpcRendererEvent, state: AppUpdateState) => listener(state)
      ipcRenderer.on(EventChannel.updateStateChanged, wrapped)
      return () => {
        ipcRenderer.removeListener(EventChannel.updateStateChanged, wrapped)
      }
    },
  },
  navigation: {
    drainCommands: () =>
      invoke<readonly CliNavigationCommand[]>(InvokeChannel.drainNavigationCommands),
    onCommandsAvailable: (listener: () => void) => {
      const wrapped = () => listener()
      ipcRenderer.on(EventChannel.navigationCommandsAvailable, wrapped)
      return () => {
        ipcRenderer.removeListener(EventChannel.navigationCommandsAvailable, wrapped)
      }
    },
  },
  diagnostics: () => invoke<AppPrerequisites>(InvokeChannel.appDiagnostics),
  installDiffDashCli: () => invoke<DiffDashCliInstallResult>(InvokeChannel.appInstallDiffDashCli),
  openExternalUrl: (url: string) => invoke<void>(InvokeChannel.appOpenExternalUrl, url),
  openRepositoryFile: (request: OpenHostedReviewFileRequest) =>
    invoke<void>(InvokeChannel.appOpenRepositoryFile, request),
  openLocalRepositoryFile: (rootPath: string, filePath: string) =>
    invoke<void>(InvokeChannel.appOpenLocalRepositoryFile, rootPath, filePath),
  repositories: {
    list: (query?: string) => invoke<readonly Repo[]>(InvokeChannel.listRepositories, query),
    setFavorite: (id: string, isFavorite: boolean) =>
      invoke<Repo>(InvokeChannel.setRepositoryFavorite, id, isFavorite),
    favoriteRemote: (repo: RepositorySearchResult) =>
      invoke<Repo>(InvokeChannel.favoriteRemoteRepository, repo),
    addLocal: (localPath: string) => invoke<Repo>(InvokeChannel.addLocalRepository, localPath),
    install: (localPath: string) => invoke<Repo>(InvokeChannel.installRepository, localPath),
    link: (input: LinkRepositoryCheckoutRequest) =>
      invoke<Repo>(InvokeChannel.linkRepository, input),
    selectLocalFolder: () => invoke<string | null>(InvokeChannel.selectLocalFolder),
  },
  reviewThreads: {
    list: (target: ReviewThreadTarget) =>
      invoke<readonly ReviewThread[]>(InvokeChannel.listReviewThreads, target),
    create: (input: CreateReviewThreadRequest) =>
      invoke<ReviewThreadDetails>(InvokeChannel.createReviewThread, input),
    addUserMessage: (input: AddReviewThreadUserMessageRequest) =>
      invoke<ReviewThreadDetails>(InvokeChannel.addReviewThreadUserMessage, input),
    get: (threadId: ReviewThreadId) =>
      invoke<ReviewThreadDetails>(InvokeChannel.getReviewThread, { threadId }),
    runAgent: (input: RunReviewThreadAgentRequest) =>
      invoke<ReviewThreadDetails>(InvokeChannel.runReviewThreadAgent, input),
    onAgentProgress: (listener: (progress: ReviewAgentProgress) => void) => {
      const wrapped = (_event: IpcRendererEvent, progress: ReviewAgentProgress) =>
        listener(progress)
      ipcRenderer.on(EventChannel.reviewThreadAgentProgress, wrapped)
      return () => {
        ipcRenderer.removeListener(EventChannel.reviewThreadAgentProgress, wrapped)
      }
    },
  },
  settings: {
    get: () => invoke<AISettings>(InvokeChannel.settingsGet),
    update: (settings: AISettings) => invoke<AISettings>(InvokeChannel.settingsUpdate, settings),
  },
  appState: {
    get: () => invoke<AppState>(InvokeChannel.appStateGet),
    update: (state: AppState) => invoke<AppState>(InvokeChannel.appStateUpdate, state),
  },
  providers: {
    list: () => invoke<readonly GitProviderDescriptor[]>(InvokeChannel.listProviders),
  },
  hostedRepositories: {
    searchRepositories: (request: HostedRepositorySearchRequest) =>
      invoke<readonly RepositorySearchResult[]>(InvokeChannel.searchHostedRepositories, request),
    listSearchScopes: (request: HostedProviderRequest) =>
      invoke<readonly RepositorySearchScope[]>(
        InvokeChannel.listHostedRepositorySearchScopes,
        request,
      ),
  },
  hostedReviews: {
    list: (request: HostedRepositoryRequest) =>
      invoke<readonly PullRequestSummary[]>(InvokeChannel.listHostedReviews, request),
    listAssigned: (request: HostedProviderRequest) =>
      invoke<readonly PullRequestSummary[]>(InvokeChannel.listAssignedHostedReviews, request),
    get: (request: HostedReviewRequest) =>
      invoke<PullRequestDetail>(InvokeChannel.getHostedReview, request),
    refresh: (request: HostedReviewRequest) =>
      invoke<PullRequestDetail>(InvokeChannel.refreshHostedReview, request),
    getDiff: (request: HostedReviewRequest) =>
      invoke<PullRequestDiff>(InvokeChannel.getHostedReviewDiff, request),
    getDecision: (request: HostedReviewRequest) =>
      invoke<ReviewDecision>(InvokeChannel.getHostedReviewDecision, request),
    submitDecision: (request: SubmitHostedReviewDecisionRequest) =>
      invoke<void>(InvokeChannel.submitHostedReviewDecision, request),
  },
  localReviews: {
    resolveBranch: (localPath: string, branchName: string | null) =>
      invoke<LocalReviewTarget>(InvokeChannel.resolveLocalBranch, localPath, branchName),
    getDetail: (target: LocalReviewTarget) =>
      invoke<LocalReviewDetail>(InvokeChannel.localReviewDetail, target),
    getDiff: (target: LocalReviewTarget) =>
      invoke<LocalReviewDiff>(InvokeChannel.localReviewDiff, target),
    getSnapshot: (target: LocalReviewTarget) =>
      invoke<LocalReviewSnapshot>(InvokeChannel.localReviewSnapshot, target),
  },
  viewedFiles: {
    list: (request: HostedViewedFilesRequest) =>
      invoke<readonly string[]>(InvokeChannel.listViewedFiles, request),
    set: (request: SetHostedViewedFileRequest) =>
      invoke<void>(InvokeChannel.setViewedFile, request),
    listLocal: (rootPath: string, headSha: string) =>
      invoke<readonly string[]>(InvokeChannel.listLocalViewedFiles, rootPath, headSha),
    setLocal: (
      rootPath: string,
      headSha: string,
      reviewKey: string,
      filePath: string,
      viewed: boolean,
    ) =>
      invoke<void>(
        InvokeChannel.setLocalViewedFile,
        rootPath,
        headSha,
        reviewKey,
        filePath,
        viewed,
      ),
  },
  walkthroughs: {
    get: (request: HostedWalkthroughRequest) =>
      invoke<StoredWalkthrough | null>(InvokeChannel.getWalkthrough, request),
    generate: (request: GenerateHostedWalkthroughRequest) =>
      invoke<StoredWalkthrough>(InvokeChannel.generateWalkthrough, request),
  },
  localWalkthroughs: {
    get: (target: LocalReviewTarget, baseSha: string, headSha: string) =>
      invoke<StoredWalkthrough | null>(InvokeChannel.getLocalWalkthrough, target, baseSha, headSha),
    generate: (target: LocalReviewTarget) =>
      invoke<StoredWalkthrough>(InvokeChannel.generateLocalWalkthrough, target, false),
    regenerate: (target: LocalReviewTarget) =>
      invoke<StoredWalkthrough>(InvokeChannel.generateLocalWalkthrough, target, true),
  },
}

contextBridge.exposeInMainWorld("diffDash", api)

/** Typed renderer API exposed through Electron preload. */
export type { DiffDashApi } from "@diffdash/protocol/api"
