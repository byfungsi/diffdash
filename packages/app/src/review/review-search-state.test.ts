import { ReviewFileId, ReviewProjectId, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import { ReviewSnapshotAddress } from "@diffdash/domain/review-navigation"
import { ReviewSnapshotSearchFileAnchor } from "@diffdash/protocol/review-snapshot"
import { describe, expect, it } from "@effect/vitest"
import { AtomRegistry } from "effect/unstable/reactivity"

import {
  makeInitialReviewSearchModel,
  reduceReviewSearch,
  ReviewSearchController,
} from "./review-search-state"

const session = ReviewSnapshotAddress.make({
  projectId: ReviewProjectId.make("project-search"),
  snapshotId: ReviewSnapshotId.make("snapshot:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
})

describe("progressive review search state", () => {
  it("clears the controller's toolbar and search targets before reopening", () => {
    const registry = AtomRegistry.make()
    const controller = new ReviewSearchController(registry)
    try {
      controller.attach(session)
      controller.open(null)
      controller.setQuery("needle")
      controller.close()
      expect(registry.get(controller.toolbarAtom)).toEqual({
        open: false,
        query: "",
        resultStatus: { _tag: "idle" },
        totalMatches: 0,
        activeGlobalIndex: 0,
      })
      expect(registry.get(controller.activeMatchAtom)).toBeNull()
      expect(registry.get(controller.retainedMatchesAtom)).toEqual([])
      controller.open(null)
      expect(registry.get(controller.toolbarAtom)).toMatchObject({
        open: true,
        query: "",
        totalMatches: 0,
      })
    } finally {
      controller.dispose()
      registry.dispose()
    }
  })

  it("invalidates delayed results and resets the search anchor on close", () => {
    const attached = reduceReviewSearch(makeInitialReviewSearchModel(), {
      _tag: "attach",
      session,
    }).model
    const opened = reduceReviewSearch(attached, {
      _tag: "open",
      anchor: ReviewSnapshotSearchFileAnchor.make({ fileId: ReviewFileId.make("search-file") }),
    }).model
    const queried = reduceReviewSearch(opened, { _tag: "query", query: "needle" })
    if (queried.operation === null) throw new Error("Expected search operation")
    const closed = reduceReviewSearch(queried.model, { _tag: "close" }).model
    expect(closed).toMatchObject({
      query: "",
      anchor: null,
      desiredGlobalIndex: 0,
      activeGlobalIndex: 0,
    })
    const reopened = reduceReviewSearch(closed, { _tag: "open", anchor: null })
    expect(reopened.operation).toBeNull()
    const late = reduceReviewSearch(reopened.model, {
      _tag: "results",
      key: queried.operation.key,
      totalMatches: 1,
      retainedMatches: [],
    })
    expect(late.stale).toBe(true)
    expect(late.model.totalMatches).toBe(0)
  })

  it("starts a latest-query operation only while attached and open", () => {
    const attached = reduceReviewSearch(makeInitialReviewSearchModel(), {
      _tag: "attach",
      session,
    }).model
    const opened = reduceReviewSearch(attached, { _tag: "open", anchor: null }).model
    const queried = reduceReviewSearch(opened, { _tag: "query", query: "needle" })

    expect(queried.model.resultStatus._tag).toBe("loading")
    expect(queried.operation?.kind).toBe("query")
    expect(queried.operation?.targetIndex).toBe(0)
  })

  it("rejects results from an older progressive query generation", () => {
    const attached = reduceReviewSearch(makeInitialReviewSearchModel(), {
      _tag: "attach",
      session,
    }).model
    const opened = reduceReviewSearch(attached, { _tag: "open", anchor: null }).model
    const first = reduceReviewSearch(opened, { _tag: "query", query: "first" })
    const second = reduceReviewSearch(first.model, { _tag: "query", query: "second" })
    const firstOperation = first.operation
    if (firstOperation === null) throw new Error("Expected the first query operation")
    const stale = reduceReviewSearch(second.model, {
      _tag: "results",
      key: firstOperation.key,
      totalMatches: 2,
      retainedMatches: [],
    })

    expect(stale.stale).toBe(true)
    expect(stale.model.query).toBe("second")
    expect(stale.model.totalMatches).toBe(0)
  })
})
