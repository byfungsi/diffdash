import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"

import { createAgentProviderComposition } from "./agent-provider-composition"

describe("agent provider composition", () => {
  it("adds a fourth provider with one composition registration", () => {
    const composition = createAgentProviderComposition({
      processes: {
        run: () => Effect.dieMessage("probe is not evaluated during composition"),
        streamLines: () => Stream.dieMessage("execution is not evaluated during composition"),
      },
      tempDirectory: "/tmp/diffdash-agent-composition",
      includeFixture: true,
    })

    expect(composition.registrations.map(({ manifest }) => manifest.descriptor.id)).toEqual([
      "claude",
      "codex",
      "opencode",
      "fixture-agent",
    ])
    expect(composition.registrations[3]?.manifest.models[0]?.id).toBe("fixture-model")
    expect(composition.policies.walkthrough).toEqual(["claude", "codex", "opencode"])
    expect(composition.policies.reviewThread).toEqual(["claude", "codex", "opencode"])
  })
})
