import { describe, expect, it, vi } from "vitest"

import { createShutdown } from "./shutdown"

describe("createShutdown", () => {
  it("disposes once before an ordinary quit", async () => {
    const dispose = vi.fn<() => Promise<void>>(async () => undefined)
    const quit = vi.fn<() => void>()
    const preventDefault = vi.fn<() => void>()
    const lifecycle = createShutdown({ dispose, quit })

    lifecycle.beforeQuit({ preventDefault })
    lifecycle.beforeQuit({ preventDefault })
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })

  it("keeps ordinary quit blocked until the shared disposal completes", async () => {
    const disposal = deferred<void>()
    const dispose = vi.fn<() => Promise<void>>(() => disposal.promise)
    const quit = vi.fn<() => void>()
    const firstPreventDefault = vi.fn<() => void>()
    const secondPreventDefault = vi.fn<() => void>()
    const lifecycle = createShutdown({ dispose, quit })

    lifecycle.beforeQuit({ preventDefault: firstPreventDefault })
    lifecycle.beforeQuit({ preventDefault: secondPreventDefault })
    await Promise.resolve()

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()
    expect(firstPreventDefault).toHaveBeenCalledTimes(1)
    expect(secondPreventDefault).toHaveBeenCalledTimes(1)

    disposal.resolve(undefined)
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
  })

  it("installs only after runtime disposal and allows the updater-managed quit", async () => {
    const order: string[] = []
    const quit = vi.fn<() => void>()
    const lifecycle = createShutdown({
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

  it("keeps update installation blocked until disposal completes", async () => {
    const disposal = deferred<void>()
    const install = vi.fn<() => void>()
    const lifecycle = createShutdown({
      dispose: () => disposal.promise,
      quit: vi.fn<() => void>(),
    })

    const restart = lifecycle.restartAndInstall(install)
    await Promise.resolve()
    expect(install).not.toHaveBeenCalled()

    disposal.resolve(undefined)
    await restart
    expect(install).toHaveBeenCalledTimes(1)
  })

  it("reports disposal failures and still permits an ordinary quit", async () => {
    const failure = new Error("dispose failed")
    const onDisposalError = vi.fn<(cause: unknown) => void>()
    const quit = vi.fn<() => void>()
    const lifecycle = createShutdown({
      dispose: () => Promise.reject(failure),
      quit,
      onDisposalError,
    })

    lifecycle.beforeQuit({ preventDefault: vi.fn<() => void>() })
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))

    expect(onDisposalError).toHaveBeenCalledWith(failure)
  })

  it("bounds a hung disposal before reporting and quitting", async () => {
    const onDisposalError = vi.fn<(cause: unknown) => void>()
    const quit = vi.fn<() => void>()
    const lifecycle = createShutdown({
      dispose: () => new Promise<void>(() => undefined),
      quit,
      disposalTimeoutMs: 5,
      onDisposalError,
    })

    lifecycle.beforeQuit({ preventDefault: vi.fn<() => void>() })
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))

    expect(onDisposalError).toHaveBeenCalledTimes(1)
    expect(onDisposalError.mock.calls[0]?.[0]).toMatchObject({
      message: "Application runtime disposal exceeded 5ms",
    })
  })
})

const deferred = <A>() => {
  let resolvePromise: ((value: A | PromiseLike<A>) => void) | undefined
  const promise = new Promise<A>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value: A | PromiseLike<A>) => resolvePromise?.(value),
  }
}
