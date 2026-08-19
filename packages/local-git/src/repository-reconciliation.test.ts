import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Layer, Stream } from "effect"

import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { ProcessResult, ProcessService, type ProcessRequest } from "@diffdash/process"
import { RepositoryReconciler } from "./repository-reconciliation"
import { sanitizedGitTestEnvironment } from "./test-support/git-environment"

describe("RepositoryReconciler", () => {
  it.effect("resolves independent worktree Git directories and their shared common directory", () =>
    Effect.gen(function* () {
      const parent = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-watch-layout-"))),
        (path) => Effect.sync(() => rmSync(path, { force: true, recursive: true })),
      )
      const repository = join(parent, "repository")
      const linked = join(parent, "linked")
      mkdirSync(repository)
      git(repository, "init", "-b", "main")
      writeFileSync(join(repository, "README.md"), "repository\n")
      commitAll(repository, "initial")
      git(repository, "worktree", "add", "-b", "linked", linked)

      const reconciler = yield* RepositoryReconciler.pipe(
        Effect.provide(RepositoryReconciler.layer.pipe(Layer.provide(ProcessService.layer))),
      )
      const normal = yield* reconciler.resolveDirectories(RepositoryCheckoutPath.make(repository))
      const worktree = yield* reconciler.resolveDirectories(RepositoryCheckoutPath.make(linked))

      const canonicalRepository = resolve(git(repository, "rev-parse", "--show-toplevel"))
      const canonicalLinked = resolve(git(linked, "rev-parse", "--show-toplevel"))
      expect(normal.checkoutRoot).toBe(canonicalRepository)
      expect(normal.worktreeGitDirectory).toBe(join(canonicalRepository, ".git"))
      expect(normal.commonGitDirectory).toBe(join(canonicalRepository, ".git"))
      expect(worktree.checkoutRoot).toBe(canonicalLinked)
      expect(worktree.worktreeGitDirectory).not.toBe(normal.worktreeGitDirectory)
      expect(worktree.worktreeGitDirectory).toContain(join(".git", "worktrees"))
      expect(worktree.commonGitDirectory).toBe(normal.commonGitDirectory)
    }),
  )

  it.effect("keeps branch intent separate from its resolved SHA and never fetches", () =>
    Effect.gen(function* () {
      const calls: ProcessRequest[] = []
      const sha = "a".repeat(40)
      const processLayer = Layer.succeed(
        ProcessService,
        ProcessService.of({
          run: (request) => {
            calls.push(request)
            const command = request.args.join(" ")
            const stdout = command.includes("symbolic-ref")
              ? "feature/watcher\n"
              : command.includes("rev-parse --verify")
                ? `${sha}\n`
                : `# branch.oid ${sha}\n# branch.head feature/watcher\n`
            return Effect.succeed(result(stdout, request.args))
          },
          streamBytes: () => Stream.empty,
          streamLines: () => Stream.empty,
        }),
      )
      const reconciler = yield* RepositoryReconciler.pipe(
        Effect.provide(RepositoryReconciler.layer.pipe(Layer.provide(processLayer))),
      )

      const state = yield* reconciler.readState(RepositoryCheckoutPath.make("/workspace/repo"))

      expect(state.branchIntent).toBe("feature/watcher")
      expect(state.resolvedHeadSha).toBe(sha)
      expect(state.branchIntent).not.toBe(state.resolvedHeadSha)
      expect(calls).toHaveLength(3)
      expect(calls.some((call) => call.args.includes("fetch"))).toBe(false)
      expect(calls.some((call) => call.args.includes("pull"))).toBe(false)
      expect(calls.some((call) => call.args.includes("ls-remote"))).toBe(false)
    }),
  )
})

const result = (stdout: string, args: readonly string[]): ProcessResult =>
  ProcessResult.make({
    command: "git",
    args,
    cwd: null,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    outputTruncated: false,
  })

const git = (cwd: string, ...args: readonly string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: sanitizedGitTestEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

const commitAll = (cwd: string, message: string): void => {
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
