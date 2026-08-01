import { describe, expect, it } from "vitest"

import type { DemoCliOperations } from "../src/orchestration"
import { runDemoCli } from "../src/orchestration"

const handlers = (calls: string[]): DemoCliOperations => ({
  record: async (storyId) => {
    calls.push(`record:${storyId}`)
  },
  combine: async (storyId) => {
    calls.push(`combine:${storyId}`)
  },
  verify: async (storyId) => {
    calls.push(`verify:${storyId}`)
  },
  dashboard: async () => {
    calls.push("dashboard")
  },
})

describe("demo CLI orchestration", () => {
  it("forwards one explicit story ID to recording and combination", async () => {
    const calls: string[] = []

    await runDemoCli(["video", "--", "diffdash-0.4.3"], handlers(calls))

    expect(calls).toEqual(["record:diffdash-0.4.3", "combine:diffdash-0.4.3"])
  })

  it("requires exactly one safe story ID for artifact commands", async () => {
    const operations = handlers([])

    await expect(runDemoCli(["record"], operations)).rejects.toThrow("exactly one story ID")
    await expect(runDemoCli(["verify", "story", "extra"], operations)).rejects.toThrow(
      "exactly one story ID",
    )
    await expect(runDemoCli(["combine", "../escape"], operations)).rejects.toThrow(
      "story ID must contain",
    )
  })
})
