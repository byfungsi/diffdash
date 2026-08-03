import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { assertDemoSlug, replaceGeneratedFiles, resolveContainedPath } from "../src/paths"

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

  it("rolls back all promoted files when a replacement fails", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "diffdash-promotion-"))
    const firstDestination = resolve(directory, "first.webm")
    const secondDestination = resolve(directory, "second.json")
    const firstSource = resolve(directory, "new-first.webm")
    await Promise.all([
      writeFile(firstDestination, "old-first"),
      writeFile(secondDestination, "old-second"),
      writeFile(firstSource, "new-first"),
    ])
    try {
      await expect(
        replaceGeneratedFiles(
          [
            { source: firstSource, destination: firstDestination },
            { source: resolve(directory, "missing.json"), destination: secondDestination },
          ],
          directory,
        ),
      ).rejects.toThrow("ENOENT")
      await expect(readFile(firstDestination, "utf8")).resolves.toBe("old-first")
      await expect(readFile(secondDestination, "utf8")).resolves.toBe("old-second")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
