import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { CoreAnalyticsDisabled, CoreAnalyticsEnabled, CoreAnalyticsState } from "./analytics-state"

describe("CoreAnalyticsState", () => {
  it("decodes complete credentials to the enabled state", () => {
    const state = Schema.decodeUnknownSync(CoreAnalyticsState)({
      host: "https://us.i.posthog.com",
      projectKey: "phc_test",
    })

    expect(state).toBeInstanceOf(CoreAnalyticsEnabled)
    expect(state).toMatchObject({
      host: "https://us.i.posthog.com",
      projectKey: "phc_test",
    })
  })

  it.each([
    { host: null, projectKey: null },
    { host: "https://us.i.posthog.com", projectKey: null },
    { host: null, projectKey: "phc_test" },
  ])("normalizes incomplete credentials to disabled", (encoded) => {
    expect(Schema.decodeUnknownSync(CoreAnalyticsState)(encoded)).toBeInstanceOf(
      CoreAnalyticsDisabled,
    )
  })

  it("encodes disabled analytics with the nullable host contract", () => {
    const state = Schema.decodeUnknownSync(CoreAnalyticsState)({
      host: "https://us.i.posthog.com",
      projectKey: null,
    })

    expect(Schema.encodeSync(CoreAnalyticsState)(state)).toEqual({
      host: null,
      projectKey: null,
    })
  })
})
