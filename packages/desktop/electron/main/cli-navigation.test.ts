import { describe, expect, it } from "@effect/vitest"

import { parseCliNavigationCommand } from "./cli-navigation"

const parse = (args: readonly string[]) =>
  parseCliNavigationCommand(
    ["electron", "app", "--diffdash-cli-v1=/workspace/repo", "--", ...args],
    "/fallback",
  )

describe("parseCliNavigationCommand", () => {
  it("parses working-tree, repository, PR, and branch commands", () => {
    expect(parse([])).toMatchObject({ _tag: "openWorkingTree", localPath: "/workspace/repo" })
    expect(parse(["src"])).toMatchObject({
      _tag: "openWorkingTree",
      localPath: "/workspace/repo/src",
    })
    expect(parse(["install"])).toMatchObject({
      _tag: "linkRepository",
      localPath: "/workspace/repo",
    })
    expect(parse(["pr"])).toMatchObject({
      _tag: "openPullRequest",
      localPath: "/workspace/repo",
      number: null,
    })
    expect(parse(["pr", "42"])).toMatchObject({ _tag: "openPullRequest", number: 42 })
    expect(parse(["diff"])).toMatchObject({ _tag: "openBranchDiff", branchName: null })
    expect(parse(["diff", "release/next"])).toMatchObject({
      _tag: "openBranchDiff",
      branchName: "release/next",
    })
  })

  it("returns navigation errors for invalid public syntax", () => {
    expect(parse(["pr", "zero"])).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("positive integer"),
    })
    expect(parse(["diff", "dev", "extra"])).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("Too many arguments"),
    })
  })

  it("keeps legacy packaged launcher arguments working", () => {
    expect(
      parseCliNavigationCommand(["DiffDash", "--diffdash-local-path=project"], "/workspace"),
    ).toMatchObject({ _tag: "openWorkingTree", localPath: "/workspace/project" })
    expect(
      parseCliNavigationCommand(["DiffDash", "--diffdash-link-path", "project"], "/workspace"),
    ).toMatchObject({ _tag: "linkRepository", localPath: "/workspace/project" })
  })

  it("keeps the legacy envelope working when Electron injects and reorders switches", () => {
    expect(
      parseCliNavigationCommand(
        [
          "electron",
          "--diffdash-cli-v1",
          "--allow-file-access-from-files",
          "/workspace/app",
          "/workspace/repo",
          "--",
          "pr",
          "3",
        ],
        "/fallback",
      ),
    ).toMatchObject({ _tag: "openPullRequest", localPath: "/workspace/repo", number: 3 })
  })
})
