import { describe, expect, it } from "@effect/vitest"
import { AgentProviderFailure } from "./provider-failure"

describe("AgentProviderFailure", () => {
  it("accepts real UTC reset timestamps and rejects impossible values", () => {
    expect(
      AgentProviderFailure.make({
        version: 1,
        providerId: "claude",
        capability: "review-thread",
        category: "usage-limited",
        processKind: null,
        exitCode: null,
        signal: null,
        httpStatus: null,
        retryAfterSeconds: null,
        resetsAt: "2026-08-06T12:34:56Z",
      }).resetsAt,
    ).toBe("2026-08-06T12:34:56Z")
    expect(() =>
      AgentProviderFailure.make({
        version: 1,
        providerId: "claude",
        capability: "review-thread",
        category: "usage-limited",
        processKind: null,
        exitCode: null,
        signal: null,
        httpStatus: null,
        retryAfterSeconds: null,
        resetsAt: "2026-99-99T99:99:99Z",
      }),
    ).toThrow(/Invalid UTC provider reset timestamp/)
  })
})
