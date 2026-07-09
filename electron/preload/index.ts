import { contextBridge, ipcRenderer } from "electron"
import type { IpcRendererEvent } from "electron"

import type { AppState } from "../../src/shared/app-state"
import type {
  LocalReviewDetail,
  LocalReviewDiff,
  PullRequestDetail,
  PullRequestDiff,
  PullRequestSummary,
  RepositorySearchResult,
  RepositorySearchScope,
  Repo,
} from "../../src/shared/domain"
import type { AISettings } from "../../src/shared/ai-settings"
import type { AppPrerequisites, DiffDashCliInstallResult } from "../../src/shared/prerequisites"
import type { StoredWalkthrough } from "../../src/shared/walkthrough"

const invoke = <A>(channel: string, ...args: readonly unknown[]): Promise<A> => {
  // SAFETY: Each channel is registered in `electron/main/index.ts` with the matching return type.
  return ipcRenderer.invoke(channel, ...args) as Promise<A>
}

const api = {
  navigation: {
    getPendingLocalReview: () => invoke<string | null>("navigation:getPendingLocalReview"),
    onOpenLocalReview: (listener: (rootPath: string) => void) => {
      const wrapped = (_event: IpcRendererEvent, rootPath: string) => listener(rootPath)
      ipcRenderer.on("navigation:openLocalReview", wrapped)
      return () => {
        ipcRenderer.removeListener("navigation:openLocalReview", wrapped)
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
    selectLocalFolder: () => invoke<string | null>("repositories:selectLocalFolder"),
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
    searchRepositories: (query: string) =>
      invoke<readonly RepositorySearchResult[]>("gitProvider:searchRepositories", query),
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
