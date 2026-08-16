import type { CoreEventHint } from "@diffdash/core-rpc/event"

const deliveryMode = process.env.DIFFDASH_E2E_TERMINAL_HINT_DELIVERY
delete process.env.DIFFDASH_E2E_TERMINAL_HINT_DELIVERY

if (deliveryMode !== undefined && deliveryMode !== "drop" && deliveryMode !== "duplicate") {
  throw new Error("DIFFDASH_E2E_TERMINAL_HINT_DELIVERY must be drop or duplicate")
}

/** E2E-only deterministic terminal-hint delivery fault. */
export const e2eCoreEventDeliveryTransform = (
  hint: CoreEventHint,
): ReadonlyArray<CoreEventHint> => {
  if (hint.kind !== "operationTerminal") return [hint]
  if (deliveryMode === "drop") return []
  if (deliveryMode === "duplicate") return [hint, hint]
  return [hint]
}
