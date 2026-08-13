/* oxlint-disable eslint/no-underscore-dangle -- Tests assert Effect-compatible _tag discriminants. */
import { ReviewFilePatchHash, ReviewKey } from "@diffdash/domain/review-identity"
import { describe, expect, it, vi } from "vitest"
import type { DiffDashBridgeApi } from "@diffdash/protocol/api"
import { projectReviewSelection } from "@/review/review-selection"
import { makeReviewSelectionFixtures } from "@/review/review-test-fixtures"
import { makeReviewSourceOperations } from "./review-source-operations"

const { hostedManifest, localManifest, locator, provider } = makeReviewSelectionFixtures()

const unavailable = async (): Promise<never> => {
  throw new Error("Not used by this test")
}

const success = <Value>(value: Value) => Promise.resolve({ _tag: "Success" as const, value })

const makeApi = () => {
  const setHosted = vi.fn<DiffDashBridgeApi["viewedFiles"]["set"]>(() => success(undefined))
  const setLocal = vi.fn<DiffDashBridgeApi["viewedFiles"]["setLocal"]>(() => success(undefined))
  const openHosted = vi.fn<DiffDashBridgeApi["openRepositoryFile"]>(() => success(undefined))
  const openLocal = vi.fn<DiffDashBridgeApi["openLocalRepositoryFile"]>(() => success(undefined))
  const getHostedWalkthrough = vi.fn<DiffDashBridgeApi["walkthroughs"]["get"]>(unavailable)
  const generateHostedWalkthrough =
    vi.fn<DiffDashBridgeApi["walkthroughs"]["generate"]>(unavailable)
  const getLocalWalkthrough = vi.fn<DiffDashBridgeApi["localWalkthroughs"]["get"]>(unavailable)
  const generateLocalWalkthrough =
    vi.fn<DiffDashBridgeApi["localWalkthroughs"]["generate"]>(unavailable)
  const regenerateLocalWalkthrough =
    vi.fn<DiffDashBridgeApi["localWalkthroughs"]["regenerate"]>(unavailable)
  const api = {
    hostedReviews: {
      getDecision: () => success("none" as const),
      submitDecision: () => success(undefined),
    },
    localWalkthroughs: {
      get: getLocalWalkthrough,
      generate: generateLocalWalkthrough,
      regenerate: regenerateLocalWalkthrough,
    },
    openLocalRepositoryFile: openLocal,
    openRepositoryFile: openHosted,
    repositoryComparisons: { openFile: () => success(undefined) },
    repositoryComparisonWalkthroughs: {
      get: () => success(null),
      generate: unavailable,
      regenerate: unavailable,
    },
    viewedFiles: {
      list: () => success([]),
      listLocal: () => success([]),
      listRepositoryComparison: () => success([]),
      set: setHosted,
      setLocal,
      setRepositoryComparison: () => success(undefined),
    },
    walkthroughs: { get: getHostedWalkthrough, generate: generateHostedWalkthrough },
  } satisfies Parameters<typeof makeReviewSourceOperations>[0]
  return {
    api,
    generateHostedWalkthrough,
    generateLocalWalkthrough,
    getHostedWalkthrough,
    getLocalWalkthrough,
    openHosted,
    openLocal,
    regenerateLocalWalkthrough,
    setHosted,
    setLocal,
  }
}

const readyHostedSelection = () => {
  const selection = projectReviewSelection({
    target: { kind: "hosted", review: locator },
    hosted: { _tag: "ready", manifest: hostedManifest, refreshing: false },
    local: { _tag: "ready", manifest: localManifest, refreshing: false },
    providers: [provider],
  })
  if (selection._tag !== "ready") throw new Error("Expected ready hosted selection")
  return selection
}

const readyLocalSelection = () => {
  const target = localManifest.detail
  const selection = projectReviewSelection({
    target: {
      kind: "localDiff",
      target: {
        kind: "local",
        rootPath: target.rootPath,
        comparison: target.comparison,
      },
    },
    hosted: { _tag: "ready", manifest: hostedManifest, refreshing: false },
    local: { _tag: "ready", manifest: localManifest, refreshing: false },
    providers: [provider],
  })
  if (selection._tag !== "ready") throw new Error("Expected ready local selection")
  return selection
}

describe("review source operations", () => {
  it("maps hosted viewed, file, refresh, and decision operations", async () => {
    const fixture = makeApi()
    const operations = makeReviewSourceOperations(fixture.api, readyHostedSelection().review)

    await operations.setViewedFile({
      reviewKey: ReviewKey.make("src/app.ts"),
      patchHash: ReviewFilePatchHash.make("patch"),
      viewed: true,
    })
    await operations.openFile("src/app.ts")
    await expect(operations.getWalkthrough()).rejects.toThrow(
      "DiffDash could not complete the request",
    )
    await expect(operations.generateWalkthrough(true)).rejects.toThrow(
      "DiffDash could not complete the request",
    )

    expect(operations.source).toBe("hosted")
    expect(operations.decision._tag).toBe("supported")
    expect(fixture.setHosted).toHaveBeenCalledOnce()
    expect(fixture.setLocal).not.toHaveBeenCalled()
    expect(fixture.openHosted).toHaveBeenCalledOnce()
    expect(fixture.getHostedWalkthrough).toHaveBeenCalledOnce()
    expect(fixture.generateHostedWalkthrough).toHaveBeenCalledOnce()
    expect(fixture.getLocalWalkthrough).not.toHaveBeenCalled()
  })

  it("maps local operations without exposing review decisions", async () => {
    const fixture = makeApi()
    const operations = makeReviewSourceOperations(fixture.api, readyLocalSelection().review)

    await operations.setViewedFile({
      reviewKey: ReviewKey.make("src/app.ts"),
      patchHash: ReviewFilePatchHash.make("patch"),
      viewed: false,
    })
    await operations.openFile("src/app.ts")
    await expect(operations.getWalkthrough()).rejects.toThrow(
      "DiffDash could not complete the request",
    )
    await expect(operations.generateWalkthrough(true)).rejects.toThrow(
      "DiffDash could not complete the request",
    )

    expect(operations.source).toBe("local")
    expect(operations.decision).toEqual({ _tag: "unsupported" })
    expect(fixture.setLocal).toHaveBeenCalledOnce()
    expect(fixture.setHosted).not.toHaveBeenCalled()
    expect(fixture.openLocal).toHaveBeenCalledWith("/workspace/diffdash", "src/app.ts")
    expect(fixture.getLocalWalkthrough).toHaveBeenCalledOnce()
    expect(fixture.regenerateLocalWalkthrough).toHaveBeenCalledOnce()
    expect(fixture.generateLocalWalkthrough).not.toHaveBeenCalled()
  })
})
