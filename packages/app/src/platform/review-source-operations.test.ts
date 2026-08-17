/* oxlint-disable eslint/no-underscore-dangle -- Tests assert Effect-compatible _tag discriminants. */
import { ReviewFilePatchHash, ReviewKey } from "@diffdash/domain/review-identity"
import { describe, expect, it, vi } from "vitest"
import type { DiffDashBridgeApi } from "@diffdash/protocol/api"
import { projectReviewSelection } from "@/review/review-selection"
import { makeReviewSelectionFixtures } from "@/review/review-test-fixtures"
import { makeReviewSourceOperations } from "./review-source-operations"

const { hostedManifest, localManifest, locator, provider } = makeReviewSelectionFixtures()

const success = <Value>(value: Value) => Promise.resolve({ _tag: "Success" as const, value })

const makeApi = () => {
  const setHosted = vi.fn<DiffDashBridgeApi["viewedFiles"]["set"]>(() => success(undefined))
  const setLocal = vi.fn<DiffDashBridgeApi["viewedFiles"]["setLocal"]>(() => success(undefined))
  const openHosted = vi.fn<DiffDashBridgeApi["openRepositoryFile"]>(() => success(undefined))
  const openLocal = vi.fn<DiffDashBridgeApi["openLocalRepositoryFile"]>(() => success(undefined))
  const api = {
    hostedReviews: {
      getDecision: () => success("none" as const),
      submitDecision: () => success(undefined),
    },
    openLocalRepositoryFile: openLocal,
    openRepositoryFile: openHosted,
    repositoryComparisons: { openFile: () => success(undefined) },
    viewedFiles: {
      list: () => success([]),
      listLocal: () => success([]),
      listRepositoryComparison: () => success([]),
      set: setHosted,
      setLocal,
      setRepositoryComparison: () => success(undefined),
    },
  } satisfies Parameters<typeof makeReviewSourceOperations>[0]
  return {
    api,
    openHosted,
    openLocal,
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

    expect(operations.decision._tag).toBe("supported")
    expect(fixture.setHosted).toHaveBeenCalledOnce()
    expect(fixture.setLocal).not.toHaveBeenCalled()
    expect(fixture.openHosted).toHaveBeenCalledOnce()
  })

  it("maps local operations without exposing review decisions", async () => {
    const fixture = makeApi()
    const ready = readyLocalSelection()
    const operations = makeReviewSourceOperations(fixture.api, ready.review)

    await operations.setViewedFile({
      reviewKey: ReviewKey.make("src/app.ts"),
      patchHash: ReviewFilePatchHash.make("patch"),
      viewed: false,
    })
    await operations.openFile("src/app.ts")

    expect(operations.decision).toEqual({ _tag: "unsupported" })
    expect(fixture.setLocal).toHaveBeenCalledOnce()
    expect(fixture.setHosted).not.toHaveBeenCalled()
    expect(fixture.openLocal).toHaveBeenCalledWith(
      "/workspace/diffdash",
      "src/app.ts",
      ready.review.target,
    )
  })
})
