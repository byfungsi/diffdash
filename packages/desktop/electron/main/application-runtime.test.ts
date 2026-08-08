import { CoreLifecycleError } from "@diffdash/core"
import { describe, expect, it } from "vitest"
import { unwrapCoreResult } from "./application-runtime"

describe("unwrapCoreResult", () => {
  it("returns successful Core values without changing their identity", () => {
    const value = { onboardingCompleted: false }

    expect(unwrapCoreResult({ ok: true, value })).toBe(value)
  })

  it("throws the exact typed Core failure for the IPC error adapter", () => {
    const failure = CoreLifecycleError.make({
      state: "notStarted",
      message: "DiffDash Core is not started.",
    })

    expect(() => unwrapCoreResult({ ok: false, error: failure })).toThrow(failure)
  })
})
