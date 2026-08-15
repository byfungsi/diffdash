import { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
import { Clock, Effect, Schema } from "effect"

/** Managed disposable-resource high-water mark that triggers collection. */
export const RESOURCE_HIGH_WATER_BYTES = 4 * 1024 * 1024 * 1024

/** Managed disposable-resource target after a collection pass. */
export const RESOURCE_COLLECTION_TARGET_BYTES = 3 * 1024 * 1024 * 1024

/** Stable identity of one managed resource. */
export const ResourceId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
  Schema.brand("ResourceId"),
)

/** Stable identity of one managed resource. */
export type ResourceId = typeof ResourceId.Type

/** Lease protecting a resource for one exact application and Core process lifetime. */
export interface ResourceLease {
  readonly owner: string
  readonly applicationInstanceId: ApplicationInstanceId
  readonly processEpoch: CoreProcessEpoch
  readonly renewedAtMs: number
  readonly expiresAtMs: number
}

interface ResourceBase {
  readonly id: ResourceId
  readonly parentId: ResourceId | null
  readonly location: {
    readonly kind: "filesystem" | "gitRef" | "updaterPartial"
    readonly value: string
  }
  readonly bytes: number
  readonly reservedBytes: number
  readonly generation: number
  readonly lastUsedAtMs: number
  readonly leases: readonly ResourceLease[]
}

/** Durable user data has no disposable policy or collectible lifecycle state. */
export interface DurableResource extends ResourceBase {
  readonly policyClass: "durableUserData"
  readonly state: "ready"
}

/** Disposable managed resource eligible for policy-driven collection when unleased. */
export interface DisposableResource extends ResourceBase {
  readonly policyClass: "cache" | "temporary" | "migrationBackup"
  readonly state: "writing" | "ready" | "collecting" | "quarantined" | "deletionFailed"
}

/** Complete resource-policy input with durable ineligibility encoded by the union. */
export type ManagedResource = DurableResource | DisposableResource

/** Reserve-ahead result for an unknown-length writer. */
export type ResourceReservationResult =
  | { readonly kind: "reserved"; readonly resource: DisposableResource }
  | {
      readonly kind: "quotaExceeded"
      readonly requiredBytes: number
      readonly availableBytes: number
    }

/** Reserves bytes before a writer may cross its currently accounted size. */
export const reserveResourceBytes = (
  resource: DisposableResource,
  requestedBytes: number,
  availableBytes: number,
): ResourceReservationResult => {
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0) {
    throw new Error("requestedBytes must be a positive safe integer")
  }
  if (requestedBytes > availableBytes) {
    return { kind: "quotaExceeded", requiredBytes: requestedBytes, availableBytes }
  }
  return {
    kind: "reserved",
    resource: { ...resource, reservedBytes: resource.reservedBytes + requestedBytes },
  }
}

/** Deterministic collection plan from the 4 GiB high-water mark toward the 3 GiB target. */
export const planResourceCollection = (
  resources: readonly ManagedResource[],
  nowMs: number,
): readonly ResourceId[] => {
  const accountedBytes = resources.reduce(
    (total, resource) =>
      resource.policyClass === "durableUserData"
        ? total
        : total + resource.bytes + resource.reservedBytes,
    0,
  )
  if (accountedBytes <= RESOURCE_HIGH_WATER_BYTES) return []

  const byParent = new Map<ResourceId, ManagedResource[]>()
  for (const resource of resources) {
    if (resource.parentId === null) continue
    const children = byParent.get(resource.parentId) ?? []
    children.push(resource)
    byParent.set(resource.parentId, children)
  }
  const hasLiveLeaseInTree = (resource: ManagedResource): boolean =>
    resource.leases.some(({ expiresAtMs }) => expiresAtMs > nowMs) ||
    (byParent.get(resource.id) ?? []).some(hasLiveLeaseInTree)

  const policyRank = { temporary: 0, cache: 1, migrationBackup: 2 } as const
  const candidates = resources.filter(
    (resource): resource is DisposableResource =>
      resource.policyClass !== "durableUserData" &&
      (resource.state === "ready" || resource.state === "deletionFailed") &&
      !hasLiveLeaseInTree(resource),
  )
  candidates.sort(
    (left, right) =>
      policyRank[left.policyClass] - policyRank[right.policyClass] ||
      left.lastUsedAtMs - right.lastUsedAtMs ||
      left.id.localeCompare(right.id),
  )

  const selected: ResourceId[] = []
  let projectedBytes = accountedBytes
  for (const candidate of candidates) {
    if (projectedBytes <= RESOURCE_COLLECTION_TARGET_BYTES) break
    selected.push(candidate.id)
    projectedBytes -= candidate.bytes + candidate.reservedBytes
  }
  return selected
}

/** Plans collection against the current Effect clock for deterministic TestClock verification. */
export const planResourceCollectionNow = (resources: readonly ManagedResource[]) =>
  Clock.currentTimeMillis.pipe(Effect.map((nowMs) => planResourceCollection(resources, nowMs)))
