import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Layer, Stream } from "effect"

import {
  ProcessExitError,
  ProcessOutputError,
  ProcessResult,
  ProcessService,
  type ProcessExecutionError,
  type ProcessRequest,
} from "@diffdash/process"
import { GitService, LocalReviewTargetError } from "./local-git"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { REPOSITORY_SCOPED_GIT_ENV } from "./git-environment"

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
      streamBytes: () => Stream.empty,
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

  it.effect("fetches a target branch and compares from its merge base with the live checkout", () =>
    Effect.gen(function* () {
      const targetSha = "dddddddddddddddddddddddddddddddddddddddd"
      const mergeBaseSha = "cccccccccccccccccccccccccccccccccccccccc"
      const calls: string[][] = []
      const processesLayer = makeProcessLayer((command, args, request) => {
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
        if (
          joined.includes("refs/heads/dev^{commit}") ||
          joined.includes("refs/tags/dev^{commit}")
        ) {
          return Effect.fail(
            ProcessExitError.make({
              command,
              args: [...args],
              cwd: request.cwd,
              exitCode: 128,
              signal: null,
              stdout: "",
              stderr: "unknown revision",
              stdoutTruncated: false,
              stderrTruncated: false,
              outputTruncated: false,
              message: "Unknown revision",
            }),
          )
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
        throw new Error(`Unexpected git call: ${joined}`)
      })
      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(processesLayer))),
      )
      const target = yield* service.resolveBranchComparison(
        RepositoryCheckoutPath.make("/workspace/repo"),
        RepositoryComparisonRef.make("dev"),
      )
      expect(target.comparison).toMatchObject({
        _tag: "branch",
        branchName: "dev",
        baseRef: "refs/remotes/origin/dev",
        baseSha: mergeBaseSha,
      })
      expect(calls.some((args) => args.includes("+refs/heads/dev:refs/remotes/origin/dev"))).toBe(
        true,
      )
      expect(calls.some((args) => args.join(" ").includes(`merge-base ${targetSha} HEAD`))).toBe(
        true,
      )
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
        if (
          joined.includes("refs/heads/dev^{commit}") ||
          joined.includes("refs/tags/dev^{commit}")
        ) {
          return Effect.fail(
            ProcessExitError.make({
              command,
              args: [...args],
              cwd: request.cwd,
              exitCode: 128,
              signal: null,
              stdout: "",
              stderr: "unknown revision",
              stdoutTruncated: false,
              stderrTruncated: false,
              outputTruncated: false,
              message: "Unknown revision",
            }),
          )
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
})
