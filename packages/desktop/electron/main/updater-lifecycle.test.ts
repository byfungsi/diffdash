import { AppUpdateIdle } from "@diffdash/protocol/app-update"
import { EventChannel } from "@diffdash/protocol/channels"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopUpdater } from "../../src/main/services/app-updater"
import { startUpdaterLifecycle } from "./updater-lifecycle"

type RendererTarget = {
  readonly isDestroyed: () => boolean
  readonly send: (channel: string, payload: unknown) => void
}

const electronHostMocks = vi.hoisted(() => ({
  getAllWindows: vi.fn<() => ReadonlyArray<{ readonly webContents: RendererTarget }>>(),
}))

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: electronHostMocks.getAllWindows },
}))

afterEach(() => vi.unstubAllEnvs())

describe("startUpdaterLifecycle", () => {
  it("continues an updater broadcast when renderer delivery is unavailable", async () => {
    vi.stubEnv("DIFFDASH_E2E_DISABLE_UPDATES", "0")
    const liveSend = vi.fn<(channel: string, payload: unknown) => void>()
    electronHostMocks.getAllWindows.mockReturnValue([
      {
        webContents: {
          isDestroyed: () => true,
          send: vi.fn<(channel: string, payload: unknown) => void>(),
        },
      },
      {
        webContents: {
          isDestroyed: () => false,
          send: () => {
            throw new Error("Render frame was disposed before WebContents.send")
          },
        },
      },
      { webContents: { isDestroyed: () => false, send: liveSend } },
    ])
    let publish: ((state: AppUpdateIdle) => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const updater: DesktopUpdater = {
      getState: () => Effect.succeed(AppUpdateIdle.make({ currentVersion: "0.7.0" })),
      check: () => Effect.void,
      download: () => Effect.void,
      quitAndInstall: () => Effect.void,
      startAutomaticChecks: () => Effect.sync(() => markStarted?.()),
      subscribe: (listener) =>
        Effect.sync(() => {
          publish = listener
          return () => undefined
        }),
      dispose: () => Effect.void,
    }

    startUpdaterLifecycle(updater)
    await started

    expect(() => publish?.(AppUpdateIdle.make({ currentVersion: "0.7.0" }))).not.toThrow()
    expect(liveSend).toHaveBeenCalledWith(EventChannel.updateStateChanged, {
      _tag: "idle",
      currentVersion: "0.7.0",
    })
  })
})
