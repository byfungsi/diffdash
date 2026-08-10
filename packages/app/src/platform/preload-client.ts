import { Context, Layer } from "effect"

import type { DiffDashBridgeApi } from "@diffdash/protocol/api"

/** Internal renderer capability that owns access to the context-bridged preload contract. */
export class PreloadClient extends Context.Service<PreloadClient, DiffDashBridgeApi>()(
  "@diffdash/app/PreloadClient",
) {}

/** Production preload contract, acquired lazily after browser test fixtures install their bridge. */
export const preloadClientLive = Layer.sync(PreloadClient, () => window.diffDash)
