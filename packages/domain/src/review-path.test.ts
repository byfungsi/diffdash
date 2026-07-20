import { describe, expect, it } from "@effect/vitest"

import { reviewPathBasename, reviewPathDirectory } from "./review-path"

describe("review paths", () => {
  it("reads POSIX/Git basenames without Node path semantics", () => {
    expect(reviewPathBasename("src/review/file.ts")).toBe("file.ts")
    expect(reviewPathBasename("pnpm-lock.yaml")).toBe("pnpm-lock.yaml")
    expect(reviewPathBasename("src/review/")).toBe("review")
  })

  it("returns null only for root-level review paths", () => {
    expect(reviewPathDirectory("src/review/file.ts")).toBe("src/review")
    expect(reviewPathDirectory("pnpm-lock.yaml")).toBeNull()
    expect(reviewPathDirectory("src/")).toBe("src")
  })
})
