const publicPullDiffPath =
  /^\/api\/public-pull-diff\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\/([1-9][0-9]*)$/

/** Streams a public GitHub PR patch from a fixed origin without forwarding browser credentials. */
export async function servePublicPullDiff(
  request: Request,
  send: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url)
  const match = publicPullDiffPath.exec(url.pathname)
  const [, owner, repository, number] = match ?? []
  if (
    owner === undefined ||
    repository === undefined ||
    number === undefined ||
    repository === "." ||
    repository === ".." ||
    url.search !== ""
  ) {
    return new Response("Invalid public pull-request path", { status: 400 })
  }
  if (request.method !== "GET")
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } })
  try {
    const upstream = await send(
      `https://patch-diff.githubusercontent.com/raw/${owner}/${repository}/pull/${number}.diff`,
      {
        method: "GET",
        headers: { Accept: "text/plain" },
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      },
    )
    if (!upstream.ok) {
      await upstream.body?.cancel()
      return new Response("Public GitHub patch is unavailable", {
        status: upstream.status === 404 ? 404 : 502,
      })
    }
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch {
    return new Response("Public GitHub patch could not be loaded", { status: 502 })
  }
}
