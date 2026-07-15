import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer } from "effect"

import { CliError, CliService, type CliResult } from "./cli"
import { GitService, LocalReviewChangedError } from "./git"

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

  it.effect("fetches a different target branch and compares its tip with the live worktree", () =>
    Effect.gen(function* () {
      const baseSha = "dddddddddddddddddddddddddddddddddddddddd"
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
              return Effect.succeed(makeCliResult(`${baseSha}\n`, args))
            }
            if (joined.includes(`diff --no-ext-diff ${baseSha} --`)) {
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
      })
      expect(detail).toMatchObject({ baseSha, title: "Changes vs dev" })
      expect(calls.some((args) => args.includes("+refs/heads/dev:refs/remotes/origin/dev"))).toBe(
        true,
      )
      expect(
        calls.some((args) => args.join(" ").includes(`diff --no-ext-diff ${baseSha} --`)),
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
      })
      expect(calls.some((args) => args.includes("+refs/heads/main:refs/remotes/origin/main"))).toBe(
        true,
      )
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
