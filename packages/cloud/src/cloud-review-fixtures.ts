/** Deterministic GitHub fixture revision before a single-file change. */
export const cloudFixtureBaseSha = "a".repeat(40)
/** Deterministic GitHub fixture revision after a single-file change. */
export const cloudFixtureHeadSha = "b".repeat(40)

const owner = { id: 1, login: "cloud-fixture", avatar_url: "https://example.com/avatar.png" }
const repository = {
  name: "review-fixture",
  full_name: "cloud-fixture/review-fixture",
  html_url: "https://github.com/cloud-fixture/review-fixture",
  description: "Cloud routing fixture",
  private: false,
  updated_at: null,
  owner,
}
const pull = {
  number: 1,
  title: "Cloud route fixture PR",
  body: "A deterministic review.",
  state: "open",
  html_url: "https://github.com/cloud-fixture/review-fixture/pull/1",
  draft: false,
  created_at: null,
  updated_at: null,
  user: owner,
  base: { ref: "main", sha: cloudFixtureBaseSha },
  head: { ref: "feature", sha: cloudFixtureHeadSha },
}
const patch =
  "diff --git a/route.txt b/route.txt\nindex 1234567..7654321 100644\n--- a/route.txt\n+++ b/route.txt\n@@ -1 +1 @@\n-before route\n+after route\n"

/** Fake GitHub HTTP boundary for Cloud's real browser adapter; never calls external services. */
export const cloudFixtureRequest: typeof fetch = async (input, init) => {
  const url = new URL(new Request(input, init).url)
  const path = decodeURIComponent(url.pathname)
  if (path === "/user") return Response.json(owner)
  const prefix = "/repos/cloud-fixture/review-fixture"
  if (path === prefix) return Response.json(repository)
  if (path === `${prefix}/pulls`) return Response.json([pull])
  if (path === "/search/repositories") return Response.json({ items: [repository] })
  if (new Headers(init?.headers).get("Accept") === "application/vnd.github.diff")
    return new Response(patch)
  if (path === `${prefix}/pulls/1`) return Response.json(pull)
  if (path === `${prefix}/pulls/1/files`)
    return Response.json([
      { filename: "route.txt", additions: 1, deletions: 1, status: "modified" },
    ])
  if (path === `${prefix}/pulls/1/commits`) return Response.json([])
  if (path.startsWith(`${prefix}/commits/`)) {
    const sha =
      path.endsWith("/main") || path.endsWith(cloudFixtureBaseSha)
        ? cloudFixtureBaseSha
        : cloudFixtureHeadSha
    return Response.json({ sha, parents: [{ sha: cloudFixtureBaseSha }] })
  }
  if (path.startsWith(`${prefix}/compare/`))
    return Response.json({ merge_base_commit: { sha: cloudFixtureBaseSha } })
  return Response.json({ message: "Not found" }, { status: 404 })
}
