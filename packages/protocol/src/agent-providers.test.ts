import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { AgentProviderCapabilities, AgentProviderCapabilityStatus } from "./agent-providers"

describe("agent provider capability protocol", () => {
  it("encodes a closed record of tagged capability states", () => {
    const capabilities = AgentProviderCapabilities.make({
      walkthrough: AgentProviderCapabilityStatus.cases.Ready.make({
        runtimeVersion: "1.2.3",
      }),
      "review-thread": AgentProviderCapabilityStatus.cases.PolicyUnsupported.make({
        reason: "Review policy cannot be enforced.",
      }),
    })

    expect(Schema.encodeSync(AgentProviderCapabilities)(capabilities)).toEqual({
      walkthrough: { _tag: "Ready", runtimeVersion: "1.2.3" },
      "review-thread": {
        _tag: "PolicyUnsupported",
        reason: "Review policy cannot be enforced.",
      },
    })
  })

  it("rejects incomplete capability records and missing variant fields", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentProviderCapabilities)({
        walkthrough: { _tag: "Ready", runtimeVersion: null },
      }),
    ).toThrow(/review-thread/u)
    expect(() =>
      Schema.decodeUnknownSync(AgentProviderCapabilities)({
        walkthrough: { _tag: "Unavailable" },
        "review-thread": { _tag: "Unsupported", reason: "Not implemented." },
      }),
    ).toThrow(/reason/u)
  })
})
