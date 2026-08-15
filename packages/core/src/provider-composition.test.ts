import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Stream } from "effect"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import { CoreAbsolutePath, GitFixtureRemote } from "./core-configuration"

import {
  createAgentProviderComposition,
  createGitProviderComposition,
} from "./provider-composition.e2e"

const processes = {
  run: () => Effect.die(new Error("probe is not evaluated during composition")),
  streamBytes: () => Stream.die(new Error("execution is not evaluated during composition")),
  streamLines: () => Stream.die(new Error("execution is not evaluated during composition")),
}

describe("provider composition", () => {
  it("adds a fourth provider with one composition registration", () => {
    const composition = createAgentProviderComposition({
      processes,
      tempResources: {
        makeTempDirectoryScoped: () => Effect.die(new Error("temp resources are not evaluated")),
        makeTempFileScoped: () => Effect.die(new Error("temp resources are not evaluated")),
        makeTempOutputPathScoped: () => Effect.die(new Error("temp resources are not evaluated")),
      },
      tempDirectory: CoreAbsolutePath.make("/tmp/diffdash-agent-composition"),
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
          remoteUrl: GitFixtureRemote.make("/tmp/fixture.git"),
          baseRevision: Option.some(ReviewRevision.make("a".repeat(40))),
          headRevision: Option.some(ReviewRevision.make("b".repeat(40))),
        }),
      ).map(({ descriptor }) => descriptor.id),
    ).toEqual(["github", "fixture"])
  })

  it("omits the agent fixture with one explicit absence state", () => {
    const composition = createAgentProviderComposition({
      processes,
      tempResources: {
        makeTempDirectoryScoped: () => Effect.die(new Error("temp resources are not evaluated")),
        makeTempFileScoped: () => Effect.die(new Error("temp resources are not evaluated")),
        makeTempOutputPathScoped: () => Effect.die(new Error("temp resources are not evaluated")),
      },
      tempDirectory: CoreAbsolutePath.make("/tmp/diffdash-agent-composition"),
      fixture: Option.none(),
    })

    expect(composition.registrations.map(({ manifest }) => manifest.descriptor.id)).toEqual([
      "claude",
      "codex",
      "opencode",
    ])
  })
})
