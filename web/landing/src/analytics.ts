export type DownloadPlatform = "macos" | "linux"
export type DownloadPlacement = "hero" | "footer"

const distinctIdStorageKey = "diffdash.posthog.distinct_id"
const posthogKey = (import.meta.env.VITE_POSTHOG_KEY as string | undefined)?.trim()
const posthogHost = (import.meta.env.VITE_POSTHOG_HOST as string | undefined)
  ?.trim()
  .replace(/\/+$/, "")

/** Returns whether PostHog has enough configuration to send events. */
export function isAnalyticsEnabled() {
  return Boolean(posthogKey && posthogHost)
}

/** Initializes PostHog for the landing page when env vars are configured. */
export function initAnalytics() {
  captureEvent("$pageview", getPageProperties())
}

/** Tracks navigation anchor link clicks to understand which sections users explore. */
export function captureNavClick(section: string) {
  captureEvent("nav_link_clicked", {
    section,
    ...getPageProperties(),
  })
}

/** Tracks explicit download CTA clicks before the browser leaves the landing page. */
export function captureDownloadClick(
  platform: DownloadPlatform,
  placement: DownloadPlacement,
  href: string,
) {
  captureEvent("download_button_clicked", {
    platform,
    placement,
    href,
    ...getPageProperties(),
  })
}

function captureEvent(event: string, properties: Record<string, string>) {
  if (!posthogKey || !posthogHost) {
    return
  }

  const body = JSON.stringify({
    api_key: posthogKey,
    event,
    properties: {
      distinct_id: getDistinctId(),
      $current_url: window.location.href,
      $host: window.location.host,
      ...properties,
    },
  })

  const endpoint = `${posthogHost}/capture/`
  const blob = new Blob([body], { type: "application/json" })

  if (navigator.sendBeacon(endpoint, blob)) {
    return
  }

  void fetch(endpoint, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
    keepalive: true,
  }).catch(() => undefined)
}

function getDistinctId() {
  try {
    const existingId = window.localStorage.getItem(distinctIdStorageKey)

    if (existingId) {
      return existingId
    }

    const nextId = window.crypto.randomUUID()
    window.localStorage.setItem(distinctIdStorageKey, nextId)
    return nextId
  } catch {
    return window.crypto.randomUUID()
  }
}

function getPageProperties() {
  return {
    path: window.location.pathname,
    url: window.location.href,
    title: document.title,
  }
}
