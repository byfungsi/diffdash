import { ReviewProjectId, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import { ReviewSnapshotAddress } from "@diffdash/domain/review-navigation"
import { describe, expect, it } from "vitest"

import { makeInitialReviewSearchModel, reduceReviewSearch } from "./review-search-state"

const session = ReviewSnapshotAddress.make({
  projectId: ReviewProjectId.make("project-search"),
  snapshotId: ReviewSnapshotId.make("snapshot:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
})

describe("progressive review search state", () => {
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
