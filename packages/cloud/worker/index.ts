import { servePublicPullDiff } from "./public-pull-diff"

interface CloudAssets {
  fetch(request: Request): Promise<Response>
}

interface CloudEnvironment {
  readonly ASSETS: CloudAssets
}

const securityHeaders = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self' https://api.github.com https://us.i.posthog.com https://eu.i.posthog.com",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: https://avatars.githubusercontent.com https://*.githubusercontent.com",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
  ].join("; "),
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
} as const

export default {
  async fetch(request: Request, environment: CloudEnvironment): Promise<Response> {
    const url = new URL(request.url)
    if (url.protocol === "http:") {
      url.protocol = "https:"
      return Response.redirect(url.href, 301)
    }

    const response = url.pathname.startsWith("/api/public-pull-diff/")
      ? await servePublicPullDiff(request)
      : await environment.ASSETS.fetch(request)
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  },
}
