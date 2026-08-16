import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { ResourceDiagnostics } from "./resource-diagnostics"

describe("resource diagnostics", () => {
  it("accepts only bounded aggregate classes and strips private source fields", () => {
    const decoded = Schema.decodeUnknownSync(ResourceDiagnostics)({
      bytes: 42,
      reservedBytes: 8,
      resources: 1,
      activeLeases: 1,
      failures: 0,
      repositoryName: "private-repository",
      classes: [
        {
          resourceClass: "localWorktreePool",
          bytes: 42,
          reservedBytes: 8,
          resources: 1,
          activeLeases: 1,
          failures: 0,
          path: "/private/repository/worktree",
          states: {
            writing: 0,
            ready: 1,
            collecting: 0,
            quarantined: 0,
            deletionFailed: 0,
            deleted: 0,
          },
        },
      ],
    })

    const serialized = JSON.stringify(decoded)
    expect(serialized).not.toContain("private-repository")
    expect(serialized).not.toContain("/private/repository/worktree")
    expect(() =>
      Schema.decodeUnknownSync(ResourceDiagnostics)({
        ...decoded,
        classes: [{ ...decoded.classes[0], resourceClass: "repository:private" }],
      }),
    ).toThrow("Expected resourceClass")
  })
})
