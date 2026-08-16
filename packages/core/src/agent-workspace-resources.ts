import { createHash, randomUUID } from "node:crypto"
import { lstat, readdir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"

import type { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
import type { AgentRunId } from "@diffdash/domain/review-agent"
import type { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import {
  CatalogResourceId,
  ResourceCatalog,
  type ResourceCatalogError,
  ResourceLeaseId,
  type ResourceRootId,
} from "@diffdash/persistence/resource-catalog"
import { Clock, Context, Effect, Layer, Predicate, Schema } from "effect"

import { DisposableResourceLifecycle } from "./disposable-resource-lifecycle"
import { registerDisposableResourceProducers } from "./resource-producer-registration"

const WORKSPACE_LEASE_LIFETIME_MS = 15 * 60 * 1_000

/** A managed workspace path was not one of the generated paths owned by a configured pool. */
export class AgentWorkspaceResourceError extends Schema.TaggedError<AgentWorkspaceResourceError>()(
  "AgentWorkspaceResourceError",
  { cause: Schema.ErrorInstance() },
) {}

/** Exact Core ownership required to protect one provider's managed workspace. */
export interface ProtectAgentWorkspaceInput {
  readonly localPath: RepositoryCheckoutPath
  readonly agentRunId: AgentRunId
  readonly applicationInstanceId: ApplicationInstanceId
  readonly processEpoch: CoreProcessEpoch
}

/** Catalog-backed lifetime bridge for generated hosted-review workspaces. */
export class AgentWorkspaceResources extends Context.Service<
  AgentWorkspaceResources,
  {
    readonly protect: <A, E, R>(
      input: ProtectAgentWorkspaceInput,
      use: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ResourceCatalogError | AgentWorkspaceResourceError, R>
  }
>()("@diffdash/core/AgentWorkspaceResources") {}

interface ManagedPool {
  readonly kind: "localWorktreePool" | "remoteWorktreePool"
  readonly rootId: ResourceRootId
  readonly rootPath: string
}

/** Creates the production bridge for local-source and remote-only hosted-review pools. */
export const agentWorkspaceResourcesLayer = (options: {
  readonly local: { readonly rootId: ResourceRootId; readonly rootPath: string }
  readonly remote: { readonly rootId: ResourceRootId; readonly rootPath: string }
}) =>
  Layer.effect(
    AgentWorkspaceResources,
    Effect.gen(function* () {
      const catalog = yield* ResourceCatalog
      const lifecycle = yield* DisposableResourceLifecycle
      const pools: readonly ManagedPool[] = [
        { kind: "localWorktreePool", ...options.local },
        { kind: "remoteWorktreePool", ...options.remote },
      ]

      return AgentWorkspaceResources.of({
        protect: Effect.fn("AgentWorkspaceResources.protect")(function* (input, use) {
          const workspace = yield* inspectManagedWorkspace(pools, input.localPath)
          const nowMs = yield* Clock.currentTimeMillis
          const repositoryId = CatalogResourceId.make(
            `workspace:${workspace.pool.kind}:repository:${workspace.repositoryDigest}`,
          )
          const worktreeId = CatalogResourceId.make(
            `workspace:${workspace.pool.kind}:worktree:${createHash("sha256")
              .update(workspace.worktreeRelativePath)
              .digest("hex")}`,
          )
          const registered = yield* registerDisposableResourceProducers(catalog, {
            roots: [
              {
                id: workspace.pool.rootId,
                path: workspace.pool.rootPath,
                createdAtMs: nowMs,
              },
            ],
            resources: [
              {
                id: repositoryId,
                parentId: null,
                kind: "bareRepository",
                policyClass: "cache",
                state: "ready",
                generation: 1,
                location: {
                  kind: "filesystem",
                  rootId: workspace.pool.rootId,
                  relativePath: workspace.repositoryRelativePath,
                },
                bytes: workspace.repositoryBytes,
                nowMs,
                checksum: null,
                validation: "generated-hosted-review-repository-v1",
              },
              {
                id: worktreeId,
                parentId: repositoryId,
                kind: workspace.pool.kind,
                policyClass: "cache",
                state: "ready",
                generation: 1,
                location: {
                  kind: "filesystem",
                  rootId: workspace.pool.rootId,
                  relativePath: workspace.worktreeRelativePath,
                },
                bytes: workspace.worktreeBytes,
                nowMs,
                checksum: null,
                validation: "generated-hosted-review-worktree-v1",
              },
            ],
          })
          yield* Effect.forEach(registered, (resource) =>
            catalog.recordUsage({
              resourceId: resource.id,
              bytes:
                resource.id === repositoryId ? workspace.repositoryBytes : workspace.worktreeBytes,
              nowMs,
            }),
          )
          const lease = {
            repositoryResourceId: repositoryId,
            repositoryLeaseId: ResourceLeaseId.make(randomUUID()),
            worktreeResourceId: worktreeId,
            worktreeLeaseId: ResourceLeaseId.make(randomUUID()),
            agentRunId: input.agentRunId,
            applicationInstanceId: input.applicationInstanceId,
            processEpoch: input.processEpoch,
            acquiredAtMs: nowMs,
            expiresAtMs: nowMs + WORKSPACE_LEASE_LIFETIME_MS,
          }
          return yield* Effect.acquireUseRelease(
            lifecycle.acquireAgentWorkspace(lease),
            () => use,
            () => lifecycle.releaseAgentWorkspace(lease).pipe(Effect.orDie),
          )
        }),
      })
    }),
  )

const inspectManagedWorkspace = (
  pools: readonly ManagedPool[],
  localPath: RepositoryCheckoutPath,
): Effect.Effect<
  {
    readonly pool: ManagedPool
    readonly repositoryDigest: string
    readonly repositoryRelativePath: string
    readonly worktreeRelativePath: string
    readonly repositoryBytes: number
    readonly worktreeBytes: number
  },
  AgentWorkspaceResourceError
> =>
  Effect.tryPromise({
    try: async () => {
      const suppliedWorkspace = await lstat(localPath)
      if (suppliedWorkspace.isSymbolicLink())
        throw new Error("Agent workspace path cannot be a symbolic link")
      const workspacePath = await realpath(localPath)
      const rootedPools = await Promise.all(
        pools.map(async (pool) => ({ pool, root: await realpath(pool.rootPath) })),
      )
      const candidate = rootedPools
        .map(({ pool, root }) => {
          const workspaceRelativePath = relative(root, workspacePath)
          if (!isContainedRelativePath(workspaceRelativePath)) return null
          const segments = workspaceRelativePath.split(sep)
          const regularWorkspace =
            segments.length === 3 &&
            isGeneratedSegment(segments[2]) &&
            segments[2] !== "repository.git" &&
            segments[2] !== "comparison-workspaces"
          const comparisonWorkspace =
            segments.length === 4 &&
            segments[2] === "comparison-workspaces" &&
            isGeneratedSegment(segments[3])
          if (
            segments[0] !== "repositories" ||
            !/^[0-9a-f]{64}$/u.test(segments[1] ?? "") ||
            (!regularWorkspace && !comparisonWorkspace)
          ) {
            return null
          }
          return {
            pool,
            root,
            repositoryDigest: segments[1] ?? "",
            worktreeRelativePath: workspaceRelativePath,
          }
        })
        .find(Predicate.isNotNull)
      if (candidate === undefined)
        throw new Error("Agent workspace is outside the generated hosted-review pool layout")

      const repositoryPath = join(
        candidate.root,
        "repositories",
        candidate.repositoryDigest,
        "repository.git",
      )
      const [canonicalRepositoryPath, repositoryBytes, worktreeBytes] = await Promise.all([
        realpath(repositoryPath),
        directoryBytes(repositoryPath),
        directoryBytes(workspacePath),
      ])
      const repositoryRelativePath = relative(candidate.root, canonicalRepositoryPath)
      if (!isContainedRelativePath(repositoryRelativePath))
        throw new Error("Managed bare repository escaped its configured pool root")
      return {
        pool: candidate.pool,
        repositoryDigest: candidate.repositoryDigest,
        repositoryRelativePath,
        worktreeRelativePath: candidate.worktreeRelativePath,
        repositoryBytes,
        worktreeBytes,
      }
    },
    catch: (cause) =>
      AgentWorkspaceResourceError.make({
        cause: Predicate.isError(cause) ? cause : new Error(String(cause)),
      }),
  })

const directoryBytes = async (path: string): Promise<number> => {
  const pending = [path]
  let bytes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    // Sequential traversal keeps repository-scale pool accounting memory bounded.
    // eslint-disable-next-line no-await-in-loop
    const details = await lstat(current)
    bytes += details.size
    if (!Number.isSafeInteger(bytes))
      throw new Error("Managed workspace size exceeds safe accounting")
    if (!details.isDirectory()) continue
    // eslint-disable-next-line no-await-in-loop
    const entries = await readdir(current)
    for (const entry of entries) pending.push(join(current, entry))
  }
  return bytes
}

const isContainedRelativePath = (path: string): boolean =>
  path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)

const isGeneratedSegment = (value: string | undefined): value is string =>
  value !== undefined && /^[a-zA-Z0-9_.-]+$/u.test(value) && value !== "." && value !== ".."
