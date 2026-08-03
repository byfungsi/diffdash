import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import {
  GitProviderId,
  HostedRepositoryName,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"

import {
  CliGitRevision,
  CliNavigationCommand,
  CliRepositorySelector,
  OpenRepositoryComparisonCommand,
} from "./cli-navigation"

describe("CliNavigationCommand", () => {
  it("round-trips a qualified immutable repository comparison", () => {
    const command = OpenRepositoryComparisonCommand.make({
      repository: CliRepositorySelector.make({
        providerId: GitProviderId.make("github"),
        namespace: RepositoryNamespace.make("torvalds"),
        name: HostedRepositoryName.make("linux"),
      }),
      baseRef: CliGitRevision.make("v6.0"),
      headRef: CliGitRevision.make("v6.1"),
    })

    const encoded = Schema.encodeSync(CliNavigationCommand)(command)

    expect(Schema.decodeUnknownSync(CliNavigationCommand)(encoded)).toEqual(command)
  })

  it("rejects malformed repository selector fields", () => {
    expect(() =>
      Schema.decodeUnknownSync(CliNavigationCommand)({
        _tag: "openRepositoryComparison",
        repository: { providerId: "local", namespace: "torvalds", name: "linux" },
        baseRef: "v6.0",
        headRef: "v6.1",
      }),
    ).toThrow(/GitProviderId|Expected/)
  })

  it.each([
    "-head",
    "@",
    "feature~1",
    "refs/.hidden/head",
    "refs/heads/topic.lock",
  ])("rejects unsafe revision input %s", (revision) => {
    expect(() => CliGitRevision.make(revision)).toThrow("Invalid Git revision")
  })
})
