import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { DemoArtifactTransaction } from "../src/artifact-transaction"

describe("DemoArtifactTransaction", () => {
  it("promotes generated files and removes obsolete artifacts", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "diffdash-artifact-transaction-"))
    try {
      await DemoArtifactTransaction.run(root, "story-1", "record", async (transaction) => {
        await writeFile(transaction.outputPath("old.webm"), "old")
        await writeFile(transaction.stagePath("new.webm"), "new")
        await transaction.commit(["new.webm"], { obsolete: (file) => file.endsWith(".webm") })
      })
      await expect(readFile(resolve(root, "story-1/new.webm"), "utf8")).resolves.toBe("new")
      await expect(readFile(resolve(root, "story-1/old.webm"), "utf8")).rejects.toThrow("ENOENT")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("restores replaced and obsolete files when promotion fails", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "diffdash-artifact-transaction-"))
    try {
      await mkdir(resolve(root, "story-1"))
      await writeFile(resolve(root, "story-1/video.mp4"), "old-video")
      await writeFile(resolve(root, "story-1/old.webm"), "old-clip")
      await expect(
        DemoArtifactTransaction.run(root, "story-1", "combine", async (transaction) => {
          await writeFile(transaction.stagePath("video.mp4"), "new-video")
          await transaction.commit(["video.mp4", "missing.json"], {
            obsolete: (file) => file.endsWith(".webm"),
          })
        }),
      ).rejects.toThrow("ENOENT")
      await expect(readFile(resolve(root, "story-1/video.mp4"), "utf8")).resolves.toBe("old-video")
      await expect(readFile(resolve(root, "story-1/old.webm"), "utf8")).resolves.toBe("old-clip")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("attempts every promoted cleanup and backup restore when rollback operations fail", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "diffdash-artifact-transaction-"))
    try {
      await mkdir(resolve(root, "story-1"))
      await writeFile(resolve(root, "story-1/first.webm"), "old-first")
      await writeFile(resolve(root, "story-1/second.webm"), "old-second")
      await writeFile(resolve(root, "story-1/obsolete.webm"), "old-obsolete")

      const failure = await DemoArtifactTransaction.run(
        root,
        "story-1",
        "record",
        async (transaction) => {
          await mkdir(transaction.stagePath("first.webm"))
          await mkdir(transaction.stagePath("second.webm"))
          await transaction.commit(["first.webm", "second.webm", "missing.webm"], {
            obsolete: (file) => file === "obsolete.webm",
          })
        },
      ).then(
        () => null,
        (error: unknown) => error,
      )

      expect(failure).toBeInstanceOf(AggregateError)
      if (!(failure instanceof AggregateError))
        throw new Error("Expected aggregate rollback failure")
      expect(failure.errors).toHaveLength(5)
      expect(failure.cause).toBe(failure.errors[0])
      await expect(readFile(resolve(root, "story-1/obsolete.webm"), "utf8")).resolves.toBe(
        "old-obsolete",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
