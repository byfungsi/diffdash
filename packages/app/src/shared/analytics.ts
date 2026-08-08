import { Effect } from "effect"

import type { AnalyticsEvent } from "@diffdash/protocol/analytics"
import { useDesktopRuntime } from "@/platform/renderer-runtime"

/** Returns best-effort renderer analytics backed by the shared desktop capability. */
export const useCaptureAnalytics = () => {
  const desktop = useDesktopRuntime()
  return (event: AnalyticsEvent): void => {
    Effect.runFork(desktop.analytics.capture(event).pipe(Effect.catchAll(() => Effect.void)))
  }
}
