/** Canonical invoke channels shared by the Electron host and preload bridge. */
export const InvokeChannel = {
  analyticsCapture: "analytics:capture",
  analyticsStart: "analytics:start",
  appDiagnostics: "app:diagnostics",
  appInstallDiffDashCli: "app:installDiffDashCli",
  appOpenExternalUrl: "app:openExternalUrl",
  appOpenLocalRepositoryFile: "app:openLocalRepositoryFile",
  appOpenRepositoryFile: "app:openRepositoryFile",
  appStateGet: "appState:get",
  appStateUpdate: "appState:update",
  approvePullRequest: "gitProvider:approvePullRequest",
  getPullRequestDetail: "gitProvider:getPullRequestDetail",
  getPullRequestDiff: "gitProvider:getPullRequestDiff",
  hasApprovedPullRequest: "gitProvider:hasApprovedPullRequest",
  listPullRequests: "gitProvider:listPullRequests",
  listReviewRequests: "gitProvider:listReviewRequests",
  listSearchScopes: "gitProvider:listSearchScopes",
  refreshPullRequestDetail: "gitProvider:refreshPullRequestDetail",
  searchRepositories: "gitProvider:searchRepositories",
  localReviewDetail: "localReviews:getDetail",
  localReviewDiff: "localReviews:getDiff",
  localReviewSnapshot: "localReviews:getSnapshot",
  resolveLocalBranch: "localReviews:resolveBranch",
  generateLocalWalkthrough: "localWalkthroughs:generate",
  getLocalWalkthrough: "localWalkthroughs:get",
  drainNavigationCommands: "navigation:drainCommands",
  addLocalRepository: "repositories:addLocal",
  favoriteRemoteRepository: "repositories:favoriteRemote",
  installRepository: "repositories:install",
  linkRepository: "repositories:link",
  listRepositories: "repositories:list",
  selectLocalFolder: "repositories:selectLocalFolder",
  setRepositoryFavorite: "repositories:setFavorite",
  addReviewThreadUserMessage: "reviewThreads:addUserMessage",
  createReviewThread: "reviewThreads:create",
  getReviewThread: "reviewThreads:get",
  listReviewThreads: "reviewThreads:list",
  runReviewThreadAgent: "reviewThreads:runAgent",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  updatesCheck: "updates:check",
  updatesDownload: "updates:download",
  updatesGetState: "updates:getState",
  updatesRestartAndInstall: "updates:restartAndInstall",
  listViewedFiles: "viewedFiles:list",
  listLocalViewedFiles: "viewedFiles:listLocal",
  setViewedFile: "viewedFiles:set",
  setLocalViewedFile: "viewedFiles:setLocal",
  generateWalkthrough: "walkthroughs:generate",
  getWalkthrough: "walkthroughs:get",
} as const

/** One valid renderer-to-host invoke channel. */
export type InvokeChannel = (typeof InvokeChannel)[keyof typeof InvokeChannel]

/** Canonical host-to-renderer event channels. */
export const EventChannel = {
  navigationCommandsAvailable: "navigation:commandsAvailable",
  reviewThreadAgentProgress: "reviewThreads:agentProgress",
  updateStateChanged: "updates:stateChanged",
} as const

/** One valid host-to-renderer event channel. */
export type EventChannel = (typeof EventChannel)[keyof typeof EventChannel]
