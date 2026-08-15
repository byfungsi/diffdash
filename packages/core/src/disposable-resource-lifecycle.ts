import {
  type CatalogResource,
  CatalogResourceClass,
  type CatalogResourceId,
  type CatalogResourceState,
  ResourceCatalog,
  type ResourceCatalogError,
  type ResourceLeaseId,
  type ResourceRecoveryToken,
} from "@diffdash/persistence/resource-catalog"
import { Context, Effect, Schema } from "effect"

import { ResourceCollection } from "./resource-collection"

/** Aggregate resource diagnostics that contain no paths, repository identities, or owner IDs. */
export interface ResourceClassDiagnostics {
  readonly resourceClass: CatalogResourceClass
  readonly bytes: number
  readonly reservedBytes: number
  readonly resources: number
  readonly activeLeases: number
  readonly failures: number
  readonly states: Readonly<Record<CatalogResourceState, number>>
}

/** Privacy-safe diagnostics for all explicitly cataloged disposable resources. */
export interface DisposableResourceDiagnostics {
  readonly bytes: number
  readonly reservedBytes: number
  readonly activeLeases: number
  readonly failures: number
  readonly classes: readonly ResourceClassDiagnostics[]
}

/** Exact ownership used by a continuing agent run rather than a renderer lifetime. */
export interface AgentWorkspaceLeaseInput {
  readonly repositoryResourceId: CatalogResourceId
  readonly repositoryLeaseId: ResourceLeaseId
  readonly worktreeResourceId: CatalogResourceId
  readonly worktreeLeaseId: ResourceLeaseId
  readonly agentRunId: string
  readonly applicationInstanceId: string
  readonly processEpoch: string
  readonly acquiredAtMs: number
  readonly expiresAtMs: number
}

/** Policy and token authority for an explicit clear-cache operation. */
export interface ClearResourceCacheInput {
  readonly nowMs: number
  readonly retryAtMs: number
  readonly recoveryToken: (resourceId: CatalogResourceId) => ResourceRecoveryToken
}

/** Result of a policy-driven clear-cache pass. */
export interface ClearResourceCacheResult {
  readonly collected: readonly CatalogResourceId[]
  readonly protected: readonly CatalogResourceId[]
}

/** Catalog-backed policy for diagnostics, clear-cache, and agent workspace protection. */
export class DisposableResourceLifecycle extends Context.Service<
  DisposableResourceLifecycle,
  {
    readonly diagnostics: (
      nowMs: number,
    ) => Effect.Effect<DisposableResourceDiagnostics, ResourceCatalogError>
    readonly clearCache: (
      input: ClearResourceCacheInput,
    ) => Effect.Effect<ClearResourceCacheResult, ResourceCatalogError>
    readonly acquireAgentWorkspace: (
      input: AgentWorkspaceLeaseInput,
    ) => Effect.Effect<void, ResourceCatalogError>
    readonly releaseAgentWorkspace: (
      input: AgentWorkspaceLeaseInput,
    ) => Effect.Effect<void, ResourceCatalogError>
  }
>()("@diffdash/core/DisposableResourceLifecycle") {}

/** Builds disposable-resource policy over the durable catalog and collection boundary. */
export const makeDisposableResourceLifecycle = (
  catalog: Context.Service.Shape<typeof ResourceCatalog>,
  collection: Context.Service.Shape<typeof ResourceCollection>,
): Context.Service.Shape<typeof DisposableResourceLifecycle> =>
  DisposableResourceLifecycle.of({
    diagnostics: Effect.fn("DisposableResourceLifecycle.diagnostics")(function* (nowMs) {
      return summarizeResources(yield* catalog.list(), nowMs)
    }),
    clearCache: Effect.fn("DisposableResourceLifecycle.clearCache")(function* (input) {
      const resources = yield* catalog.list()
      const { collectible, protectedResources } = planClearCache(resources, input.nowMs)
      for (const resource of collectible) {
        yield* collection.collect({
          resourceId: resource.id,
          recoveryToken: input.recoveryToken(resource.id),
          nowMs: input.nowMs,
          retryAtMs: input.retryAtMs,
        })
      }
      return {
        collected: collectible.map(({ id }) => id),
        protected: protectedResources.map(({ id }) => id),
      }
    }),
    acquireAgentWorkspace: Effect.fn("DisposableResourceLifecycle.acquireAgentWorkspace")(
      function (input) {
        const ownership = {
          ownerKind: "agentRun",
          ownerId: input.agentRunId,
          applicationInstanceId: input.applicationInstanceId,
          processEpoch: input.processEpoch,
          acquiredAtMs: input.acquiredAtMs,
          renewedAtMs: input.acquiredAtMs,
          expiresAtMs: input.expiresAtMs,
          purpose: "agent workspace",
        }
        return catalog.acquireLeases([
          {
            ...ownership,
            id: input.repositoryLeaseId,
            resourceId: input.repositoryResourceId,
          },
          {
            ...ownership,
            id: input.worktreeLeaseId,
            resourceId: input.worktreeResourceId,
          },
        ])
      },
    ),
    releaseAgentWorkspace: Effect.fn("DisposableResourceLifecycle.releaseAgentWorkspace")(
      function (input) {
        return catalog.releaseLeases({
          ids: [input.repositoryLeaseId, input.worktreeLeaseId],
          applicationInstanceId: input.applicationInstanceId,
          processEpoch: input.processEpoch,
        })
      },
    ),
  })

const summarizeResources = (
  resources: readonly CatalogResource[],
  nowMs: number,
): DisposableResourceDiagnostics => {
  const byClass = new Map<CatalogResourceClass, ResourceClassDiagnostics>()
  for (const resource of resources) {
    if (
      resource.policyClass === "durableUserData" ||
      resource.state === "deleted" ||
      !Schema.is(CatalogResourceClass)(resource.kind)
    ) {
      continue
    }
    const current = byClass.get(resource.kind) ?? emptyClassDiagnostics(resource.kind)
    byClass.set(resource.kind, {
      ...current,
      bytes: current.bytes + resource.bytes,
      reservedBytes: current.reservedBytes + resource.reservedBytes,
      resources: current.resources + 1,
      activeLeases:
        current.activeLeases +
        resource.leases.filter(({ expiresAtMs }) => expiresAtMs > nowMs).length,
      failures: current.failures + (resource.state === "deletionFailed" ? 1 : 0),
      states: { ...current.states, [resource.state]: current.states[resource.state] + 1 },
    })
  }
  const classes = sortCopy([...byClass.values()], (left, right) =>
    left.resourceClass.localeCompare(right.resourceClass),
  )
  return {
    bytes: classes.reduce((total, entry) => total + entry.bytes, 0),
    reservedBytes: classes.reduce((total, entry) => total + entry.reservedBytes, 0),
    activeLeases: classes.reduce((total, entry) => total + entry.activeLeases, 0),
    failures: classes.reduce((total, entry) => total + entry.failures, 0),
    classes,
  }
}

const emptyClassDiagnostics = (resourceClass: CatalogResourceClass): ResourceClassDiagnostics => ({
  resourceClass,
  bytes: 0,
  reservedBytes: 0,
  resources: 0,
  activeLeases: 0,
  failures: 0,
  states: {
    writing: 0,
    ready: 0,
    collecting: 0,
    quarantined: 0,
    deletionFailed: 0,
    deleted: 0,
  },
})

const planClearCache = (resources: readonly CatalogResource[], nowMs: number) => {
  const byId = new Map(resources.map((resource) => [resource.id, resource]))
  const children = new Map<CatalogResourceId, CatalogResource[]>()
  for (const resource of resources) {
    if (resource.parentId === null) continue
    const current = children.get(resource.parentId) ?? []
    current.push(resource)
    children.set(resource.parentId, current)
  }
  const liveLeaseByResource = new Map<CatalogResourceId, boolean>()
  const hasLiveLease = (resource: CatalogResource): boolean => {
    const cached = liveLeaseByResource.get(resource.id)
    if (cached !== undefined) return cached
    const result =
      resource.leases.some(({ expiresAtMs }) => expiresAtMs > nowMs) ||
      (children.get(resource.id) ?? []).some(hasLiveLease)
    liveLeaseByResource.set(resource.id, result)
    return result
  }
  const cache = resources.filter(
    (resource) =>
      Schema.is(CatalogResourceClass)(resource.kind) &&
      resource.policyClass === "cache" &&
      isClearableState(resource),
  )
  const depthByResource = new Map<CatalogResourceId, number>()
  const depth = (resource: CatalogResource): number => {
    const cached = depthByResource.get(resource.id)
    if (cached !== undefined) return cached
    if (resource.parentId === null) return 0
    const parent = byId.get(resource.parentId)
    const result = parent === undefined ? 0 : depth(parent) + 1
    depthByResource.set(resource.id, result)
    return result
  }
  const collectible = sortCopy(
    cache.filter((resource) => !hasLiveLease(resource)),
    (left, right) =>
      depth(right) - depth(left) ||
      left.lastUsedAtMs - right.lastUsedAtMs ||
      left.id.localeCompare(right.id),
  )
  return {
    collectible,
    protectedResources: cache.filter(hasLiveLease),
  }
}

const isClearableState = (resource: CatalogResource): boolean =>
  resource.state === "ready" || resource.state === "deletionFailed"

const sortCopy = <Value>(
  values: readonly Value[],
  compare: (left: Value, right: Value) => number,
): Value[] => {
  const sorted: Value[] = []
  for (const value of values) {
    const index = sorted.findIndex((candidate) => compare(value, candidate) < 0)
    if (index < 0) sorted.push(value)
    else sorted.splice(index, 0, value)
  }
  return sorted
}
