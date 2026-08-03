import type { HostedReviewSummary } from "@diffdash/domain/git-provider"
import { describe, expect, it } from "vitest"

import { matchRibbonLifecycle, type RibbonLifecycle } from "./ribbon-lifecycle"
import { projectReviewsLifecycle } from "./reviews-lifecycle"

type ReviewsFixtureLifecycle = RibbonLifecycle<readonly HostedReviewSummary[], Error, string>
type ReviewsFixtureMap = {
  readonly [Tag in ReviewsFixtureLifecycle["_tag"]]: Extract<
    ReviewsFixtureLifecycle,
    { readonly _tag: Tag }
  >
}

const data = [] as readonly HostedReviewSummary[]
const fixtures = {
  loading: { _tag: "loading" },
  ready: { _tag: "ready", data, refreshing: false },
  empty: { _tag: "empty", refreshing: false },
  unavailable: { _tag: "unavailable", reason: "No hosted provider" },
  failure: { _tag: "failure", error: new Error("Provider failed") },
  stale: { _tag: "stale", data, reason: "Refresh failed", refreshing: false },
  invalid: { _tag: "invalid", reason: "Invalid repository identity" },
  degraded: { _tag: "degraded", data, issues: ["One source failed"], refreshing: false },
} satisfies ReviewsFixtureMap

describe("Reviews ribbon lifecycle fixtures", () => {
  it("covers every lifecycle state with exhaustive presentation handlers", () => {
    const rendered = Object.values(fixtures).map((fixture) =>
      matchRibbonLifecycle(fixture, {
        loading: () => "loading",
        ready: () => "ready",
        empty: () => "empty",
        unavailable: () => "unavailable",
        failure: () => "failure",
        stale: () => "stale",
        invalid: () => "invalid",
        degraded: () => "degraded",
      }),
    )

    expect(rendered).toEqual([
      "loading",
      "ready",
      "empty",
      "unavailable",
      "failure",
      "stale",
      "invalid",
      "degraded",
    ])
  })

  it("classifies two authoritative empty sources as empty", () => {
    expect(
      projectReviewsLifecycle(
        { _tag: "empty", refreshing: false },
        { _tag: "empty", refreshing: false },
      ),
    ).toEqual({ _tag: "empty", refreshing: false })
  })

  it("keeps a clean local source when hosted reviews fail", () => {
    const state = projectReviewsLifecycle(
      { _tag: "empty", refreshing: false },
      { _tag: "failure", error: new Error("Provider unavailable") },
    )

    expect(state._tag).toBe("degraded")
    if (state._tag !== "degraded") return
    expect(state.data.local._tag).toBe("empty")
    expect(state.data.hosted._tag).toBe("failure")
    expect(state.issues).toEqual(["One review source could not be loaded."])
  })

  it("uses failure only when no review source remains usable", () => {
    expect(
      projectReviewsLifecycle(
        { _tag: "failure", error: new Error("Local failed") },
        { _tag: "unavailable", reason: "No hosted provider" },
      )._tag,
    ).toBe("failure")
  })
})
