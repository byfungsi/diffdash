import { createHash, randomUUID } from "node:crypto"
import { lstat, readdir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"

import {
  encodeReviewRefIdentity,
  HostedReviewWorkspacePoolError,
  type ReviewRefLifecycle,
} from "@diffdash/local-git/hosted-review-workspace-pool"
import {
  CatalogResourceId,
  ResourceCatalog,
  ResourceCatalogError,
  ResourceLeaseId,
  ResourceRecoveryToken,
  type ResourceRootId,
} from "@diffdash/persistence/resource-catalog"
import type { CreatedTempResource, TempResourceLifecycle } from "@diffdash/process/temp-resource"
import { Clock, Context, Effect, Predicate, Schema } from "effect"

import { ResourceCollection } from "./resource-collection"

const PRODUCER_LEASE_LIFETIME_MS = 30_000
const PRODUCER_LEASE_RENEWAL_MS = 10_000
const COLLECTION_RETRY_MS = 60_000

interface ProducerResourceAuthorityOptions {
  readonly tempRootId: ResourceRootId
  readonly tempRootPath: string
}

/** Catalog-backed lifecycle hooks installed directly into disposable-resource producers. */
export const makeProducerResourceLifecycles = (
  catalog: Context.Service.Shape<typeof ResourceCatalog>,
  collection: Context.Service.Shape<typeof ResourceCollection>,
  options: ProducerResourceAuthorityOptions,
): {
  readonly reviewRefs: ReviewRefLifecycle
  readonly tempResources: TempResourceLifecycle
} => {
  const ownerId = `core-producer:${process.pid}:${randomUUID()}`
  const applicationInstanceId = `core-producer:${randomUUID()}`
  const processEpoch = `pid:${process.pid}:${Date.now()}`

  const tempResources: TempResourceLifecycle = {
    manage: Effect.fn("ProducerResources.manageTemp")(function* (capture) {
      const verified = yield* inspectCreatedTemp(options.tempRootPath, capture)
      const nowMs = yield* Clock.currentTimeMillis
      yield* catalog.registerRoot({
        id: options.tempRootId,
        path: options.tempRootPath,
        createdAtMs: nowMs,
      })
      const resourceId = resourceIdFor("temp", verified.relativePath)
      yield* catalog.register({
        id: resourceId,
        parentId: null,
        kind: capture.resourceClass,
        policyClass: "temporary",
        state: "ready",
        generation: 1,
        location: {
          kind: "filesystem",
          rootId: options.tempRootId,
          relativePath: verified.relativePath,
        },
        bytes: verified.bytes,
        nowMs,
        checksum: null,
        validation: "verified-producer-temp-v1",
      })
      const leaseId = ResourceLeaseId.make(randomUUID())
      yield* acquireLease(catalog, {
        resourceId,
        leaseId,
        ownerId,
        applicationInstanceId,
        processEpoch,
        nowMs,
        purpose: capture.resourceClass,
      })
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* catalog.releaseLease({ id: leaseId, applicationInstanceId, processEpoch })
          const releaseMs = yield* Clock.currentTimeMillis
          const bytes = yield* directoryBytes(capture.directory).pipe(Effect.orElseSucceed(() => 0))
          yield* catalog.recordUsage({ resourceId, bytes, nowMs: releaseMs })
          yield* collection.collect({
            resourceId,
            recoveryToken: ResourceRecoveryToken.make(`temp:${randomUUID()}`),
            nowMs: releaseMs,
            retryAtMs: releaseMs + COLLECTION_RETRY_MS,
          })
        }).pipe(Effect.orDie),
      )
      yield* renewLease(catalog, {
        leaseId,
        applicationInstanceId,
        processEpoch,
      }).pipe(Effect.forkScoped)
    }),
  }

  const reviewRefs: ReviewRefLifecycle = {
    manage: (captures, use) =>
      Effect.scoped(
        Effect.gen(function* () {
          const unique = new Map(
            captures.map((capture) => [encodeReviewRefIdentity(capture), capture]),
          )
          const nowMs = yield* Clock.currentTimeMillis
          const leases: Array<{
            readonly resourceId: CatalogResourceId
            readonly leaseId: ResourceLeaseId
          }> = []
          for (const [identity] of unique) {
            const resourceId = resourceIdFor("review-ref", identity)
            yield* catalog.register({
              id: resourceId,
              parentId: null,
              kind: "reviewRef",
              policyClass: "cache",
              state: "ready",
              generation: 1,
              location: { kind: "gitRef", identity },
              bytes: 0,
              nowMs,
              checksum: null,
              validation: "verified-producer-review-ref-v1",
            })
            leases.push({ resourceId, leaseId: ResourceLeaseId.make(randomUUID()) })
          }
          yield* catalog.acquireLeases(
            leases.map(({ resourceId, leaseId }) => ({
              id: leaseId,
              resourceId,
              ownerKind: "coreProducer",
              ownerId,
              applicationInstanceId,
              processEpoch,
              acquiredAtMs: nowMs,
              renewedAtMs: nowMs,
              expiresAtMs: nowMs + PRODUCER_LEASE_LIFETIME_MS,
              purpose: "review ref operation",
            })),
          )
          yield* Effect.addFinalizer(() =>
            catalog
              .releaseLeases({
                ids: leases.map(({ leaseId }) => leaseId),
                applicationInstanceId,
                processEpoch,
              })
              .pipe(Effect.orDie),
          )
          yield* Effect.forEach(
            leases,
            ({ leaseId }) =>
              renewLease(catalog, { leaseId, applicationInstanceId, processEpoch }).pipe(
                Effect.forkScoped,
              ),
            { discard: true },
          )
          return yield* use
        }).pipe(Effect.mapError(toReviewRefError)),
      ),
  }

  return { reviewRefs, tempResources }
}

const acquireLease = (
  catalog: Context.Service.Shape<typeof ResourceCatalog>,
  input: {
    readonly resourceId: CatalogResourceId
    readonly leaseId: ResourceLeaseId
    readonly ownerId: string
    readonly applicationInstanceId: string
    readonly processEpoch: string
    readonly nowMs: number
    readonly purpose: string
  },
) =>
  catalog.acquireLease({
    id: input.leaseId,
    resourceId: input.resourceId,
    ownerKind: "coreProducer",
    ownerId: input.ownerId,
    applicationInstanceId: input.applicationInstanceId,
    processEpoch: input.processEpoch,
    acquiredAtMs: input.nowMs,
    renewedAtMs: input.nowMs,
    expiresAtMs: input.nowMs + PRODUCER_LEASE_LIFETIME_MS,
    purpose: input.purpose,
  })

const renewLease = (
  catalog: Context.Service.Shape<typeof ResourceCatalog>,
  input: {
    readonly leaseId: ResourceLeaseId
    readonly applicationInstanceId: string
    readonly processEpoch: string
  },
) =>
  Effect.forever(
    Effect.sleep(`${PRODUCER_LEASE_RENEWAL_MS} millis`).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis
          yield* catalog.renewLease({
            id: input.leaseId,
            applicationInstanceId: input.applicationInstanceId,
            processEpoch: input.processEpoch,
            renewedAtMs: nowMs,
            expiresAtMs: nowMs + PRODUCER_LEASE_LIFETIME_MS,
          })
        }),
      ),
      Effect.catch(() => Effect.void),
    ),
  )

const inspectCreatedTemp = (
  rootPath: string,
  capture: CreatedTempResource,
): Effect.Effect<{ readonly relativePath: string; readonly bytes: number }, Error> =>
  Effect.tryPromise({
    try: async () => {
      const [root, parent, directory] = await Promise.all([
        realpath(rootPath),
        realpath(capture.parentDirectory),
        realpath(capture.directory),
      ])
      if (parent !== root) throw new Error("Temporary resource parent is not the configured root")
      const details = await lstat(directory)
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error("Temporary resource is not a verified directory")
      }
      const relativePath = relative(root, directory)
      if (!isContainedRelativePath(relativePath)) {
        throw new Error("Temporary resource escaped the configured root")
      }
      return { relativePath, bytes: await directoryBytesPromise(directory) }
    },
    catch: (cause) => (Predicate.isError(cause) ? cause : new Error(String(cause))),
  })

const directoryBytes = (path: string): Effect.Effect<number, Error> =>
  Effect.tryPromise({
    try: () => directoryBytesPromise(path),
    catch: (cause) => (Predicate.isError(cause) ? cause : new Error(String(cause))),
  })

const directoryBytesPromise = async (path: string): Promise<number> => {
  const pending = [path]
  let bytes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    // Sequential traversal keeps temporary-resource accounting memory bounded.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const details = await lstat(current)
    bytes += details.size
    if (!Number.isSafeInteger(bytes))
      throw new Error("Temporary resource size exceeds safe accounting")
    if (!details.isDirectory()) continue
    // oxlint-disable-next-line eslint/no-await-in-loop
    for (const entry of await readdir(current)) pending.push(join(current, entry))
  }
  return bytes
}

const isContainedRelativePath = (path: string): boolean =>
  path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)

const resourceIdFor = (prefix: string, identity: string): CatalogResourceId =>
  CatalogResourceId.make(`${prefix}:${createHash("sha256").update(identity).digest("hex")}`)

const toReviewRefError = <E>(
  cause: E | ResourceCatalogError,
): E | HostedReviewWorkspacePoolError =>
  Schema.is(ResourceCatalogError)(cause)
    ? HostedReviewWorkspacePoolError.make({
        code: "git",
        operation: "reviewRef.catalog",
        reason: "DiffDash could not protect a producer-created review ref.",
        cause,
      })
    : cause
