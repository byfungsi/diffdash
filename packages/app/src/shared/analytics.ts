/** Captures a renderer analytics event without allowing telemetry failures to affect the UI. */
export const captureAnalytics = (
  event: Parameters<typeof window.diffDash.analytics.capture>[0],
) => {
  void window.diffDash.analytics.capture(event).catch(() => undefined)
}
