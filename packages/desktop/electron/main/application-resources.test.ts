import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { disposeApplicationResources } from "./application-resources"

describe("disposeApplicationResources", () => {
  it("disposes Core when updater cleanup fails", async () => {
    const updaterFailure = new Error("updater cleanup failed")
    const disposeCore = vi.fn<() => Promise<void>>(async () => undefined)
    const updater = { dispose: () => Effect.die(updaterFailure) }
    const runtime = { dispose: disposeCore }

    await expect(disposeApplicationResources(updater, runtime)).rejects.toThrow(
      "updater cleanup failed",
    )
    expect(disposeCore).toHaveBeenCalledOnce()
  })

  it("reports both cleanup failures after attempting both", async () => {
    const updaterFailure = new Error("updater cleanup failed")
    const coreFailure = new Error("core cleanup failed")
    const updater = { dispose: () => Effect.die(updaterFailure) }
    const runtime = { dispose: async () => Promise.reject(coreFailure) }

    const failure = await disposeApplicationResources(updater, runtime).catch(
      (cause: unknown) => cause,
    )
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate cleanup error")
    expect(
      failure.errors.map((cause) => (cause instanceof Error ? cause.message : String(cause))),
    ).toEqual(["updater cleanup failed", "core cleanup failed"])
  })
})
