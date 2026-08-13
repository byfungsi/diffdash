import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { assertDemoSlug, resolveContainedPath } from "../src/paths"

describe("demo path safety", () => {
  it("accepts conservative story and clip slugs", () => {
    expect(assertDemoSlug("diffdash-0.4.3", "story ID")).toBe("diffdash-0.4.3")
    expect(assertDemoSlug("7-local-review", "clip ID")).toBe("7-local-review")
  })

  it.each([
    "",
    "../story",
    "/tmp/story",
    "Story",
    "story_name",
    "story--name",
    "story..name",
  ])("rejects unsafe slug %j", (value) => {
    expect(() => assertDemoSlug(value, "story ID")).toThrow("story ID must contain")
  })

  it("rejects resolved paths outside the output root", () => {
    const root = resolve("/tmp", "diffdash-output")

    expect(resolveContainedPath(root, "story", "clip.webm")).toBe(
      resolve(root, "story", "clip.webm"),
    )
    expect(() => resolveContainedPath(root, "..", "outside.webm")).toThrow("escapes")
    expect(() => resolveContainedPath(root, "/tmp/outside.webm")).toThrow("escapes")
  })
})
