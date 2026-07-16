import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"

import { CliError, CliService, type CliResult } from "@diffdash/process/cli"
import { GitService, LocalReviewChangedError, LocalReviewTargetError } from "./local-git"

const makeCliResult = (stdout: string, args: readonly string[]): CliResult => ({
  args,
  command: "git",
  cwd: null,
  exitCode: 0,
  stderr: "",
  stdout,
})

describe("GitService", () => {
  it.effect(
    "detects a local Git checkout root and origin URL without parsing provider identity",
    () =>
      Effect.gen(function* () {
        const calls: CliResult[] = []
        const cliLayer = Layer.succeed(
          CliService,
          CliService.of({
            run: (_command, args) => {
              const result = makeCliResult(
                args.includes("rev-parse")
                  ? "/workspace/repo\n"
                  : "git@example.com:owner/repo.git\n",
                args,
              )
              calls.push(result)
              return Effect.succeed(result)
            },
          }),
        )
        const layer = GitService.layer.pipe(Layer.provide(cliLayer))

        const service = yield* GitService.pipe(Effect.provide(layer))
        const detected = yield* service.detectRepository("/workspace/repo/src")

        expect(detected).toEqual({
          remoteUrl: "git@example.com:owner/repo.git",
          rootPath: "/workspace/repo",
        })
        expect(calls.map((call) => call.args)).toEqual([
          ["-C", "/workspace/repo/src", "rev-parse", "--show-toplevel"],
          ["-C", "/workspace/repo", "remote", "get-url", "origin"],
        ])
      }),
  )

  it.effect("builds local review details from tracked and untracked changes", () =>
    Effect.gen(function* () {
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
      const calls: Array<{ readonly args: readonly string[]; readonly cwd: string | undefined }> =
        []
      const cliLayer = Layer.succeed(
        CliService,
        CliService.of({
          run: (command, args, options) => {
            calls.push({ args: [...args], cwd: options?.cwd })
            const joined = args.join(" ")
            if (joined.includes("rev-parse --show-toplevel")) {
              return Effect.succeed(makeCliResult("/workspace/repo\n", args))
            }
            if (joined.includes("branch --show-current")) {
              return Effect.succeed(makeCliResult("feature/local\n", args))
            }
            if (joined.includes("rev-parse --verify HEAD")) {
              return Effect.succeed(
                makeCliResult("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", args),
              )
            }
            if (joined.includes("diff --no-ext-diff bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --")) {
              return Effect.succeed(makeCliResult(trackedDiff, args))
            }
            if (joined.includes("ls-files --others --exclude-standard -z")) {
              return Effect.succeed(makeCliResult("notes.txt\0", args))
            }
            if (args[0] === "diff" && args.includes("--no-index")) {
              return Effect.fail(
                CliError.make({
                  command,
                  args: [...args],
                  cwd: options?.cwd ?? null,
                  exitCode: 1,
                  stdout: untrackedDiff,
                  stderr: "",
                  cause: null,
                }),
              )
            }

            throw new Error(`Unexpected git call: ${joined}`)
          },
        }),
      )
      const layer = GitService.layer.pipe(Layer.provide(cliLayer))

      const service = yield* GitService.pipe(Effect.provide(layer))
      const detail = yield* service.getLocalReviewDetail("/workspace/repo/src")
      const diff = yield* service.getLocalReviewDiff("/workspace/repo/src")
      const snapshot = yield* service.getLocalReviewSnapshot("/workspace/repo/src")

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
      expect(calls.some((call) => call.cwd === "/workspace/repo")).toBe(true)
    }),
  )

  it.effect("fetches a target branch and compares from its merge base with the live checkout", () =>
    Effect.gen(function* () {
      const targetSha = "dddddddddddddddddddddddddddddddddddddddd"
      const mergeBaseSha = "cccccccccccccccccccccccccccccccccccccccc"
      const calls: string[][] = []
      const cliLayer = Layer.succeed(
        CliService,
        CliService.of({
          run: (_command, args) => {
            calls.push([...args])
            const joined = args.join(" ")
            if (joined.includes("rev-parse --show-toplevel")) {
              return Effect.succeed(makeCliResult("/workspace/repo\n", args))
            }
            if (joined.includes("branch --show-current")) {
              return Effect.succeed(makeCliResult("feat/abc\n", args))
            }
            if (joined.includes("check-ref-format --branch dev")) {
              return Effect.succeed(makeCliResult("dev\n", args))
            }
            if (joined.includes(" fetch --no-tags origin ")) {
              return Effect.succeed(makeCliResult("", args))
            }
            if (
              joined.includes(
                "rev-parse --verify --end-of-options refs/remotes/origin/dev^{commit}",
              )
            ) {
              return Effect.succeed(makeCliResult(`${targetSha}\n`, args))
            }
            if (joined.includes(`merge-base ${targetSha} HEAD`)) {
              return Effect.succeed(makeCliResult(`${mergeBaseSha}\n`, args))
            }
            if (joined.includes(`diff --no-ext-diff ${mergeBaseSha} --`)) {
              return Effect.succeed(
                makeCliResult(
                  "diff --git a/src/feature.ts b/src/feature.ts\n--- a/src/feature.ts\n+++ b/src/feature.ts\n@@ -1 +1 @@\n-old\n+new",
                  args,
                ),
              )
            }
            if (joined.includes("ls-files --others --exclude-standard -z")) {
              return Effect.succeed(makeCliResult("", args))
            }
            throw new Error(`Unexpected git call: ${joined}`)
          },
        }),
      )
      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(cliLayer))),
      )
      const target = yield* service.resolveBranchComparison("/workspace/repo", "dev")
      const detail = yield* service.getLocalReviewDetail(target)

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
      const cliLayer = Layer.succeed(
        CliService,
        CliService.of({
          run: (_command, args) => {
            calls.push([...args])
            const joined = args.join(" ")
            if (joined.includes("rev-parse --show-toplevel")) {
              return Effect.succeed(makeCliResult("/workspace/repo\n", args))
            }
            if (joined.includes("branch --show-current")) {
              return Effect.succeed(makeCliResult("feat/abc\n", args))
            }
            if (joined.includes("symbolic-ref --quiet --short refs/remotes/origin/HEAD")) {
              return Effect.succeed(makeCliResult("origin/main\n", args))
            }
            if (joined.includes("check-ref-format --branch main")) {
              return Effect.succeed(makeCliResult("main\n", args))
            }
            if (joined.includes("fetch --no-tags origin")) {
              return Effect.succeed(makeCliResult("", args))
            }
            if (joined.includes("refs/remotes/origin/main^{commit}")) {
              return Effect.succeed(
                makeCliResult("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n", args),
              )
            }
            if (joined.includes("merge-base eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee HEAD")) {
              return Effect.succeed(
                makeCliResult("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", args),
              )
            }
            throw new Error(`Unexpected git call: ${joined}`)
          },
        }),
      )
      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(cliLayer))),
      )

      const target = yield* service.resolveBranchComparison("/workspace/repo", null)

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
      const cliLayer = Layer.succeed(
        CliService,
        CliService.of({
          run: (_command, args) => {
            calls.push([...args])
            const joined = args.join(" ")
            if (joined.includes("rev-parse --show-toplevel")) {
              return Effect.succeed(makeCliResult("/workspace/repo\n", args))
            }
            if (joined.includes("branch --show-current")) {
              return Effect.succeed(makeCliResult("main\n", args))
            }
            if (joined.includes("check-ref-format --branch main")) {
              return Effect.succeed(makeCliResult("main\n", args))
            }
            if (joined.includes("refs/heads/main^{commit}")) {
              return Effect.succeed(makeCliResult(`${headSha}\n`, args))
            }
            if (joined.includes(`merge-base ${headSha} HEAD`)) {
              return Effect.succeed(makeCliResult(`${headSha}\n`, args))
            }
            throw new Error(`Unexpected git call: ${joined}`)
          },
        }),
      )
      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(cliLayer))),
      )

      const target = yield* service.resolveBranchComparison("/workspace/repo", "main")

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
      const cliLayer = Layer.succeed(
        CliService,
        CliService.of({
          run: (command, args) => {
            const joined = args.join(" ")
            if (joined.includes("rev-parse --show-toplevel")) {
              return Effect.succeed(makeCliResult("/workspace/repo\n", args))
            }
            if (joined.includes("branch --show-current")) {
              return Effect.succeed(makeCliResult("feat/abc\n", args))
            }
            if (joined.includes("check-ref-format --branch dev")) {
              return Effect.succeed(makeCliResult("dev\n", args))
            }
            if (joined.includes(" fetch --no-tags origin ")) {
              return Effect.succeed(makeCliResult("", args))
            }
            if (joined.includes("refs/remotes/origin/dev^{commit}")) {
              return Effect.succeed(makeCliResult(`${targetSha}\n`, args))
            }
            if (joined.includes(`merge-base ${targetSha} HEAD`)) {
              return Effect.fail(
                CliError.make({
                  command,
                  args: [...args],
                  cwd: null,
                  exitCode: 1,
                  stdout: "",
                  stderr: "",
                  cause: null,
                }),
              )
            }
            throw new Error(`Unexpected git call: ${joined}`)
          },
        }),
      )
      const service = yield* GitService.pipe(
        Effect.provide(GitService.layer.pipe(Layer.provide(cliLayer))),
      )

      const result = yield* Effect.either(service.resolveBranchComparison("/workspace/repo", "dev"))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(LocalReviewTargetError)
        expect(result.left).toMatchObject({
          operation: "branch.mergeBase",
          reason: "Branch dev does not share a common ancestor with the current HEAD",
        })
      }
    }),
  )

  it.scoped(
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
          Effect.provide(GitService.layer.pipe(Layer.provide(CliService.layer))),
        )
        const mainTarget = yield* service.resolveBranchComparison(rootPath, "main")
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

        const devTarget = yield* service.resolveBranchComparison(rootPath, "dev")
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

  it.effect("FUN-80 AC: rejects a local snapshot that changes during repeated capture", () =>
    Effect.gen(function* () {
      let diffRead = 0
      const cliLayer = Layer.succeed(
        CliService,
        CliService.of({
          run: (_command, args) => {
            const joined = args.join(" ")
            if (joined.includes("rev-parse --show-toplevel")) {
              return Effect.succeed(makeCliResult("/workspace/repo\n", args))
            }
            if (joined.includes("rev-parse --verify HEAD")) {
              return Effect.succeed(
                makeCliResult("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", args),
              )
            }
            if (joined.includes("diff --no-ext-diff bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --")) {
              diffRead += 1
              return Effect.succeed(
                makeCliResult(
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
              return Effect.succeed(makeCliResult("", args))
            }
            throw new Error(`Unexpected git call: ${joined}`)
          },
        }),
      )
      const layer = GitService.layer.pipe(Layer.provide(cliLayer))
      const service = yield* GitService.pipe(Effect.provide(layer))
      const result = yield* Effect.either(service.getLocalReviewSnapshot("/workspace/repo"))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(LocalReviewChangedError)
    }),
  )
})

const git = (cwd: string, ...args: readonly string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
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
    "commit",
    "-m",
    message,
  )
}
