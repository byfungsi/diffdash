import { mkdirSync } from "node:fs"
import { AgentProviderId } from "@diffdash/agent-provider"
import { AgentProviderRegistry } from "@diffdash/agent-provider/registry"
import { DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import { type GitProviderRegistration, GitProviderRegistry } from "@diffdash/git-provider"
import { createFixtureGitProvider } from "@diffdash/git-provider-fixture"
import { createGitHubProvider } from "@diffdash/git-provider-github"
import { HostedReviewWorkspacePool } from "@diffdash/local-git/hosted-review-workspace-pool"
import { GitService } from "@diffdash/local-git/local-git"
import { AgentRunArtifactStore } from "@diffdash/persistence/agent-run-artifact-store"
import { DatabaseService } from "@diffdash/persistence/database"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import { ReviewTurnStore } from "@diffdash/persistence/review-turn-store"
import { ViewedFileStore } from "@diffdash/persistence/viewed-file-store"
import { WalkthroughStore } from "@diffdash/persistence/walkthrough-store"
import { ProcessService, processRequest } from "@diffdash/process"
import { ReviewAgentRouting, ReviewAgentService } from "@diffdash/review-agent"
import { ReviewThreadAnchorMapper } from "@diffdash/review-agent/anchor-mapper"
import { AgentArtifactNormalizer } from "@diffdash/review-agent/artifact-normalizer"
import { ReviewContextBuilder } from "@diffdash/review-agent/context-builder"
import { DiffDashMcpServer } from "@diffdash/review-agent/mcp-server"
import { AppSettings } from "@diffdash/settings/app-settings"
import { AppState } from "@diffdash/settings/app-state"
import { WalkthroughRouting, WalkthroughService } from "@diffdash/walkthrough"
import { Effect, Layer } from "effect"
import { app } from "electron"
import { AgentProviders } from "../../src/main/services/agent-providers"
import { Analytics } from "../../src/main/services/analytics"
import { AppConfig } from "../../src/main/services/app-config"
import { AppUpdater, nativeUpdaterAdapter } from "../../src/main/services/app-updater"
import { GitProvider } from "../../src/main/services/git-provider"
import { Prerequisites } from "../../src/main/services/prerequisites"
import { RepositoryLinker } from "../../src/main/services/repository-linker"
import { ReviewContextService } from "../../src/main/services/review-context"
import { ReviewSnapshotService } from "../../src/main/services/review-snapshot"
import { createAgentProviderComposition } from "./agent-provider-composition"
import { applicationPaths } from "./paths"

export const createAppLayer = () => {
  const {
    agentWorkingDirectory,
    databasePath,
    diffDashCliPath,
    remoteWorktreePoolPath,
    settingsPath,
    statePath,
    worktreePoolPath,
  } = applicationPaths()
  mkdirSync(agentWorkingDirectory, { recursive: true, mode: 0o700 })
  const configLayer = AppConfig.layer({
    appVersion: app.getVersion(),
    ...(process.env.APPIMAGE === undefined ? {} : { appImagePath: process.env.APPIMAGE }),
    architecture: process.arch,
    databasePath,
    diffDashCliPath,
    packaged: app.isPackaged,
    platform: process.platform,
    ...(process.env.VITE_POSTHOG_HOST === undefined
      ? {}
      : { posthogHost: process.env.VITE_POSTHOG_HOST }),
    ...(process.env.VITE_POSTHOG_KEY === undefined
      ? {}
      : { posthogKey: process.env.VITE_POSTHOG_KEY }),
    settingsPath,
    tempDir: agentWorkingDirectory,
    remoteWorktreePoolPath,
    worktreePoolPath,
  })
  const settingsLayer = AppSettings.layer(settingsPath)
  const processLayer = ProcessService.layer
  const gitProviderRegistryLayer = Layer.effect(
    GitProviderRegistry,
    Effect.gen(function* () {
      const processes = yield* ProcessService
      const registrations: GitProviderRegistration[] = [createGitHubProvider({}, processes)]
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
                : processes
                    .run(
                      processRequest("git", ["clone", "--bare", "--", remoteUrl, destination], {
                        timeoutMs: 120_000,
                      }),
                    )
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
  )
  const gitProviderLayer = GitProvider.layer.pipe(Layer.provide(gitProviderRegistryLayer))
  const appStateLayer = AppState.layer(statePath)
  const analyticsLayer = Analytics.layer.pipe(Layer.provideMerge(settingsLayer))
  const agentProviderRegistryLayer = Layer.effect(
    AgentProviderRegistry,
    Effect.gen(function* () {
      const processes = yield* ProcessService
      const { registrations, policies } = createAgentProviderComposition({
        processes,
        tempDirectory: agentWorkingDirectory,
        includeFixture: process.env.DIFFDASH_E2E_FAKE_AGENT_PROVIDER === "1",
      })
      return yield* AgentProviderRegistry.pipe(
        Effect.provide(AgentProviderRegistry.layer(registrations, policies)),
      )
    }),
  )
  const walkthroughRoutingLayer = Layer.effect(
    WalkthroughRouting,
    Effect.gen(function* () {
      const settings = yield* AppSettings
      return WalkthroughRouting.of({
        get: settings.get.pipe(
          Effect.catchAll(() => Effect.succeed(DEFAULT_AI_SETTINGS)),
          Effect.map((current) => ({
            route:
              current.routes.walkthrough === "auto"
                ? ({ mode: "auto" } as const)
                : ({
                    mode: "provider" as const,
                    providerId: AgentProviderId.make(current.routes.walkthrough),
                  } as const),
            models: current.models,
            autoQuality: current.autoQuality,
          })),
        ),
      })
    }),
  ).pipe(Layer.provide(settingsLayer))
  const walkthroughLayer = WalkthroughService.layer({
    remoteWorkingDirectory: agentWorkingDirectory,
  }).pipe(Layer.provide(agentProviderRegistryLayer), Layer.provide(walkthroughRoutingLayer))
  const agentProvidersLayer = AgentProviders.layer.pipe(Layer.provide(agentProviderRegistryLayer))
  const reviewContextLayer = ReviewContextService.layer.pipe(
    Layer.provideMerge(GitService.layer),
    Layer.provideMerge(gitProviderLayer),
  )
  const reviewSnapshotLayer = ReviewSnapshotService.layer().pipe(
    Layer.provideMerge(reviewContextLayer),
  )
  const threadStoreLayer = ReviewThreadStore.layer
  const reviewTurnStoreLayer = ReviewTurnStore.layer
  const artifactStoreLayer = AgentRunArtifactStore.layer
  const reviewAgentRoutingLayer = Layer.effect(
    ReviewAgentRouting,
    Effect.gen(function* () {
      const settings = yield* AppSettings
      return ReviewAgentRouting.of({
        get: settings.get.pipe(
          Effect.catchAll(() => Effect.succeed(DEFAULT_AI_SETTINGS)),
          Effect.map((current) => ({
            route:
              current.routes.reviewThread === "auto"
                ? ({ mode: "auto" } as const)
                : ({
                    mode: "provider" as const,
                    providerId: AgentProviderId.make(current.routes.reviewThread),
                  } as const),
            models: current.models,
            autoQuality: current.autoQuality,
          })),
        ),
      })
    }),
  ).pipe(Layer.provide(settingsLayer))
  const mcpLayer = DiffDashMcpServer.layer.pipe(
    Layer.provideMerge(threadStoreLayer),
    Layer.provideMerge(artifactStoreLayer),
  )
  const reviewAgentLayer = ReviewAgentService.layer.pipe(
    Layer.provideMerge(reviewAgentRoutingLayer),
    Layer.provideMerge(agentProviderRegistryLayer),
    Layer.provideMerge(gitProviderRegistryLayer),
    Layer.provideMerge(mcpLayer),
    Layer.provideMerge(ReviewContextBuilder.layer),
    Layer.provideMerge(AgentArtifactNormalizer.layer),
    Layer.provideMerge(reviewTurnStoreLayer),
    Layer.provideMerge(
      HostedReviewWorkspacePool.layer({ remoteWorktreePoolPath, worktreePoolPath }),
    ),
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
    reviewSnapshotLayer,
    reviewTurnStoreLayer,
    appStateLayer,
    Prerequisites.layer.pipe(
      Layer.provideMerge(gitProviderLayer),
      Layer.provideMerge(agentProvidersLayer),
    ),
    agentProvidersLayer,
    gitProviderLayer,
    walkthroughLayer,
    ViewedFileStore.layer,
    WalkthroughStore.layer,
    reviewAgentLayer,
    threadAnchorMapperLayer,
    updaterLayer,
  ).pipe(
    Layer.provideMerge(DatabaseService.layer(databasePath)),
    Layer.provideMerge(processLayer),
    Layer.provide(configLayer),
  )
}
