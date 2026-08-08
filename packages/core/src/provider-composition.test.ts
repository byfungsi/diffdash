import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Stream } from "effect"

import {
  createAgentProviderComposition,
  createGitProviderComposition,
} from "./provider-composition"

const processes = {
  run: () => Effect.dieMessage("probe is not evaluated during composition"),
  streamLines: () => Stream.dieMessage("execution is not evaluated during composition"),
}

describe("provider composition", () => {
  it("adds a fourth provider with one composition registration", () => {
    const composition = createAgentProviderComposition({
      processes,
      tempResources: {
        makeTempDirectoryScoped: () => Effect.dieMessage("temp resources are not evaluated"),
        makeTempFileScoped: () => Effect.dieMessage("temp resources are not evaluated"),
        makeTempOutputPathScoped: () => Effect.dieMessage("temp resources are not evaluated"),
      },
      tempDirectory: "/tmp/diffdash-agent-composition",
      fixture: Option.some({ walkthroughNeverCompletes: false }),
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

  it("adds the Git fixture only when the host enables it", () => {
    expect(
      createGitProviderComposition(processes, Option.none()).map(({ descriptor }) => descriptor.id),
    ).toEqual(["github"])
    expect(
      createGitProviderComposition(
        processes,
        Option.some({
          remoteUrl: "/tmp/fixture.git",
          baseRevision: Option.some("a".repeat(40)),
          headRevision: Option.some("b".repeat(40)),
        }),
      ).map(({ descriptor }) => descriptor.id),
    ).toEqual(["github", "fixture"])
  })

  it("omits the agent fixture with one explicit absence state", () => {
    const composition = createAgentProviderComposition({
      processes,
      tempResources: {
        makeTempDirectoryScoped: () => Effect.dieMessage("temp resources are not evaluated"),
        makeTempFileScoped: () => Effect.dieMessage("temp resources are not evaluated"),
        makeTempOutputPathScoped: () => Effect.dieMessage("temp resources are not evaluated"),
      },
      tempDirectory: "/tmp/diffdash-agent-composition",
      fixture: Option.none(),
    })

    expect(composition.registrations.map(({ manifest }) => manifest.descriptor.id)).toEqual([
      "claude",
      "codex",
      "opencode",
    ])
  })
})
