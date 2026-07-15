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
  RepositorySearchRequest,
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
  openRepositoryFile: (
    owner: string,
    name: string,
    filePath: string,
    headRefName: string,
    headRefOid: string | null,
  ) =>
    invoke<void>(
      InvokeChannel.appOpenRepositoryFile,
      owner,
      name,
      filePath,
      headRefName,
      headRefOid,
    ),
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
  gitProvider: {
    searchRepositories: (request: RepositorySearchRequest) =>
      invoke<readonly RepositorySearchResult[]>(InvokeChannel.searchRepositories, request),
    listSearchScopes: () =>
      invoke<readonly RepositorySearchScope[]>(InvokeChannel.listSearchScopes),
    listPullRequests: (owner: string, name: string) =>
      invoke<readonly PullRequestSummary[]>(InvokeChannel.listPullRequests, owner, name),
    listReviewRequests: () =>
      invoke<readonly PullRequestSummary[]>(InvokeChannel.listReviewRequests),
    getPullRequestDetail: (owner: string, name: string, number: number) =>
      invoke<PullRequestDetail>(InvokeChannel.getPullRequestDetail, owner, name, number),
    refreshPullRequestDetail: (owner: string, name: string, number: number) =>
      invoke<PullRequestDetail>(InvokeChannel.refreshPullRequestDetail, owner, name, number),
    getPullRequestDiff: (owner: string, name: string, number: number) =>
      invoke<PullRequestDiff>(InvokeChannel.getPullRequestDiff, owner, name, number),
    hasApprovedPullRequest: (owner: string, name: string, number: number) =>
      invoke<boolean>(InvokeChannel.hasApprovedPullRequest, owner, name, number),
    approvePullRequest: (owner: string, name: string, number: number) =>
      invoke<void>(InvokeChannel.approvePullRequest, owner, name, number),
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
    list: (owner: string, name: string, number: number, headSha: string) =>
      invoke<readonly string[]>(InvokeChannel.listViewedFiles, owner, name, number, headSha),
    set: (
      owner: string,
      name: string,
      number: number,
      headSha: string,
      reviewKey: string,
      filePath: string,
      viewed: boolean,
    ) =>
      invoke<void>(
        InvokeChannel.setViewedFile,
        owner,
        name,
        number,
        headSha,
        reviewKey,
        filePath,
        viewed,
      ),
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
    get: (owner: string, name: string, number: number, baseSha: string, headSha: string) =>
      invoke<StoredWalkthrough | null>(
        InvokeChannel.getWalkthrough,
        owner,
        name,
        number,
        baseSha,
        headSha,
      ),
    generate: (owner: string, name: string, number: number) =>
      invoke<StoredWalkthrough>(InvokeChannel.generateWalkthrough, owner, name, number, false),
    regenerate: (owner: string, name: string, number: number) =>
      invoke<StoredWalkthrough>(InvokeChannel.generateWalkthrough, owner, name, number, true),
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
