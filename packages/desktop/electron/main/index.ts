import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import { createAppLifecycle } from "./app-lifecycle"
import { parseCliNavigationCommand } from "./cli-navigation"
import {
  createDiffDashBrowserWindowOptions,
  isInternalNavigationAllowed,
  normalizeReviewFilePath,
  resolveContainedRepositoryPath,
} from "./electron-policy"
import { openAllowedExternalUrl, openLocalPath, openProviderFile } from "./file-opening"
import { createNavigationCommandQueue } from "./navigation-command-queue"
import { revealAppWindow } from "./window-activation"
import { AgentArtifactNormalizer } from "../../src/main/services/agent-artifact-normalizer"
import { electronErrorPageDataUrl } from "../error-page"
import { AgentRunArtifactStore } from "@diffdash/persistence/agent-run-artifact-store"
import { AgentRunStore } from "@diffdash/persistence/agent-run-store"
import { AIAgent } from "../../src/main/services/ai-agent"
import { Analytics } from "../../src/main/services/analytics"
import { AppConfig } from "../../src/main/services/app-config"
import { AppSettings } from "@diffdash/settings/app-settings"
import { AppState } from "@diffdash/settings/app-state"
import { AppUpdater, nativeUpdaterAdapter } from "../../src/main/services/app-updater"
import { CliError, CliService } from "@diffdash/process/cli"
import { CliStreamService } from "@diffdash/process/cli-stream"
import { ConfigurableAIAgent } from "../../src/main/services/configurable-ai-agent"
import { DatabaseService } from "@diffdash/persistence/database"
import { DiffDashMcpServer } from "../../src/main/services/diffdash-mcp-server"
import { GitService } from "@diffdash/local-git/local-git"
import { GitProvider } from "../../src/main/services/git-provider"
import { GitProviderRegistry, type GitProviderRegistration } from "@diffdash/git-provider"
import { createFixtureGitProvider } from "@diffdash/git-provider-fixture"
import { createGitHubProvider } from "@diffdash/git-provider-github"
import { OpenCodeSdkClient } from "../../src/main/services/opencode-sdk-client"
import { Prerequisites } from "../../src/main/services/prerequisites"
import { RepositoryLinkError, RepositoryLinker } from "../../src/main/services/repository-linker"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { ReviewAgentService } from "../../src/main/services/review-agent"
import { ReviewAgentProviderRegistry } from "../../src/main/services/review-agent-provider-registry"
import { ReviewContextService } from "../../src/main/services/review-context"
import { ReviewContextBuilder } from "../../src/main/services/review-context-builder"
import { ReviewThreadAnchorMapper } from "../../src/main/services/review-thread-anchor-mapper"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import { HostedReviewWorkspacePool } from "@diffdash/local-git/hosted-review-workspace-pool"
import { ThreadMemoryStore } from "@diffdash/persistence/thread-memory-store"
import { ViewedFileStore } from "@diffdash/persistence/viewed-file-store"
import { WalkthroughService } from "../../src/main/services/walkthrough"
import { WalkthroughStore } from "@diffdash/persistence/walkthrough-store"
import { AISettings } from "@diffdash/domain/ai-settings"
import { AnalyticsEvent } from "@diffdash/protocol/analytics"
import { DEFAULT_APP_STATE, AppState as SharedAppState } from "@diffdash/domain/app-state"
import type { AppUpdateState } from "@diffdash/protocol/app-update"
import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import type { LocalReviewSnapshot } from "@diffdash/domain/review-context"
import type { LocalReviewDetail, LocalReviewDiff } from "@diffdash/domain/local-review"
import type {
  PullRequestDetail,
  PullRequestDiff,
  PullRequestSummary,
} from "@diffdash/domain/pull-request"
import type { Repo, RepositorySearchScope } from "@diffdash/domain/repository"
import { RepositorySearchRequest, RepositorySearchResult } from "@diffdash/domain/repository"
import { AppPrerequisites, type DiffDashCliInstallResult } from "@diffdash/protocol/prerequisites"
import { LinkRepositoryCheckoutRequest } from "@diffdash/protocol/repository-link"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import { LocalReviewTarget } from "@diffdash/domain/local-review"
import { ReviewAgentProgress } from "@diffdash/domain/review-agent"
import { makePullRequestReviewKey } from "@diffdash/domain/review-identity"
import {
  GitProviderId,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewLocator,
  HostedReviewNumber,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import {
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
import {
  isReviewAnchorInParsedDiff,
  type ReviewThread,
  type ReviewThreadDetails,
  ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import {
  AddReviewThreadUserMessageRequest,
  CreateReviewThreadRequest,
  ReviewThreadIdRequest,
  RunReviewThreadAgentRequest,
} from "@diffdash/protocol/review-threads"
import {
  prepareWalkthroughPromptInput,
  type StoredWalkthrough,
  WALKTHROUGH_PROMPT_VERSION,
  walkthroughLocalDiffScope,
  walkthroughPullRequestScope,
} from "@diffdash/domain/walkthrough"

const startupStartedAt = Date.now() - process.uptime() * 1_000

const logStartupStage = (stage: string) => {
  console.info(`[startup] ${stage} +${Math.round(Date.now() - startupStartedAt)}ms`)
}

logStartupStage("main module loaded")

let mainWindow: BrowserWindow | null = null
const navigationCommandQueue = createNavigationCommandQueue()

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
    diffDashCliInPath: false,
    diffDashCliPath: null,
    gitInstalled: false,
    ghAuthenticated: false,
    ghInstalled: false,
    ghSearchRepositoriesAvailable: false,
    ghSupported: false,
    ghVersion: null,
    installedCodingAgents: [],
    providerDiagnostics: [],
    setupRequirements: [],
  })

const createAppLayer = () => {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  const databasePath = join(app.getPath("userData"), "diffdash.sqlite")
  const remoteWorktreePoolPath =
    process.env.DIFFDASH_REMOTE_WORKTREE_POOL_PATH ??
    join(homedir(), ".diffdash", "remote-worktree-pool")
  const worktreePoolPath =
    process.env.DIFFDASH_WORKTREE_POOL_PATH ?? join(homedir(), ".diffdash", "worktree-pool")
  const configLayer = AppConfig.layer({
    appVersion: app.getVersion(),
    ...(process.env.APPIMAGE === undefined ? {} : { appImagePath: process.env.APPIMAGE }),
    architecture: process.arch,
    databasePath,
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
    remoteWorktreePoolPath,
    worktreePoolPath,
  })
  const configDirectory = join(xdgConfigHome, "diffdash")
  const settingsLayer = AppSettings.layer(join(configDirectory, "settings.json"))
  const cliLayer = CliService.layer
  const gitProviderRegistryLayer = Layer.effect(
    GitProviderRegistry,
    Effect.gen(function* () {
      const cli = yield* CliService
      const registrations: GitProviderRegistration[] = [createGitHubProvider({}, cli)]
      if (process.env.DIFFDASH_E2E_FAKE_GIT_PROVIDER === "1") {
        const remoteUrl = process.env.DIFFDASH_E2E_FAKE_GIT_REMOTE
        registrations.push(
          createFixtureGitProvider({
            ...(remoteUrl === undefined ? {} : { remoteUrl }),
            ...(process.env.DIFFDASH_E2E_FAKE_GIT_BASE_SHA === undefined
              ? {}
              : { baseRevision: process.env.DIFFDASH_E2E_FAKE_GIT_BASE_SHA }),
            ...(process.env.DIFFDASH_E2E_FAKE_GIT_HEAD_SHA === undefined
              ? {}
              : { headRevision: process.env.DIFFDASH_E2E_FAKE_GIT_HEAD_SHA }),
            bootstrapBareRepository: (destination) =>
              remoteUrl === undefined
                ? Effect.dieMessage("DIFFDASH_E2E_FAKE_GIT_REMOTE is required")
                : cli
                    .run("git", ["clone", "--bare", "--", remoteUrl, destination], {
                      timeoutMs: 120_000,
                    })
                    .pipe(Effect.asVoid),
          }),
        )
      }
      const registry = yield* Effect.provide(
        GitProviderRegistry,
        GitProviderRegistry.layer(registrations),
      )
      return registry
    }),
  ).pipe(Layer.provide(cliLayer))
  const gitProviderLayer = GitProvider.layer.pipe(Layer.provide(gitProviderRegistryLayer))
  const appStateLayer = AppState.layer(join(configDirectory, "state.json"))
  const analyticsLayer = Analytics.layer.pipe(Layer.provideMerge(settingsLayer))
  const aiAgentLayer = ConfigurableAIAgent.layer.pipe(Layer.provideMerge(settingsLayer))
  const walkthroughLayer = WalkthroughService.layer.pipe(Layer.provideMerge(aiAgentLayer))
  const reviewContextLayer = ReviewContextService.layer.pipe(
    Layer.provideMerge(GitService.layer),
    Layer.provideMerge(gitProviderLayer),
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
    Layer.provideMerge(
      HostedReviewWorkspacePool.layer({ remoteWorktreePoolPath, worktreePoolPath }),
    ),
    Layer.provideMerge(gitProviderLayer),
  )
  const threadAnchorMapperLayer = ReviewThreadAnchorMapper.layer.pipe(
    Layer.provideMerge(threadStoreLayer),
  )
  const repositoryLinkerLayer = RepositoryLinker.layer.pipe(
    Layer.provideMerge(RepositoryStore.layer),
    Layer.provideMerge(GitService.layer),
    Layer.provideMerge(gitProviderLayer),
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
    appStateLayer,
    Prerequisites.layer.pipe(Layer.provideMerge(gitProviderLayer)),
    gitProviderLayer,
    walkthroughLayer,
    ViewedFileStore.layer,
    WalkthroughStore.layer,
    reviewAgentLayer,
    threadAnchorMapperLayer,
    updaterLayer,
  ).pipe(
    Layer.provideMerge(DatabaseService.layer(databasePath)),
    Layer.provideMerge(cliLayer),
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

  ipcMain.handle(InvokeChannel.analyticsStart, async (): Promise<void> => {
    const analytics = await run(Analytics)
    return run(analytics.start)
  })

  ipcMain.handle(InvokeChannel.analyticsCapture, async (_event, input: unknown): Promise<void> => {
    const event = await run(Schema.decodeUnknown(AnalyticsEvent)(input))
    const analytics = await run(Analytics)
    return run(analytics.capture(event))
  })

  ipcMain.handle(InvokeChannel.updatesGetState, async (): Promise<AppUpdateState> => {
    const updater = await run(AppUpdater)
    return run(updater.state)
  })

  ipcMain.handle(InvokeChannel.updatesCheck, async (): Promise<void> => {
    const updater = await run(AppUpdater)
    return run(updater.check)
  })

  ipcMain.handle(InvokeChannel.updatesDownload, async (): Promise<void> => {
    const updater = await run(AppUpdater)
    return run(updater.download)
  })

  ipcMain.handle(InvokeChannel.updatesRestartAndInstall, async (): Promise<void> => {
    const updater = await run(AppUpdater)
    await lifecycle.restartAndInstall(() => Effect.runPromise(updater.quitAndInstall))
  })

  void run(
    Effect.gen(function* () {
      const updater = yield* AppUpdater
      yield* updater.subscribe((state) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send(EventChannel.updateStateChanged, state)
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
      const review = hostedReview(target.providerId, target.owner, target.name, target.number)
      const snapshot = await run(contexts.getPullRequestSnapshot(review))
      const repo = await run(
        repositories.upsertRepository({
          provider: target.providerId,
          owner: target.owner,
          name: target.name,
          remoteUrl: await run(gitProvider.repositoryUrl(review.repository)),
          localPath: null,
        }),
      )
      return { repo, snapshot, prNumber: target.number } as const
    }

    const snapshot = await run(contexts.getLocalReviewSnapshot(target))
    const repo = await run(
      repositories.upsertRepository(localRepositoryInput(snapshot.detail.rootPath)),
    )
    return { repo, snapshot, prNumber: null } as const
  }

  ipcMain.handle(
    InvokeChannel.listRepositories,
    async (_event, query?: string): Promise<readonly Repo[]> => {
      const store = await run(RepositoryStore)
      return run(store.list(query))
    },
  )

  ipcMain.handle(
    InvokeChannel.listReviewThreads,
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
    InvokeChannel.addReviewThreadUserMessage,
    async (_event, input: unknown): Promise<ReviewThreadDetails> => {
      const request = await run(Schema.decodeUnknown(AddReviewThreadUserMessageRequest)(input))
      const threads = await run(ReviewThreadStore)
      return run(threads.addUserMessage(request))
    },
  )

  ipcMain.handle(
    InvokeChannel.createReviewThread,
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
    InvokeChannel.getReviewThread,
    async (_event, input: unknown): Promise<ReviewThreadDetails> => {
      const request = await run(Schema.decodeUnknown(ReviewThreadIdRequest)(input))
      const threads = await run(ReviewThreadStore)
      return run(threads.get(request.threadId))
    },
  )

  ipcMain.handle(
    InvokeChannel.runReviewThreadAgent,
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
                EventChannel.reviewThreadAgentProgress,
                ReviewAgentProgress.make({ threadId: request.threadId, stage }),
              )
            }),
        }),
      )
    },
  )

  ipcMain.handle(InvokeChannel.settingsGet, async (): Promise<AISettings> => {
    const settings = await run(AppSettings)
    return run(settings.get)
  })

  ipcMain.handle(
    InvokeChannel.settingsUpdate,
    async (_event, input: unknown): Promise<AISettings> => {
      const parsed = await run(Schema.decodeUnknown(AISettings)(input))
      const settings = await run(AppSettings)
      return run(settings.save(parsed))
    },
  )

  ipcMain.handle(InvokeChannel.appStateGet, async (): Promise<SharedAppState> => {
    if (isDebugOnboardingEnabled()) return DEFAULT_APP_STATE

    const appState = await run(AppState)
    return run(appState.get)
  })

  ipcMain.handle(
    InvokeChannel.appStateUpdate,
    async (_event, input: unknown): Promise<SharedAppState> => {
      const parsed = await run(Schema.decodeUnknown(SharedAppState)(input))
      if (isDebugOnboardingEnabled()) return parsed

      const appState = await run(AppState)
      return run(appState.save(parsed))
    },
  )

  ipcMain.handle(
    InvokeChannel.setRepositoryFavorite,
    async (_event, id: string, isFavorite: boolean): Promise<Repo> => {
      const store = await run(RepositoryStore)
      return run(store.setFavorite(id, isFavorite))
    },
  )

  ipcMain.handle(
    InvokeChannel.favoriteRemoteRepository,
    async (_event, input: unknown): Promise<Repo> => {
      const repo = await run(Schema.decodeUnknown(RepositorySearchResult)(input))
      const store = await run(RepositoryStore)
      return run(
        store.upsertRepository({
          provider: repo.providerId,
          owner: repo.owner,
          name: repo.name,
          remoteUrl: repo.url,
          localPath: null,
          isFavorite: true,
        }),
      )
    },
  )

  ipcMain.handle(
    InvokeChannel.addLocalRepository,
    async (_event, localPath: string): Promise<Repo> => {
      const git = await run(GitService)
      const gitProvider = await run(GitProvider)
      const store = await run(RepositoryStore)
      const rootPath = await run(git.detectRoot(localPath))
      try {
        const checkout = await run(git.detectRepository(rootPath))
        const detected = await run(gitProvider.parseRemoteUrl(checkout.remoteUrl))
        return run(
          store.upsertRepository({
            provider: detected.providerId,
            owner: detected.namespace,
            name: detected.name,
            remoteUrl: checkout.remoteUrl,
            localPath: checkout.rootPath,
            isFavorite: true,
          }),
        )
      } catch {
        return run(store.upsertRepository(localRepositoryInput(rootPath)))
      }
    },
  )

  ipcMain.handle(
    InvokeChannel.installRepository,
    async (_event, localPath: string): Promise<Repo> => {
      const linker = await run(RepositoryLinker)
      try {
        return await run(linker.install(localPath))
      } catch (error) {
        if (error instanceof RepositoryLinkError) throw new Error(error.reason, { cause: error })
        throw error
      }
    },
  )

  ipcMain.handle(InvokeChannel.linkRepository, async (_event, input: unknown): Promise<Repo> => {
    const request = await run(Schema.decodeUnknown(LinkRepositoryCheckoutRequest)(input))
    const linker = await run(RepositoryLinker)
    try {
      return await run(linker.link(request))
    } catch (error) {
      if (error instanceof RepositoryLinkError) throw new Error(error.reason, { cause: error })
      throw error
    }
  })

  ipcMain.handle(InvokeChannel.selectLocalFolder, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select a local Git repository",
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(
    InvokeChannel.listProviders,
    async (): Promise<readonly import("@diffdash/domain/git-provider").GitProviderDescriptor[]> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listProviders)
    },
  )

  ipcMain.handle(
    InvokeChannel.searchHostedRepositories,
    async (_event, input: unknown): Promise<readonly RepositorySearchResult[]> => {
      const request = await run(Schema.decodeUnknown(HostedRepositorySearchRequest)(input))
      const gitProvider = await run(GitProvider)
      try {
        return await run(
          gitProvider.searchRepositories(
            RepositorySearchRequest.make({
              providerId: request.providerId,
              query: request.query,
              owners: request.namespaces,
            }),
          ),
        )
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
    InvokeChannel.listHostedRepositorySearchScopes,
    async (_event, input: unknown): Promise<readonly RepositorySearchScope[]> => {
      const request = await run(Schema.decodeUnknown(HostedProviderRequest)(input))
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listSearchScopes(request.providerId))
    },
  )

  ipcMain.handle(
    InvokeChannel.listHostedReviews,
    async (_event, input: unknown): Promise<readonly PullRequestSummary[]> => {
      const request = await run(Schema.decodeUnknown(HostedRepositoryRequest)(input))
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listPullRequests(request.repository))
    },
  )

  ipcMain.handle(
    InvokeChannel.listAssignedHostedReviews,
    async (_event, input: unknown): Promise<readonly PullRequestSummary[]> => {
      const request = await run(Schema.decodeUnknown(HostedProviderRequest)(input))
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listReviewRequests(request.providerId))
    },
  )

  ipcMain.handle(
    InvokeChannel.getHostedReview,
    async (_event, input: unknown): Promise<PullRequestDetail> => {
      const request = await run(Schema.decodeUnknown(HostedReviewRequest)(input))
      const gitProvider = await run(GitProvider)
      return run(gitProvider.getPullRequestDetail(request.review))
    },
  )

  ipcMain.handle(
    InvokeChannel.refreshHostedReview,
    async (_event, input: unknown): Promise<PullRequestDetail> => {
      const request = await run(Schema.decodeUnknown(HostedReviewRequest)(input))
      const gitProvider = await run(GitProvider)
      return run(gitProvider.refreshPullRequestDetail(request.review))
    },
  )

  ipcMain.handle(
    InvokeChannel.getHostedReviewDiff,
    async (_event, input: unknown): Promise<PullRequestDiff> => {
      const request = await run(Schema.decodeUnknown(HostedReviewRequest)(input))
      const gitProvider = await run(GitProvider)
      return run(gitProvider.getPullRequestDiff(request.review))
    },
  )

  ipcMain.handle(
    InvokeChannel.getHostedReviewDecision,
    async (
      _event,
      input: unknown,
    ): Promise<import("@diffdash/domain/git-provider").ReviewDecision> => {
      const request = await run(Schema.decodeUnknown(HostedReviewRequest)(input))
      const gitProvider = await run(GitProvider)
      return (await run(gitProvider.hasApprovedPullRequest(request.review))) ? "approved" : "none"
    },
  )

  ipcMain.handle(
    InvokeChannel.submitHostedReviewDecision,
    async (_event, input: unknown): Promise<void> => {
      const request = await run(Schema.decodeUnknown(SubmitHostedReviewDecisionRequest)(input))
      if (request.decision !== "approved") throw new Error("Only approval is currently supported")
      const gitProvider = await run(GitProvider)
      return run(gitProvider.approvePullRequest(request.review))
    },
  )

  ipcMain.handle(
    InvokeChannel.resolveLocalBranch,
    async (_event, localPath: string, branchName: string | null): Promise<LocalReviewTarget> => {
      const git = await run(GitService)
      return run(git.resolveBranchComparison(localPath, branchName))
    },
  )

  ipcMain.handle(
    InvokeChannel.localReviewDetail,
    async (_event, input: unknown): Promise<LocalReviewDetail> => {
      const target = await run(Schema.decodeUnknown(LocalReviewTarget)(input))
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const detail = await run(git.getLocalReviewDetail(target))
      await run(store.upsertRepository(localRepositoryInput(detail.rootPath)))
      return detail
    },
  )

  ipcMain.handle(
    InvokeChannel.localReviewDiff,
    async (_event, input: unknown): Promise<LocalReviewDiff> => {
      const target = await run(Schema.decodeUnknown(LocalReviewTarget)(input))
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const diff = await run(git.getLocalReviewDiff(target))
      await run(store.upsertRepository(localRepositoryInput(diff.rootPath)))
      return diff
    },
  )

  ipcMain.handle(
    InvokeChannel.localReviewSnapshot,
    async (_event, input: unknown): Promise<LocalReviewSnapshot> => {
      const target = await run(Schema.decodeUnknown(LocalReviewTarget)(input))
      const git = await run(GitService)
      const store = await run(RepositoryStore)
      const snapshot = await run(git.getLocalReviewSnapshot(target))
      await run(store.upsertRepository(localRepositoryInput(snapshot.detail.rootPath)))
      return snapshot
    },
  )

  ipcMain.handle(
    InvokeChannel.drainNavigationCommands,
    async (): Promise<readonly CliNavigationCommand[]> => {
      return navigationCommandQueue.drain()
    },
  )

  ipcMain.handle(
    InvokeChannel.getWalkthrough,
    async (_event, input: unknown): Promise<StoredWalkthrough | null> => {
      const request = await run(Schema.decodeUnknown(HostedWalkthroughRequest)(input))
      const hostedRepository = request.review.repository
      const store = await run(RepositoryStore)
      const gitProvider = await run(GitProvider)
      const walkthroughStore = await run(WalkthroughStore)
      const repo = await run(
        store.upsertRepository({
          provider: hostedRepository.providerId,
          owner: hostedRepository.namespace,
          name: hostedRepository.name,
          remoteUrl: await run(gitProvider.repositoryUrl(hostedRepository)),
          localPath: null,
        }),
      )
      return run(
        walkthroughStore.get({
          repoId: repo.id,
          reviewKey: pullRequestReviewKey(
            hostedRepository.providerId,
            hostedRepository.namespace,
            hostedRepository.name,
            request.review.number,
          ),
          baseSha: request.baseRevision,
          headSha: request.headRevision,
          promptVersion: WALKTHROUGH_PROMPT_VERSION,
        }),
      )
    },
  )

  ipcMain.handle(
    InvokeChannel.getLocalWalkthrough,
    async (
      _event,
      input: unknown,
      baseSha: string,
      headSha: string,
    ): Promise<StoredWalkthrough | null> => {
      const target = await run(Schema.decodeUnknown(LocalReviewTarget)(input))
      const contexts = await run(ReviewContextService)
      const store = await run(RepositoryStore)
      const walkthroughStore = await run(WalkthroughStore)
      const snapshot = await run(contexts.getLocalReviewSnapshot(target))
      const repo = await run(store.upsertRepository(localRepositoryInput(snapshot.detail.rootPath)))
      return run(
        walkthroughStore.get({
          repoId: repo.id,
          reviewKey: snapshot.reviewKey,
          baseSha,
          headSha,
          promptVersion: WALKTHROUGH_PROMPT_VERSION,
        }),
      )
    },
  )

  ipcMain.handle(
    InvokeChannel.listViewedFiles,
    async (_event, input: unknown): Promise<readonly string[]> => {
      const request = await run(Schema.decodeUnknown(HostedViewedFilesRequest)(input))
      const hostedRepository = request.review.repository
      const store = await run(RepositoryStore)
      const gitProvider = await run(GitProvider)
      const viewedFiles = await run(ViewedFileStore)
      const repo = await run(
        store.upsertRepository({
          provider: hostedRepository.providerId,
          owner: hostedRepository.namespace,
          name: hostedRepository.name,
          remoteUrl: await run(gitProvider.repositoryUrl(hostedRepository)),
          localPath: null,
        }),
      )
      return run(
        viewedFiles.list({
          repoId: repo.id,
          prNumber: request.review.number,
          headSha: request.headRevision,
        }),
      )
    },
  )

  ipcMain.handle(InvokeChannel.setViewedFile, async (_event, input: unknown): Promise<void> => {
    const request = await run(Schema.decodeUnknown(SetHostedViewedFileRequest)(input))
    const hostedRepository = request.review.repository
    const store = await run(RepositoryStore)
    const gitProvider = await run(GitProvider)
    const viewedFiles = await run(ViewedFileStore)
    const repo = await run(
      store.upsertRepository({
        provider: hostedRepository.providerId,
        owner: hostedRepository.namespace,
        name: hostedRepository.name,
        remoteUrl: await run(gitProvider.repositoryUrl(hostedRepository)),
        localPath: null,
      }),
    )
    return run(
      viewedFiles.set({
        repoId: repo.id,
        prNumber: request.review.number,
        headSha: request.headRevision,
        reviewKey: request.reviewKey,
        filePath: request.filePath,
        viewed: request.viewed,
      }),
    )
  })

  ipcMain.handle(
    InvokeChannel.listLocalViewedFiles,
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
    InvokeChannel.setLocalViewedFile,
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
    InvokeChannel.generateWalkthrough,
    async (_event, input: unknown): Promise<StoredWalkthrough> => {
      const request = await run(Schema.decodeUnknown(GenerateHostedWalkthroughRequest)(input))
      const { repository } = request.review
      const repositoryStore = await run(RepositoryStore)
      const gitProvider = await run(GitProvider)
      const walkthroughStore = await run(WalkthroughStore)
      const walkthroughService = await run(WalkthroughService)

      const repo = await run(
        repositoryStore.upsertRepository({
          provider: repository.providerId,
          owner: repository.namespace,
          name: repository.name,
          remoteUrl: await run(gitProvider.repositoryUrl(repository)),
          localPath: null,
        }),
      )
      const pullRequest = await run(gitProvider.getPullRequestDetail(request.review))
      const baseSha = pullRequest.baseRefOid
      if (baseSha === null) {
        throw new Error("Cannot generate a walkthrough without a PR base SHA")
      }

      let diff: PullRequestDiff | null = null
      let headSha = pullRequest.headRefOid
      if (headSha === null) {
        diff = await run(gitProvider.getPullRequestDiff(request.review))
        headSha = diff.headRefOid
      }
      if (headSha === null) {
        throw new Error("Cannot generate a walkthrough without a PR head SHA")
      }

      const reviewKey = pullRequestReviewKey(
        repository.providerId,
        repository.namespace,
        repository.name,
        request.review.number,
      )
      const cacheKey = {
        repoId: repo.id,
        reviewKey,
        baseSha,
        headSha,
        promptVersion: WALKTHROUGH_PROMPT_VERSION,
      }

      if (!request.regenerate) {
        const cached = await run(walkthroughStore.get(cacheKey))
        if (cached !== null) return cached
      }

      diff ??= await run(gitProvider.getPullRequestDiff(request.review))
      const parsedDiff = parseUnifiedDiff(diff.diff)
      const promptInput = await run(
        prepareWalkthroughPromptInput(
          parsedDiff.files,
          walkthroughPullRequestScope(request.review.number),
        ),
      )
      const walkthrough = await run(
        walkthroughService.generate({
          review: { kind: "pullRequest", pullRequest },
          diff: promptInput.diff,
          hunkDigest: promptInput.hunkDigest,
          changedFileTree: promptInput.changedFileTree,
          generation: promptInput.generation,
          promptStats: promptInput.stats,
        }),
      )

      return run(
        walkthroughStore.save({
          ...cacheKey,
          prNumber: request.review.number,
          walkthrough,
        }),
      )
    },
  )

  ipcMain.handle(
    InvokeChannel.generateLocalWalkthrough,
    async (_event, input: unknown, regenerate: boolean): Promise<StoredWalkthrough> => {
      const target = await run(Schema.decodeUnknown(LocalReviewTarget)(input))
      const contexts = await run(ReviewContextService)
      const repositoryStore = await run(RepositoryStore)
      const walkthroughStore = await run(WalkthroughStore)
      const walkthroughService = await run(WalkthroughService)

      const snapshot = await run(contexts.getLocalReviewSnapshot(target))
      const localReview = snapshot.detail
      const diff = snapshot.diff
      const repo = await run(repositoryStore.upsertRepository(localRepositoryInput(diff.rootPath)))
      const cacheKey = {
        repoId: repo.id,
        reviewKey: snapshot.reviewKey,
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
          changedFileTree: promptInput.changedFileTree,
          generation: promptInput.generation,
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

  ipcMain.handle(InvokeChannel.appDiagnostics, async (): Promise<AppPrerequisites> => {
    if (isDebugOnboardingEnabled()) return debugMissingPrerequisites()

    const prerequisites = await run(Prerequisites)
    return run(prerequisites.get)
  })

  ipcMain.handle(
    InvokeChannel.appInstallDiffDashCli,
    async (): Promise<DiffDashCliInstallResult> => {
      const prerequisites = await run(Prerequisites)
      return run(prerequisites.installDiffDashCli)
    },
  )

  ipcMain.handle(InvokeChannel.appOpenExternalUrl, async (_event, url: string): Promise<void> => {
    await openAllowedExternalUrl((targetUrl) => shell.openExternal(targetUrl), url)
  })

  ipcMain.handle(
    InvokeChannel.appOpenRepositoryFile,
    async (_event, input: unknown): Promise<void> => {
      const request = await run(Schema.decodeUnknown(OpenHostedReviewFileRequest)(input))
      const hostedRepository = request.review.repository
      const store = await run(RepositoryStore)
      const git = await run(GitService)
      const gitProvider = await run(GitProvider)
      const repositories = await run(
        store.list(`${hostedRepository.namespace}/${hostedRepository.name}`),
      )
      const linkedRepository = repositories.find(
        (repo) =>
          repo.provider === request.review.repository.providerId &&
          repo.owner.toLowerCase() === request.review.repository.namespace.toLowerCase() &&
          repo.name.toLowerCase() === request.review.repository.name.toLowerCase(),
      )

      if (isAbsolute(request.filePath)) {
        throw new Error("Cannot open an absolute file path from a review")
      }

      const normalizedFilePath = normalizeReviewFilePath(request.filePath)

      if (linkedRepository?.localPath === null || linkedRepository?.localPath === undefined) {
        await openProviderFile(
          (locator, path, revision) => run(gitProvider.fileUrl(locator, path, revision)),
          (targetUrl) => shell.openExternal(targetUrl),
          request.review.repository,
          normalizedFilePath,
          request.headRefName,
          request.headRevision,
        )
        return
      }

      let currentBranch: string
      try {
        currentBranch = await run(git.currentBranch(linkedRepository.localPath))
      } catch {
        await openProviderFile(
          (locator, path, revision) => run(gitProvider.fileUrl(locator, path, revision)),
          (targetUrl) => shell.openExternal(targetUrl),
          request.review.repository,
          normalizedFilePath,
          request.headRefName,
          request.headRevision,
        )
        return
      }
      if (currentBranch !== request.headRefName) {
        await openProviderFile(
          (locator, path, revision) => run(gitProvider.fileUrl(locator, path, revision)),
          (targetUrl) => shell.openExternal(targetUrl),
          request.review.repository,
          normalizedFilePath,
          request.headRefName,
          request.headRevision,
        )
        return
      }

      const targetPath = resolveContainedRepositoryPath(
        linkedRepository.localPath,
        normalizedFilePath,
      )

      await openLocalPath((path) => shell.openPath(path), targetPath)
    },
  )

  ipcMain.handle(
    InvokeChannel.appOpenLocalRepositoryFile,
    async (_event, rootPath: string, filePath: string): Promise<void> => {
      const git = await run(GitService)
      const canonicalRootPath = await run(git.detectRoot(rootPath))

      const targetPath = resolveContainedRepositoryPath(canonicalRootPath, filePath)

      await openLocalPath((path) => shell.openPath(path), targetPath)
    },
  )
}

const pullRequestReviewKey = (
  provider: Repo["provider"],
  owner: string,
  name: string,
  number: number,
) => makePullRequestReviewKey(provider, owner, name, number)

const hostedReview = (providerId: string, owner: string, name: string, number: number) =>
  HostedReviewLocator.make({
    repository: HostedRepositoryLocator.make({
      providerId: GitProviderId.make(providerId),
      namespace: RepositoryNamespace.make(owner),
      name: HostedRepositoryName.make(name),
    }),
    number: HostedReviewNumber.make(number),
  })

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

const isHiddenE2EWindow = () => process.env.DIFFDASH_E2E_HIDDEN === "1"

const revealWindow = (targetWindow: BrowserWindow) => {
  revealAppWindow(targetWindow, {
    hidden: isHiddenE2EWindow(),
    platform: process.platform,
    focusApplication: () => app.focus({ steal: true }),
  })
}

const enqueueNavigationCommand = (command: CliNavigationCommand) => {
  navigationCommandQueue.enqueue(command)
  const targetWindow = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null
  if (targetWindow === null || targetWindow.isDestroyed()) return

  revealWindow(targetWindow)
  targetWindow.webContents.send(EventChannel.navigationCommandsAvailable)
}

const createWindow = () => {
  const developmentIconPath = getDevelopmentIconPath()
  const window = new BrowserWindow(
    createDiffDashBrowserWindowOptions({
      iconPath: developmentIconPath,
      preloadPath: join(__dirname, "../preload/index.mjs"),
    }),
  )
  mainWindow = window
  logStartupStage("window created")

  let isWindowShown = false
  let showFallbackTimer: NodeJS.Timeout | null = null
  const showMainWindow = () => {
    if (isWindowShown) {
      return
    }
    isWindowShown = true
    if (showFallbackTimer !== null) clearTimeout(showFallbackTimer)
    revealWindow(window)
    logStartupStage(isHiddenE2EWindow() ? "window ready (hidden)" : "window shown")
  }

  window.once("ready-to-show", showMainWindow)
  showFallbackTimer = setTimeout(showMainWindow, 2_000)
  showFallbackTimer.unref()

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
    if (showFallbackTimer !== null) clearTimeout(showFallbackTimer)
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
    void openAllowedExternalUrl((targetUrl) => shell.openExternal(targetUrl), url)
    return { action: "deny" }
  })

  window.webContents.on("will-navigate", (event, url) => {
    const currentUrl = window.webContents.getURL()
    if (isInternalNavigationAllowed(url, currentUrl)) return

    event.preventDefault()
    void openAllowedExternalUrl((targetUrl) => shell.openExternal(targetUrl), url)
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
      logStartupStage("renderer loaded")
      showMainWindow()
      if (navigationCommandQueue.hasPending()) {
        window.webContents.send(EventChannel.navigationCommandsAvailable)
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
    app.setActivationPolicy(isHiddenE2EWindow() ? "accessory" : "regular")
  }

  await app.whenReady()
  logStartupStage("electron ready")
  if (process.platform === "darwin" && !isHiddenE2EWindow()) {
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
  const initialCommand = parseCliNavigationCommand(process.argv, process.cwd())
  if (initialCommand !== null) navigationCommandQueue.enqueue(initialCommand)

  app.on("second-instance", (_event, argv, cwd) => {
    const command = parseCliNavigationCommand(argv, cwd)
    if (command !== null) {
      enqueueNavigationCommand(command)
      return
    }

    const targetWindow = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null
    if (targetWindow === null || targetWindow.isDestroyed()) return
    revealWindow(targetWindow)
  })

  void start()

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit()
    }
  })
}
