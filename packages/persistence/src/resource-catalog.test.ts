import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Result } from "effect"

import * as DatabaseNode from "./database-node"
import {
  type CatalogResourceLease,
  CatalogResourceId,
  ResourceCatalog,
  ResourceLeaseId,
  ResourceRecoveryToken,
  ResourceReservationId,
  ResourceRootId,
} from "./resource-catalog"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-resource-catalog-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  ResourceCatalog.layer.pipe(Layer.provideMerge(DatabaseNode.layer(databasePath)))

const register = (
  catalog: Context.Service.Shape<typeof ResourceCatalog>,
  id: string,
  bytes: number,
  parentId: string | null = null,
) =>
  catalog.register({
    id: CatalogResourceId.make(id),
    parentId: parentId === null ? null : CatalogResourceId.make(parentId),
    kind: "snapshot-block",
    policyClass: "cache",
    state: "ready",
    generation: 1,
    location: { kind: "gitRef", identity: `refs/diffdash/${id}` },
    bytes,
    nowMs: 1,
    checksum: null,
    validation: null,
  })

const lease = (
  id: string,
  resourceId: CatalogResourceLease["resourceId"],
  expiresAtMs = 100,
): CatalogResourceLease => ({
  id: ResourceLeaseId.make(id),
  resourceId,
  ownerKind: "agentRun",
  ownerId: "run-1",
  applicationInstanceId: "app-1",
  processEpoch: "epoch-1",
  acquiredAtMs: 1,
  renewedAtMs: 1,
  expiresAtMs,
  purpose: "agent workspace",
})

describe("ResourceCatalog", () => {
  it.effect("keeps registered filesystem root identities immutable", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        const root = { id: ResourceRootId.make("root-1"), path: "/cache/one", createdAtMs: 1 }
        yield* catalog.registerRoot(root)
        yield* catalog.registerRoot(root)

        expect(
          Result.isFailure(
            yield* Effect.result(catalog.registerRoot({ ...root, path: "/cache/two" })),
          ),
        ).toBe(true)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("reserves unknown output ahead and commits only actual bytes", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        const writer = yield* catalog.register({
          id: CatalogResourceId.make("writer"),
          parentId: null,
          kind: "snapshot-spool",
          policyClass: "temporary",
          state: "writing",
          generation: 1,
          location: { kind: "updaterPartial", identity: "writer.partial" },
          bytes: 100,
          nowMs: 1,
          checksum: null,
          validation: null,
        })
        const reserved = yield* catalog.reserve({
          id: ResourceReservationId.make("reservation-1"),
          resourceId: writer.id,
          bytes: 200,
          nowMs: 2,
          expiresAtMs: 100,
          quotaBytes: 350,
        })
        expect(reserved).toMatchObject({ kind: "reserved", resource: { reservedBytes: 200 } })

        expect(
          yield* catalog.reserve({
            id: ResourceReservationId.make("reservation-2"),
            resourceId: writer.id,
            bytes: 51,
            nowMs: 3,
            expiresAtMs: 100,
            quotaBytes: 350,
          }),
        ).toEqual({ kind: "quotaExceeded", requiredBytes: 51, availableBytes: 50 })

        expect(
          yield* catalog.commitReservation({
            id: ResourceReservationId.make("reservation-1"),
            actualBytes: 150,
            nowMs: 4,
          }),
        ).toMatchObject({ bytes: 250, reservedBytes: 0 })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("shares one byte budget across local-source and remote-only pools", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        const registerPool = (id: string, kind: "localWorktreePool" | "remoteWorktreePool") =>
          catalog.register({
            id: CatalogResourceId.make(id),
            parentId: null,
            kind,
            policyClass: "cache",
            state: "writing",
            generation: 1,
            location: { kind: "updaterPartial", identity: `${id}.partial` },
            bytes: 100,
            nowMs: 1,
            checksum: null,
            validation: null,
          })
        const local = yield* registerPool("local-pool", "localWorktreePool")
        const remote = yield* registerPool("remote-pool", "remoteWorktreePool")

        expect(
          yield* catalog.reserve({
            id: ResourceReservationId.make("local-reservation"),
            resourceId: local.id,
            bytes: 100,
            nowMs: 2,
            expiresAtMs: 100,
            quotaBytes: 350,
          }),
        ).toMatchObject({ kind: "reserved" })
        expect(
          yield* catalog.reserve({
            id: ResourceReservationId.make("remote-reservation"),
            resourceId: remote.id,
            bytes: 51,
            nowMs: 2,
            expiresAtMs: 100,
            quotaBytes: 350,
          }),
        ).toEqual({ kind: "quotaExceeded", requiredBytes: 51, availableBytes: 50 })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("refreshes producer-owned usage and revives the same generated identity", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        const resource = yield* register(catalog, "producer-resource", 10)

        expect(
          yield* catalog.recordUsage({ resourceId: resource.id, bytes: 25, nowMs: 2 }),
        ).toMatchObject({ state: "ready", bytes: 25, lastUsedAtMs: 2 })

        const token = ResourceRecoveryToken.make("producer-token")
        yield* catalog.beginCollection({ resourceId: resource.id, recoveryToken: token, nowMs: 3 })
        yield* catalog.quarantine({ resourceId: resource.id, recoveryToken: token, nowMs: 3 })
        yield* catalog.completeDeletion({ resourceId: resource.id, recoveryToken: token, nowMs: 3 })

        expect(
          yield* catalog.recordUsage({ resourceId: resource.id, bytes: 30, nowMs: 4 }),
        ).toMatchObject({ state: "ready", bytes: 30, lastUsedAtMs: 4 })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect(
    "blocks parent collection for a live descendant lease and permits exact-owner expiry",
    () =>
      Effect.gen(function* () {
        const databasePath = yield* makeTempDatabasePath
        yield* Effect.gen(function* () {
          const catalog = yield* ResourceCatalog
          const parent = yield* register(catalog, "parent", 100)
          const child = yield* register(catalog, "child", 50, parent.id)
          yield* catalog.acquireLease({
            id: ResourceLeaseId.make("lease-1"),
            resourceId: child.id,
            ownerKind: "foregroundReview",
            ownerId: "review-1",
            applicationInstanceId: "app-1",
            processEpoch: "epoch-1",
            acquiredAtMs: 1,
            renewedAtMs: 1,
            expiresAtMs: 100,
            purpose: "visible range",
          })
          const token = ResourceRecoveryToken.make("token-1")

          expect(
            Result.isFailure(
              yield* Effect.result(
                catalog.beginCollection({ resourceId: parent.id, recoveryToken: token, nowMs: 10 }),
              ),
            ),
          ).toBe(true)
          yield* catalog.expireOwnership({
            applicationInstanceId: "app-1",
            processEpoch: "epoch-1",
          })
          expect(
            yield* catalog.beginCollection({
              resourceId: parent.id,
              recoveryToken: token,
              nowMs: 11,
            }),
          ).toMatchObject({ state: "collecting", recoveryToken: token })
        }).pipe(Effect.provide(makeLayer(databasePath)))
      }),
  )

  it.effect("retains failed-deletion bytes and requires the persisted recovery token", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        const resource = yield* register(catalog, "failed-delete", 512)
        const token = ResourceRecoveryToken.make("token-delete")
        yield* catalog.beginCollection({ resourceId: resource.id, recoveryToken: token, nowMs: 2 })
        yield* catalog.failDeletion({
          resourceId: resource.id,
          recoveryToken: token,
          failure: "busy",
          retryAtMs: 50,
          nowMs: 3,
        })

        expect(yield* catalog.get(resource.id)).toMatchObject({
          state: "deletionFailed",
          bytes: 512,
          recoveryToken: token,
        })
        expect(
          Result.isFailure(
            yield* Effect.result(
              catalog.completeDeletion({
                resourceId: resource.id,
                recoveryToken: ResourceRecoveryToken.make("wrong-token"),
                nowMs: 4,
              }),
            ),
          ),
        ).toBe(true)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("acquires paired agent leases atomically", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        const repository = yield* register(catalog, "repository", 100)
        const worktree = yield* register(catalog, "worktree", 50, repository.id)
        const ownership = {
          ownerKind: "agentRun",
          ownerId: "run-1",
          applicationInstanceId: "app-1",
          processEpoch: "epoch-1",
          acquiredAtMs: 1,
          renewedAtMs: 1,
          expiresAtMs: 100,
          purpose: "agent workspace",
        }

        const failed = yield* Effect.result(
          catalog.acquireLeases([
            {
              ...ownership,
              id: ResourceLeaseId.make("repository-lease"),
              resourceId: repository.id,
            },
            {
              ...ownership,
              id: ResourceLeaseId.make("missing-lease"),
              resourceId: CatalogResourceId.make("missing"),
            },
          ]),
        )
        expect(Result.isFailure(failed)).toBe(true)
        expect((yield* catalog.get(repository.id)).leases).toHaveLength(0)

        yield* catalog.acquireLeases([
          {
            ...ownership,
            id: ResourceLeaseId.make("repository-lease"),
            resourceId: repository.id,
          },
          {
            ...ownership,
            id: ResourceLeaseId.make("worktree-lease"),
            resourceId: worktree.id,
          },
        ])
        expect((yield* catalog.get(repository.id)).leases).toHaveLength(1)
        expect((yield* catalog.get(worktree.id)).leases).toHaveLength(1)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("renews paired leases atomically", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        const repository = yield* register(catalog, "renew-repository", 100)
        const worktree = yield* register(catalog, "renew-worktree", 50, repository.id)
        yield* catalog.acquireLeases([
          lease("renew-repository-lease", repository.id),
          lease("renew-worktree-lease", worktree.id),
        ])

        yield* catalog.renewLeases({
          ids: [
            ResourceLeaseId.make("renew-repository-lease"),
            ResourceLeaseId.make("renew-worktree-lease"),
          ],
          applicationInstanceId: "app-1",
          processEpoch: "epoch-1",
          renewedAtMs: 50,
          expiresAtMs: 150,
        })

        expect((yield* catalog.get(repository.id)).leases[0]).toMatchObject({
          renewedAtMs: 50,
          expiresAtMs: 150,
        })
        expect((yield* catalog.get(worktree.id)).leases[0]).toMatchObject({
          renewedAtMs: 50,
          expiresAtMs: 150,
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rolls back a batch renewal when any lease is missing", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        const resource = yield* register(catalog, "renew-rollback", 100)
        yield* catalog.acquireLease(lease("renew-rollback-lease", resource.id))

        expect(
          Result.isFailure(
            yield* Effect.result(
              catalog.renewLeases({
                ids: [
                  ResourceLeaseId.make("renew-rollback-lease"),
                  ResourceLeaseId.make("missing-renewal-lease"),
                ],
                applicationInstanceId: "app-1",
                processEpoch: "epoch-1",
                renewedAtMs: 50,
                expiresAtMs: 150,
              }),
            ),
          ),
        ).toBe(true)
        expect((yield* catalog.get(resource.id)).leases[0]).toMatchObject({
          renewedAtMs: 1,
          expiresAtMs: 100,
        })

        expect(
          Result.isFailure(
            yield* Effect.result(
              catalog.renewLeases({
                ids: [ResourceLeaseId.make("renew-rollback-lease")],
                applicationInstanceId: "wrong-app",
                processEpoch: "epoch-1",
                renewedAtMs: 50,
                expiresAtMs: 150,
              }),
            ),
          ),
        ).toBe(true)
        expect((yield* catalog.get(resource.id)).leases[0]).toMatchObject({
          renewedAtMs: 1,
          expiresAtMs: 100,
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rejects renewal after the old lease expiry", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        const resource = yield* register(catalog, "expired-renewal", 100)
        yield* catalog.acquireLease(lease("expired-renewal-lease", resource.id, 10))

        expect(
          Result.isFailure(
            yield* Effect.result(
              catalog.renewLeases({
                ids: [ResourceLeaseId.make("expired-renewal-lease")],
                applicationInstanceId: "app-1",
                processEpoch: "epoch-1",
                renewedAtMs: 10,
                expiresAtMs: 110,
              }),
            ),
          ),
        ).toBe(true)
        expect((yield* catalog.get(resource.id)).leases[0]).toMatchObject({
          renewedAtMs: 1,
          expiresAtMs: 10,
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rejects lease acquisition and renewal for non-ready resources", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        const writing = yield* catalog.register({
          id: CatalogResourceId.make("writing-lease-resource"),
          parentId: null,
          kind: "snapshot-spool",
          policyClass: "temporary",
          state: "writing",
          generation: 1,
          location: { kind: "updaterPartial", identity: "writing-lease-resource.partial" },
          bytes: 0,
          nowMs: 1,
          checksum: null,
          validation: null,
        })
        expect(
          Result.isFailure(
            yield* Effect.result(catalog.acquireLease(lease("writing-lease", writing.id))),
          ),
        ).toBe(true)

        const collecting = yield* register(catalog, "collecting-renewal", 100)
        yield* catalog.acquireLease(lease("collecting-renewal-lease", collecting.id, 10))
        yield* catalog.beginCollection({
          resourceId: collecting.id,
          recoveryToken: ResourceRecoveryToken.make("collecting-renewal-token"),
          nowMs: 10,
        })
        expect(
          Result.isFailure(
            yield* Effect.result(
              catalog.renewLeases({
                ids: [ResourceLeaseId.make("collecting-renewal-lease")],
                applicationInstanceId: "app-1",
                processEpoch: "epoch-1",
                renewedAtMs: 9,
                expiresAtMs: 20,
              }),
            ),
          ),
        ).toBe(true)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("atomically resolves lease acquisition against collection", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        const resource = yield* register(catalog, "lease-collection-race", 100)
        const [acquired, collected] = yield* Effect.all(
          [
            Effect.result(catalog.acquireLease(lease("racing-lease", resource.id))),
            Effect.result(
              catalog.beginCollection({
                resourceId: resource.id,
                recoveryToken: ResourceRecoveryToken.make("racing-collection-token"),
                nowMs: 10,
              }),
            ),
          ],
          { concurrency: "unbounded" },
        )

        expect(Result.isSuccess(acquired)).not.toBe(Result.isSuccess(collected))
        const persisted = yield* catalog.get(resource.id)
        if (Result.isSuccess(acquired)) {
          expect(persisted).toMatchObject({ state: "ready" })
          expect(persisted.leases).toHaveLength(1)
        } else {
          expect(persisted).toMatchObject({ state: "collecting" })
          expect(persisted.leases).toHaveLength(0)
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
