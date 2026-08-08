import { EventContract, eventPayloadSchema } from "@diffdash/protocol/ipc"
import type { EventPayload } from "@diffdash/protocol/ipc"
import type { EventChannel } from "@diffdash/protocol/channels"
import { assertJsonPayloadWithinBudget } from "@diffdash/protocol/payload-budget"
import { Schema } from "effect"
import type { WebContents } from "electron"

/** Encodes and best-effort delivers one unsolicited protocol event to a live renderer. */
export const sendProtocolEvent = <Channel extends EventChannel>(
  target: Pick<WebContents, "isDestroyed" | "send">,
  channel: Channel,
  payload: EventPayload<Channel>,
): void => {
  if (target.isDestroyed()) return
  const encoded = Schema.encodeUnknownSync(eventPayloadSchema(channel))(payload)
  assertJsonPayloadWithinBudget(encoded, EventContract[channel].maxPayloadBytes, channel)
  try {
    target.send(channel, encoded)
  } catch {
    // The renderer can disappear after the lifetime check; event delivery is best-effort.
  }
}
