import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer } from "effect"

import { CliError, CliService, type CliResult } from "./cli"
import { GitProvider, GitProviderRemoteParseError } from "./git-provider"
import { GitHubCliParseError, GitHubProvider, parseGitHubRemote } from "./github"

const makeCliResult = (stdout: string, args: readonly string[] = []): CliResult => ({
  args,
  command: "gh",
  cwd: null,
  exitCode: 0,
  stderr: "",
  stdout,
})

const cliLayer = (stdout: string) =>
  Layer.succeed(
    CliService,
    CliService.of({
      run: () => Effect.succeed(makeCliResult(stdout)),
    }),
  )

const testLayer = (stdout: string) => GitHubProvider.layer.pipe(Layer.provide(cliLayer(stdout)))

const repositorySearchJson = JSON.stringify({
  data: {
    viewer: {
      repositories: {
        nodes: [
          {
            description: "Desktop review app",
            isPrivate: false,
            name: "diffdash",
            nameWithOwner: "fungsi/diffdash",
            owner: { login: "fungsi" },
            updatedAt: "2026-07-07T00:00:00Z",
            url: "https://github.com/fungsi/diffdash",
          },
          {
            description: "Another accessible repo",
            isPrivate: true,
            name: "internal-tools",
            nameWithOwner: "fungsi/internal-tools",
            owner: { login: "fungsi" },
            updatedAt: "2026-07-06T00:00:00Z",
            url: "https://github.com/fungsi/internal-tools",
          },
        ],
      },
    },
  },
})

const pullRequestListJson = JSON.stringify([
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

const reviewRequestsJson = JSON.stringify({
  data: {
    search: {
      nodes: [
        {
          author: { login: "octocat" },
          baseRefName: "main",
          baseRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          body: "Please review this workspace change.",
          createdAt: "2026-07-07T00:00:00Z",
          headRefName: "feature/requested-review",
          headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          isDraft: false,
          number: 51,
          repository: {
            name: "diffdash",
            owner: { login: "fungsi" },
          },
          state: "OPEN",
          title: "Request review flow",
          updatedAt: "2026-07-07T02:00:00Z",
          url: "https://github.com/fungsi/diffdash/pull/51",
        },
      ],
    },
  },
})

const pullRequestDetailJson = JSON.stringify({
  author: { login: "octocat" },
  baseRefName: "main",
  baseRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  body: "Adds the first review workspace slice.",
  commits: [
    {
      authoredDate: "2026-07-07T00:30:00Z",
      messageHeadline: "Add PR workspace",
      oid: "cccccccccccccccccccccccccccccccccccccccc",
    },
  ],
  createdAt: "2026-07-07T00:00:00Z",
  files: [
    {
      additions: 120,
      deletions: 12,
      path: "src/renderer/src/app.tsx",
    },
  ],
  headRefName: "feature/pr-workspace",
  headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  isDraft: false,
  number: 42,
  state: "OPEN",
  title: "Add PR workspace",
  updatedAt: "2026-07-07T01:00:00Z",
  url: "https://github.com/fungsi/diffdash/pull/42",
})

const pullRequestDiffText = `diff --git a/src/app.tsx b/src/app.tsx
index 1111111..2222222 100644
--- a/src/app.tsx
+++ b/src/app.tsx
@@ -1,1 +1,1 @@
-old
+new
`

describe("GitHubProvider", () => {
  it.effect("parses SSH GitHub remotes", () =>
    Effect.gen(function* () {
      const parsed = yield* parseGitHubRemote("git@github.com:owner/repo.git")

      expect(parsed).toEqual({ provider: "github", owner: "owner", name: "repo" })
    }),
  )

  it.effect("parses HTTPS GitHub remotes", () =>
    Effect.gen(function* () {
      const parsed = yield* parseGitHubRemote("https://github.com/owner/repo.git")

      expect(parsed).toEqual({ provider: "github", owner: "owner", name: "repo" })
    }),
  )

  it.effect("fails with a typed error for unsupported remotes", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(parseGitHubRemote("https://gitlab.com/owner/repo.git"))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(GitProviderRemoteParseError)
        expect(result.left.remoteUrl).toBe("https://gitlab.com/owner/repo.git")
      }
    }),
  )

  it.effect("lists authenticated GitHub user and organization search scopes", () => {
    const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = []
    const layer = GitHubProvider.layer.pipe(
      Layer.provide(
        Layer.succeed(
          CliService,
          CliService.of({
            run: (command, args) =>
              Effect.sync(() => {
                calls.push({ command, args })
                if (args[1] === "user") {
                  return makeCliResult(JSON.stringify({ login: "hanipcode" }), args)
                }

                return makeCliResult(
                  JSON.stringify([{ login: "fungsi" }, { login: "xenithlabs" }]),
                  args,
                )
              }),
          }),
        ),
      ),
    )

    return Effect.gen(function* () {
      const github = yield* GitProvider
      const scopes = yield* github.listSearchScopes()

      expect(scopes.map((scope) => scope.login)).toEqual(["hanipcode", "fungsi", "xenithlabs"])
      expect(scopes.map((scope) => scope.kind)).toEqual(["user", "organization", "organization"])
      expect(calls.map((call) => call.args)).toEqual([
        ["api", "user"],
        ["api", "user/orgs"],
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("searches accessible GitHub repositories from viewer repo GraphQL JSON", () =>
    Effect.gen(function* () {
      const github = yield* GitProvider
      const repos = yield* github.searchRepositories("diffdash")
      const repo = repos[0]

      expect(repos).toHaveLength(1)
      expect(repo).toBeDefined()
      if (repo !== undefined) {
        expect(repo).toMatchObject({
          description: "Desktop review app",
          isPrivate: false,
          name: "diffdash",
          nameWithOwner: "fungsi/diffdash",
          owner: "fungsi",
          url: "https://github.com/fungsi/diffdash",
        })
      }
    }).pipe(Effect.provide(testLayer(repositorySearchJson))),
  )

  it.effect("supports owner-scoped repository search queries", () =>
    Effect.gen(function* () {
      const github = yield* GitProvider
      const repos = yield* github.searchRepositories("owner:xenithlabs dashboard")

      expect(repos.map((repo) => repo.nameWithOwner)).toEqual(["xenithlabs/xenith-dashboard"])
    }).pipe(
      Effect.provide(
        testLayer(
          JSON.stringify([
            {
              description: "Xenith dashboard",
              fullName: "xenithlabs/xenith-dashboard",
              name: "xenith-dashboard",
              owner: { login: "xenithlabs" },
              url: "https://github.com/xenithlabs/xenith-dashboard",
            },
          ]),
        ),
      ),
    ),
  )

  it.effect("uses gh repository search for owner-scoped queries", () => {
    const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = []
    const layer = GitHubProvider.layer.pipe(
      Layer.provide(
        Layer.succeed(
          CliService,
          CliService.of({
            run: (command, args) =>
              Effect.sync(() => {
                calls.push({ command, args })
                return makeCliResult("[]", args)
              }),
          }),
        ),
      ),
    )

    return Effect.gen(function* () {
      const github = yield* GitProvider
      yield* github.searchRepositories("owner:xenithlabs dashboard")

      expect(calls[0]).toMatchObject({ command: "gh" })
      expect(calls[0]?.args).toEqual([
        "search",
        "repos",
        "dashboard",
        "--owner",
        "xenithlabs",
        "--json",
        "fullName,name,owner,url,description,isPrivate,updatedAt",
        "--limit",
        "30",
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("uses viewer repository affiliations instead of arbitrary public search", () => {
    const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = []
    const layer = GitHubProvider.layer.pipe(
      Layer.provide(
        Layer.succeed(
          CliService,
          CliService.of({
            run: (command, args) =>
              Effect.sync(() => {
                calls.push({ command, args })
                return makeCliResult(repositorySearchJson, args)
              }),
          }),
        ),
      ),
    )

    return Effect.gen(function* () {
      const github = yield* GitProvider
      yield* github.searchRepositories("diffdash")

      expect(calls[0]?.command).toBe("gh")
      expect(calls[0]?.args).toEqual([
        "api",
        "graphql",
        "-f",
        expect.stringContaining("affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]"),
        "-F",
        "first=100",
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("fails with a typed error when gh returns malformed JSON", () =>
    Effect.gen(function* () {
      const github = yield* GitProvider
      const result = yield* Effect.either(github.searchRepositories("diffdash"))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(GitHubCliParseError)
        if (result.left instanceof GitHubCliParseError) {
          expect(result.left.operation).toBe("searchRepositories")
        }
      }
    }).pipe(Effect.provide(testLayer("not json"))),
  )

  it.effect("fails with a typed error when parsed rows are missing owner or name", () =>
    Effect.gen(function* () {
      const github = yield* GitProvider
      const result = yield* Effect.either(github.searchRepositories("diffdash"))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(GitHubCliParseError)
      }
    }).pipe(
      Effect.provide(
        testLayer(
          JSON.stringify({
            data: {
              viewer: { repositories: { nodes: [{ url: "https://github.com/fungsi/diffdash" }] } },
            },
          }),
        ),
      ),
    ),
  )

  it.effect("lists open pull requests for a selected repository", () => {
    const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = []
    const layer = GitHubProvider.layer.pipe(
      Layer.provide(
        Layer.succeed(
          CliService,
          CliService.of({
            run: (command, args) =>
              Effect.sync(() => {
                calls.push({ command, args })
                return makeCliResult(pullRequestListJson, args)
              }),
          }),
        ),
      ),
    )

    return Effect.gen(function* () {
      const github = yield* GitProvider
      const pullRequests = yield* github.listPullRequests("fungsi", "diffdash")
      const pullRequest = pullRequests[0]

      expect(calls[0]?.command).toBe("gh")
      expect(calls[0]?.args).toEqual([
        "pr",
        "list",
        "--repo",
        "fungsi/diffdash",
        "--state",
        "open",
        "--json",
        expect.stringContaining("headRefOid"),
        "--limit",
        "50",
      ])
      expect(pullRequests).toHaveLength(1)
      expect(pullRequest).toMatchObject({
        author: { login: "octocat" },
        baseRefName: "main",
        headRefName: "feature/pr-workspace",
        headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        number: 42,
        repoName: "diffdash",
        repoOwner: "fungsi",
        title: "Add PR workspace",
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect("fetches pull request detail with files and commits", () =>
    Effect.gen(function* () {
      const github = yield* GitProvider
      const detail = yield* github.getPullRequestDetail("fungsi", "diffdash", 42)

      expect(detail.files).toHaveLength(1)
      expect(detail.files[0]).toMatchObject({
        additions: 120,
        changeType: "modified",
        deletions: 12,
        path: "src/renderer/src/app.tsx",
      })
      expect(detail.commits).toHaveLength(1)
      expect(detail.commits[0]).toMatchObject({
        messageHeadline: "Add PR workspace",
        oid: "cccccccccccccccccccccccccccccccccccccccc",
      })
    }).pipe(Effect.provide(testLayer(pullRequestDetailJson))),
  )

  it.effect("lists recent review requests for the authenticated user", () => {
    const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = []
    const layer = GitHubProvider.layer.pipe(
      Layer.provide(
        Layer.succeed(
          CliService,
          CliService.of({
            run: (command, args) =>
              Effect.sync(() => {
                calls.push({ command, args })
                return makeCliResult(reviewRequestsJson, args)
              }),
          }),
        ),
      ),
    )

    return Effect.gen(function* () {
      const github = yield* GitProvider
      const pullRequests = yield* github.listReviewRequests()

      expect(calls[0]?.command).toBe("gh")
      expect(calls[0]?.args).toEqual([
        "api",
        "graphql",
        "-f",
        expect.stringContaining("search(type: ISSUE"),
        "-F",
        "searchQuery=type:pr state:open review-requested:@me",
        "-F",
        "first=20",
      ])
      expect(pullRequests).toHaveLength(1)
      expect(pullRequests[0]).toMatchObject({
        author: { login: "octocat" },
        baseRefName: "main",
        headRefName: "feature/requested-review",
        number: 51,
        repoName: "diffdash",
        repoOwner: "fungsi",
        title: "Request review flow",
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect("fetches raw pull request diff with cache metadata", () => {
    const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = []
    const layer = GitHubProvider.layer.pipe(
      Layer.provide(
        Layer.succeed(
          CliService,
          CliService.of({
            run: (command, args) =>
              Effect.sync(() => {
                calls.push({ command, args })
                return makeCliResult(
                  args.includes("diff")
                    ? pullRequestDiffText
                    : JSON.stringify({
                        headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                      }),
                  args,
                )
              }),
          }),
        ),
      ),
    )

    return Effect.gen(function* () {
      const github = yield* GitProvider
      const diff = yield* github.getPullRequestDiff("fungsi", "diffdash", 42)

      expect(calls).toHaveLength(2)
      expect(calls[0]?.args).toEqual([
        "pr",
        "view",
        "42",
        "--repo",
        "fungsi/diffdash",
        "--json",
        "headRefOid",
      ])
      expect(calls[1]?.args).toEqual(["pr", "diff", "42", "--repo", "fungsi/diffdash"])
      expect(diff).toMatchObject({
        diff: pullRequestDiffText,
        headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        number: 42,
        repoName: "diffdash",
        repoOwner: "fungsi",
      })
      expect(diff.fetchedAt).toEqual(expect.any(String))
    }).pipe(Effect.provide(layer))
  })

  it.effect("approves a pull request review with gh", () => {
    const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = []
    const layer = GitHubProvider.layer.pipe(
      Layer.provide(
        Layer.succeed(
          CliService,
          CliService.of({
            run: (command, args) =>
              Effect.sync(() => {
                calls.push({ command, args })
                return makeCliResult("", args)
              }),
          }),
        ),
      ),
    )

    return Effect.gen(function* () {
      const github = yield* GitProvider
      yield* github.approvePullRequest("fungsi", "diffdash", 42)

      expect(calls).toEqual([
        {
          command: "gh",
          args: ["pr", "review", "42", "--repo", "fungsi/diffdash", "--approve"],
        },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("detects when the viewer has already approved a pull request", () => {
    const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = []
    const approvalJson = JSON.stringify({
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
    const layer = GitHubProvider.layer.pipe(
      Layer.provide(
        Layer.succeed(
          CliService,
          CliService.of({
            run: (command, args) =>
              Effect.sync(() => {
                calls.push({ command, args })
                return makeCliResult(approvalJson, args)
              }),
          }),
        ),
      ),
    )

    return Effect.gen(function* () {
      const github = yield* GitProvider
      const approved = yield* github.hasApprovedPullRequest("fungsi", "diffdash", 42)

      expect(approved).toBe(true)
      expect(calls[0]?.command).toBe("gh")
      expect(calls[0]?.args).toEqual([
        "api",
        "graphql",
        "-f",
        expect.stringContaining("latestReviews"),
        "-F",
        "owner=fungsi",
        "-F",
        "name=diffdash",
        "-F",
        "number=42",
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("fails with a typed error when pull request detail is malformed", () =>
    Effect.gen(function* () {
      const github = yield* GitProvider
      const result = yield* Effect.either(github.getPullRequestDetail("fungsi", "diffdash", 42))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(GitHubCliParseError)
        if (result.left instanceof GitHubCliParseError) {
          expect(result.left.operation).toBe("getPullRequestDetail")
        }
      }
    }).pipe(Effect.provide(testLayer("{}"))),
  )

  it.effect("preserves gh command failures as CLI errors", () =>
    Effect.gen(function* () {
      const github = yield* GitProvider
      const result = yield* Effect.either(github.listPullRequests("fungsi", "diffdash"))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(CliError)
        if (result.left instanceof CliError) {
          expect(result.left.stderr).toContain("gh auth login")
        }
      }
    }).pipe(
      Effect.provide(
        GitHubProvider.layer.pipe(
          Layer.provide(
            Layer.succeed(
              CliService,
              CliService.of({
                run: (command, args) =>
                  CliError.make({
                    args: [...args],
                    cause: null,
                    command,
                    cwd: null,
                    exitCode: 4,
                    stderr: "Run gh auth login to authenticate.",
                  }),
              }),
            ),
          ),
        ),
      ),
    ),
  )
})
