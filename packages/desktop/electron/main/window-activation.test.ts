import { describe, expect, it, vi } from "vitest"

import { revealAppWindow, type ActivatableWindow } from "./window-activation"

const makeWindow = (minimized: boolean): ActivatableWindow => ({
  isMinimized: vi.fn<() => boolean>(() => minimized),
  restore: vi.fn<() => void>(),
  show: vi.fn<() => void>(),
  focus: vi.fn<() => void>(),
})

describe("revealAppWindow", () => {
  it("restores a minimized window before showing and focusing it", () => {
    const targetWindow = makeWindow(true)
    const focusApplication = vi.fn<() => void>()

    revealAppWindow(targetWindow, { hidden: false, platform: "linux", focusApplication })

    expect(targetWindow.restore).toHaveBeenCalledTimes(1)
    expect(targetWindow.show).toHaveBeenCalledTimes(1)
    expect(targetWindow.focus).toHaveBeenCalledTimes(1)
    expect(focusApplication).not.toHaveBeenCalled()
    expect(vi.mocked(targetWindow.restore).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(targetWindow.show).mock.invocationCallOrder[0] ?? 0,
    )
  })

  it("uses application focus on macOS without focusing the window directly", () => {
    const targetWindow = makeWindow(false)
    const focusApplication = vi.fn<() => void>()

    revealAppWindow(targetWindow, { hidden: false, platform: "darwin", focusApplication })

    expect(targetWindow.restore).not.toHaveBeenCalled()
    expect(targetWindow.show).toHaveBeenCalledTimes(1)
    expect(focusApplication).toHaveBeenCalledTimes(1)
    expect(targetWindow.focus).not.toHaveBeenCalled()
  })

  it("does not reveal or focus windows in hidden E2E mode", () => {
    const targetWindow = makeWindow(true)
    const focusApplication = vi.fn<() => void>()

    revealAppWindow(targetWindow, { hidden: true, platform: "darwin", focusApplication })

    expect(targetWindow.isMinimized).not.toHaveBeenCalled()
    expect(targetWindow.restore).not.toHaveBeenCalled()
    expect(targetWindow.show).not.toHaveBeenCalled()
    expect(targetWindow.focus).not.toHaveBeenCalled()
    expect(focusApplication).not.toHaveBeenCalled()
  })
})
