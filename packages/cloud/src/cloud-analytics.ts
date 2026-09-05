import type { AnalyticsEvent } from "@diffdash/protocol/analytics"

/** Closed, content-free events accepted by web analytics. */
export type CloudAnalyticsEvent =
  | {
      readonly event:
        | "cloud_opened"
        | "github_connected"
        | "github_connection_failed"
        | "github_disconnected"
        | "note_created"
        | "notes_cleared"
        | "note_deleted"
    }
  | {
      readonly event: "review_opened"
      readonly reviewType: "local_diff" | "pull_request" | "repository_comparison"
    }

/** Explicit PostHog transport dependencies; no DOM, credentials, or route data enter the payload. */
export interface CloudAnalyticsOptions {
  readonly projectKey: string
  readonly host: string
  readonly distinctId: () => string
  readonly request: typeof fetch
}

/** Creates best-effort anonymous telemetry with an explicit property allowlist. */
export function createCloudAnalytics(options: CloudAnalyticsOptions) {
  return async (event: CloudAnalyticsEvent): Promise<void> => {
    if (
      !options.projectKey ||
      !["https://us.i.posthog.com", "https://eu.i.posthog.com"].includes(options.host)
    )
      return
    try {
      const properties =
        event.event === "review_opened"
          ? {
              app: "cloud",
              distinct_id: options.distinctId(),
              $process_person_profile: false,
              $geoip_disable: true,
              reviewType: event.reviewType,
            }
          : {
              app: "cloud",
              distinct_id: options.distinctId(),
              $process_person_profile: false,
              $geoip_disable: true,
            }
      const request = options.request
      await request(`${options.host}/capture/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: options.projectKey, event: event.event, properties }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        keepalive: true,
      })
    } catch {
      // Analytics failures must never interrupt authentication or review work.
    }
  }
}

const idKey = "diffdash.cloud.analytics-id"
let memoryId: string | undefined
const anonymousId = (): string => {
  memoryId ??= crypto.randomUUID()
  try {
    const existing = localStorage.getItem(idKey)
    if (existing !== null && /^[0-9a-f-]{36}$/i.test(existing)) return existing
    localStorage.setItem(idKey, memoryId)
  } catch {
    // Restricted browser storage falls back to a page-lifetime anonymous identity.
  }
  return memoryId
}

/** Sends only explicitly selected events when the public PostHog build configuration is present. */
export const captureCloudEvent = createCloudAnalytics({
  projectKey: String(import.meta.env.VITE_POSTHOG_KEY ?? "").trim(),
  host: String(import.meta.env.VITE_POSTHOG_HOST ?? "")
    .trim()
    .replace(/\/+$/, ""),
  distinctId: anonymousId,
  request: (...args) => fetch(...args),
})

/** Projects shared renderer analytics into the small web-specific allowlist. */
export function captureCloudRendererEvent(event: AnalyticsEvent): void {
  if (event.event === "review_opened") {
    void captureCloudEvent({ event: "review_opened", reviewType: event.reviewType })
  }
}

/** Unlinks subsequent usage when a GitHub session is disconnected. */
export function resetCloudAnalytics(): void {
  memoryId = undefined
  try {
    localStorage.removeItem(idKey)
  } catch {
    /* Storage may be unavailable. */
  }
}
