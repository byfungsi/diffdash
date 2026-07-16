export const repositorySearchJson = JSON.stringify([
  {
    description: "Desktop review app",
    fullName: "fungsi/diffdash",
    isPrivate: false,
    name: "diffdash",
    owner: { login: "fungsi" },
    updatedAt: "2026-07-07T00:00:00Z",
    url: "https://github.com/fungsi/diffdash",
  },
])

export const accessibleRepositoriesJson = JSON.stringify({
  data: {
    viewer: {
      repositories: { nodes: JSON.parse(repositorySearchJson) },
    },
  },
})

export const pullRequestListJson = JSON.stringify([
  {
    author: { login: "octocat" },
    baseRefName: "main",
    baseRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    body: "Adds the first review workspace slice.",
    createdAt: "2026-07-07T00:00:00Z",
    headRefName: "feature/pr-workspace",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    isDraft: false,
    number: 42,
    state: "OPEN",
    title: "Add PR workspace",
    updatedAt: "2026-07-07T01:00:00Z",
    url: "https://github.com/fungsi/diffdash/pull/42",
  },
])

export const pullRequestDetailJson = JSON.stringify({
  ...JSON.parse(pullRequestListJson)[0],
  files: [{ additions: 120, deletions: 12, path: "src/renderer/src/app.tsx" }],
  commits: [
    {
      authoredDate: "2026-07-07T00:30:00Z",
      messageHeadline: "Add PR workspace",
      oid: "cccccccccccccccccccccccccccccccccccccccc",
    },
  ],
})

export const reviewRequestsJson = JSON.stringify({
  data: {
    search: {
      nodes: [
        {
          ...JSON.parse(pullRequestListJson)[0],
          number: 51,
          repository: { name: "diffdash", owner: { login: "fungsi" } },
          title: "Request review flow",
        },
      ],
    },
  },
})

export const approvalJson = JSON.stringify({
  data: {
    viewer: { login: "hanipcode" },
    repository: {
      pullRequest: {
        latestReviews: {
          nodes: [
            { author: { login: "octocat" }, state: "COMMENTED" },
            { author: { login: "hanipcode" }, state: "APPROVED" },
          ],
        },
      },
    },
  },
})

export const pullRequestDiffText = `diff --git a/src/app.tsx b/src/app.tsx
index 1111111..2222222 100644
--- a/src/app.tsx
+++ b/src/app.tsx
@@ -1,1 +1,1 @@
-old
+new
`
