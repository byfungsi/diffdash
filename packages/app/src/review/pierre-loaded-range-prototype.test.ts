import { describe, expect, it, vi } from "vitest"
import {
  PierrePartialRangeCoordinator,
  type PierreLoadedRange,
  type PierreRangeIdentity,
  PierreRangeOwnership,
  PierreRangeOwnershipCache,
  rebaseLogicalScroll,
  retainInverseStickyAnchor,
} from "./pierre-loaded-range-prototype"

const identity = (requestId: string): PierreRangeIdentity => ({
  projectId: "project",
  processEpoch: "process-1",
  snapshotGeneration: "snapshot-1",
  sessionEpoch: "session-1",
  requestId,
  width: 900,
  mode: "unified",
})

const range = (
  value: PierreRangeIdentity,
  semanticKey: string,
  release = vi.fn<() => void>(),
): PierreLoadedRange<undefined> => ({
  identity: value,
  semanticKey,
  fileDiff: {
    name: "src/example.ts",
    type: "change",
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
  },
  renderRange: { startingLine: 0, totalLines: 10, bufferBefore: 0, bufferAfter: 0 },
  annotations: [],
  owners: [{ kind: "text", bytes: 10, release }],
})

const deferred = <Value>() => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe("PierrePartialRangeCoordinator", () => {
  it("publishes plain before deferred syntax and keeps semantic identity stable", async () => {
    const syntax = deferred<PierreLoadedRange<undefined>>()
    const publications: string[] = []
    const coordinator = new PierrePartialRangeCoordinator<undefined>({
      onPrimeShell: (_identity, height) => publications.push(`shell:${height}`),
      onPublish: ({ phase, range: published }) =>
        publications.push(`${phase}:${published.semanticKey}`),
    })
    const requestIdentity = identity("request-1")

    coordinator.request({
      identity: requestIdentity,
      estimatedHeight: 800,
      load: async () => range(requestIdentity, "same-lines"),
      highlight: async () => syntax.promise,
    })
    await vi.waitFor(() => expect(publications).toEqual(["shell:800", "plain:same-lines"]))
    syntax.resolve(range(requestIdentity, "same-lines"))
    await vi.waitFor(() =>
      expect(publications).toEqual([
        "shell:800",
        "plain:same-lines",
        "highlighted:same-lines",
      ]),
    )
    coordinator.dispose()
  })

  it("cancels reversal work, rejects stale output, and retains visible ownership until replacement", async () => {
    const firstLoad = deferred<PierreLoadedRange<undefined>>()
    const secondLoad = deferred<PierreLoadedRange<undefined>>()
    const firstRelease = vi.fn<() => void>()
    const secondRelease = vi.fn<() => void>()
    const publications: string[] = []
    const signals: AbortSignal[] = []
    const coordinator = new PierrePartialRangeCoordinator<undefined>({
      onPrimeShell: (value) => publications.push(`shell:${value.requestId}`),
      onPublish: ({ range: published }) => publications.push(`range:${published.identity.requestId}`),
    })

    coordinator.request({
      identity: identity("forward"),
      estimatedHeight: 500,
      load: (signal) => {
        signals.push(signal)
        return firstLoad.promise
      },
    })
    coordinator.request({
      identity: identity("reverse"),
      estimatedHeight: 500,
      load: () => secondLoad.promise,
    })
    expect(signals[0]?.aborted).toBe(true)

    firstLoad.resolve(range(identity("forward"), "forward", firstRelease))
    await vi.waitFor(() => expect(firstRelease).toHaveBeenCalledOnce())
    expect(publications).not.toContain("range:forward")

    secondLoad.resolve(range(identity("reverse"), "reverse", secondRelease))
    await vi.waitFor(() => expect(publications).toContain("range:reverse"))
    expect(secondRelease).not.toHaveBeenCalled()
    coordinator.dispose()
    expect(secondRelease).toHaveBeenCalledOnce()
  })

  it("never publishes deferred syntax for a changed identity or semantic key", async () => {
    const syntaxRelease = vi.fn<() => void>()
    const publications: string[] = []
    const coordinator = new PierrePartialRangeCoordinator<undefined>({
      onPrimeShell: () => undefined,
      onPublish: ({ phase }) => publications.push(phase),
    })
    const requestIdentity = identity("request-1")
    coordinator.request({
      identity: requestIdentity,
      estimatedHeight: 100,
      load: async () => range(requestIdentity, "plain"),
      highlight: async () => range(requestIdentity, "different", syntaxRelease),
    })

    await vi.waitFor(() => expect(syntaxRelease).toHaveBeenCalledOnce())
    expect(publications).toEqual(["plain"])
    coordinator.dispose()
  })
})

describe("Pierre range ownership", () => {
  it("releases every owner once even when one cleanup fails", () => {
    const released = vi.fn<(kind: string) => void>()
    const ownership = new PierreRangeOwnership([
      { kind: "text", bytes: 4, release: () => released("text") },
      {
        kind: "worker",
        bytes: 8,
        release: () => {
          throw new Error("worker cleanup failed")
        },
      },
      { kind: "reservation", bytes: 2, release: () => released("reservation") },
    ])

    expect(() => ownership.release()).toThrow(AggregateError)
    expect(released.mock.calls).toEqual([["text"], ["reservation"]])
    expect(() => ownership.release()).not.toThrow()
  })

  it("evicts least-recent ranges under a byte budget with coordinated cleanup", () => {
    const firstRelease = vi.fn<() => void>()
    const secondRelease = vi.fn<() => void>()
    const cache = new PierreRangeOwnershipCache(10)
    cache.set(
      "first",
      new PierreRangeOwnership([{ kind: "ast-output", bytes: 6, release: firstRelease }]),
    )
    cache.set(
      "second",
      new PierreRangeOwnership([{ kind: "dom-container", bytes: 6, release: secondRelease }]),
    )

    expect(firstRelease).toHaveBeenCalledOnce()
    expect(secondRelease).not.toHaveBeenCalled()
    expect(cache.bytes).toBe(6)
    cache.clear()
    expect(secondRelease).toHaveBeenCalledOnce()
    expect(cache.bytes).toBe(0)
  })
})

describe("partial-range layout math", () => {
  it("applies wrapping height deltas only for content above the visible anchor", () => {
    expect(
      retainInverseStickyAnchor({ anchorTop: 400, itemTop: 100, measuredDelta: 72, scrollTop: 320 }),
    ).toBe(392)
    expect(
      retainInverseStickyAnchor({ anchorTop: 400, itemTop: 500, measuredDelta: 72, scrollTop: 320 }),
    ).toBe(320)
  })

  it("rebases large logical scroll offsets without losing their exact coordinate", () => {
    const rebased = rebaseLogicalScroll(987_654_321, 10_000_000)
    expect(rebased.physicalTop).toBeLessThan(10_000_000)
    expect(rebased.pageOrigin + rebased.physicalTop).toBe(987_654_321)
  })
})
