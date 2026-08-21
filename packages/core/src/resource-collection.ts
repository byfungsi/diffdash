import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import {
  type CatalogResource,
  CatalogResourceId,
  type CatalogResourceLocation,
  ResourceCatalog,
  ResourceCatalogError,
  ResourceRecoveryToken,
  type ResourceRootId,
} from "@diffdash/persistence/resource-catalog"
import { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
import { Context, Effect, Predicate, Schema } from "effect"
import { type ManagedResource, planResourceCollection, ResourceId } from "./resource-policy"

const MAX_POLICY_COLLECTIONS_PER_PASS = 50

/** External mutation stage performed after durable collection intent commits. */
export const ResourceAdapterOperation = Schema.Literals(["quarantine", "delete"])

/** External mutation stage performed after durable collection intent commits. */
export type ResourceAdapterOperation = typeof ResourceAdapterOperation.Type

/** Classified adapter failure safe for retry scheduling and diagnostics. */
export class ResourceAdapterError extends Schema.TaggedError<ResourceAdapterError>()(
  "ResourceAdapterError",
  {
    operation: ResourceAdapterOperation,
    resourceId: Schema.String,
    reason: Schema.String,
    cause: Schema.ErrorInstance(),
  },
) {}

/** Bounded mutation capability for one typed catalog location. */
export interface ResourceMutationAdapter {
  readonly quarantine: (
    resource: CatalogResource,
    token: ResourceRecoveryToken,
  ) => Effect.Effect<void, ResourceAdapterError>
  readonly delete: (
    resource: CatalogResource,
    token: ResourceRecoveryToken,
  ) => Effect.Effect<void, ResourceAdapterError>
}

/** Complete adapter set required by resource reconciliation. */
export interface ResourceMutationAdapters {
  readonly filesystem: ResourceMutationAdapter
  readonly gitRef: ResourceMutationAdapter
  readonly updaterPartial: ResourceMutationAdapter
}

/** Inputs for one new collection intent and mutation pass. */
export interface CollectResourceInput {
  readonly resourceId: CatalogResourceId
  readonly recoveryToken: ResourceRecoveryToken
  readonly nowMs: number
  readonly retryAtMs: number
}

/** Core-owned collection and crash-reconciliation boundary. */
export class ResourceCollection extends Context.Service<
  ResourceCollection,
  {
    readonly collect: (input: CollectResourceInput) => Effect.Effect<void, ResourceCatalogError>
    readonly reconcile: (
      nowMs: number,
      retryAtMs: number,
    ) => Effect.Effect<void, ResourceCatalogError>
    readonly collectPolicy: (
      nowMs: number,
      retryAtMs: number,
    ) => Effect.Effect<number, ResourceCatalogError>
  }
>()("@diffdash/core/ResourceCollection") {}

/** Creates registered-root filesystem mutation with containment and symlink checks. */
export const makeFilesystemResourceAdapter = (
  roots: ReadonlyMap<ResourceRootId, string>,
  lock?: (
    operation: ResourceAdapterOperation,
    resource: CatalogResource,
    mutation: Effect.Effect<void, ResourceAdapterError>,
  ) => Effect.Effect<void, ResourceAdapterError>,
): ResourceMutationAdapter => ({
  quarantine: (resource, token) =>
    withFilesystemMutationLock(
      lock,
      "quarantine",
      resource,
      filesystemPaths(roots, resource, token, "quarantine").pipe(
        Effect.flatMap(({ original, quarantined, quarantineDirectory }) =>
          Effect.tryPromise({
            try: async () => {
              const originalExists = await validatePath(original.root, original.path)
              const quarantinedExists = await validatePath(original.root, quarantined)
              if (originalExists && quarantinedExists) {
                throw new Error("Both source and quarantine paths exist")
              }
              if (!originalExists || quarantinedExists) return
              await mkdir(quarantineDirectory, { recursive: true, mode: 0o700 })
              const quarantineStat = await lstat(quarantineDirectory)
              if (quarantineStat.isSymbolicLink())
                throw new Error("Quarantine directory is a symlink")
              await rename(original.path, quarantined)
            },
            catch: (cause) => adapterError("quarantine", resource.id, cause),
          }),
        ),
      ),
    ),
  delete: (resource, token) =>
    withFilesystemMutationLock(
      lock,
      "delete",
      resource,
      filesystemPaths(roots, resource, token, "delete").pipe(
        Effect.flatMap(({ original, quarantined }) =>
          Effect.tryPromise({
            try: async () => {
              if (!(await validatePath(original.root, quarantined))) return
              await rm(quarantined, { recursive: true, force: true, maxRetries: 0 })
            },
            catch: (cause) => adapterError("delete", resource.id, cause),
          }),
        ),
      ),
    ),
})

const withFilesystemMutationLock = (
  lock:
    | ((
        operation: ResourceAdapterOperation,
        resource: CatalogResource,
        mutation: Effect.Effect<void, ResourceAdapterError>,
      ) => Effect.Effect<void, ResourceAdapterError>)
    | undefined,
  operation: ResourceAdapterOperation,
  resource: CatalogResource,
  mutation: Effect.Effect<void, ResourceAdapterError>,
): Effect.Effect<void, ResourceAdapterError> =>
  lock === undefined ? mutation : lock(operation, resource, mutation)

/** Wraps a logical mutation adapter with a hard operation deadline. */
export const makeBoundedLogicalResourceAdapter = (
  mutate: (
    operation: ResourceAdapterOperation,
    location: CatalogResourceLocation,
    token: ResourceRecoveryToken,
  ) => Effect.Effect<void, ResourceAdapterError>,
  timeoutMs: number,
): ResourceMutationAdapter => {
  const run = (
    operation: ResourceAdapterOperation,
    resource: CatalogResource,
    token: ResourceRecoveryToken,
  ) =>
    mutate(operation, resource.location, token).pipe(
      Effect.timeout(`${timeoutMs} millis`),
      Effect.mapError((cause) =>
        Schema.is(ResourceAdapterError)(cause)
          ? cause
          : adapterError(operation, resource.id, cause),
      ),
    )
  return {
    quarantine: (resource, token) => run("quarantine", resource, token),
    delete: (resource, token) => run("delete", resource, token),
  }
}

/** Builds a bounded adapter that exposes only opaque updater-partial identities to the host. */
export const makeUpdaterPartialResourceAdapter = (
  mutate: (
    operation: ResourceAdapterOperation,
    identity: string,
    token: ResourceRecoveryToken,
  ) => Effect.Effect<void, ResourceAdapterError>,
  options: { readonly timeoutMs: number; readonly maximumIdentityBytes: number },
): ResourceMutationAdapter => {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    throw new TypeError("Updater partial timeout must be a positive safe integer")
  if (!Number.isSafeInteger(options.maximumIdentityBytes) || options.maximumIdentityBytes <= 0)
    throw new TypeError("Updater partial identity limit must be a positive safe integer")

  const run = (
    operation: ResourceAdapterOperation,
    resource: CatalogResource,
    token: ResourceRecoveryToken,
  ) => {
    if (resource.location.kind !== "updaterPartial") {
      return Effect.fail(
        adapterError(operation, resource.id, new Error("Expected updater-partial location")),
      )
    }
    if (
      new TextEncoder().encode(resource.location.identity).byteLength > options.maximumIdentityBytes
    ) {
      return Effect.fail(
        adapterError(
          operation,
          resource.id,
          new Error("Updater partial identity exceeds its limit"),
        ),
      )
    }
    return mutate(operation, resource.location.identity, token).pipe(
      Effect.timeout(`${options.timeoutMs} millis`),
      Effect.mapError((cause) =>
        Schema.is(ResourceAdapterError)(cause)
          ? cause
          : adapterError(operation, resource.id, cause),
      ),
    )
  }
  return {
    quarantine: (resource, token) => run("quarantine", resource, token),
    delete: (resource, token) => run("delete", resource, token),
  }
}

/** Builds collection around a durable catalog and typed mutation adapters. */
export const makeResourceCollection = (
  catalog: Context.Service.Shape<typeof ResourceCatalog>,
  adapters: ResourceMutationAdapters,
) => {
  const resume = Effect.fn("ResourceCollection.resume")(function* (
    resource: CatalogResource,
    nowMs: number,
    retryAtMs: number,
  ) {
    const token = resource.recoveryToken
    if (
      token === null ||
      resource.policyClass === "durableUserData" ||
      resource.state === "deleted"
    ) {
      return
    }
    const adapter = adapters[resource.location.kind]
    const mutation = Effect.gen(function* () {
      yield* adapter.quarantine(resource, token)
      yield* catalog.quarantine({ resourceId: resource.id, recoveryToken: token, nowMs })
      yield* adapter.delete(resource, token)
      yield* catalog.completeDeletion({ resourceId: resource.id, recoveryToken: token, nowMs })
    })
    yield* mutation.pipe(
      Effect.catch((cause) =>
        catalog
          .failDeletion({
            resourceId: resource.id,
            recoveryToken: token,
            failure: Schema.is(ResourceAdapterError)(cause)
              ? `${cause.operation}:${cause.reason}`.slice(0, 500)
              : `${cause.operation}:${cause.cause.message}`.slice(0, 500),
            retryAtMs,
            nowMs,
          })
          .pipe(Effect.asVoid),
      ),
    )
  })

  return ResourceCollection.of({
    collect: Effect.fn("ResourceCollection.collect")(function* (input) {
      const resource = yield* catalog.beginCollection({
        resourceId: input.resourceId,
        recoveryToken: input.recoveryToken,
        nowMs: input.nowMs,
      })
      yield* resume(resource, input.nowMs, input.retryAtMs)
    }),
    reconcile: Effect.fn("ResourceCollection.reconcile")(function* (nowMs, retryAtMs) {
      const resources = yield* catalog.list()
      for (const resource of resources) {
        if (
          (resource.state === "collecting" ||
            resource.state === "quarantined" ||
            resource.state === "deletionFailed") &&
          (resource.retryAtMs === null || resource.retryAtMs <= nowMs)
        ) {
          yield* resume(resource, nowMs, retryAtMs)
        }
      }
    }),
    collectPolicy: Effect.fn("ResourceCollection.collectPolicy")(function* (nowMs, retryAtMs) {
      const resources = (yield* catalog.list()).flatMap((resource): ManagedResource[] => {
        const state = resource.state
        if (resource.policyClass === "durableUserData") {
          if (state !== "ready") return []
          return [{ ...policyResource(resource), policyClass: "durableUserData", state }]
        }
        if (state === "deleted") return []
        return [{ ...policyResource(resource), policyClass: resource.policyClass, state }]
      })
      const resourceIds = planResourceCollection(resources, nowMs)
        .slice(0, MAX_POLICY_COLLECTIONS_PER_PASS)
        .map((id) => CatalogResourceId.make(id))
      yield* Effect.forEach(
        resourceIds,
        (resourceId) =>
          Effect.gen(function* () {
            const recoveryToken = ResourceRecoveryToken.make(`policy:${randomUUID()}`)
            const resource = yield* catalog.beginCollection({ resourceId, recoveryToken, nowMs })
            yield* resume(resource, nowMs, retryAtMs)
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Resource collection candidate was retained").pipe(
                Effect.annotateLogs({ resourceId, operation: cause.operation }),
              ),
            ),
          ),
        { concurrency: 2, discard: true },
      )
      return resourceIds.length
    }),
  })
}

const policyResource = (resource: CatalogResource) => ({
  id: ResourceId.make(resource.id),
  parentId: resource.parentId === null ? null : ResourceId.make(resource.parentId),
  location: { kind: resource.location.kind, value: JSON.stringify(resource.location) },
  bytes: resource.bytes,
  reservedBytes: resource.reservedBytes,
  generation: resource.generation,
  lastUsedAtMs: resource.lastUsedAtMs,
  leases: resource.leases.map((lease) => ({
    owner: lease.ownerId,
    applicationInstanceId: ApplicationInstanceId.make(lease.applicationInstanceId),
    processEpoch: CoreProcessEpoch.make(lease.processEpoch),
    renewedAtMs: lease.renewedAtMs,
    expiresAtMs: lease.expiresAtMs,
  })),
})

const filesystemPaths = (
  roots: ReadonlyMap<ResourceRootId, string>,
  resource: CatalogResource,
  token: ResourceRecoveryToken,
  operation: ResourceAdapterOperation,
) =>
  Effect.tryPromise({
    try: async () => {
      if (resource.location.kind !== "filesystem") throw new Error("Expected filesystem location")
      const configuredRoot = roots.get(resource.location.rootId)
      if (configuredRoot === undefined) throw new Error("Filesystem root is not registered")
      if (isAbsolute(resource.location.relativePath))
        throw new Error("Resource path must be relative")
      const rootStat = await lstat(configuredRoot)
      if (rootStat.isSymbolicLink()) throw new Error("Registered root is a symlink")
      const root = await realpath(configuredRoot)
      const original = resolve(root, resource.location.relativePath)
      assertContained(root, original)
      const quarantineDirectory = resolve(root, ".diffdash-quarantine")
      const tokenName = createHash("sha256").update(token).digest("hex")
      const quarantined = resolve(quarantineDirectory, tokenName)
      assertContained(root, quarantined)
      return { original: { root, path: original }, quarantineDirectory, quarantined }
    },
    catch: (cause) => adapterError(operation, resource.id, cause),
  })

const validatePath = async (root: string, path: string): Promise<boolean> => {
  assertContained(root, path)
  const segments = relative(root, path).split(sep).filter(Boolean)
  let current = root
  for (const segment of segments) {
    current = resolve(current, segment)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new Error(`Resource path traverses a symlink: ${segment}`)
    } catch (cause) {
      if (isMissingPath(cause)) return false
      throw cause
    }
  }
  return true
}

const assertContained = (root: string, candidate: string) => {
  const child = relative(root, candidate)
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Resource path escapes or aliases its registered root")
  }
}

const ErrorCode = Schema.Struct({ code: Schema.String })

const isMissingPath = <Cause>(cause: Cause): boolean =>
  Schema.is(ErrorCode)(cause) && cause.code === "ENOENT"

const adapterError = <Cause>(
  operation: ResourceAdapterOperation,
  resourceId: string,
  cause: Cause,
) => {
  const error = Predicate.isError(cause) ? cause : new Error(String(cause))
  const reason = Predicate.isString(error.message) ? error.message : String(cause)
  return ResourceAdapterError.make({
    operation,
    resourceId,
    reason,
    cause: error,
  })
}
