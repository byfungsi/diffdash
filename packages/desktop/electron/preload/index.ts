import type { DiffDashBridgeApi } from "@diffdash/protocol/api"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import { bridgeResult, invokeResponseSchema, successEnvelope } from "@diffdash/protocol/ipc"
import { Match, Schema } from "effect"
import { contextBridge, ipcRenderer } from "electron"
import {
  createDiffDashE2eDiagnosticsBridgeApi,
  type DiffDashE2eDiagnosticsBridgeApi,
} from "./e2e-review-lifecycle"
import { createRendererTransport } from "./transport"
import { readCodeWorkspaceFileStream } from "./code-workspace-file-stream"

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
      transport.subscribe(EventChannel.navigationCommandsAvailable, listener),
  },
  diagnostics: () => transport.invoke(InvokeChannel.appDiagnostics, {}),
  resources: {
    diagnostics: () => transport.invoke(InvokeChannel.resourceDiagnostics, {}),
    clearDisposable: () => transport.invoke(InvokeChannel.clearDisposableResources, {}),
  },
  agentProviders: {
    getCatalog: () => transport.invoke(InvokeChannel.agentProvidersGetCatalog, {}),
  },
  ai: {
    listOpenCodeSessions: (request) =>
      transport.invoke(InvokeChannel.aiListOpenCodeSessions, request),
    connectOpenCodeSession: (request) =>
      transport.invoke(InvokeChannel.aiConnectOpenCodeSession, request),
    submitComment: (request) => transport.invoke(InvokeChannel.aiSubmitComment, request),
  },
  installDiffDashCli: () => transport.invoke(InvokeChannel.appInstallDiffDashCli, {}),
  openExternalUrl: (url) => transport.invoke(InvokeChannel.appOpenExternalUrl, { url }),
  openRepositoryFile: (request) => transport.invoke(InvokeChannel.appOpenRepositoryFile, request),
  openLocalRepositoryFile: (rootPath, filePath, target) =>
    transport.invoke(InvokeChannel.appOpenLocalRepositoryFile, {
      rootPath,
      filePath,
      target,
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
  codeWorkspace: {
    open: (request) => transport.invoke(InvokeChannel.openCodeWorkspace, request),
    heartbeat: (request) => transport.invoke(InvokeChannel.heartbeatCodeWorkspace, request),
    release: (request) => transport.invoke(InvokeChannel.releaseCodeWorkspace, request),
    listDirectory: (request) => transport.invoke(InvokeChannel.listCodeWorkspaceDirectory, request),
    search: (request) => transport.invoke(InvokeChannel.searchCodeWorkspace, request),
    readFile: (request, registerCancellation) =>
      readCodeWorkspaceFileStream(ipcRenderer, request, registerCancellation),
    definitions: (request) => transport.invoke(InvokeChannel.codeWorkspaceDefinitions, request),
    references: (request) => transport.invoke(InvokeChannel.codeWorkspaceReferences, request),
    changes: (request) => transport.invoke(InvokeChannel.codeWorkspaceChanges, request),
    lineChanges: (request) => transport.invoke(InvokeChannel.codeWorkspaceLineChanges, request),
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
    resolveLastCommit: (localPath) =>
      transport.invoke(InvokeChannel.resolveLastCommit, { localPath }),
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
  },
  progressiveReviews: {
    openSession: (request) => transport.invoke(InvokeChannel.openProgressiveReviewSession, request),
    currentSession: (request) =>
      transport.invoke(InvokeChannel.getProgressiveReviewSession, request),
    closeSession: (request) =>
      transport.invoke(InvokeChannel.closeProgressiveReviewSession, request),
    inventory: (request) => transport.invoke(InvokeChannel.getProgressiveReviewInventory, request),
    readRange: (request) => transport.invoke(InvokeChannel.readProgressiveReviewRange, request),
    waitForRange: (request) =>
      transport.invoke(InvokeChannel.waitForProgressiveReviewRange, request),
    resolveTarget: (request) =>
      transport.invoke(InvokeChannel.resolveProgressiveReviewTarget, request),
    search: async (request, onPublication) => {
      const result = await transport.invoke(InvokeChannel.searchProgressiveReview, request)
      return Match.valueTags(result, {
        Failure: (failure) => failure,
        Success: (success) => {
          const publications = Schema.decodeUnknownSync(
            invokeResponseSchema(InvokeChannel.searchProgressiveReview),
          )(success.value)
          for (const publication of publications) onPublication(publication)
          const responseSchema = invokeResponseSchema(InvokeChannel.analyticsStart)
          return Schema.encodeSync(bridgeResult(responseSchema))(
            successEnvelope(responseSchema).make({ value: undefined }),
          )
        },
      })
    },
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
  walkthroughOperations: {
    start: (request) => transport.invoke(InvokeChannel.startWalkthroughOperation, request),
    getOperation: (request) => transport.invoke(InvokeChannel.getWalkthroughOperation, request),
    cancel: (request) => transport.invoke(InvokeChannel.cancelWalkthroughOperation, request),
    getStored: (request) => transport.invoke(InvokeChannel.getStoredWalkthrough, request),
    onHint: (listener) => transport.subscribe(EventChannel.walkthroughOperationHint, listener),
  },
}

contextBridge.exposeInMainWorld("diffDash", api)

export type { DiffDashE2eDiagnosticsBridgeApi }

if (process.env.DIFFDASH_E2E_BUILD === "1") {
  const e2eApi = createDiffDashE2eDiagnosticsBridgeApi(transport)
  contextBridge.exposeInMainWorld("diffDashE2eDiagnostics", e2eApi)
}
