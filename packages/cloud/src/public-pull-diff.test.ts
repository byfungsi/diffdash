import { expect, it } from "vitest"
import { servePublicPullDiff } from "../worker/public-pull-diff"

it("streams a public patch using a fixed GitHub origin and no caller credentials", async () => {
  const response = await servePublicPullDiff(
    new Request("https://cloud.example/api/public-pull-diff/oven-sh/bun/30412", {
      headers: { Authorization: "Bearer secret-fixture", Cookie: "session=secret-fixture" },
    }),
    async (url, init) => {
      expect(url).toBe("https://patch-diff.githubusercontent.com/raw/oven-sh/bun/pull/30412.diff")
      expect(new Headers(init?.headers).has("Authorization")).toBe(false)
      expect(new Headers(init?.headers).has("Cookie")).toBe(false)
      expect(init?.redirect).toBe("manual")
      return new Response("diff --git a/a b/a\n")
    },
  )
  expect(response.status).toBe(200)
  expect(await response.text()).toContain("diff --git")
})

it.each([
  "/api/public-pull-diff/owner/repo/1?url=https://evil.example",
  "/api/public-pull-diff/owner/repo/not-a-pr",
])("rejects invalid proxy input %s before fetching", async (path) => {
  let requests = 0
  const response = await servePublicPullDiff(
    new Request(`https://cloud.example${path}`),
    async () => {
      requests += 1
      return new Response("")
    },
  )
  expect(response.status).toBe(400)
  expect(requests).toBe(0)
})

it("does not expose upstream failure bodies", async () => {
  const response = await servePublicPullDiff(
    new Request("https://cloud.example/api/public-pull-diff/owner/repo/1"),
    async () => new Response("upstream details", { status: 404 }),
  )
  expect(response.status).toBe(404)
  expect(await response.text()).toBe("Public GitHub patch is unavailable")
})

it("rejects upstream redirects instead of following them", async () => {
  const response = await servePublicPullDiff(
    new Request("https://cloud.example/api/public-pull-diff/owner/repo/1"),
    async (_url, init) => {
      expect(init?.redirect).toBe("manual")
      return new Response(null, { status: 302, headers: { Location: "https://untrusted.example" } })
    },
  )
  expect(response.status).toBe(502)
  expect(response.headers.has("Location")).toBe(false)
})
