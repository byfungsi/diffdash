import { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import {
  RESOURCE_COLLECTION_TARGET_BYTES,
  RESOURCE_HIGH_WATER_BYTES,
  ResourceId,
  planResourceCollection,
  planResourceCollectionNow,
  reserveResourceBytes,
  type DisposableResource,
  type DurableResource,
} from "./resource-policy"

const mib = 1024 * 1024
const disposable = (
  id: string,
  bytes: number,
  overrides: Partial<DisposableResource> = {},
): DisposableResource => ({
  id: ResourceId.make(id),
  parentId: null,
  location: { kind: "filesystem", value: id },
  policyClass: "cache",
  state: "ready",
  bytes,
  reservedBytes: 0,
  generation: 1,
  lastUsedAtMs: 0,
  leases: [],
  ...overrides,
})

describe("resource lifecycle policy", () => {
  it("reserves ahead or rejects before unknown-length output crosses quota", () => {
    const resource = disposable("writer", mib)
    expect(reserveResourceBytes(resource, 2 * mib, 2 * mib)).toMatchObject({
      kind: "reserved",
      resource: { reservedBytes: 2 * mib },
    })
    expect(reserveResourceBytes(resource, 2 * mib, mib)).toEqual({
      kind: "quotaExceeded",
      requiredBytes: 2 * mib,
      availableBytes: mib,
    })
  })

  it("collects deterministically from four GiB toward three GiB", () => {
    const resources = [
      disposable("cache-new", 600 * mib, { lastUsedAtMs: 20 }),
      disposable("temporary", 700 * mib, { policyClass: "temporary", lastUsedAtMs: 30 }),
      disposable("cache-old", 700 * mib, { lastUsedAtMs: 10 }),
      disposable("retained", RESOURCE_COLLECTION_TARGET_BYTES - 100 * mib),
    ]
    expect(resources.reduce((total, resource) => total + resource.bytes, 0)).toBeGreaterThan(
      RESOURCE_HIGH_WATER_BYTES,
    )
    expect(planResourceCollection(resources, 100)).toEqual([
      ResourceId.make("temporary"),
      ResourceId.make("retained"),
    ])
  })

  it("protects active descendants and structurally excludes durable user data", () => {
    const parent = disposable("parent", 2_000 * mib)
    const child = disposable("child", 100 * mib, {
      parentId: parent.id,
      leases: [
        {
          owner: "foreground-review",
          applicationInstanceId: ApplicationInstanceId.make("app-1"),
          processEpoch: CoreProcessEpoch.make("epoch-1"),
          renewedAtMs: 50,
          expiresAtMs: 200,
        },
      ],
    })
    const durable: DurableResource = {
      id: ResourceId.make("database"),
      parentId: null,
      location: { kind: "filesystem", value: "diffdash.sqlite" },
      policyClass: "durableUserData",
      state: "ready",
      bytes: 2_000 * mib,
      reservedBytes: 0,
      generation: 1,
      lastUsedAtMs: 0,
      leases: [],
    }
    const eligible = disposable("eligible", 3_000 * mib)

    expect(planResourceCollection([parent, child, durable, eligible], 100)).toEqual([eligible.id])
  })

  it.effect("expires leases deterministically under TestClock", () =>
    Effect.gen(function* () {
      const leased = disposable("leased", 2_000 * mib, {
        leases: [
          {
            owner: "foreground-review",
            applicationInstanceId: ApplicationInstanceId.make("app-1"),
            processEpoch: CoreProcessEpoch.make("epoch-1"),
            renewedAtMs: 0,
            expiresAtMs: 1_000,
          },
        ],
      })
      const pressure = disposable("pressure", 2_500 * mib)
      expect(yield* planResourceCollectionNow([leased, pressure])).not.toContain(leased.id)

      yield* TestClock.adjust(1_001)

      expect(yield* planResourceCollectionNow([leased, pressure])).toContain(leased.id)
    }),
  )

  it.effect("keeps collection arithmetic stable after one year", () =>
    Effect.gen(function* () {
      const dayMs = 24 * 60 * 60 * 1_000
      const leased = disposable("year-lease", 2_000 * mib, {
        lastUsedAtMs: 0,
        leases: [
          {
            owner: "review-operation",
            applicationInstanceId: ApplicationInstanceId.make("app-year"),
            processEpoch: CoreProcessEpoch.make("epoch-year"),
            renewedAtMs: 0,
            expiresAtMs: 180 * dayMs,
          },
        ],
      })
      const pressure = disposable("year-pressure", 2_500 * mib)

      yield* TestClock.adjust(365 * dayMs)

      expect(yield* planResourceCollectionNow([leased, pressure])).toContain(leased.id)
    }),
  )
})
