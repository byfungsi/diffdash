import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Result, Schema, Stream } from "effect"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  GitProviderId,
  GitFileRevision,
  GitProviderOperationError,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewLocator,
  HostedReviewNumber,
  RepositoryNamespace,
  RepositoryRelativePath,
  ReviewDiffAcquisition,
  ReviewDiffByteCompletion,
  ReviewDiffGeneration,
  ReviewDiffGenerationReused,
  ReviewDiffRevisionChanged,
  ReviewRevision,
} from "@diffdash/git-provider"
import { gitProviderConformance, reviewDiffSourceConformance } from "@diffdash/git-provider/testing"
import {
  ProcessExit,
  ProcessResult,
  ProcessService,
  type ProcessOutputPolicyInput,
  type ProcessRequest,
  type ProcessRunner,
  type ProcessStreamMetrics,
} from "@diffdash/process"
import {
  createGitHubProvider,
  createGitHubReviewDiffSource,
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
  readonly stdout: ProcessOutputPolicyInput | undefined
  readonly request: ProcessRequest
}

const result = (stdout: string, request: ProcessRequest): ProcessResult =>
  ProcessResult.make({
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    outputTruncated: false,
    exitCode: 0,
    signal: null,
  })

const processRunner = (
  run: ProcessRunner["run"],
  streamBytes: ProcessRunner["streamBytes"] = () => Stream.empty,
): ProcessRunner => ({
  run,
  streamBytes,
  streamLines: () => Stream.empty,
})

const fakeProcesses = (calls: Call[] = []): ProcessRunner => {
  const run: ProcessRunner["run"] = (request) =>
    Effect.sync(() => {
      const { args, command } = request
      calls.push({ command, args, stdout: request.stdout ?? undefined, request })
      if (args[0] === "--version") return result("gh version 2.74.0 (2026-07-01)", request)
      if (args[0] === "auth") return result("", request)
      if (args[0] === "search" && args.includes("--help")) return result("help", request)
      if (args[0] === "search") return result(repositorySearchJson, request)
      if (args[0] === "repo" && args[1] === "view") {
        return result(
          JSON.stringify({
            id: "R_diffdash",
            nameWithOwner: "byfungsi/diffdash",
            url: "https://github.com/byfungsi/diffdash",
          }),
          request,
        )
      }
      if (args[0] === "repo") return result("", request)
      if (args[0] === "pr" && args[1] === "list") return result(pullRequestListJson, request)
      if (args[0] === "pr" && args[1] === "diff" && args.includes("--help")) {
        return result("--color string  Use color: {always|never|auto}", request)
      }
      if (args[0] === "pr" && args[1] === "review") return result("", request)
      if (args[0] === "pr" && args[1] === "view") {
        return result(
          args.at(-1) === "headRefOid"
            ? JSON.stringify({ headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
            : pullRequestDetailJson,
          request,
        )
      }
      if (args[0] === "api" && args.includes("user/orgs")) {
        return result(JSON.stringify([{ login: "fungsi" }, { login: "xenithlabs" }]), request)
      }
      if (args[0] === "api" && args.includes("user")) {
        return result(JSON.stringify({ login: "hanipcode" }), request)
      }
      const query = args.find((arg) => arg.startsWith("query=")) ?? ""
      if (query.includes("latestReviews")) return result(approvalJson, request)
      if (query.includes("search(type: ISSUE")) return result(reviewRequestsJson, request)
      if (query.includes("repositories(")) return result(accessibleRepositoriesJson, request)
      throw new Error(`Unhandled gh command: ${args.join(" ")}`)
    })
  return processRunner(run, (request) => {
    calls.push({
      command: request.command,
      args: request.args,
      stdout: request.stdout ?? undefined,
      request,
    })
    return Stream.fromIterable([
      { _tag: "ProcessByteChunk" as const, bytes: new TextEncoder().encode(pullRequestDiffText) },
      ProcessExit.make({ result: result("", request) }),
    ])
  })
}

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

const makeTempDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "diffdash-gh-source-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
)

const writeFakeGh = (
  directory: string,
  behavior: "large" | "hang",
): Effect.Effect<{ readonly executable: string; readonly pidFile: string }> =>
  Effect.gen(function* () {
    const executable = join(directory, "gh")
    const pidFile = join(directory, "pid")
    const script = `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
if (args[0] === "--version") process.stdout.end("gh version 2.74.0 (fake)\\n")
else if (args[0] === "pr" && args[1] === "diff" && args.includes("--help")) process.stdout.end("--color string  Use color\\n")
else if (args[0] === "pr" && args[1] === "view") process.stdout.end(JSON.stringify({ headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }))
else if (args[0] === "pr" && args[1] === "diff") {
  if (args.includes("--name-only") || args.includes("--exclude") || args[args.indexOf("--color") + 1] !== "never" || process.env.NO_COLOR !== "1") process.exit(91)
  ${
    behavior === "large"
      ? `const chunk = Buffer.alloc(64 * 1024, 120)
  let remaining = 9 * 1024 * 1024 + 123
  const write = () => {
    while (remaining > 0) {
      const size = Math.min(remaining, chunk.length)
      remaining -= size
      if (!process.stdout.write(chunk.subarray(0, size))) return process.stdout.once("drain", write)
    }
  }
  write()`
      : `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
  process.on("SIGTERM", () => {})
  process.stdout.write("started")
  setInterval(() => {}, 1000)`
  }
} else process.exit(92)
`
    yield* Effect.promise(() => writeFile(executable, script))
    yield* Effect.promise(() => chmod(executable, 0o755))
    return { executable, pidFile }
  })

const waitForFile = (path: string, attempts = 200): Promise<string> =>
  readFile(path, "utf8").catch((cause: unknown) => {
    if (attempts <= 0) throw cause
    return new Promise((resolve) => setTimeout(resolve, 10)).then(() =>
      waitForFile(path, attempts - 1),
    )
  })

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForProcessExit = (pid: number, attempts = 200): Promise<void> =>
  processIsRunning(pid)
    ? attempts <= 0
      ? Promise.reject(new Error(`Process ${pid} did not exit`))
      : new Promise((resolve) => setTimeout(resolve, 10)).then(() =>
          waitForProcessExit(pid, attempts - 1),
        )
    : Promise.resolve()

gitProviderConformance("GitHub", {
  create: () => createGitHubProvider({}, fakeProcesses()),
  configuredRemote: "git@github.com:fungsi/diffdash.git",
  nestedNamespace: "fungsi",
  repositoryName: "diffdash",
  reviewNumber: 42,
})

reviewDiffSourceConformance("GitHub", {
  create: () => Effect.runSync(createGitHubReviewDiffSource({}, fakeProcesses(), review())),
  createCancellable: () => {
    let closed = false
    const processes = fakeProcesses()
    const cancellable = processRunner(processes.run, () =>
      Stream.never.pipe(Stream.ensuring(Effect.sync(() => void (closed = true)))),
    )
    return {
      source: Effect.runSync(createGitHubReviewDiffSource({}, cancellable, review())),
      closed: () => closed,
    }
  },
  expectedBytes: new TextEncoder().encode(pullRequestDiffText),
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

  it.effect("creates host-aware repository and file URLs", () =>
    Effect.gen(function* () {
      const provider = createGitHubProvider(
        { id: "github-acme", host: "git.acme.test" },
        fakeProcesses(),
      )
      const locator = repository("github-acme")
      expect(yield* provider.repositoryUrl(locator)).toBe("https://git.acme.test/fungsi/diffdash")
      expect(
        yield* provider.fileUrl(
          locator,
          RepositoryRelativePath.make("src/a file.ts"),
          GitFileRevision.make("feature/x"),
        ),
      ).toBe("https://git.acme.test/fungsi/diffdash/blob/feature%2Fx/src/a%20file.ts")
    }),
  )

  it.effect("resolves repository renames to the stable provider identity", () =>
    Effect.gen(function* () {
      const calls: Call[] = []
      const provider = createGitHubProvider({}, fakeProcesses(calls))

      const resolved = yield* provider.resolveRepository(repository())

      expect(resolved).toMatchObject({
        locator: { providerId: "github", namespace: "byfungsi", name: "diffdash" },
        providerRepositoryId: "R_diffdash",
        url: "https://github.com/byfungsi/diffdash",
      })
      expect(calls.at(-1)?.args).toEqual([
        "repo",
        "view",
        "fungsi/diffdash",
        "--json",
        "id,nameWithOwner,url",
      ])
    }),
  )

  it.effect("normalizes repository search, review detail, and decisions", () =>
    Effect.gen(function* () {
      const provider = createGitHubProvider({}, fakeProcesses())
      const repositories = yield* provider.searchRepositories({
        query: "diffdash",
        namespaces: ["fungsi"],
      })
      const reviews = yield* provider.listReviews(repository())
      const detail = yield* provider.getReview(review())
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
      expect(decision).toBe("approved")
    }),
  )

  it.effect("preserves current search scopes and assigned-review behavior", () =>
    Effect.gen(function* () {
      const provider = createGitHubProvider({}, fakeProcesses())
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
    const provider = createGitHubProvider({}, fakeProcesses(calls))
    return Effect.gen(function* () {
      const checkout = yield* provider.checkoutSpec(review(), ReviewRevision.make("head-sha"))
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

  it.effect("uses qualified raw output with color disabled and no buffering flags", () => {
    const calls: Call[] = []
    const provider = createGitHubProvider({}, fakeProcesses(calls))
    return Effect.gen(function* () {
      const source = yield* provider.getReviewDiffSource(review())
      const acquisition = ReviewDiffAcquisition.make({
        generation: ReviewDiffGeneration.make("raw-output-policy"),
        expectedRevision: source.offer.expectedRevision,
      })
      yield* source.unifiedBytes(acquisition).pipe(Stream.runDrain)
      yield* source.close
      const diffCall = calls.find(
        (call) => call.args[0] === "pr" && call.args[1] === "diff" && !call.args.includes("--help"),
      )
      expect(diffCall?.args).toEqual([
        "pr",
        "diff",
        "42",
        "--repo",
        "fungsi/diffdash",
        "--color",
        "never",
      ])
      expect(diffCall?.args).not.toContain("--name-only")
      expect(diffCall?.args).not.toContain("--exclude")
      expect(diffCall?.request.stdout).toMatchObject({ maxBytes: 0, overflow: "truncate" })
      expect(diffCall?.request.env).toMatchObject({ NO_COLOR: "1", CLICOLOR: "0", TERM: "dumb" })
    })
  })

  it.effect("rejects revision changes and requires a fresh generation for retry", () => {
    let metadataReads = 0
    const base = fakeProcesses()
    const processes = processRunner((request) => {
      if (request.args[0] === "pr" && request.args[1] === "view") {
        metadataReads += 1
        const revision =
          metadataReads === 3
            ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        return Effect.succeed(result(JSON.stringify({ headRefOid: revision }), request))
      }
      return base.run(request)
    }, base.streamBytes)
    return Effect.gen(function* () {
      const source = yield* createGitHubReviewDiffSource({}, processes, review())
      const reused = ReviewDiffAcquisition.make({
        generation: ReviewDiffGeneration.make("revision-change"),
        expectedRevision: source.offer.expectedRevision,
      })
      const changed = yield* source.unifiedBytes(reused).pipe(Stream.runDrain, Effect.result)
      expect(Result.isFailure(changed)).toBe(true)
      if (Result.isFailure(changed))
        expect(changed.failure).toBeInstanceOf(ReviewDiffRevisionChanged)

      const duplicate = yield* source.unifiedBytes(reused).pipe(Stream.runDrain, Effect.result)
      expect(Result.isFailure(duplicate)).toBe(true)
      if (Result.isFailure(duplicate))
        expect(duplicate.failure).toBeInstanceOf(ReviewDiffGenerationReused)

      const fresh = ReviewDiffAcquisition.make({
        generation: ReviewDiffGeneration.make("revision-retry-fresh"),
        expectedRevision: source.offer.expectedRevision,
      })
      const events = yield* source.unifiedBytes(fresh).pipe(Stream.runCollect)
      expect(Array.from(events).some(Schema.is(ReviewDiffByteCompletion))).toBe(true)
      yield* source.close
    })
  })

  it.effect("adds enterprise host arguments to gh commands", () => {
    const calls: Call[] = []
    const provider = createGitHubProvider(
      { id: "github-acme", host: "git.acme.test" },
      fakeProcesses(calls),
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
      processRunner((request) => Effect.succeed(result("not json", request))),
    )
    return Effect.gen(function* () {
      const parsed = yield* Effect.result(
        provider.searchRepositories({ query: "diffdash", namespaces: ["fungsi"] }),
      )
      expect(Result.isFailure(parsed)).toBe(true)
      if (Result.isFailure(parsed)) {
        expect(parsed.failure).toBeInstanceOf(GitProviderOperationError)
        expect(parsed.failure.operation).toBe("searchRepositories")
      }
    })
  })

  it.effect("reports GitHub CLI support and authentication diagnostics", () =>
    Effect.gen(function* () {
      const inspection = yield* inspectGitHubCli(fakeProcesses())
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

  it.effect("rejects old versions and versions without raw color control", () =>
    Effect.gen(function* () {
      for (const [version, help] of [
        ["gh version 2.6.0", "--color string"],
        ["gh version 2.74.0", "no color option"],
      ] as const) {
        const processes = processRunner((request) =>
          Effect.succeed(result(request.args[0] === "--version" ? version : help, request)),
        )
        const qualified = yield* Effect.result(
          createGitHubReviewDiffSource({}, processes, review()),
        )
        expect(Result.isFailure(qualified)).toBe(true)
        if (Result.isFailure(qualified)) {
          expect(qualified.failure).toBeInstanceOf(GitProviderOperationError)
          expect(qualified.failure.operation).toBe("getReviewDiff.qualify")
        }
      }
    }),
  )

  it.live("streams more than 8 MiB from a slow fake gh consumer within fixed pressure bounds", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const fake = yield* writeFakeGh(directory, "large")
      const processes = yield* ProcessService
      const snapshots: ProcessStreamMetrics[] = []
      const observed: ProcessRunner = {
        ...processes,
        streamBytes: (request, options) =>
          processes.streamBytes(request, {
            ...options,
            observer: (value) => snapshots.push(value),
          }),
      }
      const source = yield* createGitHubReviewDiffSource(
        { executable: fake.executable },
        observed,
        review(),
      )
      const acquisition = ReviewDiffAcquisition.make({
        generation: ReviewDiffGeneration.make("large-slow-fake"),
        expectedRevision: source.offer.expectedRevision,
      })
      let bytes = 0
      let delayed = false
      yield* source.unifiedBytes(acquisition).pipe(
        Stream.runForEach((event) => {
          if (Schema.is(ReviewDiffByteCompletion)(event)) return Effect.void
          bytes += event.bytes.byteLength
          if (delayed) return Effect.void
          delayed = true
          return Effect.sleep(100)
        }),
      )

      expect(bytes).toBe(9 * 1024 * 1024 + 123)
      expect(Math.max(...snapshots.map((value) => value.queueBytes))).toBeLessThanOrEqual(
        1024 * 1024,
      )
      expect(Math.max(...snapshots.map((value) => value.reservedBytes))).toBeLessThanOrEqual(
        1024 * 1024,
      )
      expect(Math.max(...snapshots.map((value) => value.blockedDurationMs))).toBeGreaterThan(0)
      yield* source.close
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.live("kills an in-progress fake gh process when the source closes", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const fake = yield* writeFakeGh(directory, "hang")
      const processes = yield* ProcessService
      const source = yield* createGitHubReviewDiffSource(
        { executable: fake.executable },
        processes,
        review(),
      )
      const acquisition = ReviewDiffAcquisition.make({
        generation: ReviewDiffGeneration.make("close-kills-gh"),
        expectedRevision: source.offer.expectedRevision,
      })
      const fiber = yield* source
        .unifiedBytes(acquisition)
        .pipe(Stream.runDrain, Effect.result, Effect.forkChild)
      const pid = Number.parseInt(yield* Effect.promise(() => waitForFile(fake.pidFile)), 10)
      yield* source.close
      const closed = yield* Fiber.join(fiber)
      expect(Result.isFailure(closed)).toBe(true)
      yield* Effect.promise(() => waitForProcessExit(pid))
      expect(processIsRunning(pid)).toBe(false)
    }).pipe(Effect.provide(ProcessService.layer)),
  )
})
