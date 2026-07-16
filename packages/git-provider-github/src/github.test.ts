import { describe, expect, it } from "@effect/vitest"
import { Effect, Either } from "effect"

import {
  GitProviderId,
  GitProviderOperationError,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewLocator,
  HostedReviewNumber,
  RepositoryNamespace,
} from "@diffdash/git-provider"
import { gitProviderConformance } from "@diffdash/git-provider/testing"
import type { CliResult, CliRunner } from "@diffdash/process/cli"
import {
  createGitHubProvider,
  inspectGitHubCli,
  parseGitHubCliVersion,
  parseGitHubRemote,
} from "./github"
import {
  accessibleRepositoriesJson,
  approvalJson,
  pullRequestDetailJson,
  pullRequestDiffText,
  pullRequestListJson,
  repositorySearchJson,
  reviewRequestsJson,
} from "./fixtures/github"

interface Call {
  readonly command: string
  readonly args: readonly string[]
}

const result = (stdout: string, args: readonly string[]): CliResult => ({
  command: "gh",
  args,
  cwd: null,
  stdout,
  stderr: "",
  exitCode: 0,
})

const fakeCli = (calls: Call[] = []): CliRunner => ({
  run: (command, args) =>
    Effect.sync(() => {
      calls.push({ command, args })
      if (args[0] === "--version") return result("gh version 2.74.0 (2026-07-01)", args)
      if (args[0] === "auth") return result("", args)
      if (args[0] === "search" && args.includes("--help")) return result("help", args)
      if (args[0] === "search") return result(repositorySearchJson, args)
      if (args[0] === "repo") return result("", args)
      if (args[0] === "pr" && args[1] === "list") return result(pullRequestListJson, args)
      if (args[0] === "pr" && args[1] === "diff") return result(pullRequestDiffText, args)
      if (args[0] === "pr" && args[1] === "review") return result("", args)
      if (args[0] === "pr" && args[1] === "view") {
        return result(
          args.at(-1) === "headRefOid"
            ? JSON.stringify({ headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
            : pullRequestDetailJson,
          args,
        )
      }
      if (args[0] === "api" && args.includes("user/orgs")) {
        return result(JSON.stringify([{ login: "fungsi" }, { login: "xenithlabs" }]), args)
      }
      if (args[0] === "api" && args.includes("user")) {
        return result(JSON.stringify({ login: "hanipcode" }), args)
      }
      const query = args.find((arg) => arg.startsWith("query=")) ?? ""
      if (query.includes("latestReviews")) return result(approvalJson, args)
      if (query.includes("search(type: ISSUE")) return result(reviewRequestsJson, args)
      if (query.includes("repositories(")) return result(accessibleRepositoriesJson, args)
      throw new Error(`Unhandled gh command: ${args.join(" ")}`)
    }),
})

const repository = (providerId = "github") =>
  HostedRepositoryLocator.make({
    providerId: GitProviderId.make(providerId),
    namespace: RepositoryNamespace.make("fungsi"),
    name: HostedRepositoryName.make("diffdash"),
  })

const review = (providerId = "github") =>
  HostedReviewLocator.make({
    repository: repository(providerId),
    number: HostedReviewNumber.make(42),
  })

gitProviderConformance("GitHub", {
  create: () => createGitHubProvider({}, fakeCli()),
  configuredRemote: "git@github.com:fungsi/diffdash.git",
  nestedNamespace: "fungsi",
  repositoryName: "diffdash",
  reviewNumber: 42,
})

describe("GitHub provider", () => {
  it("parses only the configured host and supports nested namespaces", () => {
    expect(parseGitHubRemote("git@github.com:fungsi/diffdash.git")).toMatchObject({
      providerId: "github",
      namespace: "fungsi",
      name: "diffdash",
    })
    expect(
      parseGitHubRemote("ssh://git@git.acme.test/platform/tools/widget.git", {
        id: "github-acme",
        host: "git.acme.test",
      }),
    ).toMatchObject({ providerId: "github-acme", namespace: "platform/tools", name: "widget" })
    expect(
      parseGitHubRemote("https://github.com/fungsi/diffdash.git", {
        id: "github-acme",
        host: "git.acme.test",
      }),
    ).toBeNull()
  })

  it("creates host-aware repository and file URLs", () => {
    const provider = createGitHubProvider({ id: "github-acme", host: "git.acme.test" }, fakeCli())
    const locator = repository("github-acme")
    expect(provider.repositoryUrl(locator)).toBe("https://git.acme.test/fungsi/diffdash")
    expect(provider.fileUrl(locator, "src/a file.ts", "feature/x")).toBe(
      "https://git.acme.test/fungsi/diffdash/blob/feature%2Fx/src/a%20file.ts",
    )
  })

  it.effect("normalizes repository search, review detail, diff, and decisions", () =>
    Effect.gen(function* () {
      const provider = createGitHubProvider({}, fakeCli())
      const repositories = yield* provider.searchRepositories({
        query: "diffdash",
        namespaces: ["fungsi"],
      })
      const reviews = yield* provider.listReviews(repository())
      const detail = yield* provider.getReview(review())
      const diff = yield* provider.getReviewDiff(review())
      const decision = yield* provider.getReviewDecision(review())

      expect(repositories[0]).toMatchObject({
        locator: { namespace: "fungsi", name: "diffdash" },
        description: "Desktop review app",
      })
      expect(reviews[0]).toMatchObject({
        author: { username: "octocat" },
        head: { revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      })
      expect(detail.files[0]).toMatchObject({ path: "src/renderer/src/app.tsx" })
      expect(detail.commits[0]).toMatchObject({ title: "Add PR workspace" })
      expect(diff.diff).toBe(pullRequestDiffText)
      expect(decision).toBe("approved")
    }),
  )

  it.effect("preserves current search scopes and assigned-review behavior", () =>
    Effect.gen(function* () {
      const provider = createGitHubProvider({}, fakeCli())
      const scopes = yield* provider.listSearchScopes()
      const assigned = yield* provider.listAssignedReviews()
      expect(scopes).toEqual([
        { login: "hanipcode", kind: "user" },
        { login: "fungsi", kind: "organization" },
        { login: "xenithlabs", kind: "organization" },
      ])
      expect(assigned[0]).toMatchObject({
        locator: { repository: { namespace: "fungsi", name: "diffdash" }, number: 51 },
        title: "Request review flow",
      })
    }),
  )

  it.effect("constructs exact pull refs and delegates authenticated bare clones", () => {
    const calls: Call[] = []
    const provider = createGitHubProvider({}, fakeCli(calls))
    return Effect.gen(function* () {
      const checkout = yield* provider.checkoutSpecAtRevision(review(), "head-sha")
      yield* provider.bootstrapBareRepository(repository(), "/tmp/repository.git")
      expect(checkout).toMatchObject({
        remoteUrl: "https://github.com/fungsi/diffdash.git",
        fetchRef: "refs/pull/42/head",
        revision: "head-sha",
      })
      expect(calls.at(-1)?.args).toEqual([
        "repo",
        "clone",
        "fungsi/diffdash",
        "/tmp/repository.git",
        "--",
        "--bare",
      ])
    })
  })

  it.effect("adds enterprise host arguments to gh commands", () => {
    const calls: Call[] = []
    const provider = createGitHubProvider(
      { id: "github-acme", host: "git.acme.test" },
      fakeCli(calls),
    )
    return Effect.gen(function* () {
      yield* provider.listReviews(repository("github-acme"))
      yield* provider.listSearchScopes()
      expect(calls[0]?.args).toContain("git.acme.test/fungsi/diffdash")
      expect(calls[1]?.args).toEqual(["api", "user", "--hostname", "git.acme.test"])
    })
  })

  it.effect("wraps malformed gh JSON in the SDK operation error", () => {
    const provider = createGitHubProvider(
      {},
      {
        run: (_command, args) => Effect.succeed(result("not json", args)),
      },
    )
    return Effect.gen(function* () {
      const parsed = yield* Effect.either(
        provider.searchRepositories({ query: "diffdash", namespaces: ["fungsi"] }),
      )
      expect(Either.isLeft(parsed)).toBe(true)
      if (Either.isLeft(parsed)) {
        expect(parsed.left).toBeInstanceOf(GitProviderOperationError)
        expect(parsed.left.operation).toBe("searchRepositories")
      }
    })
  })

  it.effect("reports GitHub CLI support and authentication diagnostics", () =>
    Effect.gen(function* () {
      const inspection = yield* inspectGitHubCli(fakeCli())
      expect(inspection).toEqual({
        installed: true,
        authenticated: true,
        searchRepositoriesAvailable: true,
        supported: true,
        version: "2.74.0",
      })
      expect(parseGitHubCliVersion("gh version 1.14.0")).toBe("1.14.0")
    }),
  )
})
