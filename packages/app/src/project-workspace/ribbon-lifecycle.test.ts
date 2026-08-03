import { describe, expect, it } from "@effect/vitest"

import {
  matchRibbonLifecycle,
  ProjectWorkspaceRibbonIds,
  type RibbonLifecycle,
  type RibbonLifecycleHandlers,
} from "./ribbon-lifecycle"

type FixtureData = { readonly count: number }
type FixtureFailure = { readonly message: string }
type FixtureIssue = { readonly message: string }
type FixtureLifecycle = RibbonLifecycle<FixtureData, FixtureFailure, FixtureIssue>
type FixtureMap = {
  readonly [Tag in FixtureLifecycle["_tag"]]: Extract<FixtureLifecycle, { readonly _tag: Tag }>
}

const preservedData: FixtureData = { count: 3 }
const fixtures = {
  loading: { _tag: "loading" },
  ready: { _tag: "ready", data: preservedData, refreshing: false },
  empty: { _tag: "empty", refreshing: true },
  unavailable: { _tag: "unavailable", reason: "Provider unavailable" },
  failure: { _tag: "failure", error: { message: "Request failed" } },
  stale: {
    _tag: "stale",
    data: preservedData,
    reason: "Last refresh failed",
    refreshing: true,
  },
  invalid: { _tag: "invalid", reason: "Selection is invalid" },
  degraded: {
    _tag: "degraded",
    data: preservedData,
    issues: [{ message: "One file could not be loaded" }],
    refreshing: false,
  },
} satisfies FixtureMap

const handlers: RibbonLifecycleHandlers<FixtureData, FixtureFailure, FixtureIssue, string> = {
  loading: () => "loading",
  ready: ({ data, refreshing }) => `ready:${data.count}:${refreshing}`,
  empty: ({ refreshing }) => `empty:${refreshing}`,
  unavailable: ({ reason }) => `unavailable:${reason}`,
  failure: ({ error }) => `failure:${error.message}`,
  stale: ({ data, reason, refreshing }) => `stale:${data.count}:${reason}:${refreshing}`,
  invalid: ({ reason }) => `invalid:${reason}`,
  degraded: ({ data, issues, refreshing }) =>
    `degraded:${data.count}:${issues[0].message}:${refreshing}`,
}

describe("RibbonLifecycle", () => {
  it("keeps a complete fixture for every lifecycle tag", () => {
    expect(Object.keys(fixtures)).toEqual([
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

  it("dispatches every variant to its exhaustive handler", () => {
    expect(Object.values(fixtures).map((state) => matchRibbonLifecycle(state, handlers))).toEqual([
      "loading",
      "ready:3:false",
      "empty:true",
      "unavailable:Provider unavailable",
      "failure:Request failed",
      "stale:3:Last refresh failed:true",
      "invalid:Selection is invalid",
      "degraded:3:One file could not be loaded:false",
    ])
  })

  it("exports lowercase semantic ribbon identifiers", () => {
    expect(ProjectWorkspaceRibbonIds).toEqual({
      Reviews: "reviews",
      Files: "files",
      Walkthrough: "walkthrough",
      Threads: "threads",
    })
  })
})
