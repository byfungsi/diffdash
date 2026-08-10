import { AgentProviderRegistry } from "@diffdash/agent-provider/registry"
import { DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { GitProviderRegistry } from "@diffdash/git-provider"
import { HostedReviewWorkspacePool } from "@diffdash/local-git/hosted-review-workspace-pool"
import { GitService } from "@diffdash/local-git/local-git"
import { AgentRunArtifactStore } from "@diffdash/persistence/agent-run-artifact-store"
import type { DatabaseError } from "@diffdash/persistence/database"
import { ProjectWorkspaceStore } from "@diffdash/persistence/project-workspace-store"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import { ReviewTurnStore } from "@diffdash/persistence/review-turn-store"
import { ViewedFileStore } from "@diffdash/persistence/viewed-file-store"
import { WalkthroughOperationStore } from "@diffdash/persistence/walkthrough-operation-store"
import { WalkthroughStore } from "@diffdash/persistence/walkthrough-store"
import { ProcessService } from "@diffdash/process"
import { defaultExecutablePath } from "@diffdash/process/executable"
import { ProcessFileSystem } from "@diffdash/process/file-system"
import { TempResources } from "@diffdash/process/temp-resource"
import { DiffDashMcpServer } from "@diffdash/mcp"
import { AppSettings } from "@diffdash/settings/app-settings"
import { AppState } from "@diffdash/settings/app-state"
import { FileStorage } from "@diffdash/settings/file-storage"
import { WalkthroughRouting, WalkthroughService } from "@diffdash/agents/walkthrough"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Cause, Effect, Layer, Option } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { ExecutableSearchPath, type CoreConfiguration } from "./core-configuration"
import { CoreOperationService, coreOperationLayer } from "./core-operation-service"
import { CoreStartupError, type CoreStartupFailure, toCoreStartupError } from "./core-startup-error"
import type { CoreProviderComposition } from "./provider-composition"
import { AgentProviders } from "./services/agent-providers"
import { Analytics } from "./services/analytics"
import { GitProvider } from "./services/git-provider"
import { Prerequisites } from "./services/prerequisites"
import { RepositoryComparisonSource } from "./services/repository-comparison-source"
import { RepositoryLinker } from "./services/repository-linker"
import { ReviewSnapshotService } from "./services/review-snapshot"
import { AgentArtifactNormalizer } from "./services/agent-artifact-normalizer"
import { ReviewAgentRouting, ReviewAgentService } from "./services/review-agent"
import { ReviewMcpHandlers } from "./services/review-mcp-handlers"
import { ReviewThreadAnchorMapper } from "./services/review-thread-anchor-mapper"

/** Builds the runtime-neutral business service graph owned by DiffDash Core. */
export const createCoreLayer = (
  configuration: CoreConfiguration,
  databaseLayer: Layer.Layer<SqlClient.SqlClient, DatabaseError>,
  providerComposition: CoreProviderComposition,
): Layer.Layer<CoreOperationService, CoreStartupFailure> => {
  const executableSearchPath = ExecutableSearchPath.make(
    defaultExecutablePath(configuration.environment.executableSearchPath),
  )
  const agentWorkingDirectory = configuration.paths.temporaryDirectory
  const remoteWorktreePoolPath = configuration.paths.remoteWorktreePool
  const settingsPath = configuration.paths.settings
  const statePath = configuration.paths.state
  const worktreePoolPath = configuration.paths.worktreePool
  const temporaryDirectoryLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const fileSystem = yield* ProcessFileSystem
      yield* fileSystem
        .ensureDirectory(agentWorkingDirectory, { recursive: true, mode: 0o700 })
        .pipe(
          Effect.mapError((cause) =>
            CoreStartupError.make({
              operation: "createTemporaryDirectory",
              message: "DiffDash Core could not create its temporary directory.",
              cause,
            }),
          ),
        )
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
      const registrations = providerComposition.createGitProviders(processes, configuration)
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
    analytics: configuration.analytics,
    settingsPath,
  }).pipe(Layer.provideMerge(settingsLayer), Layer.provide(fileStorageLayer))
  const agentProviderRegistryLayer = Layer.effect(
    AgentProviderRegistry,
    Effect.gen(function* () {
      const processes = yield* ProcessService
      const tempResources = yield* TempResources
      const { registrations, policies } = providerComposition.createAgentProviders(
        {
          processes,
          tempResources,
          tempDirectory: agentWorkingDirectory,
        },
        configuration,
      )
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
          Effect.catch(() => Effect.succeed(DEFAULT_AI_SETTINGS)),
          Effect.map((current) => ({
            selection: current.selections.walkthrough,
          })),
        ),
      })
    }),
  ).pipe(Layer.provide(settingsLayer))
  const walkthroughLayer = WalkthroughService.layer({
    remoteWorkingDirectory: agentWorkingDirectory,
  }).pipe(Layer.provide(agentProviderRegistryLayer), Layer.provide(walkthroughRoutingLayer))
  const agentProvidersLayer = AgentProviders.layer.pipe(Layer.provide(agentProviderRegistryLayer))
  const threadStoreLayer = ReviewThreadStore.layer
  const reviewTurnStoreLayer = ReviewTurnStore.layer
  const artifactStoreLayer = AgentRunArtifactStore.layer
  const reviewAgentRoutingLayer = Layer.effect(
    ReviewAgentRouting,
    Effect.gen(function* () {
      const settings = yield* AppSettings
      return ReviewAgentRouting.of({
        get: settings.get.pipe(
          Effect.catch(() => Effect.succeed(DEFAULT_AI_SETTINGS)),
          Effect.map((current) => ({
            selection: current.selections["review-thread"],
          })),
        ),
      })
    }),
  ).pipe(Layer.provide(settingsLayer))
  const mcpHandlersLayer = ReviewMcpHandlers.layer.pipe(
    Layer.provideMerge(threadStoreLayer),
    Layer.provideMerge(artifactStoreLayer),
    Layer.provideMerge(processLayer),
  )
  const mcpLayer = DiffDashMcpServer.layer
  const hostedReviewWorkspacePoolLayer = HostedReviewWorkspacePool.layer({
    remoteWorktreePoolPath: RepositoryCheckoutPath.make(remoteWorktreePoolPath),
    worktreePoolPath: RepositoryCheckoutPath.make(worktreePoolPath),
  })
  const reviewAgentLayer = ReviewAgentService.layer.pipe(
    Layer.provideMerge(reviewAgentRoutingLayer),
    Layer.provideMerge(agentProviderRegistryLayer),
    Layer.provideMerge(gitProviderRegistryLayer),
    Layer.provideMerge(mcpLayer),
    Layer.provideMerge(mcpHandlersLayer),
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
    Layer.provideMerge(GitService.layer),
    Layer.provideMerge(gitProviderLayer),
    Layer.provideMerge(repositoryComparisonSourceLayer),
  )
  const prerequisitesLayer = Prerequisites.layer({
    appImagePath: Option.getOrNull(configuration.paths.appImageOption),
    diffDashCliPath: configuration.paths.diffDashCli,
    executableSearchPath,
    executablePathExtensions: Option.getOrNull(
      configuration.environment.executablePathExtensionsOption,
    ),
    homeDirectory: Option.getOrNull(configuration.environment.homeDirectoryOption),
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
    WalkthroughOperationStore.layer,
    WalkthroughStore.layer,
    reviewAgentLayer,
    threadAnchorMapperLayer,
  ).pipe(
    Layer.provide(databaseLayer),
    Layer.provide(processLayer),
    Layer.provide(ProcessFileSystem.layer),
  )

  return coreOperationLayer.pipe(
    Layer.provide(businessServicesLayer),
    Layer.catchCause((cause) =>
      Layer.effect(CoreOperationService, Effect.failCause(Cause.map(cause, toCoreStartupError))),
    ),
  )
}
