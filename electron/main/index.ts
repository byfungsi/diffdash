import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import { createAppLifecycle } from "./app-lifecycle"
import { AgentArtifactNormalizer } from "../../src/main/services/agent-artifact-normalizer"
import { electronErrorPageDataUrl } from "../error-page"
import { AgentRunArtifactStore } from "../../src/main/services/agent-run-artifact-store"
import { AgentRunStore } from "../../src/main/services/agent-run-store"
import { AIAgent } from "../../src/main/services/ai-agent"
import { Analytics } from "../../src/main/services/analytics"
import { AppConfig } from "../../src/main/services/app-config"
import { AppSettings } from "../../src/main/services/app-settings"
import { AppState } from "../../src/main/services/app-state"
import { AppUpdater, nativeUpdaterAdapter } from "../../src/main/services/app-updater"
import { CliError, CliService } from "../../src/main/services/cli"
import { CliStreamService } from "../../src/main/services/cli-stream"
import { ConfigurableAIAgent } from "../../src/main/services/configurable-ai-agent"
import { DatabaseService } from "../../src/main/services/database"
import { DiffDashMcpServer } from "../../src/main/services/diffdash-mcp-server"
import { GitService } from "../../src/main/services/git"
import { GitProvider } from "../../src/main/services/git-provider"
import { GitHubProvider } from "../../src/main/services/github"
import { OpenCodeSdkClient } from "../../src/main/services/opencode-sdk-client"
import { Prerequisites } from "../../src/main/services/prerequisites"
import { RepositoryLinkError, RepositoryLinker } from "../../src/main/services/repository-linker"
import { RepositoryStore } from "../../src/main/services/repository-store"
import { ReviewAgentService } from "../../src/main/services/review-agent"
import { ReviewAgentProviderRegistry } from "../../src/main/services/review-agent-provider-registry"
import { ReviewContextService } from "../../src/main/services/review-context"
import { ReviewContextBuilder } from "../../src/main/services/review-context-builder"
import { ReviewThreadAnchorMapper } from "../../src/main/services/review-thread-anchor-mapper"
import { ReviewThreadStore } from "../../src/main/services/review-thread-store"
import { ReviewWorktreePool } from "../../src/main/services/review-worktree-pool"
import { ThreadMemoryStore } from "../../src/main/services/thread-memory-store"
import { ViewedFileStore } from "../../src/main/services/viewed-file-store"
import { WalkthroughService } from "../../src/main/services/walkthrough"
import { WalkthroughStore } from "../../src/main/services/walkthrough-store"
import { AISettings } from "../../src/shared/ai-settings"
import { AnalyticsEvent } from "../../src/shared/analytics"
import { DEFAULT_APP_STATE, AppState as SharedAppState } from "../../src/shared/app-state"
import type { AppUpdateState } from "../../src/shared/app-update"
import { parseUnifiedDiff } from "../../src/shared/diff-parser"
import type {
  LocalReviewDetail,
  LocalReviewDiff,
  PullRequestDetail,
  PullRequestDiff,
  PullRequestSummary,
  Repo,
  RepositorySearchResult,
  RepositorySearchScope,
} from "../../src/shared/domain"
import { RepositorySearchRequest } from "../../src/shared/domain"
import { AppPrerequisites, type DiffDashCliInstallResult } from "../../src/shared/prerequisites"
import { LinkRepositoryCheckoutRequest } from "../../src/shared/repository-link"
import { ReviewAgentProgress } from "../../src/shared/review-agent"
import { makePullRequestReviewKey } from "../../src/shared/review-identity"
import {
  AddReviewThreadUserMessageRequest,
  CreateReviewThreadRequest,
  isReviewAnchorInParsedDiff,
  type ReviewThread,
  type ReviewThreadDetails,
  ReviewThreadIdRequest,
  ReviewThreadTarget,
  RunReviewThreadAgentRequest,
} from "../../src/shared/review-thread"
import {
  prepareWalkthroughPromptInput,
  type StoredWalkthrough,
  WALKTHROUGH_PROMPT_VERSION,
  walkthroughLocalDiffScope,
  walkthroughPullRequestScope,
} from "../../src/shared/walkthrough"

const LOCAL_REVIEW_ARG = "--diffdash-local-path"
const LINK_REPOSITORY_ARG = "--diffdash-link-path"

let mainWindow: BrowserWindow | null = null
let pendingLocalReviewPath: string | null = null
let pendingRepositoryLinkPath: string | null = null

const getDevelopmentIconPath = () =>
  app.isPackaged ? null : resolve(__dirname, "../../resources/icons/icon.png")

const getDiffDashCliPath = () =>
  app.isPackaged
    ? join(process.resourcesPath, "bin", "diffdash")
    : resolve(__dirname, "../../bin/diffdash.mjs")

const isDebugOnboardingEnabled = () => !app.isPackaged && process.env.DEBUG_ONBOARD === "1"

const debugMissingPrerequisites = () =>
  AppPrerequisites.make({
    checkedAt: new Date().toISOString(),
    codingAgentInstalled: false,
    diffDashCliInstalled: false,
    diffDashCliPath: null,
    gitInstalled: false,
    ghAuthenticated: false,
    ghInstalled: false,
    ghSearchRepositoriesAvailable: false,
    ghSupported: false,
    ghVersion: null,
    installedCodingAgents: [],
  })

const createAppLayer = () => {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  const configLayer = AppConfig.layer({
    appVersion: app.getVersion(),
    architecture: process.arch,
    databasePath: join(app.getPath("userData"), "diffdash.sqlite"),
    diffDashCliPath: getDiffDashCliPath(),
    packaged: app.isPackaged,
    platform: process.platform,
    ...(process.env.VITE_POSTHOG_HOST === undefined
      ? {}
      : { posthogHost: process.env.VITE_POSTHOG_HOST }),
    ...(process.env.VITE_POSTHOG_KEY === undefined
      ? {}
      : { posthogKey: process.env.VITE_POSTHOG_KEY }),
    settingsPath: join(xdgConfigHome, "diffdash", "settings.json"),
    tempDir: join(app.getPath("temp"), "diffdash"),
    remoteWorktreePoolPath:
      process.env.DIFFDASH_REMOTE_WORKTREE_POOL_PATH ??
      join(homedir(), ".diffdash", "remote-worktree-pool"),
    worktreePoolPath:
      process.env.DIFFDASH_WORKTREE_POOL_PATH ?? join(homedir(), ".diffdash", "worktree-pool"),
  })
  const settingsLayer = AppSettings.layer
  const analyticsLayer = Analytics.layer.pipe(Layer.provideMerge(settingsLayer))
  const aiAgentLayer = ConfigurableAIAgent.layer.pipe(Layer.provideMerge(settingsLayer))
  const walkthroughLayer = WalkthroughService.layer.pipe(Layer.provideMerge(aiAgentLayer))
  const reviewContextLayer = ReviewContextService.layer.pipe(
    Layer.provideMerge(GitService.layer),
    Layer.provideMerge(GitHubProvider.layer),
  )
  const threadStoreLayer = ReviewThreadStore.layer
  const artifactStoreLayer = AgentRunArtifactStore.layer
  const providerRegistryLayer = ReviewAgentProviderRegistry.layer.pipe(
    Layer.provideMerge(OpenCodeSdkClient.layer),
    Layer.provideMerge(CliStreamService.layer),
    Layer.provideMerge(AgentArtifactNormalizer.layer),
  )
  const mcpLayer = DiffDashMcpServer.layer.pipe(
    Layer.provideMerge(threadStoreLayer),
    Layer.provideMerge(artifactStoreLayer),
  )
  const reviewAgentLayer = ReviewAgentService.layer.pipe(
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(providerRegistryLayer),
    Layer.provideMerge(mcpLayer),
    Layer.provideMerge(ReviewContextBuilder.layer),
    Layer.provideMerge(ThreadMemoryStore.layer),
    Layer.provideMerge(AgentRunStore.layer),
    Layer.provideMerge(ReviewWorktreePool.layer),
  )
  const threadAnchorMapperLayer = ReviewThreadAnchorMapper.layer.pipe(
    Layer.provideMerge(threadStoreLayer),
  )
  const repositoryLinkerLayer = RepositoryLinker.layer.pipe(
    Layer.provideMerge(RepositoryStore.layer),
    Layer.provideMerge(GitService.layer),
    Layer.provideMerge(GitHubProvider.layer),
  )
  const updaterLayer = AppUpdater.layer({
    adapter: nativeUpdaterAdapter(),
    ...(process.env.APPIMAGE === undefined ? {} : { appImagePath: process.env.APPIMAGE }),
    arch: process.arch,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
  })

  return Layer.mergeAll(
    repositoryLinkerLayer,
    analyticsLayer,
    reviewContextLayer,
    AppState.layer,
    Prerequisites.layer,
    walkthroughLayer,
    ViewedFileStore.layer,
    WalkthroughStore.layer,
    reviewAgentLayer,
    threadAnchorMapperLayer,
    updaterLayer,
  ).pipe(
    Layer.provideMerge(DatabaseService.layer),
    Layer.provideMerge(CliService.layer),
    Layer.provideMerge(CliStreamService.layer),
    Layer.provide(configLayer),
  )
}

const serializeError = (error: unknown) => {
  if (error instanceof Error) {
    return { message: error.message, name: error.name }
  }
  return { message: String(error), name: "UnknownError" }
}

const installIpcHandlers = (
  appLayer: Layer.Layer<
    | RepositoryStore
    | Analytics
    | RepositoryLinker
    | GitService
    | CliService
    | GitProvider
    | AppState
    | AppUpdater
    | AppSettings
    | AIAgent
    | Prerequisites
    | ReviewContextService
    | ReviewAgentService
    | ReviewThreadAnchorMapper
    | ReviewThreadStore
    | ViewedFileStore
    | WalkthroughStore
    | WalkthroughService,
    unknown
  >,
) => {
  const runtime = ManagedRuntime.make(appLayer)
  const run = <A>(
    program: Effect.Effect<
      A,
      unknown,
      | RepositoryStore
      | Analytics
      | RepositoryLinker
      | GitService
      | CliService
      | GitProvider
      | AppState
      | AppUpdater
      | AppSettings
      | AIAgent
      | Prerequisites
      | ReviewContextService
      | ReviewAgentService
      | ReviewThreadAnchorMapper
      | ReviewThreadStore
      | ViewedFileStore
      | WalkthroughStore
      | WalkthroughService
    >,
  ) => runtime.runPromise(program)

  const lifecycle = createAppLifecycle({ dispose: () => runtime.dispose(), quit: () => app.quit() })
  app.on("before-quit", lifecycle.beforeQuit)

  ipcMain.handle("analytics:start", async (): Promise<void> => {
    const analytics = await run(Analytics)
    return run(analytics.start)
  })

  ipcMain.handle("analytics:capture", async (_event, input: unknown): Promise<void> => {
    const event = await run(Schema.decodeUnknown(AnalyticsEvent)(input))
    const analytics = await run(Analytics)
    return run(analytics.capture(event))
  })

  ipcMain.handle("updates:getState", async (): Promise<AppUpdateState> => {
    const updater = await run(AppUpdater)
    return run(updater.state)
  })

  ipcMain.handle("updates:check", async (): Promise<void> => {
    const updater = await run(AppUpdater)
    return run(updater.check)
  })

  ipcMain.handle("updates:download", async (): Promise<void> => {
    const updater = await run(AppUpdater)
    return run(updater.download)
  })

  ipcMain.handle("updates:restartAndInstall", async (): Promise<void> => {
    const updater = await run(AppUpdater)
    await lifecycle.restartAndInstall(() => Effect.runPromise(updater.quitAndInstall))
  })

  void run(
    Effect.gen(function* () {
      const updater = yield* AppUpdater
      yield* updater.subscribe((state) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send("updates:stateChanged", state)
        }
      })
      yield* updater.startAutomaticChecks
    }),
  )

  const resolveThreadReview = async (target: ReviewThreadTarget) => {
    const contexts = await run(ReviewContextService)
    const repositories = await run(RepositoryStore)
    if (target.kind === "pullRequest") {
      const gitProvider = await run(GitProvider)
      const snapshot = await run(
        contexts.getPullRequestSnapshot(target.owner, target.name, target.number),
      )
      const repo = await run(
        repositories.upsertRepository({
          provider: "github",
          owner: target.owner,
          name: target.name,
          remoteUrl: gitProvider.repositoryUrl(target.owner, target.name),
          localPath: null,
        }),
      )
      return { repo, snapshot, prNumber: target.number } as const
    }

    const snapshot = await run(contexts.getLocalReviewSnapshot(target.rootPath))
    const repo = await run(
      repositories.upsertRepository(localRepositoryInput(snapshot.detail.rootPath)),
    )
    return { repo, snapshot, prNumber: null } as const
  }

  ipcMain.handle("repositories:list", async (_event, query?: string): Promise<readonly Repo[]> => {
    const store = await run(RepositoryStore)
    return run(store.list(query))
  })

  ipcMain.handle(
    "reviewThreads:list",
    async (_event, input: unknown): Promise<readonly ReviewThread[]> => {
      const target = await run(Schema.decodeUnknown(ReviewThreadTarget)(input))
      const { repo, snapshot } = await resolveThreadReview(target)
      const mapper = await run(ReviewThreadAnchorMapper)
      return run(
        mapper.mapReview({
          repoId: repo.id,
          reviewKey: snapshot.reviewKey,
          baseRevision: snapshot.baseRevision,
          headRevision: snapshot.headRevision,
          parsedDiff: snapshot.parsedDiff,
        }),
      )
    },
  )

  ipcMain.handle(
    "reviewThreads:addUserMessage",
    async (_event, input: unknown): Promise<ReviewThreadDetails> => {
      const request = await run(Schema.decodeUnknown(AddReviewThreadUserMessageRequest)(input))
      const threads = await run(ReviewThreadStore)
      return run(threads.addUserMessage(request))
    },
  )

  ipcMain.handle(
    "reviewThreads:create",
    async (_event, input: unknown): Promise<ReviewThreadDetails> => {
      const request = await run(Schema.decodeUnknown(CreateReviewThreadRequest)(input))
      const { repo, snapshot, prNumber } = await resolveThreadReview(request.target)
      if (
        snapshot.baseRevision !== request.expectedBaseRevision ||
        snapshot.headRevision !== request.expectedHeadRevision
      ) {
        throw new Error("Review changed before the local thread was created")
      }
      if (!isReviewAnchorInParsedDiff(request.anchor, snapshot.parsedDiff)) {
        throw new Error("Review thread anchor does not exist in the expected review revision")
      }
      const threads = await run(ReviewThreadStore)
      return run(
        threads.create({
          repoId: repo.id,
          reviewKey: snapshot.reviewKey,
          prNumber,
          baseRevision: snapshot.baseRevision,
          headRevision: snapshot.headRevision,
          anchor: request.anchor,
          bodyMarkdown: request.bodyMarkdown,
        }),
      )
    },
  )

  ipcMain.handle(
    "reviewThreads:get",
    async (_event, input: unknown): Promise<ReviewThreadDetails> => {
      const request = await run(Schema.decodeUnknown(ReviewThreadIdRequest)(input))
      const threads = await run(ReviewThreadStore)
      return run(threads.get(request.threadId))
    },
  )

  ipcMain.handle(
    "reviewThreads:runAgent",
    async (event, input: unknown): Promise<ReviewThreadDetails> => {
      const request = await run(Schema.decodeUnknown(RunReviewThreadAgentRequest)(input))
      const { repo, snapshot } = await resolveThreadReview(request.target)
      const walkthroughs = await run(WalkthroughStore)
      const walkthrough = await run(
        walkthroughs.get({
          repoId: repo.id,
          reviewKey: snapshot.reviewKey,
          baseSha: snapshot.baseRevision,
          headSha: snapshot.headRevision,
          promptVersion: WALKTHROUGH_PROMPT_VERSION,
        }),
      )
      const agents = await run(ReviewAgentService)
      return run(
        agents.runThreadTurn({
          threadId: request.threadId,
          snapshot,
          cwd: repo.localPath,
          walkthrough,
          onProgress: (stage) =>
            Effect.sync(() => {
              if (event.sender.isDestroyed()) return
              event.sender.send(
                "reviewThreads:agentProgress",
                ReviewAgentProgress.make({ threadId: request.threadId, stage }),
              )
            }),
        }),
      )
    },
  )

  ipcMain.handle("settings:get", async (): Promise<AISettings> => {
    const settings = await run(AppSettings)
    return run(settings.get)
  })

  ipcMain.handle("settings:update", async (_event, input: unknown): Promise<AISettings> => {
    const parsed = await run(Schema.decodeUnknown(AISettings)(input))
    const settings = await run(AppSettings)
    return run(settings.save(parsed))
  })

  ipcMain.handle("appState:get", async (): Promise<SharedAppState> => {
    if (isDebugOnboardingEnabled()) return DEFAULT_APP_STATE

    const appState = await run(AppState)
    return run(appState.get)
  })

  ipcMain.handle("appState:update", async (_event, input: unknown): Promise<SharedAppState> => {
    const parsed = await run(Schema.decodeUnknown(SharedAppState)(input))
    if (isDebugOnboardingEnabled()) return parsed

    const appState = await run(AppState)
    return run(appState.save(parsed))
  })

  ipcMain.handle(
    "repositories:setFavorite",
    async (_event, id: string, isFavorite: boolean): Promise<Repo> => {
      const store = await run(RepositoryStore)
      return run(store.setFavorite(id, isFavorite))
    },
  )

  ipcMain.handle(
    "repositories:favoriteRemote",
    async (_event, repo: RepositorySearchResult): Promise<Repo> => {
      const store = await run(RepositoryStore)
      return run(
        store.upsertRepository({
          provider: "github",
          owner: repo.owner,
          name: repo.name,
          remoteUrl: repo.url,
          localPath: null,
          isFavorite: true,
        }),
      )
    },
  )

  ipcMain.handle("repositories:addLocal", async (_event, localPath: string): Promise<Repo> => {
    const git = await run(GitService)
    const gitProvider = await run(GitProvider)
    const store = await run(RepositoryStore)
    const rootPath = await run(git.detectRoot(localPath))
    try {
      const checkout = await run(git.detectRepository(rootPath))
      const detected = await run(gitProvider.parseRemoteUrl(checkout.remoteUrl))
      return run(
        store.upsertRepository({
          provider: detected.provider,
          owner: detected.owner,
          name: detected.name,
          remoteUrl: checkout.remoteUrl,
          localPath: checkout.rootPath,
          isFavorite: true,
        }),
      )
    } catch {
      return run(store.upsertRepository(localRepositoryInput(rootPath)))
    }
  })

  ipcMain.handle("repositories:install", async (_event, localPath: string): Promise<Repo> => {
    const linker = await run(RepositoryLinker)
    try {
      return await run(linker.install(localPath))
    } catch (error) {
      if (error instanceof RepositoryLinkError) throw new Error(error.reason, { cause: error })
      throw error
    }
  })

  ipcMain.handle("repositories:link", async (_event, input: unknown): Promise<Repo> => {
    const request = await run(Schema.decodeUnknown(LinkRepositoryCheckoutRequest)(input))
    const linker = await run(RepositoryLinker)
    try {
      return await run(linker.link(request))
    } catch (error) {
      if (error instanceof RepositoryLinkError) throw new Error(error.reason, { cause: error })
      throw error
    }
  })

  ipcMain.handle("repositories:selectLocalFolder", async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select a local Git repository",
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(
    "gitProvider:searchRepositories",
    async (_event, input: unknown): Promise<readonly RepositorySearchResult[]> => {
      const request = await run(Schema.decodeUnknown(RepositorySearchRequest)(input))
      const gitProvider = await run(GitProvider)
      try {
        return await run(gitProvider.searchRepositories(request))
      } catch (error) {
        if (error instanceof CliError) {
          const detail = error.stderr.trim() || error.stdout?.trim()
          throw new Error(detail || "GitHub repository search failed.", { cause: error })
        }
        throw error
      }
    },
  )

  ipcMain.handle(
    "gitProvider:listSearchScopes",
    async (): Promise<readonly RepositorySearchScope[]> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listSearchScopes())
    },
  )

  ipcMain.handle(
    "gitProvider:listPullRequests",
    async (_event, owner: string, name: string): Promise<readonly PullRequestSummary[]> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listPullRequests(owner, name))
    },
  )

  ipcMain.handle(
    "gitProvider:listReviewRequests",
    async (): Promise<readonly PullRequestSummary[]> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listReviewRequests())
    },
  )

  ipcMain.handle(
    "gitProvider:getPullRequestDetail",
    async (_event, owner: string, name: string, number: number): Promise<PullRequestDetail> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.getPullRequestDetail(owner, name, number))
    },
  )

  ipcMain.handle(
    "gitProvider:refreshPullRequestDetail",
    async (_event, owner: string, name: string, number: number): Promise<PullRequestDetail> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.refreshPullRequestDetail(owner, name, number))
    },
  )

  ipcMain.handle(
    "gitProvider:getPullRequestDiff",
    async (_event, owner: string, name: string, number: number): Promise<PullRequestDiff> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.getPullRequestDiff(owner, name, number))
    },
  )

  ipcMain.handle(
    "gitProvider:hasApprovedPullRequest",
    async (_event, owner: string, name: string, number: number): Promise<boolean> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.hasApprovedPullRequest(owner, name, number))
    },
  )

  ipcMain.handle(
    "gitProvider:approvePullRequest",
    async (_event, owner: string, name: string, number: number): Promise<void> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.approvePullRequest(owner, name, number))
    },
  )

  ipcMain.handle(
    "localReviews:getDetail",
    async (_event, localPath: string): Promise<LocalReviewDetail> => {
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const detail = await run(git.getLocalReviewDetail(localPath))
      await run(store.upsertRepository(localRepositoryInput(detail.rootPath)))
      return detail
    },
  )

  ipcMain.handle(
    "localReviews:getDiff",
    async (_event, localPath: string): Promise<LocalReviewDiff> => {
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const diff = await run(git.getLocalReviewDiff(localPath))
      await run(store.upsertRepository(localRepositoryInput(diff.rootPath)))
      return diff
    },
  )

  ipcMain.handle("navigation:getPendingLocalReview", async (): Promise<string | null> => {
    return pendingLocalReviewPath
  })

  ipcMain.handle("navigation:getPendingRepositoryLink", async (): Promise<string | null> => {
    return pendingRepositoryLinkPath
  })

  ipcMain.handle(
    "walkthroughs:get",
    async (
      _event,
      owner: string,
      name: string,
      number: number,
      baseSha: string,
      headSha: string,
    ): Promise<StoredWalkthrough | null> => {
      const store = await run(RepositoryStore)
      const gitProvider = await run(GitProvider)
      const walkthroughStore = await run(WalkthroughStore)
      const repo = await run(
        store.upsertRepository({
          provider: "github",
          owner,
          name,
          remoteUrl: gitProvider.repositoryUrl(owner, name),
          localPath: null,
        }),
      )
      return run(
        walkthroughStore.get({
          repoId: repo.id,
          reviewKey: pullRequestReviewKey(repo.provider, owner, name, number),
          baseSha,
          headSha,
          promptVersion: WALKTHROUGH_PROMPT_VERSION,
        }),
      )
    },
  )

  ipcMain.handle(
    "localWalkthroughs:get",
    async (
      _event,
      rootPath: string,
      baseSha: string,
      headSha: string,
    ): Promise<StoredWalkthrough | null> => {
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const walkthroughStore = await run(WalkthroughStore)
      const canonicalRootPath = await run(git.detectRoot(rootPath))
      const repo = await run(store.upsertRepository(localRepositoryInput(canonicalRootPath)))
      return run(
        walkthroughStore.get({
          repoId: repo.id,
          reviewKey: localReviewKey(canonicalRootPath),
          baseSha,
          headSha,
          promptVersion: WALKTHROUGH_PROMPT_VERSION,
        }),
      )
    },
  )

  ipcMain.handle(
    "viewedFiles:list",
    async (
      _event,
      owner: string,
      name: string,
      number: number,
      headSha: string,
    ): Promise<readonly string[]> => {
      const store = await run(RepositoryStore)
      const gitProvider = await run(GitProvider)
      const viewedFiles = await run(ViewedFileStore)
      const repo = await run(
        store.upsertRepository({
          provider: "github",
          owner,
          name,
          remoteUrl: gitProvider.repositoryUrl(owner, name),
          localPath: null,
        }),
      )
      return run(viewedFiles.list({ repoId: repo.id, prNumber: number, headSha }))
    },
  )

  ipcMain.handle(
    "viewedFiles:set",
    async (
      _event,
      owner: string,
      name: string,
      number: number,
      headSha: string,
      reviewKey: string,
      filePath: string,
      viewed: boolean,
    ): Promise<void> => {
      const store = await run(RepositoryStore)
      const gitProvider = await run(GitProvider)
      const viewedFiles = await run(ViewedFileStore)
      const repo = await run(
        store.upsertRepository({
          provider: "github",
          owner,
          name,
          remoteUrl: gitProvider.repositoryUrl(owner, name),
          localPath: null,
        }),
      )
      return run(
        viewedFiles.set({
          repoId: repo.id,
          prNumber: number,
          headSha,
          reviewKey,
          filePath,
          viewed,
        }),
      )
    },
  )

  ipcMain.handle(
    "viewedFiles:listLocal",
    async (_event, rootPath: string, headSha: string): Promise<readonly string[]> => {
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const viewedFiles = await run(ViewedFileStore)
      const canonicalRootPath = await run(git.detectRoot(rootPath))
      const repo = await run(store.upsertRepository(localRepositoryInput(canonicalRootPath)))
      return run(viewedFiles.list({ repoId: repo.id, prNumber: null, headSha }))
    },
  )

  ipcMain.handle(
    "viewedFiles:setLocal",
    async (
      _event,
      rootPath: string,
      headSha: string,
      reviewKey: string,
      filePath: string,
      viewed: boolean,
    ): Promise<void> => {
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const viewedFiles = await run(ViewedFileStore)
      const canonicalRootPath = await run(git.detectRoot(rootPath))
      const repo = await run(store.upsertRepository(localRepositoryInput(canonicalRootPath)))
      return run(
        viewedFiles.set({
          repoId: repo.id,
          prNumber: null,
          headSha,
          reviewKey,
          filePath,
          viewed,
        }),
      )
    },
  )

  ipcMain.handle(
    "walkthroughs:generate",
    async (
      _event,
      owner: string,
      name: string,
      number: number,
      regenerate: boolean,
    ): Promise<StoredWalkthrough> => {
      const repositoryStore = await run(RepositoryStore)
      const gitProvider = await run(GitProvider)
      const walkthroughStore = await run(WalkthroughStore)
      const walkthroughService = await run(WalkthroughService)

      const repo = await run(
        repositoryStore.upsertRepository({
          provider: "github",
          owner,
          name,
          remoteUrl: gitProvider.repositoryUrl(owner, name),
          localPath: null,
        }),
      )
      const pullRequest = await run(gitProvider.getPullRequestDetail(owner, name, number))
      const baseSha = pullRequest.baseRefOid
      if (baseSha === null) {
        throw new Error("Cannot generate a walkthrough without a PR base SHA")
      }

      let diff: PullRequestDiff | null = null
      let headSha = pullRequest.headRefOid
      if (headSha === null) {
        diff = await run(gitProvider.getPullRequestDiff(owner, name, number))
        headSha = diff.headRefOid
      }
      if (headSha === null) {
        throw new Error("Cannot generate a walkthrough without a PR head SHA")
      }

      const reviewKey = pullRequestReviewKey(repo.provider, owner, name, number)
      const cacheKey = {
        repoId: repo.id,
        reviewKey,
        baseSha,
        headSha,
        promptVersion: WALKTHROUGH_PROMPT_VERSION,
      }

      if (!regenerate) {
        const cached = await run(walkthroughStore.get(cacheKey))
        if (cached !== null) return cached
      }

      diff ??= await run(gitProvider.getPullRequestDiff(owner, name, number))
      const parsedDiff = parseUnifiedDiff(diff.diff)
      const promptInput = await run(
        prepareWalkthroughPromptInput(parsedDiff.files, walkthroughPullRequestScope(number)),
      )
      const walkthrough = await run(
        walkthroughService.generate({
          review: { kind: "pullRequest", pullRequest },
          diff: promptInput.diff,
          hunkDigest: promptInput.hunkDigest,
          promptStats: promptInput.stats,
        }),
      )

      return run(
        walkthroughStore.save({
          ...cacheKey,
          prNumber: number,
          walkthrough,
        }),
      )
    },
  )

  ipcMain.handle(
    "localWalkthroughs:generate",
    async (_event, rootPath: string, regenerate: boolean): Promise<StoredWalkthrough> => {
      const git = await run(GitService)
      const repositoryStore = await run(RepositoryStore)
      const walkthroughStore = await run(WalkthroughStore)
      const walkthroughService = await run(WalkthroughService)

      const localReview = await run(git.getLocalReviewDetail(rootPath))
      const diff = await run(git.getLocalReviewDiff(localReview.rootPath))
      const repo = await run(repositoryStore.upsertRepository(localRepositoryInput(diff.rootPath)))
      const cacheKey = {
        repoId: repo.id,
        reviewKey: localReviewKey(diff.rootPath),
        baseSha: diff.baseSha,
        headSha: diff.headSha,
        promptVersion: WALKTHROUGH_PROMPT_VERSION,
      }

      if (!regenerate) {
        const cached = await run(walkthroughStore.get(cacheKey))
        if (cached !== null) return cached
      }

      const parsedDiff = parseUnifiedDiff(diff.diff)
      const promptInput = await run(
        prepareWalkthroughPromptInput(parsedDiff.files, walkthroughLocalDiffScope(diff.headSha)),
      )
      const walkthrough = await run(
        walkthroughService.generate({
          review: { kind: "localDiff", localReview },
          diff: promptInput.diff,
          hunkDigest: promptInput.hunkDigest,
          promptStats: promptInput.stats,
        }),
      )

      return run(
        walkthroughStore.save({
          ...cacheKey,
          prNumber: null,
          walkthrough,
        }),
      )
    },
  )

  ipcMain.handle("app:diagnostics", async (): Promise<AppPrerequisites> => {
    if (isDebugOnboardingEnabled()) return debugMissingPrerequisites()

    const prerequisites = await run(Prerequisites)
    return run(prerequisites.get)
  })

  ipcMain.handle("app:installDiffDashCli", async (): Promise<DiffDashCliInstallResult> => {
    const prerequisites = await run(Prerequisites)
    return run(prerequisites.installDiffDashCli)
  })

  ipcMain.handle("app:openExternalUrl", async (_event, url: string): Promise<void> => {
    await openExternalUrl(url)
  })

  ipcMain.handle(
    "app:openRepositoryFile",
    async (
      _event,
      owner: string,
      name: string,
      filePath: string,
      headRefName: string,
      headRefOid: string | null,
    ): Promise<void> => {
      const store = await run(RepositoryStore)
      const git = await run(GitService)
      const gitProvider = await run(GitProvider)
      const repositories = await run(store.list(`${owner}/${name}`))
      const repository = repositories.find(
        (repo) =>
          repo.owner.toLowerCase() === owner.toLowerCase() &&
          repo.name.toLowerCase() === name.toLowerCase(),
      )

      if (isAbsolute(filePath)) {
        throw new Error("Cannot open an absolute file path from a review")
      }

      const normalizedFilePath = normalizeReviewFilePath(filePath)

      if (repository?.localPath === null || repository?.localPath === undefined) {
        await openProviderFile(
          gitProvider,
          owner,
          name,
          normalizedFilePath,
          headRefName,
          headRefOid,
        )
        return
      }

      let currentBranch: string
      try {
        currentBranch = await run(git.currentBranch(repository.localPath))
      } catch {
        await openProviderFile(
          gitProvider,
          owner,
          name,
          normalizedFilePath,
          headRefName,
          headRefOid,
        )
        return
      }
      if (currentBranch !== headRefName) {
        await openProviderFile(
          gitProvider,
          owner,
          name,
          normalizedFilePath,
          headRefName,
          headRefOid,
        )
        return
      }

      const rootPath = resolve(repository.localPath)
      const targetPath = resolve(rootPath, normalizedFilePath)
      const relativePath = relative(rootPath, targetPath)
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        throw new Error("Cannot open a file outside the repository checkout")
      }

      const errorMessage = await shell.openPath(targetPath)
      if (errorMessage.length > 0) {
        throw new Error(errorMessage)
      }
    },
  )

  ipcMain.handle(
    "app:openLocalRepositoryFile",
    async (_event, rootPath: string, filePath: string): Promise<void> => {
      const git = await run(GitService)
      const canonicalRootPath = await run(git.detectRoot(rootPath))

      if (isAbsolute(filePath)) {
        throw new Error("Cannot open an absolute file path from a review")
      }

      const normalizedFilePath = normalizeReviewFilePath(filePath)
      const resolvedRootPath = resolve(canonicalRootPath)
      const targetPath = resolve(resolvedRootPath, normalizedFilePath)
      const relativePath = relative(resolvedRootPath, targetPath)
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        throw new Error("Cannot open a file outside the repository checkout")
      }

      const errorMessage = await shell.openPath(targetPath)
      if (errorMessage.length > 0) {
        throw new Error(errorMessage)
      }
    },
  )
}

const pullRequestReviewKey = (
  provider: Repo["provider"],
  owner: string,
  name: string,
  number: number,
) => makePullRequestReviewKey(provider, owner, name, number)

const localReviewKey = (rootPath: string) => `local:${hashText(resolve(rootPath))}`

const localRepositoryInput = (rootPath: string) => {
  const resolvedRootPath = resolve(rootPath)
  const hash = hashText(resolvedRootPath).slice(0, 12)
  const repoName = basename(resolvedRootPath) || "repository"
  return {
    provider: "local",
    owner: "local",
    name: `${repoName}-${hash}`,
    remoteUrl: pathToFileURL(resolvedRootPath).toString(),
    localPath: resolvedRootPath,
    isFavorite: false,
  } as const
}

const hashText = (text: string) => createHash("sha256").update(text).digest("hex")

const normalizeReviewFilePath = (filePath: string) => {
  const normalized = filePath.replaceAll("\\", "/")
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new Error("Cannot open a file outside the repository checkout")
  }
  return normalized
}

const openProviderFile = async (
  gitProvider: {
    readonly fileUrl: (owner: string, name: string, filePath: string, ref: string) => string
  },
  owner: string,
  name: string,
  filePath: string,
  headRefName: string,
  headRefOid: string | null,
) => {
  const ref = headRefOid ?? headRefName
  await shell.openExternal(gitProvider.fileUrl(owner, name, filePath, ref))
}

const parseLocalReviewPathArg = (argv: readonly string[], cwd: string) => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue

    if (arg === LOCAL_REVIEW_ARG) {
      const value = argv[index + 1]
      return value === undefined ? null : resolve(cwd, value)
    }

    const prefix = `${LOCAL_REVIEW_ARG}=`
    if (arg.startsWith(prefix)) {
      return resolve(cwd, arg.slice(prefix.length))
    }
  }

  return null
}

const parseRepositoryLinkPathArg = (argv: readonly string[], cwd: string) => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue

    if (arg === LINK_REPOSITORY_ARG) {
      const value = argv[index + 1]
      return value === undefined ? null : resolve(cwd, value)
    }

    const prefix = `${LINK_REPOSITORY_ARG}=`
    if (arg.startsWith(prefix)) return resolve(cwd, arg.slice(prefix.length))
  }

  return null
}

const sendLocalReviewNavigation = (localPath: string) => {
  pendingLocalReviewPath = resolve(localPath)
  const targetWindow = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null
  if (targetWindow === null || targetWindow.isDestroyed()) return

  if (targetWindow.isMinimized()) {
    targetWindow.restore()
  }
  targetWindow.show()
  if (process.platform === "darwin") {
    app.focus({ steal: true })
  } else {
    targetWindow.focus()
  }
  targetWindow.webContents.send("navigation:openLocalReview", pendingLocalReviewPath)
}

const sendRepositoryLinkNavigation = (localPath: string) => {
  pendingRepositoryLinkPath = resolve(localPath)
  const targetWindow = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null
  if (targetWindow === null || targetWindow.isDestroyed()) return

  if (targetWindow.isMinimized()) targetWindow.restore()
  targetWindow.show()
  if (process.platform === "darwin") app.focus({ steal: true })
  else targetWindow.focus()
  targetWindow.webContents.send("navigation:linkRepository", pendingRepositoryLinkPath)
}

const openExternalUrl = async (url: string) => {
  if (!url.startsWith("https://") && !url.startsWith("http://")) return
  await shell.openExternal(url)
}

const createWindow = () => {
  const developmentIconPath = getDevelopmentIconPath()
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: "DiffDash",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    ...(developmentIconPath === null ? {} : { icon: developmentIconPath }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  mainWindow = window

  let isWindowShown = false
  const showMainWindow = () => {
    if (isWindowShown) {
      return
    }
    isWindowShown = true
    window.show()
    if (process.platform === "darwin") {
      app.focus({ steal: true })
    } else {
      window.focus()
    }
  }

  window.once("ready-to-show", showMainWindow)

  const rendererUrl =
    process.env.ELECTRON_RENDERER_URL ??
    pathToFileURL(join(__dirname, "../renderer/index.html")).toString()
  let loadingErrorPage = false
  const showElectronError = (message: string) => {
    if (window.isDestroyed() || loadingErrorPage) return
    loadingErrorPage = true
    void window
      .loadURL(electronErrorPageDataUrl(message, rendererUrl))
      .then(() => showMainWindow())
      .catch((fallbackError: unknown) => {
        showMainWindow()
        dialog.showErrorBox(
          "DiffDash encountered an error",
          `${message}\n\n${serializeError(fallbackError).message}`,
        )
        app.quit()
      })
      .finally(() => {
        loadingErrorPage = false
      })
  }

  window.on("closed", () => {
    mainWindow = null
  })

  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })

  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      const message = `Renderer failed to load (${errorCode}): ${errorDescription}\n${url}`
      console.error(`[renderer:load-failed] ${errorCode} ${errorDescription} ${url}`)
      showElectronError(message)
    },
  )

  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer:gone] ${details.reason} ${details.exitCode}`)
    if (details.reason !== "clean-exit") {
      showElectronError(
        `The DiffDash renderer stopped unexpectedly (${details.reason}, exit ${details.exitCode}).`,
      )
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url)
    return { action: "deny" }
  })

  window.webContents.on("will-navigate", (event, url) => {
    const currentUrl = window.webContents.getURL()
    if (url === currentUrl || url.startsWith("file://") || url.startsWith("http://localhost:")) {
      return
    }

    event.preventDefault()
    void openExternalUrl(url)
  })

  if (app.isPackaged) {
    window.webContents.on("devtools-opened", () => {
      window.webContents.closeDevTools()
    })
  }

  const loadWindow = process.env.ELECTRON_RENDERER_URL
    ? window.loadURL(process.env.ELECTRON_RENDERER_URL)
    : window.loadFile(join(__dirname, "../renderer/index.html"))

  void loadWindow
    .then(() => {
      showMainWindow()
      if (pendingLocalReviewPath !== null) {
        sendLocalReviewNavigation(pendingLocalReviewPath)
      }
      if (pendingRepositoryLinkPath !== null) {
        sendRepositoryLinkNavigation(pendingRepositoryLinkPath)
      }
      return undefined
    })
    .catch((error: unknown) => {
      const message = serializeError(error).message
      console.error(`[renderer:load-error] ${message}`)
      showElectronError(message)
    })
}

const start = async () => {
  app.setAppUserModelId("dev.diffdash.app")

  if (process.platform === "darwin") {
    app.setName("DiffDash")
    app.setActivationPolicy("regular")
  }

  await app.whenReady()
  if (process.platform === "darwin") {
    const developmentIconPath = getDevelopmentIconPath()
    if (developmentIconPath !== null) {
      app.dock?.setIcon(developmentIconPath)
    }
    app.dock?.show()
  }

  installIpcHandlers(createAppLayer())
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}

const singleInstanceLock =
  process.env.DIFFDASH_ALLOW_MULTIPLE_INSTANCES === "1" || app.requestSingleInstanceLock()

if (!singleInstanceLock) {
  app.quit()
} else {
  pendingLocalReviewPath = parseLocalReviewPathArg(process.argv, process.cwd())
  pendingRepositoryLinkPath = parseRepositoryLinkPathArg(process.argv, process.cwd())

  app.on("second-instance", (_event, argv, cwd) => {
    const repositoryLinkPath = parseRepositoryLinkPathArg(argv, cwd)
    if (repositoryLinkPath !== null) {
      sendRepositoryLinkNavigation(repositoryLinkPath)
      return
    }
    const localReviewPath = parseLocalReviewPathArg(argv, cwd)
    if (localReviewPath !== null) {
      sendLocalReviewNavigation(localReviewPath)
      return
    }

    const targetWindow = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null
    if (targetWindow === null || targetWindow.isDestroyed()) return
    if (targetWindow.isMinimized()) targetWindow.restore()
    targetWindow.show()
    targetWindow.focus()
  })

  void start()

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit()
    }
  })
}
