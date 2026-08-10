import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { RepositoryRelativePath } from "./repository-path"

describe("RepositoryRelativePath", () => {
  it("accepts repository-relative POSIX and Git paths", () => {
    expect(Schema.decodeUnknownSync(RepositoryRelativePath)("src/app.ts")).toBe("src/app.ts")
    expect(Schema.decodeUnknownSync(RepositoryRelativePath)("README.md")).toBe("README.md")
  })

  it("rejects absolute paths and parent traversal on every platform", () => {
    for (const path of [
      "",
      "/etc/passwd",
      "\\Windows\\system.ini",
      "C:secret.txt",
      "C:\\Windows\\system.ini",
      "\\\\server\\share\\secret.txt",
      "../secret.txt",
      "src/../../secret.txt",
      "src\\..\\secret.txt",
    ]) {
      expect(() => Schema.decodeUnknownSync(RepositoryRelativePath)(path)).toThrow(
        /repository-relative path/,
      )
    }
  })
})
