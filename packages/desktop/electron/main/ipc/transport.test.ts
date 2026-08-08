import { AppUpdateFailed, AppUpdateIdle } from "@diffdash/protocol/app-update"
import { EventChannel } from "@diffdash/protocol/channels"
import { describe, expect, it, vi } from "vitest"
import { sendProtocolEvent } from "./transport"

describe("sendProtocolEvent", () => {
  it("does not send an unsolicited event to a destroyed renderer", () => {
    const send = vi.fn<(channel: string, payload: unknown) => void>()
    const target = { isDestroyed: () => true, send }

    expect(() =>
      sendProtocolEvent(
        target,
        EventChannel.updateStateChanged,
        AppUpdateIdle.make({ currentVersion: "0.7.0" }),
      ),
    ).not.toThrow()
    expect(send).not.toHaveBeenCalled()
  })

  it("isolates a renderer destroyed between the lifetime check and send", () => {
    const deliveryError = new Error("Render frame was disposed before WebContents.send")
    const target = {
      isDestroyed: () => false,
      send: () => {
        throw deliveryError
      },
    }

    expect(() =>
      sendProtocolEvent(
        target,
        EventChannel.updateStateChanged,
        AppUpdateIdle.make({ currentVersion: "0.7.0" }),
      ),
    ).not.toThrow()
  })

  it("preserves protocol validation failures before delivery", () => {
    const send = vi.fn<(channel: string, payload: unknown) => void>()

    expect(() =>
      sendProtocolEvent(
        { isDestroyed: () => false, send },
        EventChannel.updateStateChanged,
        AppUpdateFailed.make({ currentVersion: "0.7.0", message: "x".repeat(300_000) }),
      ),
    ).toThrowError(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }))
    expect(send).not.toHaveBeenCalled()
  })
})
