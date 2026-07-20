/* oxlint-disable eslint/no-underscore-dangle -- Tests assert Effect-compatible _tag discriminants. */
import { ReviewFilePatchHash } from "@diffdash/domain/review-identity"
import { describe, expect, it, vi } from "vitest"
import { projectReviewSelection } from "./review-selection"
import {
  type ReviewSourceOperationApi,
  mapReviewSourceOperations,
} from "./review-source-operations"
import { makeReviewSelectionFixtures } from "./review-test-fixtures"

const { hostedManifest, localManifest, locator, provider } = makeReviewSelectionFixtures()

const unavailable = async (): Promise<never> => {
  throw new Error("Not used by this test")
}

const makeApi = () => {
  const setHosted = vi.fn<ReviewSourceOperationApi["viewedFiles"]["set"]>(async () => undefined)
  const setLocal = vi.fn<ReviewSourceOperationApi["viewedFiles"]["setLocal"]>(async () => undefined)
  const openHosted = vi.fn<ReviewSourceOperationApi["openRepositoryFile"]>(async () => undefined)
  const openLocal = vi.fn<ReviewSourceOperationApi["openLocalRepositoryFile"]>(
    async () => undefined,
  )
  const getHostedWalkthrough = vi.fn<ReviewSourceOperationApi["walkthroughs"]["get"]>(unavailable)
  const generateHostedWalkthrough =
    vi.fn<ReviewSourceOperationApi["walkthroughs"]["generate"]>(unavailable)
  const getLocalWalkthrough =
    vi.fn<ReviewSourceOperationApi["localWalkthroughs"]["get"]>(unavailable)
  const generateLocalWalkthrough =
    vi.fn<ReviewSourceOperationApi["localWalkthroughs"]["generate"]>(unavailable)
  const regenerateLocalWalkthrough =
    vi.fn<ReviewSourceOperationApi["localWalkthroughs"]["regenerate"]>(unavailable)
  const api: ReviewSourceOperationApi = {
    hostedReviews: {
      getDecision: async () => "none",
      submitDecision: async () => undefined,
    },
    localWalkthroughs: {
      get: getLocalWalkthrough,
      generate: generateLocalWalkthrough,
      regenerate: regenerateLocalWalkthrough,
    },
    openLocalRepositoryFile: openLocal,
    openRepositoryFile: openHosted,
    viewedFiles: {
      list: async () => [],
      listLocal: async () => [],
      set: setHosted,
      setLocal,
    },
    walkthroughs: { get: getHostedWalkthrough, generate: generateHostedWalkthrough },
  }
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
    const refreshHosted = vi.fn<() => void>()
    const operations = mapReviewSourceOperations(readyHostedSelection(), {
      api: fixture.api,
      refreshHosted,
      refreshLocal: vi.fn<() => void>(),
    })

    operations.refresh()
    await operations.setViewedFile({
      reviewKey: "src/app.ts",
      patchHash: ReviewFilePatchHash.make("patch"),
      viewed: true,
    })
    await operations.openFile("src/app.ts")
    await expect(operations.getWalkthrough()).rejects.toThrow("Not used by this test")
    await expect(operations.generateWalkthrough(true)).rejects.toThrow("Not used by this test")

    expect(operations.source).toBe("hosted")
    expect(operations.decision._tag).toBe("supported")
    expect(refreshHosted).toHaveBeenCalledOnce()
    expect(fixture.setHosted).toHaveBeenCalledOnce()
    expect(fixture.setLocal).not.toHaveBeenCalled()
    expect(fixture.openHosted).toHaveBeenCalledOnce()
    expect(fixture.getHostedWalkthrough).toHaveBeenCalledOnce()
    expect(fixture.generateHostedWalkthrough).toHaveBeenCalledOnce()
    expect(fixture.getLocalWalkthrough).not.toHaveBeenCalled()
  })

  it("maps local operations without exposing review decisions", async () => {
    const fixture = makeApi()
    const refreshLocal = vi.fn<() => void>()
    const operations = mapReviewSourceOperations(readyLocalSelection(), {
      api: fixture.api,
      refreshHosted: vi.fn<() => void>(),
      refreshLocal,
    })

    operations.refresh()
    await operations.setViewedFile({
      reviewKey: "src/app.ts",
      patchHash: ReviewFilePatchHash.make("patch"),
      viewed: false,
    })
    await operations.openFile("src/app.ts")
    await expect(operations.getWalkthrough()).rejects.toThrow("Not used by this test")
    await expect(operations.generateWalkthrough(true)).rejects.toThrow("Not used by this test")

    expect(operations.source).toBe("local")
    expect(operations.decision).toEqual({ _tag: "unsupported" })
    expect(refreshLocal).toHaveBeenCalledOnce()
    expect(fixture.setLocal).toHaveBeenCalledOnce()
    expect(fixture.setHosted).not.toHaveBeenCalled()
    expect(fixture.openLocal).toHaveBeenCalledWith("/workspace/diffdash", "src/app.ts")
    expect(fixture.getLocalWalkthrough).toHaveBeenCalledOnce()
    expect(fixture.regenerateLocalWalkthrough).toHaveBeenCalledOnce()
    expect(fixture.generateLocalWalkthrough).not.toHaveBeenCalled()
  })
})
