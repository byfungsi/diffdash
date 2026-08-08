import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

describe("Durable walkthrough operation architecture", () => {
  it("keeps terminal history out of Core memory", () => {
    const source = readFileSync(new URL("./walkthrough-operations.ts", import.meta.url), "utf8")

    expect(source).toContain("FiberMap.make<")
    expect(source).not.toContain("Deferred")
    expect(source).not.toContain("MAX_RETAINED_WALKTHROUGH_OPERATIONS")
    expect(source).not.toContain("WalkthroughOperationCapacityExceeded")
    expect(source).not.toContain("new Map<WalkthroughOperationIdType")
  })
})
