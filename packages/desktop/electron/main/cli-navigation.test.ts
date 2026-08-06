import { describe, expect, it, vi } from "@effect/vitest"
import {
  OpenBranchDiffCommand,
  RepairRepositoryIdentitiesCommand,
} from "@diffdash/protocol/cli-navigation"

import { hasRepositoryIdentityRepairCommand, parseCliNavigationCommand } from "./cli-navigation"

const parse = (args: readonly string[]) =>
  parseCliNavigationCommand(
    ["electron", "app", "--diffdash-cli-v1=/workspace/repo", "--", ...args],
    "/fallback",
  )

describe("parseCliNavigationCommand", () => {
  it("parses project, repository, PR, branch, comparison, and repair commands", () => {
    expect(parse([])).toMatchObject({ _tag: "openProject", localPath: "/workspace/repo" })
    expect(parse(["src"])).toMatchObject({
      _tag: "openProject",
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
    expect(parse(["compare", "v6.0", "v6.1", "--repository=torvalds/linux"])).toMatchObject({
      _tag: "openRepositoryComparison",
      localPath: "/workspace/repo",
      baseRef: "v6.0",
      headRef: "v6.1",
      repository: {
        providerId: null,
        namespace: "torvalds",
        name: "linux",
      },
    })
    expect(parse(["compare", "v6.0", "v6.1"])).toMatchObject({
      _tag: "openRepositoryComparison",
      localPath: "/workspace/repo",
      repository: null,
      baseRef: "v6.0",
      headRef: "v6.1",
    })
    expect(
      parse([
        "compare",
        "--repository",
        "github:engineering/platform/diffdash",
        "release/1",
        "0123456789012345678901234567890123456789",
      ]),
    ).toMatchObject({
      _tag: "openRepositoryComparison",
      baseRef: "release/1",
      headRef: "0123456789012345678901234567890123456789",
      repository: {
        providerId: "github",
        namespace: "engineering/platform",
        name: "diffdash",
      },
    })
    expect(parse(["repair"])).toMatchObject({ _tag: "repairRepositoryIdentities" })
    expect(hasRepositoryIdentityRepairCommand([RepairRepositoryIdentitiesCommand.make({})])).toBe(
      true,
    )
    expect(
      hasRepositoryIdentityRepairCommand([
        OpenBranchDiffCommand.make({ localPath: "/workspace/repo", branchName: null }),
      ]),
    ).toBe(false)
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
    expect(parse(["repair", "extra"])).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("Too many arguments"),
    })
    expect(parse(["--unknown"])).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("Unrecognized option"),
    })
    expect(parse(["--version"])).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("Unrecognized option"),
    })
  })

  it.each([
    {
      args: ["compare", "v6.0", "v6.1", "--repository"],
      message: "requires a value",
    },
    {
      args: ["compare", "v6.0", "--repository=torvalds/linux"],
      message: "Missing argument <head>",
    },
    {
      args: [
        "compare",
        "v6.0",
        "v6.1",
        "--repository=torvalds/linux",
        "--repository=github:torvalds/linux",
      ],
      message: "may only be specified once",
    },
    {
      args: ["compare", "v6.0", "v6.1", "--repo=torvalds/linux"],
      message: "Unrecognized option",
    },
    {
      args: ["compare", "v6.0", "v6.1", "--repository=torvalds"],
      message: "Repository must be",
    },
    {
      args: ["compare", "v6..0", "v6.1", "--repository=torvalds/linux"],
      message: "Invalid base revision",
    },
    {
      args: ["compare", "v6.0", "feature~1", "--repository=torvalds/linux"],
      message: "Invalid head revision",
    },
    {
      args: ["compare", "v6.0", "v6.1", "extra", "--repository=torvalds/linux"],
      message: "unexpected comparison argument",
    },
  ])("returns a navigation error for invalid comparison syntax", ({ args, message }) => {
    expect(parse(args)).toMatchObject({ _tag: "error", message: expect.stringContaining(message) })
  })

  it("handles built-in help without enqueueing a navigation command", () => {
    expect(parse(["--help"])).toBeNull()
    expect(parse(["compare", "--help"])).toBeNull()
  })

  it("captures parser diagnostics instead of writing them from the Electron process", () => {
    const writeError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      expect(parse(["pr", "zero"])).toMatchObject({ _tag: "error" })
      expect(writeError).not.toHaveBeenCalled()
    } finally {
      writeError.mockRestore()
    }
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
