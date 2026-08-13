import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import {
  GitProviderId,
  HostedRepositoryName,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"

import {
  CliGitRevision,
  CliNavigationCommand,
  CliRepositorySelector,
  OpenRepositoryComparisonCommand,
  OpenLastCommitCommand,
} from "./cli-navigation"

describe("CliNavigationCommand", () => {
  it("round-trips a qualified immutable repository comparison", () => {
    const command = OpenRepositoryComparisonCommand.make({
      localPath: RepositoryCheckoutPath.make("/workspace/linux"),
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

  it("round-trips a current-checkout repository comparison", () => {
    const command = OpenRepositoryComparisonCommand.make({
      localPath: RepositoryCheckoutPath.make("/workspace/linux"),
      repository: null,
      baseRef: CliGitRevision.make("v6.0"),
      headRef: CliGitRevision.make("v6.1"),
    })

    const encoded = Schema.encodeSync(CliNavigationCommand)(command)

    expect(Schema.decodeUnknownSync(CliNavigationCommand)(encoded)).toEqual(command)
  })

  it("round-trips a last-commit command", () => {
    const command = OpenLastCommitCommand.make({
      localPath: RepositoryCheckoutPath.make("/workspace/linux"),
    })
    const encoded = Schema.encodeSync(CliNavigationCommand)(command)
    expect(Schema.decodeUnknownSync(CliNavigationCommand)(encoded)).toEqual(command)
  })

  it("rejects malformed repository selector fields", () => {
    expect(() =>
      Schema.decodeUnknownSync(CliNavigationCommand)({
        _tag: "openRepositoryComparison",
        localPath: "/workspace/linux",
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
    expect(() => CliGitRevision.make(revision)).toThrow("Schema validation failed")
  })
})
