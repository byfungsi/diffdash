import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { readFileSync } from "node:fs"

import { CoreDefectSummary } from "../core-contract"
import { summarizeCoreDefect } from "./walkthrough-operations"

describe("Durable walkthrough operation architecture", () => {
  it("keeps terminal history out of Core memory", () => {
    const source = readFileSync(new URL("./walkthrough-operations.ts", import.meta.url), "utf8")

    expect(source).toContain("FiberMap.make<")
    expect(source).not.toContain("Deferred")
    expect(source).not.toContain("MAX_RETAINED_WALKTHROUGH_OPERATIONS")
    expect(source).not.toContain("WalkthroughOperationCapacityExceeded")
    expect(source).not.toContain("new Map<WalkthroughOperationIdType")
  })

  it("summarizes defects into bounded serializable terminal data", () => {
    const summary = summarizeCoreDefect({
      _tag: "WalkthroughWorkerDefect",
      name: "WorkerFailure",
      message: "x".repeat(300),
    })

    expect(summary).toEqual({
      tag: "WalkthroughWorkerDefect",
      name: "WorkerFailure",
      message: "x".repeat(256),
    })
    expect(
      Schema.decodeUnknownSync(CoreDefectSummary)(
        JSON.parse(JSON.stringify(Schema.encodeSync(CoreDefectSummary)(summary))),
      ),
    ).toEqual(summary)
  })
})
