import type { AISettings } from "@diffdash/domain/ai-settings"

import type { AppState } from "@diffdash/domain/app-state"
import type { HostedRepository } from "@diffdash/domain/git-provider"
import type { LocalReviewTarget } from "@diffdash/domain/local-review"
import type { ReviewAgentProgress } from "@diffdash/domain/review-agent"
import type { ReviewThreadId, ReviewThreadTarget } from "@diffdash/domain/review-thread"
import type { AnalyticsEvent } from "@diffdash/protocol/analytics"
import type { DiffDashApi } from "@diffdash/protocol/api"
import type { AppUpdateState } from "@diffdash/protocol/app-update"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import type {
  GenerateHostedWalkthroughRequest,
  HostedProviderRequest,
  HostedRepositoryRequest,
  HostedRepositorySearchRequest,
  HostedReviewRequest,
  HostedWalkthroughRequest,
  OpenHostedReviewFileRequest,
  SubmitHostedReviewDecisionRequest,
} from "@diffdash/protocol/hosted-git"
import type { LinkRepositoryCheckoutRequest } from "@diffdash/protocol/repository-link"
import type {
  AddReviewThreadUserMessageRequest,
  CreateReviewThreadRequest,
  RunReviewThreadAgentRequest,
} from "@diffdash/protocol/review-threads"
import type {
  ReviewSnapshotPageRequest,
  ReviewSnapshotSearchRequest,
} from "@diffdash/protocol/review-snapshot"
import type {
  HostedViewedFilesRequest,
  LocalViewedFilesRequest,
  SetHostedViewedFileRequest,
  SetLocalViewedFileRequest,
} from "@diffdash/protocol/viewed-files"
import { contextBridge, ipcRenderer } from "electron"
import { createRendererTransport } from "./transport"

const transport = createRendererTransport({
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
  on: (channel, listener) => ipcRenderer.on(channel, listener),
  removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener),
})

const api: DiffDashApi = {
  analytics: {
    start: () => transport.invoke(InvokeChannel.analyticsStart, {}),
    capture: (event: AnalyticsEvent) => transport.invoke(InvokeChannel.analyticsCapture, { event }),
  },
  updates: {
    getState: () => transport.invoke(InvokeChannel.updatesGetState, {}),
    check: () => transport.invoke(InvokeChannel.updatesCheck, {}),
    download: () => transport.invoke(InvokeChannel.updatesDownload, {}),
    restartAndInstall: () => transport.invoke(InvokeChannel.updatesRestartAndInstall, {}),
    onStateChanged: (listener: (state: AppUpdateState) => void) =>
      transport.subscribe(EventChannel.updateStateChanged, listener),
  },
  navigation: {
    drainCommands: () => transport.invoke(InvokeChannel.drainNavigationCommands, {}),
    onCommandsAvailable: (listener: () => void) =>
      transport.subscribe(EventChannel.navigationCommandsAvailable, listener),
  },
  diagnostics: () => transport.invoke(InvokeChannel.appDiagnostics, {}),
  agentProviders: {
    getCatalog: () => transport.invoke(InvokeChannel.agentProvidersGetCatalog, {}),
  },
  installDiffDashCli: () => transport.invoke(InvokeChannel.appInstallDiffDashCli, {}),
  openExternalUrl: (url: string) => transport.invoke(InvokeChannel.appOpenExternalUrl, { url }),
  openRepositoryFile: (request: OpenHostedReviewFileRequest) =>
    transport.invoke(InvokeChannel.appOpenRepositoryFile, request),
  openLocalRepositoryFile: (rootPath: string, filePath: string) =>
    transport.invoke(InvokeChannel.appOpenLocalRepositoryFile, { rootPath, filePath }),
  repositories: {
    list: (query?: string) =>
      transport.invoke(InvokeChannel.listRepositories, { query: query ?? null }),
    setFavorite: (id: string, isFavorite: boolean) =>
      transport.invoke(InvokeChannel.setRepositoryFavorite, { id, isFavorite }),
    favoriteRemote: (repo: HostedRepository) =>
      transport.invoke(InvokeChannel.favoriteRemoteRepository, { repository: repo }),
    install: (localPath: string) =>
      transport.invoke(InvokeChannel.installRepository, { localPath }),
    link: (input: LinkRepositoryCheckoutRequest) =>
      transport.invoke(InvokeChannel.linkRepository, input),
    selectLocalFolder: () => transport.invoke(InvokeChannel.selectLocalFolder, {}),
  },
  reviewThreads: {
    list: (target: ReviewThreadTarget) =>
      transport.invoke(InvokeChannel.listReviewThreads, { target }),
    create: (input: CreateReviewThreadRequest) =>
      transport.invoke(InvokeChannel.createReviewThread, input),
    addUserMessage: (input: AddReviewThreadUserMessageRequest) =>
      transport.invoke(InvokeChannel.addReviewThreadUserMessage, input),
    get: (threadId: ReviewThreadId) =>
      transport.invoke(InvokeChannel.getReviewThread, { threadId }),
    runAgent: (input: RunReviewThreadAgentRequest) =>
      transport.invoke(InvokeChannel.runReviewThreadAgent, input),
    onAgentProgress: (listener: (progress: ReviewAgentProgress) => void) =>
      transport.subscribe(EventChannel.reviewThreadAgentProgress, listener),
  },
  settings: {
    get: () => transport.invoke(InvokeChannel.settingsGet, {}),
    update: (settings: AISettings) => transport.invoke(InvokeChannel.settingsUpdate, { settings }),
  },
  appState: {
    get: () => transport.invoke(InvokeChannel.appStateGet, {}),
    update: (state: AppState) => transport.invoke(InvokeChannel.appStateUpdate, { state }),
  },
  providers: {
    list: () => transport.invoke(InvokeChannel.listProviders, {}),
  },
  hostedRepositories: {
    searchRepositories: (request: HostedRepositorySearchRequest) =>
      transport.invoke(InvokeChannel.searchHostedRepositories, request),
    listSearchScopes: (request: HostedProviderRequest) =>
      transport.invoke(InvokeChannel.listHostedRepositorySearchScopes, request),
  },
  hostedReviews: {
    list: (request: HostedRepositoryRequest) =>
      transport.invoke(InvokeChannel.listHostedReviews, request),
    listAssigned: (request: HostedProviderRequest) =>
      transport.invoke(InvokeChannel.listAssignedHostedReviews, request),
    getDecision: (request: HostedReviewRequest) =>
      transport.invoke(InvokeChannel.getHostedReviewDecision, request),
    submitDecision: (request: SubmitHostedReviewDecisionRequest) =>
      transport.invoke(InvokeChannel.submitHostedReviewDecision, request),
  },
  localReviews: {
    resolveBranch: (localPath: string, branchName: string | null) =>
      transport.invoke(InvokeChannel.resolveLocalBranch, { localPath, branchName }),
  },
  reviewSnapshots: {
    acquireHosted: (request: HostedReviewRequest) =>
      transport.invoke(InvokeChannel.acquireHostedReviewSnapshot, request),
    acquireLocal: (target: LocalReviewTarget) =>
      transport.invoke(InvokeChannel.acquireLocalReviewSnapshot, { target }),
    getPage: (request: ReviewSnapshotPageRequest) =>
      transport.invoke(InvokeChannel.getReviewSnapshotPage, request),
    search: (request: ReviewSnapshotSearchRequest) =>
      transport.invoke(InvokeChannel.searchReviewSnapshot, request),
  },
  viewedFiles: {
    list: (request: HostedViewedFilesRequest) =>
      transport.invoke(InvokeChannel.listViewedFiles, request),
    set: (request: SetHostedViewedFileRequest) =>
      transport.invoke(InvokeChannel.setViewedFile, request),
    listLocal: (request: LocalViewedFilesRequest) =>
      transport.invoke(InvokeChannel.listLocalViewedFiles, request),
    setLocal: (request: SetLocalViewedFileRequest) =>
      transport.invoke(InvokeChannel.setLocalViewedFile, request),
  },
  walkthroughs: {
    get: (request: HostedWalkthroughRequest) =>
      transport.invoke(InvokeChannel.getWalkthrough, request),
    generate: (request: GenerateHostedWalkthroughRequest) =>
      transport.invoke(InvokeChannel.generateWalkthrough, request),
  },
  localWalkthroughs: {
    get: (target: LocalReviewTarget, baseSha: string, headSha: string) =>
      transport.invoke(InvokeChannel.getLocalWalkthrough, { target, baseSha, headSha }),
    generate: (target: LocalReviewTarget) =>
      transport.invoke(InvokeChannel.generateLocalWalkthrough, { target, regenerate: false }),
    regenerate: (target: LocalReviewTarget) =>
      transport.invoke(InvokeChannel.generateLocalWalkthrough, { target, regenerate: true }),
  },
}

contextBridge.exposeInMainWorld("diffDash", api)
