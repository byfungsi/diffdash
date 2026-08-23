import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { runRendererPromise } from "./renderer-effect"

describe("runRendererPromise", () => {
  it("interrupts the underlying renderer Effect when its AbortSignal is cancelled", async () => {
    const controller = new AbortController()
    let interrupted = false
    const running = runRendererPromise(
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true
          }),
        ),
      ),
      controller.signal,
    )

    controller.abort()

    await expect(running).rejects.toBeDefined()
    expect(interrupted).toBe(true)
  })
})
