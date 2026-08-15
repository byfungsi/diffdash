import { describe, expect, it } from "vitest"
import {
  createPierreRangeShellPool,
  PierreLoadedRangeAdapter,
  pierreRangeCacheKey,
  type PierreRangeIdentity,
  samePierreRangeIdentity,
} from "./pierre-loaded-range-adapter"
import { D12_REVIEW_CACHE_BUDGETS, ReviewRendererCaches } from "./review-global-virtualizer"

const identity: PierreRangeIdentity = {
  projectId: "project",
  processEpoch: "process",
  snapshotGeneration: "generation",
  sessionEpoch: "session",
  rangeKey: "src/range.ts:40-50",
  requestId: "request",
  width: 900,
  mode: "unified",
}

describe("Pierre loaded-range identity", () => {
  it("requires every generation, session, range, request, width, and mode coordinate", () => {
    expect(samePierreRangeIdentity(identity, { ...identity })).toBe(true)
    expect(samePierreRangeIdentity(identity, { ...identity, snapshotGeneration: "next" })).toBe(
      false,
    )
    expect(samePierreRangeIdentity(identity, { ...identity, sessionEpoch: "next" })).toBe(false)
    expect(samePierreRangeIdentity(identity, { ...identity, rangeKey: "src/range.ts:1-10" })).toBe(
      false,
    )
    expect(samePierreRangeIdentity(identity, { ...identity, requestId: "next" })).toBe(false)
    expect(samePierreRangeIdentity(identity, { ...identity, width: 901 })).toBe(false)
    expect(samePierreRangeIdentity(identity, { ...identity, mode: "split" })).toBe(false)
  })

  it("does not alias delimiter-containing identity components", () => {
    const first = { ...identity, rangeKey: "a:b", requestId: "c" }
    const second = { ...identity, rangeKey: "a", requestId: "b:c" }
    expect(pierreRangeCacheKey(first)).not.toBe(pierreRangeCacheKey(second))
  })
})

describe("PierreLoadedRangeAdapter configuration", () => {
  it("rejects invalid shell resource accounting before work starts", () => {
    expect(
      () =>
        new PierreLoadedRangeAdapter(
          new ReviewRendererCaches(D12_REVIEW_CACHE_BUDGETS),
          createPierreRangeShellPool(0),
          { domContainer: -1, observer: 0, measurement: 0 },
          () => ({}),
          {
            onPrimeShell: () => undefined,
            onPublish: () => undefined,
            onHeightChange: () => undefined,
          },
        ),
    ).toThrow("Pierre shell bytes must be non-negative safe integers")
  })
})
