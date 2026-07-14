import { describe, expect, it, vi } from "vitest"

import { createAppLifecycle } from "./app-lifecycle"

describe("createAppLifecycle", () => {
  it("disposes once before an ordinary quit", async () => {
    const dispose = vi.fn<() => Promise<void>>(async () => undefined)
    const quit = vi.fn<() => void>()
    const preventDefault = vi.fn<() => void>()
    const lifecycle = createAppLifecycle({ dispose, quit })

    lifecycle.beforeQuit({ preventDefault })
    lifecycle.beforeQuit({ preventDefault })
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })

  it("installs only after runtime disposal and allows the updater-managed quit", async () => {
    const order: string[] = []
    const quit = vi.fn<() => void>()
    const lifecycle = createAppLifecycle({
      dispose: async () => {
        order.push("dispose")
      },
      quit,
    })

    await lifecycle.restartAndInstall(() => {
      order.push("install")
    })
    const preventDefault = vi.fn<() => void>()
    lifecycle.beforeQuit({ preventDefault })

    expect(order).toEqual(["dispose", "install"])
    expect(preventDefault).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })
})
