import { mkdirSync } from "node:fs"
import { AgentProviderId } from "@diffdash/agent-provider"
import { AgentProviderRegistry } from "@diffdash/agent-provider/registry"
import { DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import { GitProviderRegistry } from "@diffdash/git-provider"
import { HostedReviewWorkspacePool } from "@diffdash/local-git/hosted-review-workspace-pool"
import { GitService } from "@diffdash/local-git/local-git"
import { AgentRunArtifactStore } from "@diffdash/persistence/agent-run-artifact-store"
import { DatabaseService } from "@diffdash/persistence/database"
import { ProjectWorkspaceStore } from "@diffdash/persistence/project-workspace-store"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import { ReviewTurnStore } from "@diffdash/persistence/review-turn-store"
import { ViewedFileStore } from "@diffdash/persistence/viewed-file-store"
import { WalkthroughStore } from "@diffdash/persistence/walkthrough-store"
import { ProcessService } from "@diffdash/process"
import { TempResources } from "@diffdash/process/temp-resource"
import { ReviewAgentRouting, ReviewAgentService } from "@diffdash/review-agent"
import { ReviewThreadAnchorMapper } from "@diffdash/review-agent/anchor-mapper"
import { AgentArtifactNormalizer } from "@diffdash/review-agent/artifact-normalizer"
import { ReviewContextBuilder } from "@diffdash/review-agent/context-builder"
import { DiffDashMcpServer } from "@diffdash/review-agent/mcp-server"
import { AppSettings } from "@diffdash/settings/app-settings"
import { AppState } from "@diffdash/settings/app-state"
import { FileStorage } from "@diffdash/settings/file-storage"
import { WalkthroughRouting, WalkthroughService } from "@diffdash/walkthrough"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, Layer } from "effect"
import type { CoreConfiguration } from "./core-configuration"
import { CoreOperationService, coreOperationLayer } from "./core-operation-service"
import { CoreStartupError, type CoreStartupFailure } from "./core-startup-error"
import {
  createAgentProviderComposition,
  createGitProviderComposition,
} from "./provider-composition"
import { AgentProviders } from "./services/agent-providers"
import { Analytics } from "./services/analytics"
import { GitProvider } from "./services/git-provider"
import { Prerequisites } from "./services/prerequisites"
import { RepositoryComparisonSource } from "./services/repository-comparison-source"
import { RepositoryLinker } from "./services/repository-linker"
import { ReviewContextService } from "./services/review-context"
import { ReviewSnapshotService } from "./services/review-snapshot"

/** Builds the runtime-neutral business service graph owned by DiffDash Core. */
export const createCoreLayer = (
  configuration: CoreConfiguration,
): Layer.Layer<CoreOperationService, CoreStartupFailure> => {
  const agentWorkingDirectory = configuration.paths.temporaryDirectory
  const databasePath = configuration.paths.database
  const remoteWorktreePoolPath = configuration.paths.remoteWorktreePool
  const settingsPath = configuration.paths.settings
  const statePath = configuration.paths.state
  const worktreePoolPath = configuration.paths.worktreePool
  const temporaryDirectoryLayer = Layer.effectDiscard(
    Effect.try({
      try: () => mkdirSync(agentWorkingDirectory, { recursive: true, mode: 0o700 }),
      catch: (cause) =>
        CoreStartupError.make({
          operation: "createTemporaryDirectory",
          message: "DiffDash Core could not create its temporary directory.",
          cause,
        }),
    }),
  )
  const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const fileStorageLayer = FileStorage.layer.pipe(Layer.provide(platformLayer))
  const tempResourcesLayer = TempResources.layer.pipe(Layer.provide(platformLayer))
  const settingsLayer = AppSettings.layer(settingsPath).pipe(Layer.provide(fileStorageLayer))
  const processLayer = ProcessService.layer
  const gitProviderRegistryLayer = Layer.effect(
    GitProviderRegistry,
    Effect.gen(function* () {
      const processes = yield* ProcessService
      const registrations = createGitProviderComposition(
        processes,
        configuration.fixtures.gitProvider,
      )
      const registry = yield* Effect.provide(
        GitProviderRegistry,
        GitProviderRegistry.layer(registrations),
      )
      return registry
    }),
  )
  const gitProviderLayer = GitProvider.layer.pipe(Layer.provide(gitProviderRegistryLayer))
  const appStateLayer = AppState.layer(statePath).pipe(Layer.provide(fileStorageLayer))
  const analyticsLayer = Analytics.makeLayer({
    appVersion: configuration.application.version,
    architecture: configuration.application.architecture,
    packaged: configuration.application.packaged,
    platform: configuration.application.platform,
    posthogHost: configuration.analytics.host,
    posthogKey: configuration.analytics.projectKey,
    settingsPath,
  }).pipe(Layer.provideMerge(settingsLayer))
  const agentProviderRegistryLayer = Layer.effect(
    AgentProviderRegistry,
    Effect.gen(function* () {
      const processes = yield* ProcessService
      const tempResources = yield* TempResources
      const { registrations, policies } = createAgentProviderComposition({
        processes,
        tempResources,
        tempDirectory: agentWorkingDirectory,
        includeFixture: configuration.fixtures.agentProviderEnabled,
        fixtureWalkthroughNeverCompletes: configuration.fixtures.agentProviderNeverCompletes,
      })
      return yield* AgentProviderRegistry.pipe(
        Effect.provide(AgentProviderRegistry.layer(registrations, policies)),
      )
    }),
  ).pipe(Layer.provide(tempResourcesLayer))
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
  const hostedReviewWorkspacePoolLayer = HostedReviewWorkspacePool.layer({
    remoteWorktreePoolPath,
    worktreePoolPath,
  })
  const reviewAgentLayer = ReviewAgentService.layer.pipe(
    Layer.provideMerge(reviewAgentRoutingLayer),
    Layer.provideMerge(agentProviderRegistryLayer),
    Layer.provideMerge(gitProviderRegistryLayer),
    Layer.provideMerge(mcpLayer),
    Layer.provideMerge(ReviewContextBuilder.layer),
    Layer.provideMerge(AgentArtifactNormalizer.layer),
    Layer.provideMerge(reviewTurnStoreLayer),
    Layer.provideMerge(hostedReviewWorkspacePoolLayer),
  )
  const threadAnchorMapperLayer = ReviewThreadAnchorMapper.layer.pipe(
    Layer.provideMerge(threadStoreLayer),
  )
  const repositoryLinkerLayer = RepositoryLinker.layer.pipe(
    Layer.provideMerge(RepositoryStore.layer),
    Layer.provideMerge(GitService.layer),
    Layer.provideMerge(gitProviderLayer),
  )
  const repositoryComparisonSourceLayer = RepositoryComparisonSource.layer.pipe(
    Layer.provide(
      Layer.mergeAll(repositoryLinkerLayer, gitProviderLayer, hostedReviewWorkspacePoolLayer),
    ),
  )
  const reviewSnapshotLayer = ReviewSnapshotService.layer().pipe(
    Layer.provideMerge(reviewContextLayer),
    Layer.provideMerge(repositoryComparisonSourceLayer),
  )
  const prerequisitesLayer = Prerequisites.layer({
    appImagePath: configuration.paths.appImage,
    diffDashCliPath: configuration.paths.diffDashCli,
    executableSearchPath: configuration.environment.executableSearchPath,
    executablePathExtensions: configuration.environment.executablePathExtensions,
    homeDirectory: configuration.environment.homeDirectory,
    platform: configuration.application.platform,
  }).pipe(Layer.provideMerge(gitProviderLayer), Layer.provideMerge(agentProvidersLayer))

  const businessServicesLayer = Layer.mergeAll(
    temporaryDirectoryLayer,
    repositoryLinkerLayer,
    repositoryComparisonSourceLayer,
    ProjectWorkspaceStore.layer,
    analyticsLayer,
    reviewSnapshotLayer,
    reviewTurnStoreLayer,
    appStateLayer,
    prerequisitesLayer,
    agentProvidersLayer,
    gitProviderLayer,
    walkthroughLayer,
    ViewedFileStore.layer,
    WalkthroughStore.layer,
    reviewAgentLayer,
    threadAnchorMapperLayer,
  ).pipe(Layer.provide(DatabaseService.layer(databasePath)), Layer.provide(processLayer))

  return coreOperationLayer.pipe(Layer.provide(businessServicesLayer))
}
