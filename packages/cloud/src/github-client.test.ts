// @vitest-environment node
import { expect, it } from "vitest"

import { GithubClient } from "./github-client"
import { parseGithubPersonalAccessToken } from "./github-credentials"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import {
  cloudFixtureBaseSha,
  cloudFixtureHeadSha,
  cloudFixtureRequest,
} from "./cloud-review-fixtures"

const request: typeof fetch = async function (this: void, input, init) {
  // Browser fetch rejects a GithubClient receiver before sending a network request.
  if (this !== undefined) throw new TypeError("Illegal invocation")
  expect(input).toBe("https://api.github.com/user")
  expect(new Headers(init?.headers).get("Authorization")).toBe(
    "Bearer github_pat_test_fixture_only",
  )
  return Response.json({ login: "cloud-test", avatar_url: "https://example.com/avatar.png" })
}

it("loads a public patch without credentials when the REST diff exceeds GitHub's file limit", async () => {
  const calls: string[] = []
  const client = new GithubClient(
    parseGithubPersonalAccessToken("github_pat_test_fixture_only"),
    async (input, init) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      calls.push(path)
      if (path === "https://api.github.com/repos/oven-sh/bun")
        return Response.json({
          name: "bun",
          full_name: "oven-sh/bun",
          html_url: "https://github.com/oven-sh/bun",
          description: null,
          private: false,
          updated_at: null,
          owner: { id: 1, login: "oven-sh", avatar_url: "https://example.com/avatar.png" },
        })
      if (path.startsWith("https://api.github.com/")) return new Response("", { status: 406 })
      expect(path).toBe("/api/public-pull-diff/oven-sh/bun/30412")
      expect(new Headers(init?.headers).has("Authorization")).toBe(false)
      expect(init?.credentials).toBe("omit")
      return new Response("diff --git a/example.ts b/example.ts\n")
    },
  )
  await expect(client.getPullRequestDiff("oven-sh", "bun", 30412)).resolves.toContain("diff --git")
  expect(calls).toHaveLength(3)
})

it("authenticates without binding fetch to the GitHub client", async () => {
  const client = new GithubClient(
    parseGithubPersonalAccessToken("github_pat_test_fixture_only"),
    request,
  )

  await expect(client.getViewer()).resolves.toMatchObject({ login: "cloud-test" })
})

it("pins comparison diff requests to resolved revisions", async () => {
  const paths: string[] = []
  const client = new GithubClient(
    parseGithubPersonalAccessToken("github_pat_test_fixture_only"),
    (input, init) => {
      paths.push(new Request(input, init).url)
      return cloudFixtureRequest(input, init)
    },
  )
  const target = await client.resolveComparison(
    "cloud-fixture",
    "review-fixture",
    RepositoryComparisonRef.make("main"),
    RepositoryComparisonRef.make("feature"),
  )
  expect(target).toMatchObject({
    baseSha: cloudFixtureBaseSha,
    headSha: cloudFixtureHeadSha,
    mergeBaseSha: cloudFixtureBaseSha,
  })
  await expect(client.getComparisonDiff(target)).resolves.toContain("+after route")
  expect(paths.at(-1)).toBe(
    `https://api.github.com/repos/cloud-fixture/review-fixture/compare/${cloudFixtureBaseSha}...${cloudFixtureHeadSha}`,
  )
})

it("uses the first parent for a commit review", async () => {
  const client = new GithubClient(
    parseGithubPersonalAccessToken("github_pat_test_fixture_only"),
    cloudFixtureRequest,
  )
  await expect(
    client.resolveCommit(
      "cloud-fixture",
      "review-fixture",
      RepositoryComparisonRef.make(cloudFixtureHeadSha),
    ),
  ).resolves.toMatchObject({
    baseSha: cloudFixtureBaseSha,
    headSha: cloudFixtureHeadSha,
    mergeBaseSha: cloudFixtureBaseSha,
  })
})

it("reports a root commit instead of inventing a comparison base", async () => {
  const client = new GithubClient(
    parseGithubPersonalAccessToken("github_pat_test_fixture_only"),
    async () => Response.json({ sha: cloudFixtureHeadSha, parents: [] }),
  )
  await expect(
    client.resolveCommit(
      "cloud-fixture",
      "review-fixture",
      RepositoryComparisonRef.make(cloudFixtureHeadSha),
    ),
  ).rejects.toMatchObject({
    safeMessage: "Root commit reviews are not supported yet because this commit has no parent.",
  })
})
