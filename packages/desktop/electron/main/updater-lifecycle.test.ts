import { AppUpdateIdle } from "@diffdash/protocol/app-update"
import { EventChannel } from "@diffdash/protocol/channels"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import type { DesktopUpdater } from "../../src/main/services/app-updater"
import { startUpdaterLifecycle } from "./updater-lifecycle"

describe("startUpdaterLifecycle", () => {
  it("continues an updater broadcast when renderer delivery is unavailable", async () => {
    const liveSend = vi.fn<(channel: string, payload: unknown) => void>()
    const host = {
      getRendererTargets: () => [
        {
          isDestroyed: () => true,
          send: vi.fn<(channel: string, payload: unknown) => void>(),
        },
        {
          isDestroyed: () => false,
          send: () => {
            throw new Error("Render frame was disposed before WebContents.send")
          },
        },
        { isDestroyed: () => false, send: liveSend },
      ],
    }
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

    startUpdaterLifecycle(updater, host)
    await started

    expect(() => publish?.(AppUpdateIdle.make({ currentVersion: "0.7.0" }))).not.toThrow()
    expect(liveSend).toHaveBeenCalledWith(EventChannel.updateStateChanged, {
      _tag: "idle",
      currentVersion: "0.7.0",
    })
  })
})
