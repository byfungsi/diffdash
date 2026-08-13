import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result, Layer, Stream } from "effect"

import {
  ProcessExitError,
  ProcessOutputError,
  ProcessResult,
  ProcessService,
  type ProcessExecutionError,
  type ProcessOutputPolicyInput,
  type ProcessRequest,
} from "@diffdash/process"
import { GitService, LocalReviewChangedError, LocalReviewTargetError } from "./local-git"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { REPOSITORY_SCOPED_GIT_ENV } from "./git-environment"
import { sanitizedGitTestEnvironment } from "./test-support/git-environment"

const makeProcessResult = (stdout: string, args: readonly string[]): ProcessResult =>
  ProcessResult.make({
    args,
    command: "git",
    cwd: null,
    exitCode: 0,
    signal: null,
    stderr: "",
    stderrTruncated: false,
    stdout,
    stdoutTruncated: false,
    outputTruncated: false,
  })

type FakeProcessRun = (
  command: string,
  args: readonly string[],
  request: ProcessRequest,
) => Effect.Effect<ProcessResult, ProcessExecutionError>

const makeProcessLayer = (run: FakeProcessRun) =>
  Layer.succeed(
    ProcessService,
    ProcessService.of({
      run: (request) => run(request.command, request.args, request),
      streamLines: () => Stream.empty,
    }),
  )

const makeLastCommitProcessLayer = (readRevisions: FakeProcessRun) =>
  makeProcessLayer((command, args, request) => {
    const joined = args.join(" ")
    if (joined.includes("rev-parse --show-toplevel")) {
      return Effect.succeed(makeProcessResult("/workspace/repo\n", args))
    }
    if (joined.includes("rev-list --parents -n 1 HEAD")) {
      return readRevisions(command, args, request)
    }
    throw new Error(`Unexpected git call: ${joined}`)
  })

describe("GitService", () => {
  it.effect(
    "detects a local Git checkout root and origin URL without parsing provider identity",
    () =>
      Effect.gen(function* () {
        const calls: ProcessRequest[] = []
        const processesLayer = makeProcessLayer((_command, args, request) => {
          const result = makeProcessResult(
            args.includes("rev-parse") ? "/workspace/repo\n" : "git@example.com:owner/repo.git\n",
            args,
          )
          calls.push(request)
          return Effect.succeed(result)
        })
        const layer = GitService.layer.pipe(Layer.provide(processesLayer))

        const service = yield* GitService.pipe(Effect.provide(layer))
        const detected = yield* service.detectRepository(
          RepositoryCheckoutPath.make("/workspace/repo/src"),
        )

        expect(detected).toEqual({
          remoteUrl: "git@example.com:owner/repo.git",
          rootPath: "/workspace/repo",
        })
        expect(calls.map((call) => call.args)).toEqual([
          ["-C", "/workspace/repo/src", "rev-parse", "--show-toplevel"],
          ["-C", "/workspace/repo", "remote", "get-url", "origin"],
        ])
        expect(calls.map((call) => call.unsetEnv)).toEqual([
          [...REPOSITORY_SCOPED_GIT_ENV],
          [...REPOSITORY_SCOPED_GIT_ENV],
        ])
      }),
  )

  it.effect("enumerates all local remotes and fetch URLs without provider assumptions", () =>
    Effect.gen(function* () {
      const processesLayer = makeProcessLayer((_command, args) => {
        const stdout = args.includes("rev-parse")
          ? "/workspace/repo\n"
          : args.at(-1) === "origin"
            ? "git@example.com:group/repo.git\nhttps://example.com/group/repo.git\n"
            : args.at(-1) === "upstream"
              ? "https://upstream.example/group/repo.git\n"
              : "origin\nupstream\n"
        return Effect.succeed(makeProcessResult(stdout, args))
      })
      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(processesLayer))),
      )

      expect(
        yield* service.listRemotes(RepositoryCheckoutPath.make("/workspace/repo/src")),
      ).toEqual([
        {
          name: "origin",
          fetchUrls: ["git@example.com:group/repo.git", "https://example.com/group/repo.git"],
        },
        {
          name: "upstream",
          fetchUrls: ["https://upstream.example/group/repo.git"],
        },
      ])
    }),
  )

  it.effect("represents detached HEAD as no current branch", () =>
    Effect.gen(function* () {
      const processesLayer = makeProcessLayer((_command, args) =>
        Effect.succeed(makeProcessResult("\n", args)),
      )
      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(processesLayer))),
      )

      expect(
        yield* service.currentBranch(RepositoryCheckoutPath.make("/workspace/repo")),
      ).toBeNull()
    }),
  )

  it.effect("resolves a last commit with its validated parent", () =>
    Effect.gen(function* () {
      const headSha = "b".repeat(40)
      const parentSha = "a".repeat(40)
      const layer = GitService.layer.pipe(
        Layer.provide(
          makeLastCommitProcessLayer((_command, args) =>
            Effect.succeed(makeProcessResult(`  ${headSha}   ${parentSha}\n`, args)),
          ),
        ),
      )
      const service = yield* GitService.pipe(Effect.provide(layer))

      expect(
        yield* service.resolveLastCommit(RepositoryCheckoutPath.make("/workspace/repo")),
      ).toMatchObject({
        rootPath: "/workspace/repo",
        comparison: { _tag: "lastCommit", baseSha: parentSha, headSha },
      })
    }),
  )

  it.effect("resolves a root commit against the empty tree", () =>
    Effect.gen(function* () {
      const headSha = "b".repeat(40)
      const layer = GitService.layer.pipe(
        Layer.provide(
          makeLastCommitProcessLayer((_command, args) =>
            Effect.succeed(makeProcessResult(`${headSha}\n`, args)),
          ),
        ),
      )
      const service = yield* GitService.pipe(Effect.provide(layer))

      expect(
        yield* service.resolveLastCommit(RepositoryCheckoutPath.make("/workspace/repo")),
      ).toMatchObject({
        comparison: {
          _tag: "lastCommit",
          baseSha: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
          headSha,
        },
      })
    }),
  )

  it.effect("translates only last-commit command failures", () =>
    Effect.gen(function* () {
      const processFailure = ProcessExitError.make({
        command: "git",
        args: ["-C", "/workspace/repo", "rev-list", "--parents", "-n", "1", "HEAD"],
        cwd: null,
        exitCode: 128,
        signal: null,
        stdout: "",
        stderr: "fatal: ambiguous argument 'HEAD'",
        stdoutTruncated: false,
        stderrTruncated: false,
        outputTruncated: false,
        message: "Command exited with code 128",
      })
      const layer = GitService.layer.pipe(
        Layer.provide(makeLastCommitProcessLayer(() => Effect.fail(processFailure))),
      )
      const service = yield* GitService.pipe(Effect.provide(layer))
      const result = yield* Effect.result(
        service.resolveLastCommit(RepositoryCheckoutPath.make("/workspace/repo")),
      )

      expect(Result.isFailure(result) && result.failure).toMatchObject({
        _tag: "LocalReviewTargetError",
        operation: "lastCommit.resolve",
        reason: "The repository does not have a commit to review",
        cause: processFailure,
      })
    }),
  )

  it.effect("preserves checkout-root resolution failures for last-commit reviews", () =>
    Effect.gen(function* () {
      let readLastCommit = false
      const processesLayer = makeProcessLayer((_command, args) => {
        const joined = args.join(" ")
        if (joined.includes("rev-parse --show-toplevel")) {
          return Effect.succeed(makeProcessResult("relative/path\n", args))
        }
        if (joined.includes("rev-list --parents -n 1 HEAD")) readLastCommit = true
        throw new Error(`Unexpected git call: ${joined}`)
      })
      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(processesLayer))),
      )
      const result = yield* Effect.result(
        service.resolveLastCommit(RepositoryCheckoutPath.make("/workspace/repo")),
      )

      expect(Result.isFailure(result) && result.failure).toBeInstanceOf(ProcessOutputError)
      expect(readLastCommit).toBe(false)
    }),
  )

  it.effect("rejects empty last-commit output", () =>
    Effect.gen(function* () {
      const layer = GitService.layer.pipe(
        Layer.provide(
          makeLastCommitProcessLayer((_command, args) =>
            Effect.succeed(makeProcessResult("  \n", args)),
          ),
        ),
      )
      const service = yield* GitService.pipe(Effect.provide(layer))
      const result = yield* Effect.result(
        service.resolveLastCommit(RepositoryCheckoutPath.make("/workspace/repo")),
      )

      expect(Result.isFailure(result) && result.failure).toMatchObject({
        _tag: "LocalReviewTargetError",
        operation: "lastCommit.resolve",
        reason: "The repository does not have a commit to review",
        cause: null,
      })
    }),
  )

  it.effect("rejects invalid last-commit head and parent output", () =>
    Effect.gen(function* () {
      for (const stdout of ["invalid-head", `${"b".repeat(40)} invalid-parent`]) {
        const layer = GitService.layer.pipe(
          Layer.provide(
            makeLastCommitProcessLayer((_command, args) =>
              Effect.succeed(makeProcessResult(stdout, args)),
            ),
          ),
        )
        const service = yield* GitService.pipe(Effect.provide(layer))
        const result = yield* Effect.result(
          service.resolveLastCommit(RepositoryCheckoutPath.make("/workspace/repo")),
        )

        expect(Result.isFailure(result) && result.failure).toMatchObject({
          _tag: "LocalReviewTargetError",
          operation: "lastCommit.resolve",
          reason: "The repository does not have a commit to review",
          cause: expect.any(Error),
        })
      }
    }),
  )

  it.effect("returns a typed process error when Git reports an invalid checkout root", () =>
    Effect.gen(function* () {
      const processesLayer = makeProcessLayer((_command, args) =>
        Effect.succeed(makeProcessResult("relative/repo\n", args)),
      )
      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(processesLayer))),
      )

      const result = yield* Effect.result(
        service.detectRoot(RepositoryCheckoutPath.make("/workspace/repo")),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(ProcessOutputError)
    }),
  )

  it.effect("builds local review details from tracked and untracked changes", () =>
    Effect.gen(function* () {
      let parseCalls = 0
      const trackedDiff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,1 @@
-old
+new`
      const untrackedDiff = `diff --git a/notes.txt b/notes.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/notes.txt
@@ -0,0 +1 @@
+note`
      const calls: Array<{
        readonly args: readonly string[]
        readonly cwd: string | null
        readonly stdout: ProcessOutputPolicyInput | undefined
      }> = []
      const processesLayer = makeProcessLayer((command, args, request) => {
        calls.push({ args: [...args], cwd: request.cwd, stdout: request.stdout ?? undefined })
        const joined = args.join(" ")
        if (joined.includes("rev-parse --show-toplevel")) {
          return Effect.succeed(makeProcessResult("/workspace/repo\n", args))
        }
        if (joined.includes("branch --show-current")) {
          return Effect.succeed(makeProcessResult("feature/local\n", args))
        }
        if (joined.includes("rev-parse --verify HEAD")) {
          return Effect.succeed(
            makeProcessResult("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", args),
          )
        }
        if (joined.includes("diff --no-ext-diff bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --")) {
          return Effect.succeed(makeProcessResult(trackedDiff, args))
        }
        if (joined.includes("ls-files --others --exclude-standard -z")) {
          return Effect.succeed(makeProcessResult("notes.txt\0", args))
        }
        if (args[0] === "diff" && args.includes("--no-index")) {
          return Effect.fail(
            ProcessExitError.make({
              command,
              args: [...args],
              cwd: request.cwd,
              exitCode: 1,
              signal: null,
              stdout: untrackedDiff,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              outputTruncated: false,
              message: "Command exited with code 1",
            }),
          )
        }

        throw new Error(`Unexpected git call: ${joined}`)
      })
      const layer = GitService.layerWith({
        parseDiff: (rawDiff) => {
          parseCalls += 1
          return parseUnifiedDiff(rawDiff)
        },
      }).pipe(Layer.provide(processesLayer))

      const service = yield* GitService.pipe(Effect.provide(layer))
      const reviewPath = RepositoryCheckoutPath.make("/workspace/repo/src")
      parseCalls = 0
      const snapshot = yield* service.getLocalReviewSnapshot(reviewPath)
      const { detail, diff } = snapshot

      expect(detail).toMatchObject({
        branchName: "feature/local",
        repoName: "repo",
        rootPath: "/workspace/repo",
        title: "Local changes",
      })
      expect(detail.files.map((file) => file.path)).toEqual(["src/app.ts", "notes.txt"])
      expect(detail.files.map((file) => file.changeType)).toEqual(["modified", "added"])
      expect(diff.diff).toContain("diff --git a/src/app.ts b/src/app.ts")
      expect(diff.diff).toContain("diff --git a/notes.txt b/notes.txt")
      expect(snapshot.baseRevision).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
      expect(snapshot.headRevision).toBe(diff.headSha)
      expect(snapshot.detail.files).toEqual(detail.files)
      expect(parseCalls).toBe(1)
      expect(calls.some((call) => call.cwd === "/workspace/repo")).toBe(true)
      expect(
        calls
          .filter((call) => call.args.includes("diff"))
          .every((call) => call.stdout?.maxBytes === 8_000_000 && call.stdout.overflow === "error"),
      ).toBe(true)
    }),
  )

  it.effect("fetches a target branch and compares from its merge base with the live checkout", () =>
    Effect.gen(function* () {
      const targetSha = "dddddddddddddddddddddddddddddddddddddddd"
      const mergeBaseSha = "cccccccccccccccccccccccccccccccccccccccc"
      const calls: string[][] = []
      const processesLayer = makeProcessLayer((_command, args) => {
        calls.push([...args])
        const joined = args.join(" ")
        if (joined.includes("rev-parse --show-toplevel")) {
          return Effect.succeed(makeProcessResult("/workspace/repo\n", args))
        }
        if (joined.includes("branch --show-current")) {
          return Effect.succeed(makeProcessResult("feat/abc\n", args))
        }
        if (joined.includes("check-ref-format --branch dev")) {
          return Effect.succeed(makeProcessResult("dev\n", args))
        }
        if (joined.includes(" fetch --no-tags origin ")) {
          return Effect.succeed(makeProcessResult("", args))
        }
        if (
          joined.includes("rev-parse --verify --end-of-options refs/remotes/origin/dev^{commit}")
        ) {
          return Effect.succeed(makeProcessResult(`${targetSha}\n`, args))
        }
        if (joined.includes(`merge-base ${targetSha} HEAD`)) {
          return Effect.succeed(makeProcessResult(`${mergeBaseSha}\n`, args))
        }
        if (joined.includes(`diff --no-ext-diff ${mergeBaseSha} --`)) {
          return Effect.succeed(
            makeProcessResult(
              "diff --git a/src/feature.ts b/src/feature.ts\n--- a/src/feature.ts\n+++ b/src/feature.ts\n@@ -1 +1 @@\n-old\n+new",
              args,
            ),
          )
        }
        if (joined.includes("ls-files --others --exclude-standard -z")) {
          return Effect.succeed(makeProcessResult("", args))
        }
        throw new Error(`Unexpected git call: ${joined}`)
      })
      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(processesLayer))),
      )
      const target = yield* service.resolveBranchComparison(
        RepositoryCheckoutPath.make("/workspace/repo"),
        RepositoryComparisonRef.make("dev"),
      )
      const detail = (yield* service.getLocalReviewSnapshot(target)).detail

      expect(target.comparison).toMatchObject({
        _tag: "branch",
        branchName: "dev",
        baseRef: "refs/remotes/origin/dev",
        baseSha: mergeBaseSha,
      })
      expect(detail).toMatchObject({ baseSha: mergeBaseSha, title: "Changes vs dev" })
      expect(calls.some((args) => args.includes("+refs/heads/dev:refs/remotes/origin/dev"))).toBe(
        true,
      )
      expect(calls.some((args) => args.join(" ").includes(`merge-base ${targetSha} HEAD`))).toBe(
        true,
      )
      expect(
        calls.some((args) => args.join(" ").includes(`diff --no-ext-diff ${mergeBaseSha} --`)),
      ).toBe(true)
    }),
  )

  it.effect("resolves the origin default branch when diff has no branch argument", () =>
    Effect.gen(function* () {
      const calls: string[][] = []
      const processesLayer = makeProcessLayer((_command, args) => {
        calls.push([...args])
        const joined = args.join(" ")
        if (joined.includes("rev-parse --show-toplevel")) {
          return Effect.succeed(makeProcessResult("/workspace/repo\n", args))
        }
        if (joined.includes("branch --show-current")) {
          return Effect.succeed(makeProcessResult("feat/abc\n", args))
        }
        if (joined.includes("symbolic-ref --quiet --short refs/remotes/origin/HEAD")) {
          return Effect.succeed(makeProcessResult("origin/main\n", args))
        }
        if (joined.includes("check-ref-format --branch main")) {
          return Effect.succeed(makeProcessResult("main\n", args))
        }
        if (joined.includes("fetch --no-tags origin")) {
          return Effect.succeed(makeProcessResult("", args))
        }
        if (joined.includes("refs/remotes/origin/main^{commit}")) {
          return Effect.succeed(
            makeProcessResult("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n", args),
          )
        }
        if (joined.includes("merge-base eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee HEAD")) {
          return Effect.succeed(
            makeProcessResult("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", args),
          )
        }
        throw new Error(`Unexpected git call: ${joined}`)
      })
      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(processesLayer))),
      )

      const target = yield* service.resolveBranchComparison(
        RepositoryCheckoutPath.make("/workspace/repo"),
        null,
      )

      expect(target.comparison).toMatchObject({
        _tag: "branch",
        branchName: "main",
        baseRef: "refs/remotes/origin/main",
        baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      })
      expect(calls.some((args) => args.includes("+refs/heads/main:refs/remotes/origin/main"))).toBe(
        true,
      )
    }),
  )

  it.effect("uses local HEAD without fetching when the comparison branch is checked out", () =>
    Effect.gen(function* () {
      const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      const calls: string[][] = []
      const processesLayer = makeProcessLayer((_command, args) => {
        calls.push([...args])
        const joined = args.join(" ")
        if (joined.includes("rev-parse --show-toplevel")) {
          return Effect.succeed(makeProcessResult("/workspace/repo\n", args))
        }
        if (joined.includes("branch --show-current")) {
          return Effect.succeed(makeProcessResult("main\n", args))
        }
        if (joined.includes("check-ref-format --branch main")) {
          return Effect.succeed(makeProcessResult("main\n", args))
        }
        if (joined.includes("refs/heads/main^{commit}")) {
          return Effect.succeed(makeProcessResult(`${headSha}\n`, args))
        }
        if (joined.includes(`merge-base ${headSha} HEAD`)) {
          return Effect.succeed(makeProcessResult(`${headSha}\n`, args))
        }
        throw new Error(`Unexpected git call: ${joined}`)
      })
      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(processesLayer))),
      )

      const target = yield* service.resolveBranchComparison(
        RepositoryCheckoutPath.make("/workspace/repo"),
        RepositoryComparisonRef.make("main"),
      )

      expect(target.comparison).toMatchObject({
        _tag: "branch",
        branchName: "main",
        baseRef: "refs/heads/main",
        baseSha: headSha,
      })
      expect(calls.some((args) => args.includes("fetch"))).toBe(false)
    }),
  )

  it.effect("reports a clear error when the comparison branch has no common ancestor", () =>
    Effect.gen(function* () {
      const targetSha = "dddddddddddddddddddddddddddddddddddddddd"
      const processesLayer = makeProcessLayer((command, args, request) => {
        const joined = args.join(" ")
        if (joined.includes("rev-parse --show-toplevel")) {
          return Effect.succeed(makeProcessResult("/workspace/repo\n", args))
        }
        if (joined.includes("branch --show-current")) {
          return Effect.succeed(makeProcessResult("feat/abc\n", args))
        }
        if (joined.includes("check-ref-format --branch dev")) {
          return Effect.succeed(makeProcessResult("dev\n", args))
        }
        if (joined.includes(" fetch --no-tags origin ")) {
          return Effect.succeed(makeProcessResult("", args))
        }
        if (joined.includes("refs/remotes/origin/dev^{commit}")) {
          return Effect.succeed(makeProcessResult(`${targetSha}\n`, args))
        }
        if (joined.includes(`merge-base ${targetSha} HEAD`)) {
          return Effect.fail(
            ProcessExitError.make({
              command,
              args: [...args],
              cwd: request.cwd,
              exitCode: 1,
              signal: null,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              outputTruncated: false,
              message: "Command exited with code 1",
            }),
          )
        }
        throw new Error(`Unexpected git call: ${joined}`)
      })
      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(processesLayer))),
      )

      const result = yield* Effect.result(
        service.resolveBranchComparison(
          RepositoryCheckoutPath.make("/workspace/repo"),
          RepositoryComparisonRef.make("dev"),
        ),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(LocalReviewTargetError)
        expect(result.failure).toMatchObject({
          operation: "branch.mergeBase",
          reason: "Branch dev does not share a common ancestor with the current HEAD",
        })
      }
    }),
  )

  it.effect(
    "excludes target-only changes while retaining the current branch and local changes",
    () =>
      Effect.gen(function* () {
        const rootPath = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-merge-base-test-"))),
          (path) => Effect.sync(() => rmSync(path, { force: true, recursive: true })),
        )
        git(rootPath, "init", "-b", "main")
        writeFileSync(join(rootPath, "base.txt"), "base\n")
        commitAll(rootPath, "base")
        const mergeBaseSha = git(rootPath, "rev-parse", "HEAD")
        git(rootPath, "branch", "dev")

        writeFileSync(join(rootPath, "main-only.txt"), "main only\n")
        commitAll(rootPath, "main only")

        git(rootPath, "checkout", "dev")
        writeFileSync(join(rootPath, "dev-only.txt"), "inherited from dev\n")
        commitAll(rootPath, "dev change")
        const devSha = git(rootPath, "rev-parse", "HEAD")
        git(rootPath, "checkout", "-b", "feat/x")
        writeFileSync(join(rootPath, "feature.txt"), "committed feature\n")
        commitAll(rootPath, "feature change")
        git(rootPath, "remote", "add", "origin", rootPath)

        writeFileSync(join(rootPath, "staged.txt"), "staged change\n")
        git(rootPath, "add", "staged.txt")
        writeFileSync(join(rootPath, "feature.txt"), "committed feature\nunstaged change\n")
        writeFileSync(join(rootPath, "untracked.txt"), "untracked change\n")
        const branchBefore = git(rootPath, "branch", "--show-current")
        const statusBefore = git(rootPath, "status", "--porcelain", "--untracked-files=all")

        const service = yield* GitService.pipe(
          Effect.provide(GitService.layer.pipe(Layer.provide(ProcessService.layer))),
        )
        const checkoutPath = RepositoryCheckoutPath.make(rootPath)
        const mainTarget = yield* service.resolveBranchComparison(
          checkoutPath,
          RepositoryComparisonRef.make("main"),
        )
        const mainSnapshot = yield* service.getLocalReviewSnapshot(mainTarget)
        const mainPaths = mainSnapshot.parsedDiff.files.map((file) => file.path)

        expect(mainTarget.comparison).toMatchObject({
          _tag: "branch",
          branchName: "main",
          baseSha: mergeBaseSha,
        })
        expect(mainSnapshot.baseRevision).toBe(mergeBaseSha)
        expect(mainPaths).toEqual(
          expect.arrayContaining(["dev-only.txt", "feature.txt", "staged.txt", "untracked.txt"]),
        )
        expect(mainPaths).not.toContain("main-only.txt")
        expect(mainSnapshot.diff.diff).toContain("+inherited from dev")
        expect(mainSnapshot.diff.diff).toContain("+committed feature")
        expect(mainSnapshot.diff.diff).toContain("+unstaged change")
        expect(mainSnapshot.diff.diff).toContain("+staged change")
        expect(mainSnapshot.diff.diff).toContain("+untracked change")
        expect(mainSnapshot.diff.diff).not.toContain("main only")

        const devTarget = yield* service.resolveBranchComparison(
          checkoutPath,
          RepositoryComparisonRef.make("dev"),
        )
        const devSnapshot = yield* service.getLocalReviewSnapshot(devTarget)
        const devPaths = devSnapshot.parsedDiff.files.map((file) => file.path)

        expect(devTarget.comparison).toMatchObject({
          _tag: "branch",
          branchName: "dev",
          baseSha: devSha,
        })
        expect(devSnapshot.baseRevision).toBe(devSha)
        expect(devPaths).toEqual(
          expect.arrayContaining(["feature.txt", "staged.txt", "untracked.txt"]),
        )
        expect(devPaths).not.toContain("dev-only.txt")
        expect(devPaths).not.toContain("main-only.txt")
        expect(devSnapshot.diff.diff).not.toContain("inherited from dev")
        expect(devSnapshot.diff.diff).not.toContain("main only")
        expect(git(rootPath, "branch", "--show-current")).toBe(branchBefore)
        expect(git(rootPath, "status", "--porcelain", "--untracked-files=all")).toBe(statusBefore)
      }),
  )

  it.effect("reviews only HEAD against its first parent and excludes checkout changes", () =>
    Effect.gen(function* () {
      const rootPath = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-last-commit-test-"))),
        (path) => Effect.sync(() => rmSync(path, { force: true, recursive: true })),
      )
      git(rootPath, "init", "-b", "main")
      writeFileSync(join(rootPath, "base.txt"), "base\n")
      commitAll(rootPath, "base")
      const baseSha = git(rootPath, "rev-parse", "HEAD")
      writeFileSync(join(rootPath, "committed.txt"), "committed\n")
      commitAll(rootPath, "last")
      const headSha = git(rootPath, "rev-parse", "HEAD")
      writeFileSync(join(rootPath, "staged.txt"), "staged\n")
      git(rootPath, "add", "staged.txt")
      writeFileSync(join(rootPath, "untracked.txt"), "untracked\n")

      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(ProcessService.layer))),
      )
      const target = yield* service.resolveLastCommit(RepositoryCheckoutPath.make(rootPath))
      const snapshot = yield* service.getLocalReviewSnapshot(target)

      expect(target.comparison).toMatchObject({ _tag: "lastCommit", baseSha, headSha })
      expect(snapshot.detail.title).toBe("Last commit")
      expect(snapshot.baseRevision).toBe(baseSha)
      expect(snapshot.headRevision).toBe(headSha)
      expect(snapshot.parsedDiff.files.map((file) => file.path)).toEqual(["committed.txt"])
    }),
  )

  it.effect("compares a root commit with Git's empty tree", () =>
    Effect.gen(function* () {
      const rootPath = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-root-commit-test-"))),
        (path) => Effect.sync(() => rmSync(path, { force: true, recursive: true })),
      )
      git(rootPath, "init", "-b", "main")
      writeFileSync(join(rootPath, "root.txt"), "root\n")
      commitAll(rootPath, "root")

      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(ProcessService.layer))),
      )
      const target = yield* service.resolveLastCommit(RepositoryCheckoutPath.make(rootPath))
      const snapshot = yield* service.getLocalReviewSnapshot(target)

      expect(target.comparison).toMatchObject({
        _tag: "lastCommit",
        baseSha: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      })
      expect(snapshot.parsedDiff.files.map((file) => file.path)).toEqual(["root.txt"])
    }),
  )

  it.effect("compares a merge commit with its first parent", () =>
    Effect.gen(function* () {
      const rootPath = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-merge-commit-test-"))),
        (path) => Effect.sync(() => rmSync(path, { force: true, recursive: true })),
      )
      git(rootPath, "init", "-b", "main")
      writeFileSync(join(rootPath, "base.txt"), "base\n")
      commitAll(rootPath, "base")
      git(rootPath, "checkout", "-b", "feature")
      writeFileSync(join(rootPath, "feature.txt"), "feature\n")
      commitAll(rootPath, "feature")
      git(rootPath, "checkout", "main")
      writeFileSync(join(rootPath, "main.txt"), "main\n")
      commitAll(rootPath, "main")
      const firstParentSha = git(rootPath, "rev-parse", "HEAD")
      git(rootPath, "merge", "--no-ff", "feature", "-m", "merge feature")
      const mergeSha = git(rootPath, "rev-parse", "HEAD")

      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(ProcessService.layer))),
      )
      const target = yield* service.resolveLastCommit(RepositoryCheckoutPath.make(rootPath))
      const snapshot = yield* service.getLocalReviewSnapshot(target)

      expect(target.comparison).toMatchObject({
        _tag: "lastCommit",
        baseSha: firstParentSha,
        headSha: mergeSha,
      })
      expect(snapshot.parsedDiff.files.map((file) => file.path)).toEqual(["feature.txt"])
    }),
  )

  it.effect("FUN-80 AC: rejects a local snapshot that changes during repeated capture", () =>
    Effect.gen(function* () {
      let diffRead = 0
      const processesLayer = makeProcessLayer((_command, args) => {
        const joined = args.join(" ")
        if (joined.includes("rev-parse --show-toplevel")) {
          return Effect.succeed(makeProcessResult("/workspace/repo\n", args))
        }
        if (joined.includes("rev-parse --verify HEAD")) {
          return Effect.succeed(
            makeProcessResult("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", args),
          )
        }
        if (joined.includes("diff --no-ext-diff bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --")) {
          diffRead += 1
          return Effect.succeed(
            makeProcessResult(
              `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new-${diffRead}`,
              args,
            ),
          )
        }
        if (joined.includes("ls-files --others --exclude-standard -z")) {
          return Effect.succeed(makeProcessResult("", args))
        }
        throw new Error(`Unexpected git call: ${joined}`)
      })
      const layer = GitService.layer.pipe(Layer.provide(processesLayer))
      const service = yield* GitService.pipe(Effect.provide(layer))
      const result = yield* Effect.result(
        service.getLocalReviewSnapshot(RepositoryCheckoutPath.make("/workspace/repo")),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(LocalReviewChangedError)
    }),
  )
})

const git = (cwd: string, ...args: readonly string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: sanitizedGitTestEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

const commitAll = (cwd: string, message: string) => {
  git(cwd, "add", "-A")
  git(
    cwd,
    "-c",
    "user.name=DiffDash Test",
    "-c",
    "user.email=test@diffdash.dev",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    message,
  )
}
