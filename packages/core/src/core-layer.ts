import { dirname } from "node:path"

import { AgentProviderRegistry } from "@diffdash/agent-provider/registry"
import { CoreRpcPayloadBytes } from "@diffdash/core-rpc"
import { DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { GitProviderRegistry } from "@diffdash/git-provider"
import {
  HostedReviewWorkspacePool,
  ReviewRefMutation,
} from "@diffdash/local-git/hosted-review-workspace-pool"
import { GitService } from "@diffdash/local-git/local-git"
import { LocalCheckoutFiles } from "@diffdash/local-git/local-checkout-files"
import { AgentRunArtifactStore } from "@diffdash/persistence/agent-run-artifact-store"
import type { DatabaseError } from "@diffdash/persistence/database"
import { ProjectWorkspaceStore } from "@diffdash/persistence/project-workspace-store"
import { ResourceCatalog, ResourceRootId } from "@diffdash/persistence/resource-catalog"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { ReviewThreadStore } from "@diffdash/persistence/review-thread-store"
import { ReviewTurnStore } from "@diffdash/persistence/review-turn-store"
import { ViewedFileStore } from "@diffdash/persistence/viewed-file-store"
import { WalkthroughOperationStore } from "@diffdash/persistence/walkthrough-operation-store"
import { WalkthroughStore } from "@diffdash/persistence/walkthrough-store"
import { SnapshotBlockStore } from "@diffdash/persistence/snapshot-block-store"
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
import { Cause, Clock, Effect, Layer } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { ExecutableSearchPath, type CoreConfiguration } from "./core-configuration"
import { CoreOperationService, coreOperationLayer } from "./core-operation-service"
import { CoreEventHub } from "./core-event-hub"
import { coreRepositoryWatcherLayer } from "./core-repository-watcher"
import { coreSnapshotAcquisitionLayer } from "./core-snapshot-acquisition"
import {
  CORE_SNAPSHOT_MAX_BLOCK_BYTES,
  CoreSnapshotIngestion,
  coreSnapshotIngestionLayer,
} from "./core-snapshot-ingestion"
import {
  CoreProgressiveReviewService,
  coreProgressiveReviewServiceLayer,
} from "./core-review-session-rpc-handlers"
import { generatedCoreReviewDataWorkerLayer } from "./generated-review-data-worker"
import {
  ReviewLifecycleDiagnostics,
  reviewLifecycleDiagnosticsLayer,
} from "./review-lifecycle-diagnostics"
import { reviewAgentOperationsLayer } from "./operations/review-agent-operations"
import { CoreStartupError, type CoreStartupFailure, toCoreStartupError } from "./core-startup-error"
import type { CoreProviderComposition } from "./provider-composition"
import { AgentProviders } from "./services/agent-providers"
import { Analytics } from "./services/analytics"
import { GitProvider } from "./services/git-provider"
import { Prerequisites } from "./services/prerequisites"
import { RepositoryComparisonSource } from "./services/repository-comparison-source"
import { RepositoryLinker } from "./services/repository-linker"
import { AgentArtifactNormalizer } from "./services/agent-artifact-normalizer"
import { ReviewAgentRouting, ReviewAgentService } from "./services/review-agent"
import { ReviewMcpHandlers } from "./services/review-mcp-handlers"
import { operationSnapshotReaderLayer } from "./services/operation-snapshot-reader"
import { ReviewThreadAnchorMapper } from "./services/review-thread-anchor-mapper"
import {
  snapshotGitRangeSourceLayer,
  snapshotProjectAuthorityLayer,
} from "./services/snapshot-production-adapters"
import { SnapshotRepository, snapshotRepositoryLayer } from "./services/snapshot-repository"
import { SnapshotSearch, snapshotSearchLayer } from "./services/snapshot-search"
import {
  makeBoundedLogicalResourceAdapter,
  makeFilesystemResourceAdapter,
  makeResourceCollection,
  makeUpdaterPartialResourceAdapter,
  ResourceAdapterError,
  ResourceCollection,
} from "./resource-collection"
import {
  DisposableResourceLifecycle,
  makeDisposableResourceLifecycle,
} from "./disposable-resource-lifecycle"
import { agentWorkspaceResourcesLayer } from "./agent-workspace-resources"
import { makeProducerResourceLifecycles } from "./producer-resource-lifecycle"

/** Maximum aggregate exact-Git output reserved by one lazy file regeneration. */
export const CORE_SNAPSHOT_MAX_LAZY_BYTES = 16 * 1_024 * 1_024

const SNAPSHOT_RESOURCE_ROOT_ID = ResourceRootId.make("core:snapshot-blocks:v1")
const PROCESS_TEMP_RESOURCE_ROOT_ID = ResourceRootId.make("core:process-temp:v1")
const LOCAL_WORKTREE_RESOURCE_ROOT_ID = ResourceRootId.make("core:local-worktrees:v1")
const REMOTE_WORKTREE_RESOURCE_ROOT_ID = ResourceRootId.make("core:remote-worktrees:v1")
const MIGRATION_BACKUP_RESOURCE_ROOT_ID = ResourceRootId.make("core:migration-backups:v1")
const SNAPSHOT_RESERVATION_LIFETIME_MS = 60_000
const SNAPSHOT_LEASE_LIFETIME_MS = 30_000
const SNAPSHOT_MANAGED_QUOTA_BYTES = 4 * 1_024 * 1_024 * 1_024

const unavailableLogicalMutation = (
  operation: "quarantine" | "delete",
  location: { readonly kind: string },
) =>
  Effect.fail(
    ResourceAdapterError.make({
      operation,
      resourceId: "unavailable-logical-resource",
      reason: `No production mutation authority is installed for ${location.kind}.`,
      cause: new Error(`No production mutation authority is installed for ${location.kind}.`),
    }),
  )

type StandaloneCoreServices =
  | CoreOperationService
  | CoreSnapshotIngestion
  | CoreProgressiveReviewService
  | ReviewLifecycleDiagnostics
  | DisposableResourceLifecycle
  | ResourceCollection
  | SnapshotRepository
  | SnapshotSearch

/** Builds the external Core graph with one SQLite-backed progressive review authority. */
export const createStandaloneCoreLayer = (
  configuration: CoreConfiguration,
  databaseLayer: Layer.Layer<SqlClient.SqlClient, DatabaseError>,
  providerComposition: CoreProviderComposition,
): Layer.Layer<StandaloneCoreServices, CoreStartupFailure, CoreEventHub> => {
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
  const threadAnchorMapperLayer = ReviewThreadAnchorMapper.layer.pipe(
    Layer.provideMerge(threadStoreLayer),
  )
  const repositoryLinkerLayer = RepositoryLinker.layer.pipe(
    Layer.provideMerge(RepositoryStore.layer),
    Layer.provideMerge(GitService.layer),
    Layer.provideMerge(gitProviderLayer),
  )
  const snapshotRootPath = `${configuration.paths.database}.snapshot-blocks`
  const snapshotBlockStoreLayer = SnapshotBlockStore.layer({
    rootId: SNAPSHOT_RESOURCE_ROOT_ID,
    rootPath: snapshotRootPath,
  })
  const snapshotPersistenceLayer = Layer.merge(ResourceCatalog.layer, snapshotBlockStoreLayer)
  const operationSnapshotReaderServiceLayer = operationSnapshotReaderLayer({
    leaseLifetimeMs: SNAPSHOT_LEASE_LIFETIME_MS,
    maximumHunkBytes: CORE_SNAPSHOT_MAX_LAZY_BYTES,
    maximumFileBytes: CORE_SNAPSHOT_MAX_LAZY_BYTES,
  }).pipe(Layer.provideMerge(snapshotPersistenceLayer), Layer.provide(databaseLayer))
  const resourceRoots = new Map([
    [SNAPSHOT_RESOURCE_ROOT_ID, snapshotRootPath],
    [PROCESS_TEMP_RESOURCE_ROOT_ID, agentWorkingDirectory],
    [LOCAL_WORKTREE_RESOURCE_ROOT_ID, worktreePoolPath],
    [REMOTE_WORKTREE_RESOURCE_ROOT_ID, remoteWorktreePoolPath],
    [MIGRATION_BACKUP_RESOURCE_ROOT_ID, dirname(configuration.paths.database)],
  ])
  const resourceCollectionLayer = Layer.effect(
    ResourceCollection,
    Effect.gen(function* () {
      const resources = yield* ResourceCatalog
      const reviewRefs = yield* ReviewRefMutation
      return makeResourceCollection(resources, {
        filesystem: makeFilesystemResourceAdapter(resourceRoots),
        gitRef: makeBoundedLogicalResourceAdapter(
          (operation, location) =>
            location.kind === "gitRef"
              ? reviewRefs.mutate(operation, location.identity).pipe(
                  Effect.mapError((cause) =>
                    ResourceAdapterError.make({
                      operation,
                      resourceId: "cataloged-review-ref",
                      reason: cause.reason,
                      cause,
                    }),
                  ),
                )
              : unavailableLogicalMutation(operation, location),
          5_000,
        ),
        updaterPartial: makeUpdaterPartialResourceAdapter(
          (operation) => unavailableLogicalMutation(operation, { kind: "updaterPartial" }),
          { timeoutMs: 5_000, maximumIdentityBytes: 4_096 },
        ),
      })
    }),
  ).pipe(
    Layer.provideMerge(snapshotPersistenceLayer),
    Layer.provide(
      ReviewRefMutation.layer({
        remoteWorktreePoolPath: RepositoryCheckoutPath.make(remoteWorktreePoolPath),
        worktreePoolPath: RepositoryCheckoutPath.make(worktreePoolPath),
      }).pipe(Layer.provide(processLayer)),
    ),
  )
  const disposableResourceLifecycleLayer = Layer.effect(
    DisposableResourceLifecycle,
    Effect.gen(function* () {
      const resources = yield* ResourceCatalog
      const collection = yield* ResourceCollection
      return makeDisposableResourceLifecycle(resources, collection)
    }),
  ).pipe(Layer.provideMerge(resourceCollectionLayer))
  const resourceLifecycleStartupLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const resources = yield* ResourceCatalog
      const nowMs = yield* Clock.currentTimeMillis
      for (const [id, path] of resourceRoots) {
        yield* resources.registerRoot({ id, path, createdAtMs: nowMs })
      }
    }),
  ).pipe(Layer.provide(disposableResourceLifecycleLayer))
  const resourceLifecycleLayer = Layer.merge(
    disposableResourceLifecycleLayer,
    resourceLifecycleStartupLayer,
  )
  const producerLayer = Layer.unwrap(
    Effect.gen(function* () {
      const resources = yield* ResourceCatalog
      const collection = yield* ResourceCollection
      const lifecycle = makeProducerResourceLifecycles(resources, collection, {
        tempRootId: PROCESS_TEMP_RESOURCE_ROOT_ID,
        tempRootPath: agentWorkingDirectory,
      })
      return Layer.merge(
        TempResources.layerWithLifecycle(lifecycle.tempResources).pipe(
          Layer.provide(platformLayer),
        ),
        HostedReviewWorkspacePool.layer({
          remoteWorktreePoolPath: RepositoryCheckoutPath.make(remoteWorktreePoolPath),
          reviewRefs: lifecycle.reviewRefs,
          worktreePoolPath: RepositoryCheckoutPath.make(worktreePoolPath),
        }).pipe(Layer.provide(processLayer)),
      )
    }),
  ).pipe(Layer.provideMerge(resourceCollectionLayer))
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
  ).pipe(Layer.provide(producerLayer))
  const walkthroughLayer = WalkthroughService.layer({
    remoteWorkingDirectory: agentWorkingDirectory,
  }).pipe(Layer.provide(agentProviderRegistryLayer), Layer.provide(walkthroughRoutingLayer))
  const agentProvidersLayer = AgentProviders.layer.pipe(Layer.provide(agentProviderRegistryLayer))
  const hostedReviewWorkspacePoolLayer = producerLayer
  const repositoryComparisonSourceLayer = RepositoryComparisonSource.layer.pipe(
    Layer.provide(
      Layer.mergeAll(repositoryLinkerLayer, gitProviderLayer, hostedReviewWorkspacePoolLayer),
    ),
  )
  const agentWorkspaceResourceLayer = agentWorkspaceResourcesLayer({
    local: { rootId: LOCAL_WORKTREE_RESOURCE_ROOT_ID, rootPath: worktreePoolPath },
    remote: { rootId: REMOTE_WORKTREE_RESOURCE_ROOT_ID, rootPath: remoteWorktreePoolPath },
  }).pipe(Layer.provideMerge(resourceLifecycleLayer))
  const reviewAgentLayer = ReviewAgentService.layer.pipe(
    Layer.provideMerge(reviewAgentRoutingLayer),
    Layer.provideMerge(agentProviderRegistryLayer),
    Layer.provideMerge(gitProviderRegistryLayer),
    Layer.provideMerge(mcpLayer),
    Layer.provideMerge(mcpHandlersLayer),
    Layer.provideMerge(AgentArtifactNormalizer.layer),
    Layer.provideMerge(reviewTurnStoreLayer),
    Layer.provideMerge(hostedReviewWorkspacePoolLayer),
    Layer.provideMerge(agentWorkspaceResourceLayer),
  )
  const reviewAgentOperationServiceLayer = reviewAgentOperationsLayer.pipe(
    Layer.provideMerge(reviewAgentLayer),
    Layer.provideMerge(reviewTurnStoreLayer),
  )
  const projectAuthorityLayer = snapshotProjectAuthorityLayer
  const gitRangeSourceLayer = snapshotGitRangeSourceLayer.pipe(
    Layer.provide(RepositoryStore.layer),
    Layer.provide(processLayer),
  )
  const snapshotRepositoryServiceLayer = snapshotRepositoryLayer({
    maximumResponseBytes: CoreRpcPayloadBytes.make(384 * 1_024),
    maximumBlockBytes: CORE_SNAPSHOT_MAX_BLOCK_BYTES,
    maximumLazyBlocks: CORE_SNAPSHOT_MAX_LAZY_BYTES / CORE_SNAPSHOT_MAX_BLOCK_BYTES,
    maximumLazyConcurrency: 1,
    managedQuotaBytes: SNAPSHOT_MANAGED_QUOTA_BYTES,
    reservationLifetimeMs: SNAPSHOT_RESERVATION_LIFETIME_MS,
    leaseLifetimeMs: SNAPSHOT_LEASE_LIFETIME_MS,
  }).pipe(
    Layer.provideMerge(snapshotPersistenceLayer),
    Layer.provide(projectAuthorityLayer),
    Layer.provide(gitRangeSourceLayer),
  )
  const snapshotSearchServiceLayer = snapshotSearchLayer({
    maximumPageMatches: 200,
    maximumExcerptBytes: 8 * 1_024,
  }).pipe(Layer.provideMerge(snapshotRepositoryServiceLayer))
  const reviewDiagnosticsLayer = reviewLifecycleDiagnosticsLayer
  const progressiveReviewServiceLayer = coreProgressiveReviewServiceLayer.pipe(
    Layer.provideMerge(snapshotSearchServiceLayer),
    Layer.provide(reviewDiagnosticsLayer),
  )
  const snapshotIngestionServiceLayer = coreSnapshotIngestionLayer({
    managedQuotaBytes: SNAPSHOT_MANAGED_QUOTA_BYTES,
    reservationLifetimeMs: SNAPSHOT_RESERVATION_LIFETIME_MS,
    maximumBlockBytes: CORE_SNAPSHOT_MAX_BLOCK_BYTES,
  }).pipe(
    Layer.provideMerge(snapshotPersistenceLayer),
    Layer.provide(generatedCoreReviewDataWorkerLayer.pipe(Layer.provide(reviewDiagnosticsLayer))),
  )
  const snapshotStorageStartupLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const fileSystem = yield* ProcessFileSystem
      const resources = yield* ResourceCatalog
      const store = yield* SnapshotBlockStore
      yield* fileSystem.ensureDirectory(snapshotRootPath, { recursive: true, mode: 0o700 })
      yield* fileSystem.ensureDirectory(`${snapshotRootPath}/spools`, {
        recursive: true,
        mode: 0o700,
      })
      const nowMs = yield* Clock.currentTimeMillis
      yield* resources.registerRoot({
        id: SNAPSHOT_RESOURCE_ROOT_ID,
        path: snapshotRootPath,
        createdAtMs: nowMs,
      })
      yield* store.recoverWrites()
      yield* resources.expireReservations(nowMs)
      yield* store.recoverCollections(nowMs)
    }),
  ).pipe(Layer.provide(snapshotPersistenceLayer))
  const snapshotAcquisitionServiceLayer = coreSnapshotAcquisitionLayer({
    rootId: SNAPSHOT_RESOURCE_ROOT_ID,
    rootPath: snapshotRootPath,
    managedQuotaBytes: SNAPSHOT_MANAGED_QUOTA_BYTES,
    reservationLifetimeMs: SNAPSHOT_RESERVATION_LIFETIME_MS,
  }).pipe(
    Layer.provideMerge(snapshotIngestionServiceLayer),
    Layer.provideMerge(resourceCollectionLayer),
    Layer.provideMerge(repositoryLinkerLayer),
    Layer.provideMerge(repositoryComparisonSourceLayer),
    Layer.provideMerge(gitProviderLayer),
    Layer.provideMerge(GitService.layer),
    Layer.provideMerge(processLayer),
  )
  const reviewAcquisitionLayer = snapshotAcquisitionServiceLayer
  const repositoryWatcherLayer = coreRepositoryWatcherLayer
  const progressiveReviewLayer = Layer.mergeAll(
    progressiveReviewServiceLayer,
    snapshotIngestionServiceLayer,
    snapshotStorageStartupLayer,
    resourceLifecycleLayer,
  )
  const prerequisitesLayer = Prerequisites.layer({
    appImagePath: configuration.paths.appImageOption,
    diffDashCliPath: configuration.paths.diffDashCli,
    executableSearchPath,
    executablePathExtensions: configuration.environment.executablePathExtensionsOption,
    homeDirectory: configuration.environment.homeDirectoryOption,
    platform: configuration.application.platform,
  }).pipe(Layer.provideMerge(gitProviderLayer), Layer.provideMerge(agentProvidersLayer))

  const businessServicesLayer = Layer.mergeAll(
    temporaryDirectoryLayer,
    repositoryLinkerLayer,
    LocalCheckoutFiles.layer,
    repositoryComparisonSourceLayer,
    repositoryWatcherLayer,
    ProjectWorkspaceStore.layer,
    analyticsLayer,
    reviewAcquisitionLayer,
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
    reviewAgentOperationServiceLayer,
    resourceLifecycleLayer,
    threadAnchorMapperLayer,
  ).pipe(
    Layer.provide(databaseLayer),
    Layer.provide(processLayer),
    Layer.provide(ProcessFileSystem.layer),
  )

  const operationLayer = coreOperationLayer.pipe(
    Layer.provide(businessServicesLayer),
    Layer.provide(operationSnapshotReaderServiceLayer),
    Layer.catchCause((cause) =>
      Layer.effect(CoreOperationService, Effect.failCause(Cause.map(cause, toCoreStartupError))),
    ),
  )
  const exposedProgressiveReviewLayer = progressiveReviewLayer.pipe(
    Layer.provideMerge(reviewDiagnosticsLayer),
    Layer.provide(databaseLayer),
    Layer.provide(processLayer),
    Layer.provide(ProcessFileSystem.layer),
  )

  return Layer.merge(operationLayer, exposedProgressiveReviewLayer).pipe(
    Layer.catchCause((cause) => {
      const failure = Effect.failCause(Cause.map(cause, toCoreStartupError))
      return Layer.mergeAll(
        Layer.effect(CoreOperationService, failure),
        Layer.effect(CoreSnapshotIngestion, failure),
        Layer.effect(CoreProgressiveReviewService, failure),
        Layer.effect(ReviewLifecycleDiagnostics, failure),
        Layer.effect(DisposableResourceLifecycle, failure),
        Layer.effect(ResourceCollection, failure),
        Layer.effect(SnapshotRepository, failure),
        Layer.effect(SnapshotSearch, failure),
      )
    }),
  )
}
