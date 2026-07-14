import { contextBridge, ipcRenderer } from "electron"
import type { IpcRendererEvent } from "electron"

import type { AppState } from "../../src/shared/app-state"
import type { AppUpdateState } from "../../src/shared/app-update"
import type { AnalyticsEvent } from "../../src/shared/analytics"
import type {
  LocalReviewDetail,
  LocalReviewDiff,
  PullRequestDetail,
  PullRequestDiff,
  PullRequestSummary,
  RepositorySearchRequest,
  RepositorySearchResult,
  RepositorySearchScope,
  Repo,
} from "../../src/shared/domain"
import type { AISettings } from "../../src/shared/ai-settings"
import type { AppPrerequisites, DiffDashCliInstallResult } from "../../src/shared/prerequisites"
import type { LinkRepositoryCheckoutRequest } from "../../src/shared/repository-link"
import type { ReviewAgentProgress } from "../../src/shared/review-agent"
import type { StoredWalkthrough } from "../../src/shared/walkthrough"
import type {
  AddReviewThreadUserMessageRequest,
  CreateReviewThreadRequest,
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  RunReviewThreadAgentRequest,
  ReviewThreadTarget,
} from "../../src/shared/review-thread"

const invoke = async <A>(channel: string, ...args: readonly unknown[]): Promise<A> => {
  try {
    // SAFETY: Each channel is registered in `electron/main/index.ts` with the matching return type.
    return (await ipcRenderer.invoke(channel, ...args)) as A
  } catch (cause) {
    throw new Error(`${channel} failed: ${ipcErrorMessage(cause)}`, { cause })
  }
}

const ipcErrorMessage = (cause: unknown) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause)

const api = {
  analytics: {
    start: () => invoke<void>("analytics:start"),
    capture: (event: AnalyticsEvent) => invoke<void>("analytics:capture", event),
  },
  updates: {
    getState: () => invoke<AppUpdateState>("updates:getState"),
    check: () => invoke<void>("updates:check"),
    download: () => invoke<void>("updates:download"),
    restartAndInstall: () => invoke<void>("updates:restartAndInstall"),
    onStateChanged: (listener: (state: AppUpdateState) => void) => {
      const wrapped = (_event: IpcRendererEvent, state: AppUpdateState) => listener(state)
      ipcRenderer.on("updates:stateChanged", wrapped)
      return () => {
        ipcRenderer.removeListener("updates:stateChanged", wrapped)
      }
    },
  },
  navigation: {
    getPendingLocalReview: () => invoke<string | null>("navigation:getPendingLocalReview"),
    getPendingRepositoryLink: () => invoke<string | null>("navigation:getPendingRepositoryLink"),
    onOpenLocalReview: (listener: (rootPath: string) => void) => {
      const wrapped = (_event: IpcRendererEvent, rootPath: string) => listener(rootPath)
      ipcRenderer.on("navigation:openLocalReview", wrapped)
      return () => {
        ipcRenderer.removeListener("navigation:openLocalReview", wrapped)
      }
    },
    onLinkRepository: (listener: (rootPath: string) => void) => {
      const wrapped = (_event: IpcRendererEvent, rootPath: string) => listener(rootPath)
      ipcRenderer.on("navigation:linkRepository", wrapped)
      return () => {
        ipcRenderer.removeListener("navigation:linkRepository", wrapped)
      }
    },
  },
  diagnostics: () => invoke<AppPrerequisites>("app:diagnostics"),
  installDiffDashCli: () => invoke<DiffDashCliInstallResult>("app:installDiffDashCli"),
  openExternalUrl: (url: string) => invoke<void>("app:openExternalUrl", url),
  openRepositoryFile: (
    owner: string,
    name: string,
    filePath: string,
    headRefName: string,
    headRefOid: string | null,
  ) => invoke<void>("app:openRepositoryFile", owner, name, filePath, headRefName, headRefOid),
  openLocalRepositoryFile: (rootPath: string, filePath: string) =>
    invoke<void>("app:openLocalRepositoryFile", rootPath, filePath),
  repositories: {
    list: (query?: string) => invoke<readonly Repo[]>("repositories:list", query),
    setFavorite: (id: string, isFavorite: boolean) =>
      invoke<Repo>("repositories:setFavorite", id, isFavorite),
    favoriteRemote: (repo: RepositorySearchResult) =>
      invoke<Repo>("repositories:favoriteRemote", repo),
    addLocal: (localPath: string) => invoke<Repo>("repositories:addLocal", localPath),
    install: (localPath: string) => invoke<Repo>("repositories:install", localPath),
    link: (input: LinkRepositoryCheckoutRequest) => invoke<Repo>("repositories:link", input),
    selectLocalFolder: () => invoke<string | null>("repositories:selectLocalFolder"),
  },
  reviewThreads: {
    list: (target: ReviewThreadTarget) =>
      invoke<readonly ReviewThread[]>("reviewThreads:list", target),
    create: (input: CreateReviewThreadRequest) =>
      invoke<ReviewThreadDetails>("reviewThreads:create", input),
    addUserMessage: (input: AddReviewThreadUserMessageRequest) =>
      invoke<ReviewThreadDetails>("reviewThreads:addUserMessage", input),
    get: (threadId: ReviewThreadId) =>
      invoke<ReviewThreadDetails>("reviewThreads:get", { threadId }),
    runAgent: (input: RunReviewThreadAgentRequest) =>
      invoke<ReviewThreadDetails>("reviewThreads:runAgent", input),
    onAgentProgress: (listener: (progress: ReviewAgentProgress) => void) => {
      const wrapped = (_event: IpcRendererEvent, progress: ReviewAgentProgress) =>
        listener(progress)
      ipcRenderer.on("reviewThreads:agentProgress", wrapped)
      return () => {
        ipcRenderer.removeListener("reviewThreads:agentProgress", wrapped)
      }
    },
  },
  settings: {
    get: () => invoke<AISettings>("settings:get"),
    update: (settings: AISettings) => invoke<AISettings>("settings:update", settings),
  },
  appState: {
    get: () => invoke<AppState>("appState:get"),
    update: (state: AppState) => invoke<AppState>("appState:update", state),
  },
  gitProvider: {
    searchRepositories: (request: RepositorySearchRequest) =>
      invoke<readonly RepositorySearchResult[]>("gitProvider:searchRepositories", request),
    listSearchScopes: () =>
      invoke<readonly RepositorySearchScope[]>("gitProvider:listSearchScopes"),
    listPullRequests: (owner: string, name: string) =>
      invoke<readonly PullRequestSummary[]>("gitProvider:listPullRequests", owner, name),
    listReviewRequests: () =>
      invoke<readonly PullRequestSummary[]>("gitProvider:listReviewRequests"),
    getPullRequestDetail: (owner: string, name: string, number: number) =>
      invoke<PullRequestDetail>("gitProvider:getPullRequestDetail", owner, name, number),
    refreshPullRequestDetail: (owner: string, name: string, number: number) =>
      invoke<PullRequestDetail>("gitProvider:refreshPullRequestDetail", owner, name, number),
    getPullRequestDiff: (owner: string, name: string, number: number) =>
      invoke<PullRequestDiff>("gitProvider:getPullRequestDiff", owner, name, number),
    hasApprovedPullRequest: (owner: string, name: string, number: number) =>
      invoke<boolean>("gitProvider:hasApprovedPullRequest", owner, name, number),
    approvePullRequest: (owner: string, name: string, number: number) =>
      invoke<void>("gitProvider:approvePullRequest", owner, name, number),
  },
  localReviews: {
    getDetail: (rootPath: string) => invoke<LocalReviewDetail>("localReviews:getDetail", rootPath),
    getDiff: (rootPath: string) => invoke<LocalReviewDiff>("localReviews:getDiff", rootPath),
  },
  viewedFiles: {
    list: (owner: string, name: string, number: number, headSha: string) =>
      invoke<readonly string[]>("viewedFiles:list", owner, name, number, headSha),
    set: (
      owner: string,
      name: string,
      number: number,
      headSha: string,
      reviewKey: string,
      filePath: string,
      viewed: boolean,
    ) => invoke<void>("viewedFiles:set", owner, name, number, headSha, reviewKey, filePath, viewed),
    listLocal: (rootPath: string, headSha: string) =>
      invoke<readonly string[]>("viewedFiles:listLocal", rootPath, headSha),
    setLocal: (
      rootPath: string,
      headSha: string,
      reviewKey: string,
      filePath: string,
      viewed: boolean,
    ) => invoke<void>("viewedFiles:setLocal", rootPath, headSha, reviewKey, filePath, viewed),
  },
  walkthroughs: {
    get: (owner: string, name: string, number: number, baseSha: string, headSha: string) =>
      invoke<StoredWalkthrough | null>("walkthroughs:get", owner, name, number, baseSha, headSha),
    generate: (owner: string, name: string, number: number) =>
      invoke<StoredWalkthrough>("walkthroughs:generate", owner, name, number, false),
    regenerate: (owner: string, name: string, number: number) =>
      invoke<StoredWalkthrough>("walkthroughs:generate", owner, name, number, true),
  },
  localWalkthroughs: {
    get: (rootPath: string, baseSha: string, headSha: string) =>
      invoke<StoredWalkthrough | null>("localWalkthroughs:get", rootPath, baseSha, headSha),
    generate: (rootPath: string) =>
      invoke<StoredWalkthrough>("localWalkthroughs:generate", rootPath, false),
    regenerate: (rootPath: string) =>
      invoke<StoredWalkthrough>("localWalkthroughs:generate", rootPath, true),
  },
}

contextBridge.exposeInMainWorld("diffDash", api)

/** Typed renderer API exposed through Electron preload. */
export type DiffDashApi = typeof api
