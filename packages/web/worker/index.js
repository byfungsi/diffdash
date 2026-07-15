const securityHeaders = {
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.protocol === "http:") {
      url.protocol = "https:"
      return Response.redirect(url.toString(), 301)
    }

    if (url.hostname === "www.usediffdash.com") {
      url.hostname = "usediffdash.com"
      return Response.redirect(url.toString(), 301)
    }

    const response = await env.ASSETS.fetch(request)
    const headers = new Headers(response.headers)

    for (const [name, value] of Object.entries(securityHeaders)) {
      headers.set(name, value)
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  },
}
