import type { DiffDashBridgeApi } from "@diffdash/protocol/api"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import { Match } from "effect"
import { contextBridge, ipcRenderer } from "electron"
import { createRendererTransport } from "./transport"

const transport = createRendererTransport({
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
  on: (channel, listener) => ipcRenderer.on(channel, listener),
  removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener),
})

const api: DiffDashBridgeApi = {
  analytics: {
    start: () => transport.invoke(InvokeChannel.analyticsStart, {}),
    capture: (event) => transport.invoke(InvokeChannel.analyticsCapture, { event }),
  },
  updates: {
    getState: () => transport.invoke(InvokeChannel.updatesGetState, {}),
    check: () => transport.invoke(InvokeChannel.updatesCheck, {}),
    download: () => transport.invoke(InvokeChannel.updatesDownload, {}),
    restartAndInstall: () => transport.invoke(InvokeChannel.updatesRestartAndInstall, {}),
    onStateChanged: (listener) => transport.subscribe(EventChannel.updateStateChanged, listener),
  },
  navigation: {
    activateWindow: () => transport.invoke(InvokeChannel.appActivateWindow, {}),
    drainCommands: () => transport.invoke(InvokeChannel.drainNavigationCommands, {}),
    onCommandsAvailable: (listener) =>
      transport.subscribe(EventChannel.navigationCommandsAvailable, (result) =>
        listener(
          Match.valueTags(result, {
            Failure: (failure) => failure,
            Success: () => ({ _tag: "Success" as const, value: undefined }),
          }),
        ),
      ),
  },
  diagnostics: () => transport.invoke(InvokeChannel.appDiagnostics, {}),
  agentProviders: {
    getCatalog: () => transport.invoke(InvokeChannel.agentProvidersGetCatalog, {}),
  },
  installDiffDashCli: () => transport.invoke(InvokeChannel.appInstallDiffDashCli, {}),
  openExternalUrl: (url) => transport.invoke(InvokeChannel.appOpenExternalUrl, { url }),
  openRepositoryFile: (request) => transport.invoke(InvokeChannel.appOpenRepositoryFile, request),
  openLocalRepositoryFile: (rootPath, filePath) =>
    transport.invoke(InvokeChannel.appOpenLocalRepositoryFile, {
      rootPath,
      filePath,
    }),
  repositories: {
    list: (query) => transport.invoke(InvokeChannel.listRepositories, { query: query ?? null }),
    setFavorite: (id, isFavorite) =>
      transport.invoke(InvokeChannel.setRepositoryFavorite, {
        id,
        isFavorite,
      }),
    favoriteRemote: (repo) =>
      transport.invoke(InvokeChannel.favoriteRemoteRepository, { repository: repo }),
    install: (localPath) =>
      transport.invoke(InvokeChannel.installRepository, {
        localPath,
      }),
    link: (input) => transport.invoke(InvokeChannel.linkRepository, input),
    openProject: (localPath, selectedRepository) =>
      transport.invoke(InvokeChannel.openProject, {
        localPath,
        selectedRepository: selectedRepository ?? null,
      }),
    repairIdentities: () => transport.invoke(InvokeChannel.repairRepositoryIdentities, {}),
    forget: (projectId) => transport.invoke(InvokeChannel.forgetRepository, { projectId }),
    selectLocalFolder: () => transport.invoke(InvokeChannel.selectLocalFolder, {}),
  },
  projectWorkspace: {
    get: (projectId) => transport.invoke(InvokeChannel.projectWorkspaceGet, { projectId }),
    save: (input) => transport.invoke(InvokeChannel.projectWorkspaceSave, { input }),
  },
  reviewThreads: {
    list: (target) => transport.invoke(InvokeChannel.listReviewThreads, { target }),
    create: (input) => transport.invoke(InvokeChannel.createReviewThread, input),
    addUserMessage: (input) => transport.invoke(InvokeChannel.addReviewThreadUserMessage, input),
    get: (threadId) => transport.invoke(InvokeChannel.getReviewThread, { threadId }),
    runAgent: (input) => transport.invoke(InvokeChannel.runReviewThreadAgent, input),
    onAgentProgress: (listener) =>
      transport.subscribe(EventChannel.reviewThreadAgentProgress, listener),
  },
  settings: {
    get: () => transport.invoke(InvokeChannel.settingsGet, {}),
    update: (settings) => transport.invoke(InvokeChannel.settingsUpdate, { settings }),
  },
  appState: {
    get: () => transport.invoke(InvokeChannel.appStateGet, {}),
    update: (state) => transport.invoke(InvokeChannel.appStateUpdate, { state }),
  },
  providers: {
    list: () => transport.invoke(InvokeChannel.listProviders, {}),
  },
  hostedRepositories: {
    searchRepositories: (request) =>
      transport.invoke(InvokeChannel.searchHostedRepositories, request),
    listSearchScopes: (request) =>
      transport.invoke(InvokeChannel.listHostedRepositorySearchScopes, request),
  },
  hostedReviews: {
    list: (request) => transport.invoke(InvokeChannel.listHostedReviews, request),
    listAssigned: (request) => transport.invoke(InvokeChannel.listAssignedHostedReviews, request),
    getDecision: (request) => transport.invoke(InvokeChannel.getHostedReviewDecision, request),
    submitDecision: (request) =>
      transport.invoke(InvokeChannel.submitHostedReviewDecision, request),
  },
  localReviews: {
    resolveBranch: (localPath, branchName) =>
      transport.invoke(InvokeChannel.resolveLocalBranch, { localPath, branchName }),
  },
  repositoryComparisons: {
    resolve: (command) => transport.invoke(InvokeChannel.resolveRepositoryComparison, { command }),
    openFile: (request) => transport.invoke(InvokeChannel.appOpenRepositoryComparisonFile, request),
  },
  reviewSnapshots: {
    acquireHosted: (request) =>
      transport.invoke(InvokeChannel.acquireHostedReviewSnapshot, request),
    acquireLocal: (target) =>
      transport.invoke(InvokeChannel.acquireLocalReviewSnapshot, { target }),
    acquireRepositoryComparison: (target) =>
      transport.invoke(InvokeChannel.acquireRepositoryComparisonSnapshot, { target }),
    getPage: (request) => transport.invoke(InvokeChannel.getReviewSnapshotPage, request),
    search: (request) => transport.invoke(InvokeChannel.searchReviewSnapshot, request),
  },
  viewedFiles: {
    list: (request) => transport.invoke(InvokeChannel.listViewedFiles, request),
    set: (request) => transport.invoke(InvokeChannel.setViewedFile, request),
    listLocal: (request) => transport.invoke(InvokeChannel.listLocalViewedFiles, request),
    setLocal: (request) => transport.invoke(InvokeChannel.setLocalViewedFile, request),
    listRepositoryComparison: (request) =>
      transport.invoke(InvokeChannel.listRepositoryComparisonViewedFiles, request),
    setRepositoryComparison: (request) =>
      transport.invoke(InvokeChannel.setRepositoryComparisonViewedFile, request),
  },
  walkthroughs: {
    get: (request) => transport.invoke(InvokeChannel.getWalkthrough, request),
    generate: (request) => transport.invoke(InvokeChannel.generateWalkthrough, request),
  },
  localWalkthroughs: {
    get: (target, baseSha, headSha) =>
      transport.invoke(InvokeChannel.getLocalWalkthrough, {
        target,
        baseSha,
        headSha,
      }),
    generate: (target) =>
      transport.invoke(InvokeChannel.generateLocalWalkthrough, { target, regenerate: false }),
    regenerate: (target) =>
      transport.invoke(InvokeChannel.generateLocalWalkthrough, { target, regenerate: true }),
  },
  repositoryComparisonWalkthroughs: {
    get: (target) =>
      transport.invoke(InvokeChannel.getRepositoryComparisonWalkthrough, {
        target,
        regenerate: false,
      }),
    generate: (target) =>
      transport.invoke(InvokeChannel.generateRepositoryComparisonWalkthrough, {
        target,
        regenerate: false,
      }),
    regenerate: (target) =>
      transport.invoke(InvokeChannel.generateRepositoryComparisonWalkthrough, {
        target,
        regenerate: true,
      }),
  },
}

contextBridge.exposeInMainWorld("diffDash", api)
