import { EventContract, eventPayloadSchema } from "@diffdash/protocol/ipc"
import type { EventPayload } from "@diffdash/protocol/ipc"
import type { EventChannel } from "@diffdash/protocol/channels"
import { assertJsonPayloadWithinBudget } from "@diffdash/protocol/payload-budget"
import { Schema } from "effect"
import type { WebContents } from "electron"

/** Encodes one protocol event before publishing it to a renderer. */
export const sendProtocolEvent = <Channel extends EventChannel>(
  target: Pick<WebContents, "send">,
  channel: Channel,
  payload: EventPayload<Channel>,
) => {
  const encoded = Schema.encodeUnknownSync(eventPayloadSchema(channel))(payload)
  assertJsonPayloadWithinBudget(encoded, EventContract[channel].maxPayloadBytes, channel)
  target.send(channel, encoded)
}
