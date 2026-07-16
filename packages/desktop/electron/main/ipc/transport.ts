import { eventPayloadSchema } from "@diffdash/protocol/ipc"
import type { EventPayload } from "@diffdash/protocol/ipc"
import type { EventChannel } from "@diffdash/protocol/channels"
import { Schema } from "effect"
import type { IpcMainInvokeEvent, WebContents } from "electron"

/** Returns whether an invoke came from DiffDash's top-level renderer frame. */
export const isTrustedIpcSender = (event: IpcMainInvokeEvent) => {
  const frame = event.senderFrame
  if (
    frame === null ||
    frame !== event.sender.mainFrame ||
    event.sender.isDestroyed() ||
    frame.url !== event.sender.getURL()
  ) {
    return false
  }

  try {
    const frameUrl = new URL(frame.url)
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    if (developmentUrl !== undefined) return frameUrl.origin === new URL(developmentUrl).origin
    return frameUrl.protocol === "file:" && frameUrl.pathname.endsWith("/renderer/index.html")
  } catch {
    return false
  }
}

/** Encodes one protocol event before publishing it to a renderer. */
export const sendProtocolEvent = <Channel extends EventChannel>(
  target: Pick<WebContents, "send">,
  channel: Channel,
  payload: EventPayload<Channel>,
) => {
  const encoded = Schema.encodeUnknownSync(eventPayloadSchema(channel))(payload)
  target.send(channel, encoded)
}
