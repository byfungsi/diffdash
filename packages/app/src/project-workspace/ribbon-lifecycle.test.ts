import { describe, expect, it } from "@effect/vitest"
import { Match } from "effect"

import { type RibbonLifecycle, type RibbonLifecycleHandlers } from "./ribbon-lifecycle"

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
  ready: { _tag: "ready", data: preservedData, refresh: "idle" },
  empty: { _tag: "empty", refresh: "refreshing" },
  unavailable: { _tag: "unavailable", reason: "Provider unavailable" },
  failure: { _tag: "failure", error: { message: "Request failed" } },
  stale: {
    _tag: "stale",
    data: preservedData,
    reason: "Last refresh failed",
    refresh: "refreshing",
  },
  invalid: { _tag: "invalid", reason: "Selection is invalid" },
  degraded: {
    _tag: "degraded",
    data: preservedData,
    issues: [{ message: "One file could not be loaded" }],
    refresh: "idle",
  },
} satisfies FixtureMap

const handlers: RibbonLifecycleHandlers<FixtureData, FixtureFailure, FixtureIssue, string> = {
  loading: () => "loading",
  ready: ({ data, refresh }) => `ready:${data.count}:${refresh}`,
  empty: ({ refresh }) => `empty:${refresh}`,
  unavailable: ({ reason }) => `unavailable:${reason}`,
  failure: ({ error }) => `failure:${error.message}`,
  stale: ({ data, reason, refresh }) => `stale:${data.count}:${reason}:${refresh}`,
  invalid: ({ reason }) => `invalid:${reason}`,
  degraded: ({ data, issues, refresh }) => `degraded:${data.count}:${issues[0].message}:${refresh}`,
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
    expect(Object.values(fixtures).map((state) => Match.valueTags(state, handlers))).toEqual([
      "loading",
      "ready:3:idle",
      "empty:refreshing",
      "unavailable:Provider unavailable",
      "failure:Request failed",
      "stale:3:Last refresh failed:refreshing",
      "invalid:Selection is invalid",
      "degraded:3:One file could not be loaded:idle",
    ])
  })
})
